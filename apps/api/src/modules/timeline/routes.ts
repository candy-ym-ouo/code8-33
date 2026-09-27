import type { FastifyPluginAsync } from 'fastify';
import { Prisma } from '@prisma/client';
import { ACTIVITY_ACTIONS, ACTIVITY_ENTITY_TYPES, type ActivityAction, type ActivityEntityType } from '@paper-book-traces/shared';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/errors.js';
import { currentUser, requireAuth } from '../../lib/auth.js';
import { optionalDate, paginationFromQuery, parseId } from '../../lib/http.js';
import { replayEntityEvents, type FoldConflict } from '../../lib/replay.js';

const INTERNAL_META_KEYS = new Set(['baseRevision', 'revision', 'clientKind', 'seq']);

function publicPayload(payloadJson: Prisma.JsonValue | null): Record<string, unknown> {
  if (!payloadJson || typeof payloadJson !== 'object' || Array.isArray(payloadJson)) return {};
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payloadJson as Record<string, unknown>)) {
    if (!INTERNAL_META_KEYS.has(key)) result[key] = value;
  }
  return result;
}

export const timelineRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAuth);

  app.get('/timeline', async (request) => {
    const { page, pageSize, skip } = paginationFromQuery(request);
    const query = request.query as Record<string, unknown>;
    const userId = currentUser(request).id;
    const bookId = typeof query.bookId === 'string' && query.bookId ? parseId(query.bookId, 'bookId') : undefined;
    const action = typeof query.eventType === 'string' && query.eventType !== 'ALL' ? query.eventType : undefined;
    const entityType =
      typeof query.entityType === 'string' && query.entityType !== 'ALL' ? query.entityType : undefined;
    const from = optionalDate(query.from, 'from');
    const to = optionalDate(query.to, 'to');

    if (action && !ACTIVITY_ACTIONS.includes(action as ActivityAction)) {
      throw new AppError(422, 'VALIDATION_ERROR', '事件类型无效');
    }
    if (entityType && !ACTIVITY_ENTITY_TYPES.includes(entityType as ActivityEntityType)) {
      throw new AppError(422, 'VALIDATION_ERROR', '对象类型无效');
    }

    const where: Prisma.ActivityEventWhereInput = {
      userId,
      ...(bookId ? { bookId } : {}),
      ...(action ? { action: action as ActivityAction } : {}),
      ...(entityType ? { entityType: entityType as ActivityEntityType } : {}),
      ...(from || to
        ? {
            occurredAt: {
              ...(from ? { gte: from } : {}),
              ...(to ? { lte: to } : {})
            }
          }
        : {})
    };

    const [total, events] = await Promise.all([
      prisma.activityEvent.count({ where }),
      prisma.activityEvent.findMany({
        where,
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        skip,
        take: pageSize,
        include: { book: { select: { title: true } } }
      })
    ]);

    // 拉取本页事件所属实体的完整事件流，使折叠/冲突判定可在任意时刻复算，
    // 不依赖实体当前是否还存在。
    const entityIds = [...new Set(events.map((event) => event.entityId).filter((id): id is string => Boolean(id)))];
    let annotations = new Map<string, { current: boolean; superseded: boolean; conflict: FoldConflict | null }>();
    if (entityIds.length > 0) {
      const entityEvents = await prisma.activityEvent.findMany({
        where: { userId, entityId: { in: entityIds } },
        select: {
          id: true,
          entityType: true,
          entityId: true,
          action: true,
          payloadJson: true,
          occurredAt: true
        }
      });
      annotations = replayEntityEvents(entityEvents).annotations;
    }

    return {
      items: events.map((event) => {
        const fold = event.entityId ? annotations.get(event.entityId) : undefined;
        return {
          id: event.id,
          bookId: event.bookId,
          bookTitle: event.book?.title ?? '已删除书目',
          entityType: event.entityType,
          entityId: event.entityId,
          action: event.action,
          payload: publicPayload(event.payloadJson),
          occurredAt: event.occurredAt,
          current: fold?.current ?? true,
          superseded: fold?.superseded ?? false,
          conflict: fold?.conflict ?? null
        };
      }),
      pagination: { page, pageSize, total }
    };
  });
};

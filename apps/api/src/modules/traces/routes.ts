import type { FastifyPluginAsync } from 'fastify';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { TRACE_TYPES, type TraceType } from '@paper-book-traces/shared';
import { prisma } from '../../lib/prisma.js';
import { AppError, zodFields } from '../../lib/errors.js';
import { currentUser, requireAuth } from '../../lib/auth.js';
import { isRestoreWindowOpen, normalizeText, validatePageRange, validateSinglePage } from '../../lib/domain.js';
import { loadEntityFold, writeEvent } from '../../lib/events.js';
import { adjudicateMutation, revisionConflictError, type MutationKind } from '../../lib/revisions.js';
import { annotationSnapshot, dogEarSnapshot, rereadMarkSnapshot } from '../../lib/snapshots.js';
import { optionalDate, paginationFromQuery, parseId } from '../../lib/http.js';

const optionalReason = (max: number) =>
  z.preprocess(
    (value) => (value === '' ? null : value),
    z.string().trim().max(max).nullable().optional()
  );

const dogEarCreateSchema = z.object({
  pageNumber: z.number().int().positive(),
  reason: optionalReason(500)
});

const dogEarUpdateSchema = z
  .object({
    pageNumber: z.number().int().positive().optional(),
    reason: optionalReason(500),
    version: z.number().int().positive().optional()
  })
  .refine((value) => value.pageNumber !== undefined || value.reason !== undefined, {
    message: '至少提供一个要更新的字段'
  });

const annotationCreateSchema = z.object({
  startPage: z.number().int().positive(),
  endPage: z.number().int().positive(),
  content: z.string().trim().min(1, '请输入批注').max(5000)
});

const annotationUpdateSchema = z
  .object({
    startPage: z.number().int().positive().optional(),
    endPage: z.number().int().positive().optional(),
    content: z.string().trim().min(1).max(5000).optional(),
    version: z.number().int().positive().optional()
  })
  .refine((value) => value.startPage !== undefined || value.endPage !== undefined || value.content !== undefined, {
    message: '至少提供一个要更新的字段'
  });

const rereadCreateSchema = z.object({
  pageNumber: z.number().int().positive(),
  reason: optionalReason(1000)
});

const rereadUpdateSchema = z
  .object({
    pageNumber: z.number().int().positive().optional(),
    reason: optionalReason(1000),
    version: z.number().int().positive().optional()
  })
  .refine((value) => value.pageNumber !== undefined || value.reason !== undefined, {
    message: '至少提供一个要更新的字段'
  });

const deleteSchema = z.object({ version: z.number().int().positive().optional() }).optional();

const restoreSchema = z.object({ version: z.number().int().positive().optional() }).optional();

function serializeDogEar(item: {
  id: string;
  bookId: string;
  version: number;
  pageNumber: number;
  reason: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return { ...item, type: 'DOG_EAR' as const };
}

function serializeAnnotation(item: {
  id: string;
  bookId: string;
  version: number;
  startPage: number;
  endPage: number;
  content: string;
  createdAt: Date;
  updatedAt: Date;
}) {
  return { ...item, type: 'ANNOTATION' as const };
}

function serializeRereadMark(item: {
  id: string;
  bookId: string;
  version: number;
  pageNumber: number;
  reason: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return { ...item, type: 'REREAD_MARK' as const };
}

/**
 * 基于事件链判定一次变更是否允许提交。
 * 判定只依赖存量事件，任何时刻都可以重放复算。
 */
async function adjudicate(
  tx: Prisma.TransactionClient,
  entityType: 'DOG_EAR' | 'ANNOTATION' | 'REREAD_MARK',
  entityId: string,
  mutation: MutationKind,
  clientVersion?: number
): Promise<{ headVersion: number; nextVersion: number }> {
  const fold = await loadEntityFold(tx, entityType, entityId);
  const verdict = adjudicateMutation(fold, mutation, clientVersion);
  if (verdict.kind === 'REJECT') throw revisionConflictError(verdict.code);
  return { headVersion: fold.version, nextVersion: verdict.nextVersion };
}

function eventSummary(value: string | null | undefined): string {
  return (value ? normalizeText(value).slice(0, 120) : '');
}

export const traceRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAuth);

  app.get('/books/:bookId/traces', async (request) => {
    const bookId = parseId((request.params as { bookId: string }).bookId, 'bookId');
    const userId = currentUser(request).id;
    const book = await prisma.book.findFirst({ where: { id: bookId, userId, deletedAt: null } });
    if (!book) throw new AppError(404, 'NOT_FOUND', '书目不存在');

    const query = request.query as Record<string, unknown>;
    const type = typeof query.type === 'string' && query.type !== 'ALL' ? query.type : undefined;
    if (type && !TRACE_TYPES.includes(type as TraceType)) {
      throw new AppError(422, 'VALIDATION_ERROR', '痕迹类型无效');
    }
    const pageNumber = query.pageNumber === undefined ? undefined : Number(query.pageNumber);
    if (pageNumber !== undefined && (!Number.isInteger(pageNumber) || pageNumber < 1)) {
      throw new AppError(422, 'VALIDATION_ERROR', '页码无效');
    }
    const keyword = typeof query.keyword === 'string' ? query.keyword.trim() : '';
    const from = optionalDate(query.from, 'from');
    const to = optionalDate(query.to, 'to');
    const dateFilter = {
      ...(from ? { gte: from } : {}),
      ...(to ? { lte: to } : {})
    };
    const { page, pageSize } = paginationFromQuery(request);

    const [dogEars, annotations, rereadMarks] = await Promise.all([
      !type || type === 'DOG_EAR'
        ? prisma.dogEar.findMany({
            where: {
              userId,
              bookId,
              deletedAt: null,
              ...(pageNumber ? { pageNumber } : {}),
              ...(keyword ? { reason: { contains: keyword, mode: 'insensitive' } } : {}),
              ...(from || to ? { createdAt: dateFilter } : {})
            },
            orderBy: { createdAt: 'desc' }
          })
        : [],
      !type || type === 'ANNOTATION'
        ? prisma.annotation.findMany({
            where: {
              userId,
              bookId,
              deletedAt: null,
              ...(pageNumber ? { startPage: { lte: pageNumber }, endPage: { gte: pageNumber } } : {}),
              ...(keyword ? { content: { contains: keyword, mode: 'insensitive' } } : {}),
              ...(from || to ? { createdAt: dateFilter } : {})
            },
            orderBy: { createdAt: 'desc' }
          })
        : [],
      !type || type === 'REREAD_MARK'
        ? prisma.rereadMark.findMany({
            where: {
              userId,
              bookId,
              deletedAt: null,
              ...(pageNumber ? { pageNumber } : {}),
              ...(keyword ? { reason: { contains: keyword, mode: 'insensitive' } } : {}),
              ...(from || to ? { createdAt: dateFilter } : {})
            },
            orderBy: { createdAt: 'desc' }
          })
        : []
    ]);

    const merged = [
      ...dogEars.map(serializeDogEar),
      ...annotations.map(serializeAnnotation),
      ...rereadMarks.map(serializeRereadMark)
    ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const total = merged.length;
    const items = merged.slice((page - 1) * pageSize, page * pageSize);
    return { items, pagination: { page, pageSize, total } };
  });

  app.post('/books/:bookId/dog-ears', async (request, reply) => {
    const bookId = parseId((request.params as { bookId: string }).bookId, 'bookId');
    const parsed = dogEarCreateSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError(422, 'VALIDATION_ERROR', '折角信息无效', zodFields(parsed.error));
    const userId = currentUser(request).id;
    const book = await prisma.book.findFirst({ where: { id: bookId, userId, deletedAt: null } });
    if (!book) throw new AppError(404, 'NOT_FOUND', '书目不存在');
    validateSinglePage(parsed.data.pageNumber, book.pageCount);
    const reason = parsed.data.reason ? normalizeText(parsed.data.reason) : null;
    const existing = await prisma.dogEar.findFirst({
      where: { bookId, pageNumber: parsed.data.pageNumber, deletedAt: null }
    });
    if (existing) {
      if ((existing.reason ?? '') === (reason ?? '')) {
        return reply.status(200).send({ dogEar: serializeDogEar(existing), idempotent: true });
      }
      throw new AppError(409, 'DOG_EAR_EXISTS', '该页已有折角，请编辑原记录');
    }

    try {
      const dogEar = await prisma.$transaction(async (tx) => {
        const created = await tx.dogEar.create({
          data: { userId, bookId, pageNumber: parsed.data.pageNumber, reason }
        });
        await writeEvent(tx, {
          userId,
          bookId,
          entityType: 'DOG_EAR',
          entityId: created.id,
          entityVersion: 1,
          action: 'CREATED',
          payload: { pageNumber: created.pageNumber, reason: eventSummary(created.reason) },
          snapshot: dogEarSnapshot(created),
          baseVersion: null
        });
        return created;
      });
      return reply.status(201).send({ dogEar: serializeDogEar(dogEar) });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new AppError(409, 'DOG_EAR_EXISTS', '该页已有折角，请编辑原记录');
      }
      throw error;
    }
  });

  app.patch('/dog-ears/:dogEarId', async (request) => {
    const id = parseId((request.params as { dogEarId: string }).dogEarId, 'dogEarId');
    const parsed = dogEarUpdateSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError(422, 'VALIDATION_ERROR', '折角信息无效', zodFields(parsed.error));
    const userId = currentUser(request).id;
    const existing = await prisma.dogEar.findFirst({
      where: { id, userId },
      include: { book: true }
    });
    if (!existing) throw new AppError(404, 'NOT_FOUND', '折角不存在');
    if (existing.book.deletedAt) throw new AppError(404, 'NOT_FOUND', '折角不存在');
    const nextPage = parsed.data.pageNumber ?? existing.pageNumber;
    validateSinglePage(nextPage, existing.book.pageCount);
    const nextReason =
      parsed.data.reason === undefined
        ? existing.reason
        : parsed.data.reason
          ? normalizeText(parsed.data.reason)
          : null;
    if (nextPage !== existing.pageNumber) {
      const duplicate = await prisma.dogEar.findFirst({
        where: { bookId: existing.bookId, pageNumber: nextPage, deletedAt: null, id: { not: id } }
      });
      if (duplicate) throw new AppError(409, 'DOG_EAR_EXISTS', '目标页已有折角');
    }
    const updated = await prisma.$transaction(async (tx) => {
      const { headVersion, nextVersion } = await adjudicate(tx, 'DOG_EAR', id, 'UPDATE', parsed.data.version);
      const result = await tx.dogEar.updateMany({
        where: { id, userId, version: headVersion, deletedAt: null },
        data: {
          pageNumber: nextPage,
          reason: nextReason,
          version: { increment: 1 }
        }
      });
      if (result.count !== 1) throw revisionConflictError('STALE_WRITE');
      const row = await tx.dogEar.findUniqueOrThrow({ where: { id } });
      await writeEvent(tx, {
        userId,
        bookId: existing.bookId,
        entityType: 'DOG_EAR',
        entityId: id,
        entityVersion: nextVersion,
        action: 'UPDATED',
        payload: { pageNumber: nextPage, reason: eventSummary(nextReason) },
        snapshot: dogEarSnapshot(row),
        baseVersion: parsed.data.version ?? null
      });
      return row;
    });
    return { dogEar: serializeDogEar(updated) };
  });

  app.delete('/dog-ears/:dogEarId', async (request, reply) => {
    const id = parseId((request.params as { dogEarId: string }).dogEarId, 'dogEarId');
    const parsed = deleteSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError(422, 'VALIDATION_ERROR', '删除参数无效', zodFields(parsed.error));
    const userId = currentUser(request).id;
    const existing = await prisma.dogEar.findFirst({ where: { id, userId } });
    if (!existing) throw new AppError(404, 'NOT_FOUND', '折角不存在');
    await prisma.$transaction(async (tx) => {
      const { headVersion, nextVersion } = await adjudicate(tx, 'DOG_EAR', id, 'DELETE', parsed.data?.version);
      const result = await tx.dogEar.updateMany({
        where: { id, userId, deletedAt: null, version: headVersion },
        data: { deletedAt: new Date(), version: { increment: 1 } }
      });
      if (result.count !== 1) throw revisionConflictError('STALE_WRITE');
      await writeEvent(tx, {
        userId,
        bookId: existing.bookId,
        entityType: 'DOG_EAR',
        entityId: id,
        entityVersion: nextVersion,
        action: 'DELETED',
        payload: { pageNumber: existing.pageNumber },
        snapshot: dogEarSnapshot(existing),
        baseVersion: parsed.data?.version ?? null
      });
    });
    return reply.status(204).send();
  });

  app.post('/dog-ears/:dogEarId/restore', async (request) => {
    const id = parseId((request.params as { dogEarId: string }).dogEarId, 'dogEarId');
    const parsed = restoreSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError(422, 'VALIDATION_ERROR', '恢复参数无效', zodFields(parsed.error));
    const userId = currentUser(request).id;
    const existing = await prisma.dogEar.findFirst({ where: { id, userId }, include: { book: true } });
    if (!existing) throw new AppError(404, 'NOT_FOUND', '已删除折角不存在');
    if (existing.deletedAt) {
      if (!isRestoreWindowOpen(existing.deletedAt)) {
        throw new AppError(409, 'RESTORE_WINDOW_EXPIRED', '已超过 24 小时恢复窗口');
      }
      if (existing.book.deletedAt) throw new AppError(409, 'BOOK_DELETED', '所属书目已删除');
      const duplicate = await prisma.dogEar.findFirst({
        where: { bookId: existing.bookId, pageNumber: existing.pageNumber, deletedAt: null, id: { not: id } }
      });
      if (duplicate) throw new AppError(409, 'DOG_EAR_EXISTS', '该页已有有效折角，无法恢复');
    }
    const restored = await prisma.$transaction(async (tx) => {
      const { headVersion, nextVersion } = await adjudicate(tx, 'DOG_EAR', id, 'RESTORE', parsed.data?.version);
      const result = await tx.dogEar.updateMany({
        where: { id, userId, version: headVersion, deletedAt: { not: null } },
        data: { deletedAt: null, version: { increment: 1 } }
      });
      if (result.count !== 1) throw revisionConflictError('STALE_WRITE');
      const value = await tx.dogEar.findUniqueOrThrow({ where: { id } });
      await writeEvent(tx, {
        userId,
        bookId: value.bookId,
        entityType: 'DOG_EAR',
        entityId: id,
        entityVersion: nextVersion,
        action: 'RESTORED',
        payload: { pageNumber: value.pageNumber },
        snapshot: dogEarSnapshot(value),
        baseVersion: parsed.data?.version ?? null
      });
      return value;
    });
    return { dogEar: serializeDogEar(restored) };
  });

  app.post('/books/:bookId/annotations', async (request, reply) => {
    const bookId = parseId((request.params as { bookId: string }).bookId, 'bookId');
    const parsed = annotationCreateSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError(422, 'VALIDATION_ERROR', '批注信息无效', zodFields(parsed.error));
    const userId = currentUser(request).id;
    const book = await prisma.book.findFirst({ where: { id: bookId, userId, deletedAt: null } });
    if (!book) throw new AppError(404, 'NOT_FOUND', '书目不存在');
    validatePageRange(parsed.data.startPage, parsed.data.endPage, book.pageCount);
    const annotation = await prisma.$transaction(async (tx) => {
      const created = await tx.annotation.create({
        data: {
          userId,
          bookId,
          startPage: parsed.data.startPage,
          endPage: parsed.data.endPage,
          content: normalizeText(parsed.data.content)
        }
      });
      await writeEvent(tx, {
        userId,
        bookId,
        entityType: 'ANNOTATION',
        entityId: created.id,
        entityVersion: 1,
        action: 'CREATED',
        payload: { startPage: created.startPage, endPage: created.endPage, summary: eventSummary(created.content) },
        snapshot: annotationSnapshot(created),
        baseVersion: null
      });
      return created;
    });
    return reply.status(201).send({ annotation: serializeAnnotation(annotation) });
  });

  app.patch('/annotations/:annotationId', async (request) => {
    const id = parseId((request.params as { annotationId: string }).annotationId, 'annotationId');
    const parsed = annotationUpdateSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError(422, 'VALIDATION_ERROR', '批注信息无效', zodFields(parsed.error));
    const userId = currentUser(request).id;
    const existing = await prisma.annotation.findFirst({
      where: { id, userId },
      include: { book: true }
    });
    if (!existing) throw new AppError(404, 'NOT_FOUND', '批注不存在');
    if (existing.book.deletedAt) throw new AppError(404, 'NOT_FOUND', '批注不存在');
    const startPage = parsed.data.startPage ?? existing.startPage;
    const endPage = parsed.data.endPage ?? existing.endPage;
    validatePageRange(startPage, endPage, existing.book.pageCount);
    const content = parsed.data.content !== undefined ? normalizeText(parsed.data.content) : existing.content;
    const updated = await prisma.$transaction(async (tx) => {
      const { headVersion, nextVersion } = await adjudicate(tx, 'ANNOTATION', id, 'UPDATE', parsed.data.version);
      const result = await tx.annotation.updateMany({
        where: { id, userId, deletedAt: null, version: headVersion },
        data: {
          startPage,
          endPage,
          content,
          version: { increment: 1 }
        }
      });
      if (result.count !== 1) throw revisionConflictError('STALE_WRITE');
      const row = await tx.annotation.findUniqueOrThrow({ where: { id } });
      await writeEvent(tx, {
        userId,
        bookId: existing.bookId,
        entityType: 'ANNOTATION',
        entityId: id,
        entityVersion: nextVersion,
        action: 'UPDATED',
        payload: { startPage, endPage },
        snapshot: annotationSnapshot(row),
        baseVersion: parsed.data.version ?? null
      });
      return row;
    });
    return { annotation: serializeAnnotation(updated) };
  });

  app.delete('/annotations/:annotationId', async (request, reply) => {
    const id = parseId((request.params as { annotationId: string }).annotationId, 'annotationId');
    const parsed = deleteSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError(422, 'VALIDATION_ERROR', '删除参数无效', zodFields(parsed.error));
    const userId = currentUser(request).id;
    const existing = await prisma.annotation.findFirst({ where: { id, userId } });
    if (!existing) throw new AppError(404, 'NOT_FOUND', '批注不存在');
    await prisma.$transaction(async (tx) => {
      const { headVersion, nextVersion } = await adjudicate(tx, 'ANNOTATION', id, 'DELETE', parsed.data?.version);
      const result = await tx.annotation.updateMany({
        where: { id, userId, deletedAt: null, version: headVersion },
        data: { deletedAt: new Date(), version: { increment: 1 } }
      });
      if (result.count !== 1) throw revisionConflictError('STALE_WRITE');
      await writeEvent(tx, {
        userId,
        bookId: existing.bookId,
        entityType: 'ANNOTATION',
        entityId: id,
        entityVersion: nextVersion,
        action: 'DELETED',
        payload: { startPage: existing.startPage, endPage: existing.endPage },
        snapshot: annotationSnapshot(existing),
        baseVersion: parsed.data?.version ?? null
      });
    });
    return reply.status(204).send();
  });

  app.post('/annotations/:annotationId/restore', async (request) => {
    const id = parseId((request.params as { annotationId: string }).annotationId, 'annotationId');
    const parsed = restoreSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError(422, 'VALIDATION_ERROR', '恢复参数无效', zodFields(parsed.error));
    const userId = currentUser(request).id;
    const existing = await prisma.annotation.findFirst({ where: { id, userId }, include: { book: true } });
    if (!existing) throw new AppError(404, 'NOT_FOUND', '已删除批注不存在');
    if (existing.deletedAt) {
      if (!isRestoreWindowOpen(existing.deletedAt)) {
        throw new AppError(409, 'RESTORE_WINDOW_EXPIRED', '已超过 24 小时恢复窗口');
      }
      if (existing.book.deletedAt) throw new AppError(409, 'BOOK_DELETED', '所属书目已删除');
    }
    const restored = await prisma.$transaction(async (tx) => {
      const { headVersion, nextVersion } = await adjudicate(tx, 'ANNOTATION', id, 'RESTORE', parsed.data?.version);
      const result = await tx.annotation.updateMany({
        where: { id, userId, version: headVersion, deletedAt: { not: null } },
        data: { deletedAt: null, version: { increment: 1 } }
      });
      if (result.count !== 1) throw revisionConflictError('STALE_WRITE');
      const value = await tx.annotation.findUniqueOrThrow({ where: { id } });
      await writeEvent(tx, {
        userId,
        bookId: value.bookId,
        entityType: 'ANNOTATION',
        entityId: id,
        entityVersion: nextVersion,
        action: 'RESTORED',
        payload: { startPage: value.startPage, endPage: value.endPage },
        snapshot: annotationSnapshot(value),
        baseVersion: parsed.data?.version ?? null
      });
      return value;
    });
    return { annotation: serializeAnnotation(restored) };
  });

  app.post('/books/:bookId/reread-marks', async (request, reply) => {
    const bookId = parseId((request.params as { bookId: string }).bookId, 'bookId');
    const parsed = rereadCreateSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError(422, 'VALIDATION_ERROR', '重读信息无效', zodFields(parsed.error));
    const userId = currentUser(request).id;
    const book = await prisma.book.findFirst({ where: { id: bookId, userId, deletedAt: null } });
    if (!book) throw new AppError(404, 'NOT_FOUND', '书目不存在');
    validateSinglePage(parsed.data.pageNumber, book.pageCount);
    const mark = await prisma.$transaction(async (tx) => {
      const created = await tx.rereadMark.create({
        data: {
          userId,
          bookId,
          pageNumber: parsed.data.pageNumber,
          reason: parsed.data.reason ? normalizeText(parsed.data.reason) : null
        }
      });
      await writeEvent(tx, {
        userId,
        bookId,
        entityType: 'REREAD_MARK',
        entityId: created.id,
        entityVersion: 1,
        action: 'CREATED',
        payload: { pageNumber: created.pageNumber, reason: eventSummary(created.reason) },
        snapshot: rereadMarkSnapshot(created),
        baseVersion: null
      });
      return created;
    });
    return reply.status(201).send({ rereadMark: serializeRereadMark(mark) });
  });

  app.patch('/reread-marks/:rereadMarkId', async (request) => {
    const id = parseId((request.params as { rereadMarkId: string }).rereadMarkId, 'rereadMarkId');
    const parsed = rereadUpdateSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError(422, 'VALIDATION_ERROR', '重读信息无效', zodFields(parsed.error));
    const userId = currentUser(request).id;
    const existing = await prisma.rereadMark.findFirst({
      where: { id, userId },
      include: { book: true }
    });
    if (!existing) throw new AppError(404, 'NOT_FOUND', '重读记录不存在');
    if (existing.book.deletedAt) throw new AppError(404, 'NOT_FOUND', '重读记录不存在');
    const pageNumber = parsed.data.pageNumber ?? existing.pageNumber;
    validateSinglePage(pageNumber, existing.book.pageCount);
    const reason =
      parsed.data.reason === undefined
        ? existing.reason
        : parsed.data.reason
          ? normalizeText(parsed.data.reason)
          : null;
    const updated = await prisma.$transaction(async (tx) => {
      const { headVersion, nextVersion } = await adjudicate(tx, 'REREAD_MARK', id, 'UPDATE', parsed.data.version);
      const result = await tx.rereadMark.updateMany({
        where: { id, userId, deletedAt: null, version: headVersion },
        data: { pageNumber, reason, version: { increment: 1 } }
      });
      if (result.count !== 1) throw revisionConflictError('STALE_WRITE');
      const row = await tx.rereadMark.findUniqueOrThrow({ where: { id } });
      await writeEvent(tx, {
        userId,
        bookId: existing.bookId,
        entityType: 'REREAD_MARK',
        entityId: id,
        entityVersion: nextVersion,
        action: 'UPDATED',
        payload: { pageNumber, reason: eventSummary(reason) },
        snapshot: rereadMarkSnapshot(row),
        baseVersion: parsed.data.version ?? null
      });
      return row;
    });
    return { rereadMark: serializeRereadMark(updated) };
  });

  app.delete('/reread-marks/:rereadMarkId', async (request, reply) => {
    const id = parseId((request.params as { rereadMarkId: string }).rereadMarkId, 'rereadMarkId');
    const parsed = deleteSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError(422, 'VALIDATION_ERROR', '删除参数无效', zodFields(parsed.error));
    const userId = currentUser(request).id;
    const existing = await prisma.rereadMark.findFirst({ where: { id, userId } });
    if (!existing) throw new AppError(404, 'NOT_FOUND', '重读记录不存在');
    await prisma.$transaction(async (tx) => {
      const { headVersion, nextVersion } = await adjudicate(tx, 'REREAD_MARK', id, 'DELETE', parsed.data?.version);
      const result = await tx.rereadMark.updateMany({
        where: { id, userId, deletedAt: null, version: headVersion },
        data: { deletedAt: new Date(), version: { increment: 1 } }
      });
      if (result.count !== 1) throw revisionConflictError('STALE_WRITE');
      await writeEvent(tx, {
        userId,
        bookId: existing.bookId,
        entityType: 'REREAD_MARK',
        entityId: id,
        entityVersion: nextVersion,
        action: 'DELETED',
        payload: { pageNumber: existing.pageNumber },
        snapshot: rereadMarkSnapshot(existing),
        baseVersion: parsed.data?.version ?? null
      });
    });
    return reply.status(204).send();
  });

  app.post('/reread-marks/:rereadMarkId/restore', async (request) => {
    const id = parseId((request.params as { rereadMarkId: string }).rereadMarkId, 'rereadMarkId');
    const parsed = restoreSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError(422, 'VALIDATION_ERROR', '恢复参数无效', zodFields(parsed.error));
    const userId = currentUser(request).id;
    const existing = await prisma.rereadMark.findFirst({ where: { id, userId }, include: { book: true } });
    if (!existing) throw new AppError(404, 'NOT_FOUND', '已删除重读记录不存在');
    if (existing.deletedAt) {
      if (!isRestoreWindowOpen(existing.deletedAt)) {
        throw new AppError(409, 'RESTORE_WINDOW_EXPIRED', '已超过 24 小时恢复窗口');
      }
      if (existing.book.deletedAt) throw new AppError(409, 'BOOK_DELETED', '所属书目已删除');
    }
    const restored = await prisma.$transaction(async (tx) => {
      const { headVersion, nextVersion } = await adjudicate(tx, 'REREAD_MARK', id, 'RESTORE', parsed.data?.version);
      const result = await tx.rereadMark.updateMany({
        where: { id, userId, version: headVersion, deletedAt: { not: null } },
        data: { deletedAt: null, version: { increment: 1 } }
      });
      if (result.count !== 1) throw revisionConflictError('STALE_WRITE');
      const value = await tx.rereadMark.findUniqueOrThrow({ where: { id } });
      await writeEvent(tx, {
        userId,
        bookId: value.bookId,
        entityType: 'REREAD_MARK',
        entityId: id,
        entityVersion: nextVersion,
        action: 'RESTORED',
        payload: { pageNumber: value.pageNumber },
        snapshot: rereadMarkSnapshot(value),
        baseVersion: parsed.data?.version ?? null
      });
      return value;
    });
    return { rereadMark: serializeRereadMark(restored) };
  });
};

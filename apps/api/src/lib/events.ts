import { Prisma, type ActivityAction, type ActivityEntityType } from '@prisma/client';
import { foldRevisionEvents, type EntityFold } from './revisions.js';

type Tx = Prisma.TransactionClient;

export async function writeEvent(
  tx: Tx,
  input: {
    userId: string;
    bookId?: string | null;
    entityType: ActivityEntityType;
    entityId?: string | null;
    entityVersion: number;
    action: ActivityAction;
    payload?: Prisma.InputJsonObject;
    /** 写入后的实体快照，供事件重放与旧客户端内容比对。 */
    snapshot?: Record<string, unknown>;
    /** 客户端声明的基准版本；旧客户端省略版本时为 null。 */
    baseVersion?: number | null;
  }
): Promise<void> {
  const payload: Prisma.InputJsonObject = {
    snapshot: (input.snapshot ?? {}) as Prisma.InputJsonObject,
    baseVersion: input.baseVersion ?? null,
    ...(input.payload ?? {})
  };
  await tx.activityEvent.create({
    data: {
      userId: input.userId,
      bookId: input.bookId ?? null,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      entityVersion: input.entityVersion,
      action: input.action,
      payloadJson: payload
    }
  });
}

/**
 * 在事务内加载某个实体的事件链并折叠成当前修订状态。
 * 冲突判定以此为准，而不是以业务行的当前值为准，
 * 这样判定结果可以随时用存量事件复算验证。
 */
export async function loadEntityFold(
  tx: Tx,
  entityType: ActivityEntityType,
  entityId: string
): Promise<EntityFold> {
  const events = await tx.activityEvent.findMany({
    where: { entityType, entityId },
    select: { id: true, action: true, entityVersion: true, occurredAt: true, payloadJson: true }
  });
  return foldRevisionEvents(events);
}

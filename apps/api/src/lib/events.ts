import { Prisma, type ActivityAction, type ActivityEntityType } from '@prisma/client';
import type { EventClientKind } from '@paper-book-traces/shared';

type Tx = Prisma.TransactionClient;

export interface WriteEventInput {
  userId: string;
  bookId?: string | null;
  entityType: ActivityEntityType;
  entityId?: string | null;
  action: ActivityAction;
  payload?: Prisma.InputJsonValue;
  /** 客户端写入时依据的实体版本；旧客户端省略 version 时传 null。 */
  baseRevision?: number | null;
  /** 本次写入落库后的实体版本。 */
  revision?: number;
  clientKind?: EventClientKind;
  /** 服务端级联写入（如删书连带软删痕迹），不记为旧端盲写。 */
  cascade?: boolean;
}

// 每个事务独立维护事件序号，消除同毫秒事件在时间线上的顺序歧义。
const txSeqCounters = new WeakMap<Tx, number>();

export async function writeEvent(tx: Tx, input: WriteEventInput): Promise<void> {
  const seq = (txSeqCounters.get(tx) ?? 0) + 1;
  txSeqCounters.set(tx, seq);

  const meta: Record<string, unknown> = {
    baseRevision: input.baseRevision ?? null,
    clientKind: input.clientKind ?? 'VERSIONED',
    seq
  };
  if (input.revision !== undefined) meta.revision = input.revision;
  if (input.cascade) meta.cascade = true;

  const payload = { ...((input.payload as Record<string, unknown> | undefined) ?? {}), ...meta };

  await tx.activityEvent.create({
    data: {
      userId: input.userId,
      bookId: input.bookId ?? null,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      action: input.action,
      payloadJson: payload as Prisma.InputJsonValue
    }
  });
}

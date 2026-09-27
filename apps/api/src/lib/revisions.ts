import type { ActivityAction } from '@prisma/client';
import { AppError } from './errors.js';

/**
 * 修订链折叠与冲突判定。
 *
 * 本模块不依赖数据库：输入是同一实体按发生顺序排列的事件，
 * 输出是确定性结论。任何时刻都可以把存量事件重新喂给这些函数，
 * 复算出与写入时一致的版本号、墓碑状态与冲突判定。
 *
 * 关键不变量：每个事件都恰好对应一次实体版本推进
 * （创建为第 1 版；书目的 STATUS_CHANGED、完成感受的 COMPLETED
 * 同样使行版本 +1）。迁移 20260926093000 按此不变量回填存量事件。
 */

export type MutationKind = 'UPDATE' | 'DELETE' | 'RESTORE';

export interface RevisionEventLike {
  id: string;
  action: ActivityAction;
  entityVersion: number;
  occurredAt: Date;
}

export interface EntityFold {
  /** 事件链推进到的版本号；没有任何事件时为 0。 */
  version: number;
  /** 链上最近一次状态变化是否为删除（墓碑）。 */
  deleted: boolean;
  /** 最近一次写入事件携带的实体快照；存量事件没有快照时为 null。 */
  latestSnapshot: Record<string, unknown> | null;
  /** 事件数；用于诊断与测试。 */
  eventCount: number;
  /** 版本链是否连续（每个版本恰好一条事件）。 */
  chainIntact: boolean;
  /** 链上出现的版本空洞；正常数据应为空数组。 */
  gaps: number[];
}

/**
 * 折叠单个实体的事件链。
 *
 * 同一实体的所有写操作都在事务里同时推进行版本与事件版本，
 * 因此这里按 (occurredAt, id) 稳定排序后逐个应用即可还原终态。
 */
export function foldRevisionEvents(
  events: ReadonlyArray<RevisionEventLike & { payloadJson?: unknown }>
): EntityFold {
  const ordered = [...events].sort(
    (a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || a.id.localeCompare(b.id)
  );
  let version = 0;
  let deleted = false;
  let latestSnapshot: Record<string, unknown> | null = null;
  const seen = new Set<number>();
  const gaps: number[] = [];

  for (const event of ordered) {
    seen.add(event.entityVersion);
    if (event.entityVersion > version) version = event.entityVersion;
    if (event.action === 'DELETED') deleted = true;
    if (event.action === 'RESTORED' || event.action === 'CREATED') deleted = false;
    const payload = event.payloadJson;
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      const snapshot = (payload as Record<string, unknown>).snapshot;
      if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)) {
        latestSnapshot = snapshot as Record<string, unknown>;
      }
    }
  }

  for (let expected = 1; expected <= version; expected += 1) {
    if (!seen.has(expected)) gaps.push(expected);
  }

  return {
    version,
    deleted,
    latestSnapshot,
    eventCount: seen.size,
    chainIntact: gaps.length === 0,
    gaps
  };
}

export type MutationVerdict =
  | { kind: 'APPLY'; nextVersion: number }
  | { kind: 'REJECT'; code: RevisionConflictCode };

export type RevisionConflictCode =
  | 'ALREADY_DELETED'
  | 'NOT_DELETED'
  | 'STALE_WRITE';

/**
 * 对一次变更请求做冲突判定。
 *
 * - 已删除的实体拒绝 UPDATE / DELETE（墓碑不会被新内容覆盖）；
 * - 未删除的实体拒绝 RESTORE；
 * - 客户端携带版本时必须等于链头版本，否则判定为过期写入；
 * - 旧客户端省略版本时退化为在链头追加（last-write-wins），
 *   但上面的状态守卫仍然生效，因此不会再产生
 *   “删除后又被更新覆盖”这类自相矛盾的事件序列。
 */
export function adjudicateMutation(
  fold: Pick<EntityFold, 'version' | 'deleted'>,
  mutation: MutationKind,
  clientVersion?: number
): MutationVerdict {
  if (mutation === 'RESTORE') {
    if (!fold.deleted) return { kind: 'REJECT', code: 'NOT_DELETED' };
  } else if (fold.deleted) {
    return { kind: 'REJECT', code: 'ALREADY_DELETED' };
  }
  if (clientVersion !== undefined && clientVersion !== fold.version) {
    return { kind: 'REJECT', code: 'STALE_WRITE' };
  }
  return { kind: 'APPLY', nextVersion: fold.version + 1 };
}

const CONFLICT_STATUS: Record<RevisionConflictCode, number> = {
  ALREADY_DELETED: 404,
  NOT_DELETED: 404,
  STALE_WRITE: 409
};

const CONFLICT_MESSAGE: Record<RevisionConflictCode, string> = {
  ALREADY_DELETED: '记录已删除，不能继续修改；如需找回请在 24 小时内撤销删除',
  NOT_DELETED: '记录未被删除，无需恢复',
  STALE_WRITE: '记录已在其他位置被修改，请刷新后重试'
};

export function revisionConflictError(code: RevisionConflictCode): AppError {
  return new AppError(CONFLICT_STATUS[code], code, CONFLICT_MESSAGE[code]);
}

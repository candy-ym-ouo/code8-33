import type { ActivityAction, ActivityEntityType, ConflictReason, EventClientKind } from '@paper-book-traces/shared';

/**
 * 事件修订元数据，内嵌在 ActivityEvent.payloadJson 中。
 *
 * - baseRevision：客户端发起写入时所依据的实体版本；旧客户端省略 version 时为 null。
 * - revision：本次写入落库后的实体版本。
 * - clientKind：VERSIONED 为携带版本的写入，LEGACY 为旧客户端盲写，SYSTEM 为服务端级联。
 * - seq：同一事务内的写入序号，用于消除同毫秒事件的排序不确定性。
 * - cascade：是否为服务端级联操作（如删书时连带软删痕迹）。
 */
export interface EventMeta {
  baseRevision: number | null;
  revision: number | null;
  clientKind: EventClientKind;
  seq: number | null;
  cascade: boolean;
}

export interface ReplayEventLike {
  id: string;
  entityType: string;
  entityId: string | null;
  action: string;
  payloadJson?: unknown;
  occurredAt: Date | string;
}

export interface FoldConflict {
  eventId: string;
  reason: ConflictReason;
  message: string;
  baseRevision: number | null;
  actualRevision: number | null;
}

export interface EntityFold {
  entityId: string;
  entityType: ActivityEntityType;
  /** 重放结束后的实体版本；实体不存在时为 0。 */
  revision: number;
  /** 重放结束后实体是否处于未删除状态。 */
  alive: boolean;
  /** 决定当前实体状态的最后一条已应用事件。 */
  currentEventId: string | null;
  /** 确定性重放顺序下的全部事件 id。 */
  orderedEventIds: string[];
  conflicts: FoldConflict[];
}

export interface EventAnnotation {
  current: boolean;
  superseded: boolean;
  conflict: FoldConflict | null;
}

export interface ReplayResult {
  entities: Map<string, EntityFold>;
  annotations: Map<string, EventAnnotation>;
}

const CONFLICT_MESSAGES: Record<ConflictReason, string> = {
  STALE_REVISION: '该写入基于旧版本，已被并发修改拦截为过期写入',
  BLIND_OVERWRITE: '旧客户端未携带版本号，此次修改可能覆盖了更新的内容',
  BLIND_DELETE: '旧客户端未携带版本号，此次删除可能基于过期内容',
  BLIND_RESTORE: '旧客户端未携带版本号，此次恢复可能基于过期状态',
  LIFECYCLE_MISMATCH: '事件与实体当时的删除状态矛盾',
  UNKNOWN: '事件与实体状态无法对应'
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asPositiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : null;
}

export function readEventMeta(payloadJson: unknown): EventMeta {
  const payload = asRecord(payloadJson);
  const baseRaw = payload.baseRevision;
  const clientKinds: EventClientKind[] = ['VERSIONED', 'LEGACY', 'SYSTEM'];
  const clientKind = clientKinds.includes(payload.clientKind as EventClientKind)
    ? (payload.clientKind as EventClientKind)
    : // 存量事件没有任何修订元数据，按旧客户端盲写兼容。
      'LEGACY';
  return {
    baseRevision: baseRaw === null ? null : asPositiveInt(baseRaw) ?? (baseRaw === 0 ? 0 : null),
    revision: asPositiveInt(payload.revision),
    seq: typeof payload.seq === 'number' && Number.isInteger(payload.seq) && payload.seq >= 0 ? payload.seq : null,
    cascade: payload.cascade === true,
    clientKind
  };
}

/**
 * 确定性排序：发生时刻升序；同一事务共用时刻时按 seq 升序；
 * 再退化为事件 id（UUID）升序，保证任何时候重放结果一致、可复算。
 */
export function compareEvents(a: ReplayEventLike, b: ReplayEventLike, metaOf: (e: ReplayEventLike) => EventMeta): number {
  const at = new Date(a.occurredAt).getTime();
  const bt = new Date(b.occurredAt).getTime();
  if (at !== bt) return at - bt;
  const aSeq = metaOf(a).seq;
  const bSeq = metaOf(b).seq;
  if (aSeq !== null && bSeq !== null && aSeq !== bSeq) return aSeq - bSeq;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function isCreation(action: string): boolean {
  // 完成感受没有独立的创建动作，COMPLETED 即其创建事件。
  return action === 'CREATED' || action === 'COMPLETED';
}

/**
 * 按实体折叠事件流，重放出版本、存活状态与冲突。
 * 纯函数：相同输入必然得到相同输出，不依赖当前时间或数据库状态。
 */
export function replayEntityEvents(events: ReplayEventLike[]): ReplayResult {
  const entities = new Map<string, EntityFold>();
  const annotations = new Map<string, EventAnnotation>();

  const groups = new Map<string, ReplayEventLike[]>();
  for (const event of events) {
    if (!event.entityId) continue;
    const list = groups.get(event.entityId);
    if (list) list.push(event);
    else groups.set(event.entityId, [event]);
  }

  for (const [entityId, group] of groups) {
    const metaCache = new Map<string, EventMeta>();
    const metaOf = (event: ReplayEventLike): EventMeta => {
      let meta = metaCache.get(event.id);
      if (!meta) {
        meta = readEventMeta(event.payloadJson);
        metaCache.set(event.id, meta);
      }
      return meta;
    };

    const ordered = [...group].sort((a, b) => compareEvents(a, b, metaOf));
    const conflicts: FoldConflict[] = [];

    let created = false;
    let alive = false;
    let revision = 0;
    let currentEventId: string | null = null;
    // 只有在版本化写入之后出现的旧端盲写，才可能覆盖新内容；
    // 存量实体在任何新端写入之前的旧端操作只是其正常编辑历史。
    let seenVersionedWrite = false;
    const appliedIds = new Set<string>();

    const addConflict = (event: ReplayEventLike, reason: ConflictReason): void => {
      conflicts.push({
        eventId: event.id,
        reason,
        message: CONFLICT_MESSAGES[reason],
        baseRevision: metaOf(event).baseRevision,
        actualRevision: revision
      });
    };

    for (const event of ordered) {
      const meta = metaOf(event);
      if (isCreation(event.action)) {
        if (created) {
          addConflict(event, 'LIFECYCLE_MISMATCH');
          continue;
        }
        created = true;
        alive = true;
        revision = 1;
        currentEventId = event.id;
        appliedIds.add(event.id);
        continue;
      }

      if (!created) {
        // 缺少创建事件的存量脏数据，不臆造状态。
        addConflict(event, 'UNKNOWN');
        continue;
      }

      const action: ActivityAction = event.action as ActivityAction;
      if (action === 'UPDATED' || action === 'STATUS_CHANGED') {
        if (!alive) {
          addConflict(event, 'LIFECYCLE_MISMATCH');
          continue;
        }
        if (meta.baseRevision !== null && meta.baseRevision !== revision) {
          addConflict(event, 'STALE_REVISION');
          continue;
        }
        if (meta.clientKind === 'LEGACY' && seenVersionedWrite) addConflict(event, 'BLIND_OVERWRITE');
        if (meta.clientKind !== 'LEGACY') seenVersionedWrite = true;
        revision += 1;
        currentEventId = event.id;
        appliedIds.add(event.id);
        continue;
      }

      if (action === 'DELETED') {
        if (!alive) {
          addConflict(event, 'LIFECYCLE_MISMATCH');
          continue;
        }
        if (meta.baseRevision !== null && meta.baseRevision !== revision) {
          addConflict(event, 'STALE_REVISION');
          // 过期删除不应用，实体仍保持存活。
          continue;
        }
        if (!meta.cascade && meta.clientKind === 'LEGACY' && seenVersionedWrite) {
          // 只有此前已有版本化写入时，旧端的无版本删除才可能抹掉新端内容；
          // 纯旧端历史中的删除是其正常编辑，不产生假阳性冲突。
          addConflict(event, 'BLIND_DELETE');
        }
        if (meta.clientKind !== 'LEGACY') seenVersionedWrite = true;
        alive = false;
        revision += 1;
        currentEventId = event.id;
        appliedIds.add(event.id);
        continue;
      }

      if (action === 'RESTORED') {
        if (alive) {
          // 并发重复恢复：实体已处于恢复状态，本次为空操作，属于并列矛盾事件。
          addConflict(event, 'LIFECYCLE_MISMATCH');
          continue;
        }
        if (meta.baseRevision !== null && meta.baseRevision !== revision) {
          addConflict(event, 'STALE_REVISION');
          continue;
        }
        if (!meta.cascade && meta.clientKind === 'LEGACY' && seenVersionedWrite) {
          addConflict(event, 'BLIND_RESTORE');
        }
        if (meta.clientKind !== 'LEGACY') seenVersionedWrite = true;
        alive = true;
        revision += 1;
        currentEventId = event.id;
        appliedIds.add(event.id);
        continue;
      }

      addConflict(event, 'UNKNOWN');
    }

    const first = ordered[0]!;
    const fold: EntityFold = {
      entityId,
      entityType: first.entityType as ActivityEntityType,
      revision,
      alive,
      currentEventId,
      orderedEventIds: ordered.map((event) => event.id),
      conflicts
    };
    entities.set(entityId, fold);

    for (const event of ordered) {
      annotations.set(event.id, {
        current: event.id === currentEventId,
        superseded: appliedIds.has(event.id) && event.id !== currentEventId,
        conflict: conflicts.find((item) => item.eventId === event.id) ?? null
      });
    }
  }

  return { entities, annotations };
}

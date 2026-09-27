import { describe, expect, it } from 'vitest';
import type { ActivityAction } from '@prisma/client';
import {
  adjudicateMutation,
  foldRevisionEvents,
  revisionConflictError,
  type RevisionEventLike
} from './revisions.js';

let sequence = 0;
function event(
  action: ActivityAction,
  entityVersion: number,
  options: { snapshot?: Record<string, unknown>; at?: string } = {}
): RevisionEventLike & { payloadJson?: unknown } {
  sequence += 1;
  return {
    id: `evt-${String(sequence).padStart(4, '0')}`,
    action,
    entityVersion,
    occurredAt: new Date(options.at ?? `2026-09-26T00:00:${String(sequence).padStart(2, '0')}.000Z`),
    ...(options.snapshot ? { payloadJson: { snapshot: options.snapshot } } : {})
  };
}

describe('foldRevisionEvents', () => {
  it('folds an empty history to version zero', () => {
    const fold = foldRevisionEvents([]);
    expect(fold).toMatchObject({ version: 0, deleted: false, latestSnapshot: null, chainIntact: true });
  });

  it('replays created and updated events into a version chain', () => {
    const fold = foldRevisionEvents([
      event('CREATED', 1, { snapshot: { reason: '初版' } }),
      event('UPDATED', 2, { snapshot: { reason: '第二版' } }),
      event('UPDATED', 3, { snapshot: { reason: '第三版' } })
    ]);
    expect(fold.version).toBe(3);
    expect(fold.deleted).toBe(false);
    expect(fold.latestSnapshot).toEqual({ reason: '第三版' });
    expect(fold.chainIntact).toBe(true);
  });

  it('tracks tombstones through delete and restore', () => {
    const deleted = foldRevisionEvents([event('CREATED', 1), event('DELETED', 2)]);
    expect(deleted.deleted).toBe(true);
    expect(deleted.version).toBe(2);

    const restored = foldRevisionEvents([event('CREATED', 1), event('DELETED', 2), event('RESTORED', 3)]);
    expect(restored.deleted).toBe(false);
    expect(restored.version).toBe(3);
  });

  it('treats legacy events without snapshots as first-class history', () => {
    // 存量事件没有 payload.snapshot，折叠结果必须仍然成立。
    const fold = foldRevisionEvents([event('CREATED', 1), event('UPDATED', 2), event('DELETED', 3)]);
    expect(fold).toMatchObject({ version: 3, deleted: true, latestSnapshot: null, chainIntact: true });
  });

  it('counts status changes and completions as revisions', () => {
    // 书目状态变化、完成感受的 COMPLETED 都会推进行版本，必须占版本槽。
    const fold = foldRevisionEvents([
      event('CREATED', 1),
      event('STATUS_CHANGED', 2),
      event('STATUS_CHANGED', 3),
      event('DELETED', 4)
    ]);
    expect(fold.version).toBe(4);
    expect(fold.deleted).toBe(true);
    expect(fold.chainIntact).toBe(true);
  });

  it('reports gaps when the chain is broken', () => {
    const fold = foldRevisionEvents([event('CREATED', 1), event('UPDATED', 3)]);
    expect(fold.chainIntact).toBe(false);
    expect(fold.gaps).toEqual([2]);
    expect(fold.version).toBe(3);
  });

  it('is deterministic regardless of input order', () => {
    const [created, updated, deleted] = [
      event('CREATED', 1, { at: '2026-09-26T08:00:00.000Z' }),
      event('UPDATED', 2, { at: '2026-09-26T09:00:00.000Z' }),
      event('DELETED', 3, { at: '2026-09-26T10:00:00.000Z' })
    ];
    const forward = foldRevisionEvents([created, updated, deleted]);
    const shuffled = foldRevisionEvents([deleted, created, updated]);
    expect(shuffled).toEqual(forward);
  });
});

describe('adjudicateMutation', () => {
  it('applies a versioned update on the head revision', () => {
    expect(adjudicateMutation({ version: 3, deleted: false }, 'UPDATE', 3)).toEqual({
      kind: 'APPLY',
      nextVersion: 4
    });
  });

  it('rejects a stale client version', () => {
    expect(adjudicateMutation({ version: 3, deleted: false }, 'UPDATE', 2)).toEqual({
      kind: 'REJECT',
      code: 'STALE_WRITE'
    });
    expect(adjudicateMutation({ version: 3, deleted: false }, 'DELETE', 1)).toEqual({
      kind: 'REJECT',
      code: 'STALE_WRITE'
    });
  });

  it('rejects updates and deletes on tombstoned entities', () => {
    // 核心回归：删除事件之后，任何更新/再次删除都不能覆盖墓碑。
    expect(adjudicateMutation({ version: 2, deleted: true }, 'UPDATE')).toEqual({
      kind: 'REJECT',
      code: 'ALREADY_DELETED'
    });
    expect(adjudicateMutation({ version: 2, deleted: true }, 'DELETE', 2)).toEqual({
      kind: 'REJECT',
      code: 'ALREADY_DELETED'
    });
  });

  it('rejects restore on live entities and allows it on tombstones', () => {
    expect(adjudicateMutation({ version: 1, deleted: false }, 'RESTORE')).toEqual({
      kind: 'REJECT',
      code: 'NOT_DELETED'
    });
    expect(adjudicateMutation({ version: 2, deleted: true }, 'RESTORE', 2)).toEqual({
      kind: 'APPLY',
      nextVersion: 3
    });
  });

  it('lets legacy clients without a version write at the head', () => {
    // 旧客户端省略版本：不再静默覆盖墓碑，但活跃实体上仍兼容放行。
    expect(adjudicateMutation({ version: 5, deleted: false }, 'UPDATE')).toEqual({
      kind: 'APPLY',
      nextVersion: 6
    });
    expect(adjudicateMutation({ version: 5, deleted: false }, 'DELETE')).toEqual({
      kind: 'APPLY',
      nextVersion: 6
    });
  });

  it('produces the same verdict when recomputed from the same fold', () => {
    const fold = { version: 4, deleted: false };
    const first = adjudicateMutation(fold, 'UPDATE', 3);
    const second = adjudicateMutation(fold, 'UPDATE', 3);
    expect(first).toEqual(second);
    expect(first).toEqual({ kind: 'REJECT', code: 'STALE_WRITE' });
  });
});

describe('revisionConflictError', () => {
  it('maps conflict codes to stable http semantics', () => {
    expect(revisionConflictError('STALE_WRITE')).toMatchObject({ statusCode: 409, code: 'STALE_WRITE' });
    expect(revisionConflictError('ALREADY_DELETED')).toMatchObject({ statusCode: 404, code: 'ALREADY_DELETED' });
    expect(revisionConflictError('NOT_DELETED')).toMatchObject({ statusCode: 404, code: 'NOT_DELETED' });
  });
});

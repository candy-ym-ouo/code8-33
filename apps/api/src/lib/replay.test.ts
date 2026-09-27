import { describe, expect, it } from 'vitest';
import { compareEvents, readEventMeta, replayEntityEvents, type ReplayEventLike } from './replay.js';

const T = '2026-09-24T10:00:00.000Z';

let counter = 0;
function eventId(): string {
  counter += 1;
  return `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
}

function makeEvent(overrides: Partial<ReplayEventLike> & { action: string }): ReplayEventLike {
  return {
    id: eventId(),
    entityType: 'DOG_EAR',
    entityId: '11111111-1111-4111-8111-111111111111',
    payloadJson: {},
    occurredAt: T,
    ...overrides
  };
}

describe('readEventMeta', () => {
  it('reads versioned metadata', () => {
    expect(readEventMeta({ baseRevision: 3, revision: 4, clientKind: 'VERSIONED', seq: 2 })).toEqual({
      baseRevision: 3,
      revision: 4,
      clientKind: 'VERSIONED',
      seq: 2,
      cascade: false
    });
  });

  it('treats legacy events without metadata as blind legacy writes', () => {
    const meta = readEventMeta({ pageNumber: 42 });
    expect(meta).toEqual({ baseRevision: null, revision: null, clientKind: 'LEGACY', seq: null, cascade: false });
  });

  it('recognises system cascade events', () => {
    const meta = readEventMeta({ cascade: true, clientKind: 'SYSTEM' });
    expect(meta.cascade).toBe(true);
    expect(meta.clientKind).toBe('SYSTEM');
  });
});

describe('replayEntityEvents', () => {
  it('replays a normal created -> updated -> deleted -> restored lifecycle', () => {
    const entityId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const events = [
      makeEvent({ entityId, action: 'CREATED', occurredAt: '2026-09-24T10:00:00.000Z', payloadJson: { revision: 1 } }),
      makeEvent({
        entityId,
        action: 'UPDATED',
        occurredAt: '2026-09-24T11:00:00.000Z',
        payloadJson: { baseRevision: 1, revision: 2, clientKind: 'VERSIONED' }
      }),
      makeEvent({
        entityId,
        action: 'DELETED',
        occurredAt: '2026-09-24T12:00:00.000Z',
        payloadJson: { baseRevision: 2, revision: 3, clientKind: 'VERSIONED' }
      }),
      makeEvent({
        entityId,
        action: 'RESTORED',
        occurredAt: '2026-09-24T13:00:00.000Z',
        payloadJson: { baseRevision: 3, revision: 4, clientKind: 'VERSIONED' }
      })
    ];

    const { entities, annotations } = replayEntityEvents(events);
    const fold = entities.get(entityId)!;
    expect(fold.revision).toBe(4);
    expect(fold.alive).toBe(true);
    expect(fold.currentEventId).toBe(events[3]!.id);
    expect(fold.conflicts).toEqual([]);
    expect(annotations.get(events[0]!.id)?.superseded).toBe(true);
    expect(annotations.get(events[3]!.id)?.current).toBe(true);
  });

  it('flags a write whose base revision is behind current state as stale', () => {
    const entityId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const created = makeEvent({
      entityId,
      action: 'CREATED',
      occurredAt: '2026-09-24T10:00:00.000Z',
      payloadJson: { revision: 1 }
    });
    const newer = makeEvent({
      entityId,
      action: 'UPDATED',
      occurredAt: '2026-09-24T11:00:00.000Z',
      payloadJson: { baseRevision: 1, revision: 2, clientKind: 'VERSIONED' }
    });
    // 旧端基于版本 1 并发提交，实际已是版本 2。
    const stale = makeEvent({
      entityId,
      action: 'UPDATED',
      occurredAt: '2026-09-24T12:00:00.000Z',
      payloadJson: { baseRevision: 1, revision: 2, clientKind: 'VERSIONED' }
    });

    const { entities, annotations } = replayEntityEvents([created, newer, stale]);
    const fold = entities.get(entityId)!;
    expect(fold.revision).toBe(2);
    expect(fold.currentEventId).toBe(newer.id);
    expect(fold.conflicts).toHaveLength(1);
    expect(fold.conflicts[0]?.eventId).toBe(stale.id);
    expect(fold.conflicts[0]?.reason).toBe('STALE_REVISION');
    expect(annotations.get(stale.id)?.conflict?.reason).toBe('STALE_REVISION');
  });

  it('marks legacy blind overwrites that followed newer edits', () => {
    const entityId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const events = [
      makeEvent({ entityId, action: 'CREATED', occurredAt: '2026-09-24T10:00:00.000Z' }),
      makeEvent({
        entityId,
        action: 'UPDATED',
        occurredAt: '2026-09-24T11:00:00.000Z',
        payloadJson: { baseRevision: 1, revision: 2, clientKind: 'VERSIONED' }
      }),
      // 旧客户端省略 version 的盲写，不阻断但要可复算地标记。
      makeEvent({ entityId, action: 'UPDATED', occurredAt: '2026-09-24T12:00:00.000Z' })
    ];

    const { entities } = replayEntityEvents(events);
    const fold = entities.get(entityId)!;
    expect(fold.revision).toBe(3);
    expect(fold.alive).toBe(true);
    expect(fold.conflicts.map((item) => item.reason)).toEqual(['BLIND_OVERWRITE']);
  });

  it('does not flag the first legacy edit after creation as an overwrite', () => {
    const entityId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const events = [
      makeEvent({ entityId, action: 'CREATED', occurredAt: '2026-09-24T10:00:00.000Z' }),
      makeEvent({ entityId, action: 'UPDATED', occurredAt: '2026-09-24T11:00:00.000Z' })
    ];

    const { entities } = replayEntityEvents(events);
    expect(entities.get(entityId)!.conflicts).toEqual([]);
  });

  it('flags legacy blind deletes after versioned edits but never flags system cascade deletes', () => {
    const entityId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

    // 纯旧端历史中的删除属于正常编辑，存量事件不应出现假阳性冲突。
    const legacyOnly = [
      makeEvent({ entityId, action: 'CREATED', occurredAt: '2026-09-24T10:00:00.000Z' }),
      makeEvent({ entityId, action: 'DELETED', occurredAt: '2026-09-24T11:00:00.000Z' })
    ];
    expect(replayEntityEvents(legacyOnly).entities.get(entityId)!.conflicts).toEqual([]);

    // 新端先改过，旧端随后不带 version 删除——可能抹掉新内容，必须标出。
    const blindAfterVersioned = [
      makeEvent({ entityId, action: 'CREATED', occurredAt: '2026-09-24T10:00:00.000Z' }),
      makeEvent({
        entityId,
        action: 'UPDATED',
        occurredAt: '2026-09-24T11:00:00.000Z',
        payloadJson: { baseRevision: 1, revision: 2, clientKind: 'VERSIONED' }
      }),
      makeEvent({ entityId, action: 'DELETED', occurredAt: '2026-09-24T12:00:00.000Z' })
    ];
    expect(replayEntityEvents(blindAfterVersioned).entities.get(entityId)!.conflicts.map((c) => c.reason)).toEqual([
      'BLIND_DELETE'
    ]);

    const cascade = [
      makeEvent({ entityId, action: 'CREATED', occurredAt: '2026-09-24T10:00:00.000Z' }),
      makeEvent({
        entityId,
        action: 'DELETED',
        occurredAt: '2026-09-24T11:00:00.000Z',
        payloadJson: { cascade: true, clientKind: 'SYSTEM', baseRevision: 1, revision: 2 }
      })
    ];
    expect(replayEntityEvents(cascade).entities.get(entityId)!.conflicts).toEqual([]);
  });

  it('flags duplicate restore against an already alive entity as lifecycle mismatch', () => {
    const entityId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const events = [
      makeEvent({ entityId, action: 'CREATED', occurredAt: '2026-09-24T10:00:00.000Z' }),
      makeEvent({
        entityId,
        action: 'DELETED',
        occurredAt: '2026-09-24T11:00:00.000Z',
        payloadJson: { baseRevision: 1, revision: 2, clientKind: 'VERSIONED' }
      }),
      makeEvent({
        entityId,
        action: 'RESTORED',
        occurredAt: '2026-09-24T12:00:00.000Z',
        payloadJson: { baseRevision: 2, revision: 3, clientKind: 'VERSIONED' }
      }),
      // 并发重复恢复（旧实现会无条件再写一条 RESTORED 并列事件）。
      makeEvent({
        entityId,
        action: 'RESTORED',
        occurredAt: '2026-09-24T12:00:01.000Z',
        payloadJson: { baseRevision: 2, revision: 3, clientKind: 'VERSIONED' }
      })
    ];

    const fold = replayEntityEvents(events).entities.get(entityId)!;
    expect(fold.alive).toBe(true);
    expect(fold.revision).toBe(3);
    expect(fold.conflicts.map((item) => item.reason)).toEqual(['LIFECYCLE_MISMATCH']);
  });

  it('treats stale deletes as not applied so the entity stays alive', () => {
    const entityId = '99999999-9999-4999-8999-999999999999';
    const events = [
      makeEvent({ entityId, action: 'CREATED', occurredAt: '2026-09-24T10:00:00.000Z' }),
      makeEvent({
        entityId,
        action: 'UPDATED',
        occurredAt: '2026-09-24T11:00:00.000Z',
        payloadJson: { baseRevision: 1, revision: 2, clientKind: 'VERSIONED' }
      }),
      makeEvent({
        entityId,
        action: 'DELETED',
        occurredAt: '2026-09-24T12:00:00.000Z',
        payloadJson: { baseRevision: 1, revision: 2, clientKind: 'VERSIONED' }
      })
    ];

    const fold = replayEntityEvents(events).entities.get(entityId)!;
    expect(fold.alive).toBe(true);
    expect(fold.revision).toBe(2);
    expect(fold.conflicts[0]?.reason).toBe('STALE_REVISION');
  });

  it('supports COMPLETED as the creation event for reflections', () => {
    const entityId = '88888888-8888-4888-8888-888888888888';
    const events = [
      makeEvent({
        entityId,
        entityType: 'COMPLETION_REFLECTION',
        action: 'COMPLETED',
        occurredAt: '2026-09-24T10:00:00.000Z',
        payloadJson: { revision: 1 }
      }),
      makeEvent({
        entityId,
        entityType: 'COMPLETION_REFLECTION',
        action: 'UPDATED',
        occurredAt: '2026-09-24T11:00:00.000Z',
        payloadJson: { baseRevision: 1, revision: 2, clientKind: 'VERSIONED' }
      })
    ];

    const fold = replayEntityEvents(events).entities.get(entityId)!;
    expect(fold.revision).toBe(2);
    expect(fold.alive).toBe(true);
    expect(fold.conflicts).toEqual([]);
  });
});

describe('deterministic ordering', () => {
  it('breaks same-instant ties with transaction seq, then event id', () => {
    const a = makeEvent({ id: 'bbbbbbbb-0000-4000-8000-000000000000', action: 'CREATED', occurredAt: T, payloadJson: { seq: 2 } });
    const b = makeEvent({ id: 'aaaaaaaa-0000-4000-8000-000000000000', action: 'DELETED', occurredAt: T, payloadJson: { seq: 1 } });
    const sorted = [a, b].sort((x, y) => compareEvents(x, y, (event) => readEventMeta(event.payloadJson)));
    expect(sorted.map((event) => event.id)).toEqual([b.id, a.id]);

    // 无 seq 的存量事件回退到 id 升序，结果仍然确定。
    const c = makeEvent({ id: 'cccccccc-0000-4000-8000-000000000000', action: 'DELETED', occurredAt: T });
    const d = makeEvent({ id: 'aaaaaaaa-0000-4000-8000-000000000001', action: 'RESTORED', occurredAt: T });
    const legacySorted = [c, d].sort((x, y) => compareEvents(x, y, (event) => readEventMeta(event.payloadJson)));
    expect(legacySorted.map((event) => event.id)).toEqual([d.id, c.id]);
  });

  it('produces the same replay result regardless of input order', () => {
    const entityId = '77777777-7777-4777-8777-777777777777';
    const events = [
      makeEvent({ entityId, action: 'DELETED', occurredAt: '2026-09-24T12:00:00.000Z' }),
      makeEvent({ entityId, action: 'UPDATED', occurredAt: '2026-09-24T11:00:00.000Z' }),
      makeEvent({ entityId, action: 'CREATED', occurredAt: '2026-09-24T10:00:00.000Z' })
    ];
    const first = replayEntityEvents(events);
    const second = replayEntityEvents([...events].reverse());
    expect([...first.entities.get(entityId)!.orderedEventIds]).toEqual([
      ...second.entities.get(entityId)!.orderedEventIds
    ]);
    expect(first.entities.get(entityId)!.currentEventId).toBe(second.entities.get(entityId)!.currentEventId);
  });

  it('folds each entity independently', () => {
    const other = '22222222-2222-4222-8222-222222222222';
    const events = [
      makeEvent({ action: 'CREATED', occurredAt: '2026-09-24T10:00:00.000Z' }),
      makeEvent({ entityId: other, action: 'CREATED', occurredAt: '2026-09-24T10:00:00.000Z' })
    ];
    const result = replayEntityEvents(events);
    expect(result.entities.size).toBe(2);
    expect(result.entities.get(other)?.revision).toBe(1);
  });
});

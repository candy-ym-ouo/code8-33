export const BOOK_STATUSES = ['TO_READ', 'READING', 'READ', 'PAUSED', 'ABANDONED'];
export const MOOD_TAGS = ['MOVED', 'CALM', 'JOYFUL', 'SAD', 'ANGRY', 'CONFUSED', 'RELIEVED', 'EMPTY', 'CHANGED'];
export const TRACE_TYPES = ['DOG_EAR', 'ANNOTATION', 'REREAD_MARK'];
export const ACTIVITY_ACTIONS = ['CREATED', 'UPDATED', 'DELETED', 'RESTORED', 'STATUS_CHANGED', 'COMPLETED'];
export const ACTIVITY_ENTITY_TYPES = ['BOOK', 'DOG_EAR', 'ANNOTATION', 'REREAD_MARK', 'COMPLETION_REFLECTION'];

// Revision metadata keys stored inside ActivityEvent.payload_json.
export const EVENT_META_KEYS = ['baseRevision', 'revision', 'clientKind', 'seq', 'cascade'];

export const CONFLICT_REASONS = [
  'STALE_REVISION',
  'BLIND_OVERWRITE',
  'BLIND_DELETE',
  'BLIND_RESTORE',
  'LIFECYCLE_MISMATCH',
  'UNKNOWN'
];

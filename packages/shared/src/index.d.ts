export type BookStatus = 'TO_READ' | 'READING' | 'READ' | 'PAUSED' | 'ABANDONED';
export type MoodTag = 'MOVED' | 'CALM' | 'JOYFUL' | 'SAD' | 'ANGRY' | 'CONFUSED' | 'RELIEVED' | 'EMPTY' | 'CHANGED';
export type TraceType = 'DOG_EAR' | 'ANNOTATION' | 'REREAD_MARK';
export type ActivityAction = 'CREATED' | 'UPDATED' | 'DELETED' | 'RESTORED' | 'STATUS_CHANGED' | 'COMPLETED';
export type ActivityEntityType = 'BOOK' | 'DOG_EAR' | 'ANNOTATION' | 'REREAD_MARK' | 'COMPLETION_REFLECTION';
export type ConflictReason =
  | 'STALE_REVISION'
  | 'BLIND_OVERWRITE'
  | 'BLIND_DELETE'
  | 'BLIND_RESTORE'
  | 'LIFECYCLE_MISMATCH'
  | 'UNKNOWN';
export type EventClientKind = 'VERSIONED' | 'LEGACY' | 'SYSTEM';
export declare const BOOK_STATUSES: BookStatus[];
export declare const MOOD_TAGS: MoodTag[];
export declare const TRACE_TYPES: TraceType[];
export declare const ACTIVITY_ACTIONS: ActivityAction[];
export declare const ACTIVITY_ENTITY_TYPES: ActivityEntityType[];
export declare const EVENT_META_KEYS: string[];
export declare const CONFLICT_REASONS: ConflictReason[];

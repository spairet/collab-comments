export interface StoredPosition {
  line: number;
  character: number;
}

export interface StoredRange {
  start: StoredPosition;
  end: StoredPosition;
}

export interface CommentReplyData {
  id: string;
  author: string;
  timestamp: string;
  text: string;
}

export interface TrackedTextChangeData {
  id: string;
  author: string;
  timestamp: string;
  previousText: string;
  newText: string;
}

export interface CommentData {
  id: string;
  author: string;
  timestamp: string;
  text: string;
  filePath: string;
  range: StoredRange;
  selectedText?: string;
  contextBefore?: string;
  contextAfter?: string;
  documentHash?: string;
  replies?: CommentReplyData[];
  trackedChanges?: TrackedTextChangeData[];
  resolved?: boolean;
}

export interface CommentStore {
  comments: CommentData[];
}

export function collapseTrackedChanges(
  changes: TrackedTextChangeData[]
): TrackedTextChangeData[] {
  if (changes.length < 2) {
    return [...changes];
  }

  const ordered = [...changes].sort((left, right) =>
    left.timestamp.localeCompare(right.timestamp)
  );
  const oldest = ordered[0];
  const newest = ordered[ordered.length - 1];
  if (oldest.previousText === newest.newText) {
    return [];
  }

  const authors = [...new Set(ordered.map(change => change.author))];
  return [{
    ...oldest,
    author: authors.join(', '),
    newText: newest.newText
  }];
}

function trackedChangeSegment(timestamp: string, replyTimestamps: string[]): number {
  let segment = 0;
  for (const replyTimestamp of replyTimestamps) {
    if (replyTimestamp.localeCompare(timestamp) <= 0) {
      segment++;
    }
  }
  return segment;
}

export function hasMergeableTrackedChanges(
  changes: TrackedTextChangeData[],
  replyTimestamps: string[]
): boolean {
  const orderedReplies = [...replyTimestamps].sort();
  const counts = new Map<number, number>();
  for (const change of changes) {
    const segment = trackedChangeSegment(change.timestamp, orderedReplies);
    const count = (counts.get(segment) ?? 0) + 1;
    if (count > 1) {
      return true;
    }
    counts.set(segment, count);
  }
  return false;
}

export function collapseTrackedChangesBetweenReplies(
  changes: TrackedTextChangeData[],
  replyTimestamps: string[]
): TrackedTextChangeData[] {
  const orderedReplies = [...replyTimestamps].sort();
  const segments = new Map<number, TrackedTextChangeData[]>();
  for (const change of changes) {
    const segment = trackedChangeSegment(change.timestamp, orderedReplies);
    segments.set(segment, [...(segments.get(segment) ?? []), change]);
  }
  return [...segments.values()]
    .flatMap(collapseTrackedChanges)
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isPosition(value: unknown): value is StoredPosition {
  return isRecord(value)
    && Number.isInteger(value.line)
    && (value.line as number) >= 0
    && Number.isInteger(value.character)
    && (value.character as number) >= 0;
}

function isReply(value: unknown): value is CommentReplyData {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.author === 'string'
    && typeof value.timestamp === 'string'
    && typeof value.text === 'string';
}

function isTrackedChange(value: unknown): value is TrackedTextChangeData {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.author === 'string'
    && typeof value.timestamp === 'string'
    && typeof value.previousText === 'string'
    && typeof value.newText === 'string';
}

function isComment(value: unknown): value is CommentData {
  if (!isRecord(value)
    || typeof value.id !== 'string'
    || typeof value.author !== 'string'
    || typeof value.timestamp !== 'string'
    || typeof value.text !== 'string'
    || typeof value.filePath !== 'string'
    || !isRecord(value.range)
    || !isPosition(value.range.start)
    || !isPosition(value.range.end)) {
    return false;
  }

  if (value.selectedText !== undefined && typeof value.selectedText !== 'string') {
    return false;
  }
  if (value.contextBefore !== undefined && typeof value.contextBefore !== 'string') {
    return false;
  }
  if (value.contextAfter !== undefined && typeof value.contextAfter !== 'string') {
    return false;
  }
  if (value.documentHash !== undefined && typeof value.documentHash !== 'string') {
    return false;
  }
  if (value.resolved !== undefined && typeof value.resolved !== 'boolean') {
    return false;
  }
  if (value.replies !== undefined
    && (!Array.isArray(value.replies) || !value.replies.every(isReply))) {
    return false;
  }
  return value.trackedChanges === undefined
    || (Array.isArray(value.trackedChanges) && value.trackedChanges.every(isTrackedChange));
}

export function parseCommentStore(raw: string): CommentStore {
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value)
    || !Array.isArray(value.comments)
    || !value.comments.every(isComment)) {
    throw new Error('Expected an object containing a valid "comments" array.');
  }

  const store = value as unknown as CommentStore;
  const ids = new Set<string>();
  for (const comment of store.comments) {
    if (ids.has(comment.id)) {
      throw new Error(`Duplicate comment id "${comment.id}".`);
    }
    ids.add(comment.id);
    comment.filePath = comment.filePath.replace(/\\/g, '/');
  }
  return store;
}

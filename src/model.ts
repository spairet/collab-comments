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
  replies: CommentReplyData[];
  trackedChanges: TrackedTextChangeData[];
  resolved: boolean;
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

function trackedChangeGroups(
  changes: TrackedTextChangeData[],
  replyTimestamps: string[]
): TrackedTextChangeData[][] {
  const orderedChanges = [...changes].sort((left, right) =>
    left.timestamp.localeCompare(right.timestamp)
  );
  const orderedReplies = [...replyTimestamps].sort();
  const groups: TrackedTextChangeData[][] = [];
  let group: TrackedTextChangeData[] = [];
  let replyIndex = 0;

  for (const change of orderedChanges) {
    while (replyIndex < orderedReplies.length
      && orderedReplies[replyIndex].localeCompare(change.timestamp) <= 0) {
      if (group.length > 0) {
        groups.push(group);
        group = [];
      }
      replyIndex++;
    }
    group.push(change);
  }
  if (group.length > 0) {
    groups.push(group);
  }
  return groups;
}

export function hasMergeableTrackedChanges(
  changes: TrackedTextChangeData[],
  replyTimestamps: string[]
): boolean {
  return trackedChangeGroups(changes, replyTimestamps)
    .some(group => group.length > 1);
}

export function collapseTrackedChangesBetweenReplies(
  changes: TrackedTextChangeData[],
  replyTimestamps: string[]
): TrackedTextChangeData[] {
  return trackedChangeGroups(changes, replyTimestamps)
    .flatMap(collapseTrackedChanges);
}

type LegacyCommentData = Omit<CommentData, 'replies' | 'trackedChanges' | 'resolved'>
  & Partial<Pick<CommentData, 'replies' | 'trackedChanges' | 'resolved'>>;

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

function isComment(value: unknown): value is LegacyCommentData {
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

  const ids = new Set<string>();
  const comments = value.comments.map(comment => {
    if (ids.has(comment.id)) {
      throw new Error(`Duplicate comment id "${comment.id}".`);
    }
    ids.add(comment.id);
    return {
      ...comment,
      filePath: comment.filePath.replace(/\\/g, '/'),
      replies: comment.replies ?? [],
      trackedChanges: comment.trackedChanges ?? [],
      resolved: comment.resolved ?? false
    };
  });
  return { comments };
}

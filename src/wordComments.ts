import { createHash } from 'crypto';
import { randomUUID } from 'crypto';
import { CommentData, CommentStore } from './model';
import { MappedSelection, mapRenderedSelection } from './quartoMapping';

/** Limits applied before untrusted DOCX/Pandoc content reaches the store. */
export const MAX_DOCX_BYTES = 50 * 1024 * 1024;
export const MAX_PANDOC_JSON_BYTES = 20 * 1024 * 1024;
export const MAX_WORD_COMMENTS = 500;
export const MAX_WORD_COMMENT_BODY_LENGTH = 32_000;
export const MAX_WORD_SELECTION_LENGTH = 32_000;
export const WORD_CONTEXT_LENGTH = 120;
export const MAX_PANDOC_BLOCK_NODES = 100_000;
export const MAX_PANDOC_INLINE_DEPTH = 100;

export interface WordComment {
  wordId: string;
  author: string;
  timestamp: string;
  /** False only when the source omitted or supplied an invalid Word timestamp. */
  timestampReliable?: boolean;
  text: string;
  selectedText: string;
  contextBefore: string;
  contextAfter: string;
}

export type WordImportCandidate =
  | { kind: 'new'; wordComment: WordComment; comment: CommentData }
  | { kind: 'unchanged'; wordComment: WordComment; existingId: string }
  | { kind: 'changed'; wordComment: WordComment; existingId: string; replyText: string; replyAuthor: string; replyTimestamp: string }
  | { kind: 'ambiguous'; wordComment: WordComment; reason: string }
  | { kind: 'conflict'; wordComment: WordComment; reason: string }
  | { kind: 'invalid'; wordId?: string; reason: string };

export interface WordExtraction {
  comments: WordComment[];
  invalid: Array<{ wordId?: string; reason: string }>;
}

/** Pandoc DOCX output represents a horizontal whitespace run as one Space inline. */
export function canonicalWordText(value: string): string {
  return value.replace(/[ \t]+/g, ' ').replace(/\r\n?/g, '\n');
}

interface Marker {
  id: string;
  author: string;
  timestamp: string;
  timestampReliable: boolean;
  text: string;
}

interface OpenComment extends Marker {
  start: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function plain(value: unknown): string | undefined {
  return typeof value === 'string' && !value.includes('\0') ? value.replace(/\r\n?/g, '\n') : undefined;
}

function attribute(value: unknown): { classes: string[]; values: Map<string, string> } | undefined {
  if (!Array.isArray(value) || value.length !== 3 || !Array.isArray(value[1]) || !Array.isArray(value[2])) {
    return undefined;
  }
  if (!value[1].every(item => typeof item === 'string')
    || !value[2].every(item => Array.isArray(item) && item.length === 2
      && typeof item[0] === 'string' && typeof item[1] === 'string')) {
    return undefined;
  }
  return { classes: value[1] as string[], values: new Map(value[2] as Array<[string, string]>) };
}

function normaliseAuthor(value: unknown): string {
  const author = plain(value)?.trim();
  return author && author.length <= 256 ? author : 'Word reviewer';
}

function normaliseTimestamp(value: unknown, fallback: string): string {
  const source = plain(value)?.trim();
  if (!source || source.length > 128) {
    return fallback;
  }
  const time = Date.parse(source);
  return Number.isNaN(time) ? fallback : new Date(time).toISOString();
}

function wordTimestamp(value: unknown, fallback: string): { timestamp: string; reliable: boolean } {
  const source = plain(value)?.trim();
  if (!source || source.length > 128) {
    return { timestamp: fallback, reliable: false };
  }
  const time = Date.parse(source);
  return Number.isNaN(time)
    ? { timestamp: fallback, reliable: false }
    : { timestamp: new Date(time).toISOString(), reliable: true };
}

function inlineText(inlines: unknown, depth = 0): string | undefined {
  if (depth > MAX_PANDOC_INLINE_DEPTH) {
    return undefined;
  }
  if (!Array.isArray(inlines)) {
    return undefined;
  }
  let result = '';
  for (const inline of inlines) {
    const text = inlineToText(inline, depth + 1);
    if (text === undefined) {
      return undefined;
    }
    result += text;
  }
  return result;
}

function inlineToText(value: unknown, depth = 0): string | undefined {
  if (depth > MAX_PANDOC_INLINE_DEPTH) {
    return undefined;
  }
  if (!isRecord(value) || typeof value.t !== 'string') {
    return undefined;
  }
  if (value.t === 'Str') {return plain(value.c);}
  if (value.t === 'Space') {return ' ';}
  if (value.t === 'SoftBreak' || value.t === 'LineBreak') {return '\n';}
  if (value.t === 'Code' || value.t === 'Math') {
    return Array.isArray(value.c) ? plain(value.c[1]) : undefined;
  }
  if (value.t === 'Emph' || value.t === 'Strong' || value.t === 'Underline'
    || value.t === 'Strikeout' || value.t === 'SmallCaps' || value.t === 'Quoted'
    || value.t === 'Cite' || value.t === 'Span') {
    const content = value.t === 'Quoted' ? (Array.isArray(value.c) ? value.c[1] : undefined)
      : value.t === 'Cite' ? (Array.isArray(value.c) ? value.c[1] : undefined)
        : value.t === 'Span' ? (Array.isArray(value.c) ? value.c[1] : undefined) : value.c;
    return inlineText(content, depth + 1);
  }
  if (value.t === 'Link' || value.t === 'Image') {
    return Array.isArray(value.c) ? inlineText(value.c[1], depth + 1) : undefined;
  }
  if (value.t === 'Note') {return '';}
  return undefined;
}

function marker(value: unknown, fallback: string): Marker | undefined {
  if (!isRecord(value) || value.t !== 'Span' || !Array.isArray(value.c) || value.c.length !== 2) {
    return undefined;
  }
  const attrs = attribute(value.c[0]);
  if (!attrs || !attrs.classes.includes('comment-start')) {
    return undefined;
  }
  const id = attrs.values.get('id');
  const text = inlineText(value.c[1]);
  if (!id || !/^\d+$/.test(id) || text === undefined || text.length > MAX_WORD_COMMENT_BODY_LENGTH) {
    return undefined;
  }
  const timestamp = wordTimestamp(attrs.values.get('date'), fallback);
  return {
    id,
    author: normaliseAuthor(attrs.values.get('author')),
    timestamp: timestamp.timestamp,
    timestampReliable: timestamp.reliable,
    text
  };
}

function endMarker(value: unknown): string | undefined {
  if (!isRecord(value) || value.t !== 'Span' || !Array.isArray(value.c) || value.c.length !== 2) {
    return undefined;
  }
  const attrs = attribute(value.c[0]);
  if (!attrs || !attrs.classes.includes('comment-end')) {
    return undefined;
  }
  const id = attrs.values.get('id');
  return id && /^\d+$/.test(id) ? id : undefined;
}

function containsCommentMarker(value: unknown): 'found' | 'absent' | 'limit' {
  const stack: unknown[] = [value];
  let visited = 0;
  while (stack.length > 0) {
    if (++visited > MAX_PANDOC_BLOCK_NODES) {
      return 'limit';
    }
    const current = stack.pop();
    if (Array.isArray(current)) {
      for (const item of current) {
        if (visited + stack.length >= MAX_PANDOC_BLOCK_NODES) {
          return 'limit';
        }
        stack.push(item);
      }
      continue;
    }
    if (!isRecord(current)) {
      continue;
    }
    if (current.t === 'Span' && Array.isArray(current.c)) {
      const attrs = attribute(current.c[0]);
      if (attrs && (attrs.classes.includes('comment-start') || attrs.classes.includes('comment-end'))) {
        return 'found';
      }
    }
    for (const key in current) {
      if (!Object.prototype.hasOwnProperty.call(current, key)) {
        continue;
      }
      if (visited + stack.length >= MAX_PANDOC_BLOCK_NODES) {
        return 'limit';
      }
      stack.push(current[key]);
    }
  }
  return 'absent';
}

/**
 * Markers are only supported as direct members of a Pandoc inline list. A
 * marker wrapped by formatting (or another inline container) cannot safely be
 * paired without changing the rendered selection, so reject it rather than
 * flattening it into document text.
 */
function containsNestedCommentMarker(value: unknown): 'found' | 'absent' | 'limit' {
  if (!isRecord(value)) {
    return 'absent';
  }
  return containsCommentMarker(value.c);
}

interface BlockCollection {
  inlines: unknown[][];
  invalid: string[];
}

function pushBlocks(stack: unknown[], blocks: unknown): boolean {
  if (!Array.isArray(blocks)) {
    return false;
  }
  for (let index = blocks.length - 1; index >= 0; index--) {
    stack.push(blocks[index]);
  }
  return true;
}

function collectBlockInlines(blocks: unknown): BlockCollection | undefined {
  if (!Array.isArray(blocks)) {
    return undefined;
  }
  const stack: unknown[] = [];
  pushBlocks(stack, blocks);
  const result: BlockCollection = { inlines: [], invalid: [] };
  let visited = 0;
  while (stack.length > 0) {
    if (++visited > MAX_PANDOC_BLOCK_NODES) {
      return { inlines: [], invalid: [`Pandoc block traversal exceeds ${MAX_PANDOC_BLOCK_NODES} nodes`] };
    }
    const block = stack.pop();
    if (!isRecord(block) || typeof block.t !== 'string') {
      return undefined;
    }
    if (block.t === 'Para' || block.t === 'Plain') {
      if (!Array.isArray(block.c)) {
        return undefined;
      }
      result.inlines.push(block.c);
      continue;
    }
    if (block.t === 'Header') {
      if (!Array.isArray(block.c) || !Array.isArray(block.c[2])) {
        return undefined;
      }
      result.inlines.push(block.c[2]);
      continue;
    }
    if (block.t === 'BlockQuote') {
      if (!pushBlocks(stack, block.c)) {
        return undefined;
      }
      continue;
    }
    if (block.t === 'Div') {
      if (!Array.isArray(block.c) || !pushBlocks(stack, block.c[1])) {
        return undefined;
      }
      continue;
    }
    if (block.t === 'BulletList') {
      if (!Array.isArray(block.c)) {
        return undefined;
      }
      for (let index = block.c.length - 1; index >= 0; index--) {
        if (!pushBlocks(stack, block.c[index])) {
          return undefined;
        }
      }
      continue;
    }
    if (block.t === 'OrderedList') {
      if (!Array.isArray(block.c) || !Array.isArray(block.c[1])) {
        return undefined;
      }
      for (let index = block.c[1].length - 1; index >= 0; index--) {
        if (!pushBlocks(stack, block.c[1][index])) {
          return undefined;
        }
      }
      continue;
    }
    const marker = containsCommentMarker(block);
    if (marker === 'limit') {
      result.invalid.push(`Pandoc ${block.t} traversal exceeds ${MAX_PANDOC_BLOCK_NODES} nodes`);
    } else if (marker === 'found') {
      result.invalid.push(`comment marker appears in unsupported ${block.t} block`);
    }
  }
  return result;
}

function walkInlines(
  inlines: unknown[],
  fallback: string,
  comments: WordComment[],
  invalid: Array<{ wordId?: string; reason: string }>,
  seenIds: Set<string>
): void {
  let text = '';
  let open: OpenComment | undefined;
  const completed: Array<{ comment: WordComment; end: number }> = [];
  const blockIds = new Set<string>();
  let invalidStructure = false;
  for (const inline of inlines) {
    const nestedMarker = containsNestedCommentMarker(inline);
    if (nestedMarker === 'limit') {
      invalid.push({ reason: `Pandoc inline traversal exceeds ${MAX_PANDOC_BLOCK_NODES} nodes` });
      invalidStructure = true;
      continue;
    }
    if (nestedMarker === 'found') {
      invalid.push({ reason: 'comment marker is nested inside an unsupported inline structure' });
      invalidStructure = true;
      continue;
    }
    const start = marker(inline, fallback);
    const end = endMarker(inline);
    const spanAttrs = isRecord(inline) && inline.t === 'Span' && Array.isArray(inline.c)
      ? attribute(inline.c[0]) : undefined;
    if (spanAttrs && (spanAttrs.classes.includes('comment-start') || spanAttrs.classes.includes('comment-end'))
      && !start && !end) {
      invalid.push({ reason: 'malformed comment marker' });
      invalidStructure = true;
      continue;
    }
    if (start) {
      if (open || seenIds.has(start.id) || blockIds.has(start.id)) {
        invalid.push({ wordId: start.id, reason: 'duplicate or nested comment marker' });
        invalidStructure = true;
      } else {
        open = { ...start, start: text.length };
        blockIds.add(start.id);
      }
      continue;
    }
    if (end) {
      if (!open || open.id !== end) {
        invalid.push({ wordId: end, reason: 'unmatched comment end marker' });
        invalidStructure = true;
      } else {
        const selectedText = text.slice(open.start);
        if (!selectedText || selectedText.length > MAX_WORD_SELECTION_LENGTH) {
          invalid.push({ wordId: open.id, reason: 'empty or overlong commented selection' });
          invalidStructure = true;
        } else {
          const comment: WordComment = {
            wordId: open.id,
            author: open.author,
            timestamp: open.timestamp,
            text: open.text,
            selectedText,
            contextBefore: text.slice(Math.max(0, open.start - WORD_CONTEXT_LENGTH), open.start),
            contextAfter: ''
          };
          if (!open.timestampReliable) {
            comment.timestampReliable = false;
          }
          completed.push({ comment, end: text.length });
        }
        open = undefined;
      }
      continue;
    }
    const value = inlineToText(inline);
    if (value === undefined) {
      if (open) {
        invalid.push({ wordId: open.id, reason: 'unsupported inline structure in selection' });
        invalidStructure = true;
      }
      continue;
    }
    text += value;
  }
  if (open) {
    invalid.push({ wordId: open.id, reason: 'unmatched comment start marker' });
    invalidStructure = true;
  }
  // Complete after-context only once the full block is known. Keep the exact
  // marker offset rather than searching repeated selected text again.
  for (const completedComment of completed) {
    completedComment.comment.contextAfter = text.slice(
      completedComment.end,
      completedComment.end + WORD_CONTEXT_LENGTH
    );
  }
  if (!invalidStructure) {
    for (const completedComment of completed) {
      comments.push(completedComment.comment);
      seenIds.add(completedComment.comment.wordId);
    }
  }
}

/** Extract only Pandoc's portable, top-level comment representation. */
export function extractWordComments(document: unknown, importTime = new Date().toISOString()): WordExtraction {
  if (!isRecord(document) || document['pandoc-api-version'] === undefined || !Array.isArray(document.blocks)) {
    return { comments: [], invalid: [{ reason: 'invalid Pandoc JSON document' }] };
  }
  const blocks = collectBlockInlines(document.blocks);
  if (!blocks) {return { comments: [], invalid: [{ reason: 'invalid Pandoc block structure' }] };}
  const comments: WordComment[] = [];
  const seenIds = new Set<string>();
  const invalid: Array<{ wordId?: string; reason: string }> = blocks.invalid.map(reason => ({ reason }));
  for (const inlines of blocks.inlines) {
    walkInlines(inlines, importTime, comments, invalid, seenIds);
    if (comments.length > MAX_WORD_COMMENTS) {
      return { comments: [], invalid: [{ reason: `more than ${MAX_WORD_COMMENTS} Word comments` }] };
    }
  }
  const invalidIds = new Set(invalid.flatMap(item => item.wordId ? [item.wordId] : []));
  return { comments: comments.filter(comment => !invalidIds.has(comment.wordId)), invalid };
}

/** 31-bit FNV-1a over UTF-8, shared with the Quarto Lua filter. */
function fnv1a31(value: string): string {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(value, 'utf8')) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const id = hash & 0x7fffffff;
  return String(id === 0 ? 1 : id);
}

/** Legacy 31-bit FNV-1a local-ID mapping retained for pre-provenance DOCX files. */
export function stableWordId(localId: string): string {
  return fnv1a31(localId);
}

/**
 * The DOCX export ID binds a local thread to the exact flattened body emitted
 * for that export. Keep this byte-for-byte algorithm in lockstep with Lua.
 */
export function wordIdForTranscript(localId: string, transcript: string): string {
  return fnv1a31(`${localId}\0${transcript}`);
}

export function wordIdCollisions(comments: CommentData[]): Map<string, CommentData[]> {
  const grouped = new Map<string, CommentData[]>();
  for (const comment of comments) {
    const id = stableWordId(comment.id);
    grouped.set(id, [...(grouped.get(id) ?? []), comment]);
  }
  return new Map([...grouped].filter(([, values]) => values.length > 1));
}

interface TranscriptEntry {
  timestamp: string;
  kind: string;
  author: string;
  text: string;
}

function transcriptEntries(comment: CommentData): TranscriptEntry[] {
  const opening: TranscriptEntry = {
    timestamp: comment.timestamp, kind: 'Opening comment', author: comment.author, text: comment.text
  };
  const activity: Array<TranscriptEntry & { kindRank: number; sequence: number }> = [];
  for (let index = 0; index < comment.replies.length; index++) {
    const reply = comment.replies[index];
    activity.push({ timestamp: reply.timestamp, kind: 'Reply', author: reply.author, text: reply.text,
      kindRank: 0, sequence: index });
  }
  for (let index = 0; index < comment.trackedChanges.length; index++) {
    const change = comment.trackedChanges[index];
    activity.push({ timestamp: change.timestamp, kind: 'Tracked change', author: change.author,
      text: `Previous: ${change.previousText}\nCurrent: ${change.newText}`, kindRank: 1, sequence: index });
  }
  activity.sort((left, right) => Buffer.compare(
    Buffer.from(left.timestamp, 'utf8'), Buffer.from(right.timestamp, 'utf8')
  ) || left.kindRank - right.kindRank || left.sequence - right.sequence);
  const entries: TranscriptEntry[] = [opening];
  for (const entry of activity) {
    entries.push(entry);
  }
  return entries;
}

function flattenTranscript(entries: TranscriptEntry[]): string {
  return entries.map((entry, index) => index === 0
    ? entry.text
    : `—— ${entry.kind} · ${entry.author} · ${entry.timestamp} ——\n${entry.text}`).join('\n\n');
}

export function formatWordTranscript(comment: CommentData): string {
  const body = flattenTranscript(transcriptEntries(comment));
  return comment.resolved ? `Resolved\n\n${body}` : body;
}

interface TranscriptSnapshot {
  wordId: string;
  body: string;
}

function transcriptSnapshots(comment: CommentData): TranscriptSnapshot[] {
  const snapshots: TranscriptSnapshot[] = [];
  const entries = transcriptEntries(comment);
  let body = '';
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    body += index === 0 ? entry.text : `\n\n—— ${entry.kind} · ${entry.author} · ${entry.timestamp} ——\n${entry.text}`;
    snapshots.push({ wordId: wordIdForTranscript(comment.id, body), body });
    if (comment.resolved) {
      const resolvedBody = `Resolved\n\n${body}`;
      snapshots.push({ wordId: wordIdForTranscript(comment.id, resolvedBody), body: resolvedBody });
    }
  }
  return snapshots;
}

function matchingSuffix(left: string, right: string): boolean {
  const length = Math.min(left.length, right.length);
  if (length === 0) {
    return true;
  }
  return left.slice(-length) === right.slice(-length);
}

function matchingPrefix(left: string, right: string): boolean {
  const length = Math.min(left.length, right.length);
  if (length === 0) {
    return true;
  }
  return left.slice(0, length) === right.slice(0, length);
}

function sameRange(left: CommentData['range'], right: MappedSelection['range']): boolean {
  return left.start.line === right.start.line
    && left.start.character === right.start.character
    && left.end.line === right.end.line
    && left.end.character === right.end.character;
}

function anchorEvidenceMatches(word: WordComment, mapped: MappedSelection, comment: CommentData): boolean {
  if (!sameRange(comment.range, mapped.range) || word.selectedText !== (comment.selectedText ?? '')) {
    return false;
  }
  return (comment.contextBefore === undefined || matchingSuffix(comment.contextBefore, mapped.contextBefore))
    && (comment.contextAfter === undefined || matchingPrefix(comment.contextAfter, mapped.contextAfter));
}

function sameText(left: string, right: string): boolean {
  return canonicalWordText(left) === canonicalWordText(right);
}

function timestampMatches(word: WordComment, comment: CommentData): boolean {
  return word.timestampReliable !== false
    && word.timestamp === normaliseTimestamp(comment.timestamp, '');
}

function currentTranscriptMatches(word: WordComment, comment: CommentData): boolean {
  return sameText(word.text, formatWordTranscript(comment));
}

function semanticIdentityMatches(word: WordComment, mapped: MappedSelection, comment: CommentData): boolean {
  return anchorEvidenceMatches(word, mapped, comment)
    && word.author === comment.author
    && (timestampMatches(word, comment) || currentTranscriptMatches(word, comment));
}

function importedReplyAlreadyExists(comment: CommentData, word: WordComment): boolean {
  const author = `Word import: ${word.author}`;
  return comment.replies.some(reply => reply.author === author
    && sameText(reply.text, word.text));
}

function validTimestampMilliseconds(timestamp: string): number | undefined {
  const milliseconds = Date.parse(timestamp);
  return Number.isNaN(milliseconds) ? undefined : milliseconds;
}

/**
 * Returns a representable timestamp at least as recent as proposed and strictly
 * after every valid timestamp already present in the thread.
 */
export function appendSafeThreadTimestamp(comment: CommentData, proposed: string): string | undefined {
  const proposedMilliseconds = validTimestampMilliseconds(proposed);
  if (proposedMilliseconds === undefined) {
    return undefined;
  }
  let latest = validTimestampMilliseconds(comment.timestamp);
  for (const reply of comment.replies) {
    const timestamp = validTimestampMilliseconds(reply.timestamp);
    if (timestamp !== undefined && (latest === undefined || timestamp > latest)) {
      latest = timestamp;
    }
  }
  for (const change of comment.trackedChanges) {
    const timestamp = validTimestampMilliseconds(change.timestamp);
    if (timestamp !== undefined && (latest === undefined || timestamp > latest)) {
      latest = timestamp;
    }
  }
  const minimum = latest === undefined ? proposedMilliseconds : latest + 1;
  const result = Math.max(proposedMilliseconds, minimum);
  if (!Number.isFinite(result)) {
    return undefined;
  }
  const date = new Date(result);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

interface ProvenanceRecord {
  comment: CommentData;
  body: string;
}

interface KnownIdentityMatch {
  comment: CommentData;
  provenanceBodies: string[];
  legacy: boolean;
}

function provenanceIndex(comments: CommentData[]): Map<string, ProvenanceRecord[]> {
  const indexed = new Map<string, ProvenanceRecord[]>();
  for (const comment of comments) {
    for (const snapshot of transcriptSnapshots(comment)) {
      const records = indexed.get(snapshot.wordId);
      const record = { comment, body: snapshot.body };
      if (records) {
        records.push(record);
      } else {
        indexed.set(snapshot.wordId, [record]);
      }
    }
  }
  return indexed;
}

function knownIdentityMatches(
  wordId: string,
  comments: CommentData[],
  provenance: Map<string, ProvenanceRecord[]>
): KnownIdentityMatch[] {
  const matches = new Map<CommentData, KnownIdentityMatch>();
  for (const record of provenance.get(wordId) ?? []) {
    const existing = matches.get(record.comment);
    if (existing) {
      existing.provenanceBodies.push(record.body);
    } else {
      matches.set(record.comment, { comment: record.comment, provenanceBodies: [record.body], legacy: false });
    }
  }
  for (const comment of comments) {
    if (stableWordId(comment.id) !== wordId) {
      continue;
    }
    const existing = matches.get(comment);
    if (existing) {
      existing.legacy = true;
    } else {
      matches.set(comment, { comment, provenanceBodies: [], legacy: true });
    }
  }
  return Array.from(matches.values());
}

export function prepareWordImport(
  extracted: WordExtraction,
  source: string,
  filePath: string,
  store: CommentStore,
  importTimestamp = new Date().toISOString()
): WordImportCandidate[] {
  const result: WordImportCandidate[] = extracted.invalid.map(item => ({ kind: 'invalid', ...item }));
  const relevant = store.comments.filter(comment => comment.filePath === filePath);
  const provenance = provenanceIndex(relevant);
  for (const wordComment of extracted.comments) {
    const mapped = mapRenderedSelection(source, {
      text: wordComment.selectedText,
      before: wordComment.contextBefore,
      after: wordComment.contextAfter
    });
    if (!mapped) {
      result.push({ kind: 'ambiguous', wordComment, reason: 'selection cannot be mapped uniquely to saved QMD text' });
      continue;
    }
    const known = knownIdentityMatches(wordComment.wordId, relevant, provenance);
    if (known.length > 1) {
      result.push({ kind: 'conflict', wordComment, reason: 'Word ID collides with multiple local threads' });
      continue;
    }
    if (known.length === 1) {
      const match = known[0];
      const existing = match.comment;
      const exactProvenanceBody = match.provenanceBodies.some(body => sameText(wordComment.text, body));
      const exactLegacyBody = match.legacy && currentTranscriptMatches(wordComment, existing);
      const compatible = anchorEvidenceMatches(wordComment, mapped, existing)
        && wordComment.author === existing.author
        && (timestampMatches(wordComment, existing) || exactProvenanceBody || exactLegacyBody);
      if (!compatible) {
        result.push({ kind: 'conflict', wordComment, reason: 'Word ID was reused with incompatible author, timestamp, or selection evidence' });
      } else if (exactProvenanceBody || exactLegacyBody || importedReplyAlreadyExists(existing, wordComment)) {
        result.push({ kind: 'unchanged', wordComment, existingId: existing.id });
      } else {
        const replyTimestamp = appendSafeThreadTimestamp(existing, importTimestamp);
        if (replyTimestamp === undefined) {
          result.push({ kind: 'conflict', wordComment, reason: 'no safe timestamp is available after existing thread activity' });
        } else {
          result.push({ kind: 'changed', wordComment, existingId: existing.id, replyText: wordComment.text,
            replyAuthor: `Word import: ${wordComment.author}`, replyTimestamp });
        }
      }
      continue;
    }
    const semantic = relevant.filter(comment => semanticIdentityMatches(wordComment, mapped, comment));
    if (semantic.length === 1) {
      const existing = semantic[0];
      if (currentTranscriptMatches(wordComment, existing) || importedReplyAlreadyExists(existing, wordComment)) {
        result.push({ kind: 'unchanged', wordComment, existingId: existing.id });
      } else {
        const replyTimestamp = appendSafeThreadTimestamp(existing, importTimestamp);
        if (replyTimestamp === undefined) {
          result.push({ kind: 'conflict', wordComment, reason: 'no safe timestamp is available after existing thread activity' });
        } else {
          result.push({ kind: 'changed', wordComment, existingId: existing.id, replyText: wordComment.text,
            replyAuthor: `Word import: ${wordComment.author}`, replyTimestamp });
        }
      }
      continue;
    }
    if (semantic.length > 1) {
      result.push({ kind: 'conflict', wordComment, reason: 'multiple local threads have the same semantic fingerprint' });
      continue;
    }
    result.push({
      kind: 'new',
      wordComment,
      comment: {
        id: randomUUID(), author: wordComment.author, timestamp: wordComment.timestamp, text: wordComment.text,
        filePath, range: mapped.range, selectedText: mapped.selectedText, contextBefore: mapped.contextBefore,
        contextAfter: mapped.contextAfter, documentHash: createHash('sha256').update(source).digest('hex'),
        replies: [], trackedChanges: [], resolved: false
      }
    });
  }
  return result;
}

export function candidateSummary(candidates: WordImportCandidate[]): Record<WordImportCandidate['kind'], number> {
  return candidates.reduce((summary, candidate) => {
    summary[candidate.kind]++;
    return summary;
  }, { new: 0, unchanged: 0, changed: 0, ambiguous: 0, conflict: 0, invalid: 0 });
}

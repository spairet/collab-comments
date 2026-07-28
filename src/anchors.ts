import { StoredPosition, StoredRange } from './model';

export interface TextChange {
  range: StoredRange;
  text: string;
}

export interface AnchorInput {
  range: StoredRange;
  selectedText?: string;
  contextBefore?: string;
  contextAfter?: string;
  preferRange?: boolean;
}

export interface LocatedAnchor {
  start: number;
  end: number;
  confidence: 'exact' | 'context' | 'position';
}

const CONTEXT_LENGTH = 80;
const CONTEXT_SEARCH_LENGTH = 40;
const MAX_CONTEXT_GAP = 10_000;

function comparePositions(left: StoredPosition, right: StoredPosition): number {
  return left.line - right.line || left.character - right.character;
}

function insertedEnd(start: StoredPosition, text: string): StoredPosition {
  const lines = text.split(/\r?\n/);
  if (lines.length === 1) {
    return { line: start.line, character: start.character + text.length };
  }
  return {
    line: start.line + lines.length - 1,
    character: lines[lines.length - 1].length
  };
}

function transformPosition(
  position: StoredPosition,
  change: TextChange,
  affinity: 'before' | 'after'
): StoredPosition {
  const { start, end } = change.range;
  const atStart = comparePositions(position, start) === 0;
  const atEnd = comparePositions(position, end) === 0;
  const insertion = comparePositions(start, end) === 0;

  if (comparePositions(position, start) < 0
    || (atStart && affinity === 'before')) {
    return position;
  }

  const newEnd = insertedEnd(start, change.text);
  if (comparePositions(position, end) > 0
    || (atEnd && (!insertion || affinity === 'after'))) {
    if (position.line === end.line) {
      return {
        line: newEnd.line,
        character: newEnd.character + Math.max(0, position.character - end.character)
      };
    }
    return {
      line: position.line + newEnd.line - end.line,
      character: position.character
    };
  }

  return affinity === 'before' ? start : newEnd;
}

export function transformRange(range: StoredRange, changes: TextChange[]): StoredRange {
  const sorted = [...changes].sort((left, right) =>
    comparePositions(right.range.start, left.range.start)
  );

  let transformed = range;
  for (const change of sorted) {
    transformed = {
      start: transformPosition(transformed.start, change, 'before'),
      end: transformPosition(transformed.end, change, 'after')
    };
  }
  return transformed;
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '\n') {
      starts.push(index + 1);
    }
  }
  return starts;
}

export function positionToOffset(text: string, position: StoredPosition): number {
  const starts = lineStarts(text);
  const line = Math.min(Math.max(position.line, 0), starts.length - 1);
  const lineStart = starts[line];
  const nextLineStart = line + 1 < starts.length ? starts[line + 1] : text.length + 1;
  const lineEnd = Math.max(lineStart, nextLineStart - 1);
  return Math.min(lineStart + Math.max(position.character, 0), lineEnd);
}

export function offsetToPosition(text: string, rawOffset: number): StoredPosition {
  const offset = Math.min(Math.max(rawOffset, 0), text.length);
  const starts = lineStarts(text);
  let low = 0;
  let high = starts.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (starts[middle] <= offset) {
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  const line = Math.max(0, high);
  return { line, character: offset - starts[line] };
}

function matchingSuffix(left: string, right: string): number {
  const limit = Math.min(left.length, right.length, CONTEXT_LENGTH);
  let count = 0;
  while (count < limit
    && left[left.length - 1 - count] === right[right.length - 1 - count]) {
    count++;
  }
  return count;
}

function matchingPrefix(left: string, right: string): number {
  const limit = Math.min(left.length, right.length, CONTEXT_LENGTH);
  let count = 0;
  while (count < limit && left[count] === right[count]) {
    count++;
  }
  return count;
}

function allOccurrences(text: string, needle: string): number[] {
  const occurrences: number[] = [];
  let from = 0;
  while (from <= text.length - needle.length) {
    const index = text.indexOf(needle, from);
    if (index === -1) {
      break;
    }
    occurrences.push(index);
    from = index + Math.max(1, needle.length);
  }
  return occurrences;
}

function locateByExactText(text: string, input: AnchorInput, expected: number): LocatedAnchor | undefined {
  const selected = input.selectedText;
  if (!selected) {
    return undefined;
  }

  const occurrences = allOccurrences(text, selected);
  if (occurrences.length === 0) {
    return undefined;
  }

  let best = occurrences[0];
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const candidate of occurrences) {
    const before = text.slice(Math.max(0, candidate - CONTEXT_LENGTH), candidate);
    const after = text.slice(candidate + selected.length, candidate + selected.length + CONTEXT_LENGTH);
    const contextScore =
      matchingSuffix(before, input.contextBefore ?? '') * 8
      + matchingPrefix(after, input.contextAfter ?? '') * 8;
    const distancePenalty = Math.min(Math.abs(candidate - expected) / 100, 100);
    const score = contextScore - distancePenalty;
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  return { start: best, end: best + selected.length, confidence: 'exact' };
}

function usefulBeforeContext(context: string | undefined): string {
  return (context ?? '').slice(-CONTEXT_SEARCH_LENGTH);
}

function usefulAfterContext(context: string | undefined): string {
  return (context ?? '').slice(0, CONTEXT_SEARCH_LENGTH);
}

function locateBetweenContexts(
  text: string,
  input: AnchorInput,
  expected: number
): LocatedAnchor | undefined {
  const beforeNeedle = usefulBeforeContext(input.contextBefore);
  const afterNeedle = usefulAfterContext(input.contextAfter);
  if (beforeNeedle.trim().length < 4 || afterNeedle.trim().length < 4) {
    return undefined;
  }

  const expectedLength = input.selectedText?.length ?? 0;
  let best: LocatedAnchor | undefined;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const beforeIndex of allOccurrences(text, beforeNeedle)) {
    const start = beforeIndex + beforeNeedle.length;
    const afterIndex = text.indexOf(afterNeedle, start);
    if (afterIndex < start || afterIndex - start > MAX_CONTEXT_GAP) {
      continue;
    }
    const score = Math.abs(start - expected) + Math.abs((afterIndex - start) - expectedLength) * 2;
    if (score < bestScore) {
      best = { start, end: afterIndex, confidence: 'context' };
      bestScore = score;
    }
  }
  return best;
}

export function locateAnchor(text: string, input: AnchorInput): LocatedAnchor {
  const expectedStart = positionToOffset(text, input.range.start);
  const expectedEnd = Math.max(expectedStart, positionToOffset(text, input.range.end));
  const exact = locateByExactText(text, input, expectedStart);

  // Keep an exact match that is already at the transformed range. This avoids
  // second-guessing a stable anchor when its context contains repeated text.
  if (exact?.start === expectedStart && exact.end === expectedEnd) {
    return exact;
  }

  // Context is more trustworthy than an exact match somewhere else. In
  // particular, the original selected text may still occur elsewhere after the
  // user replaces the text under this comment.
  const contextual = locateBetweenContexts(text, input, expectedStart);
  if (contextual) {
    return contextual;
  }

  if (input.preferRange) {
    return { start: expectedStart, end: expectedEnd, confidence: 'position' };
  }

  if (exact) {
    return exact;
  }

  return { start: expectedStart, end: expectedEnd, confidence: 'position' };
}

export function captureAnchor(text: string, start: number, end: number): Pick<
  AnchorInput,
  'selectedText' | 'contextBefore' | 'contextAfter'
> {
  const safeStart = Math.min(Math.max(start, 0), text.length);
  const safeEnd = Math.min(Math.max(end, safeStart), text.length);
  return {
    selectedText: text.slice(safeStart, safeEnd),
    contextBefore: text.slice(Math.max(0, safeStart - CONTEXT_LENGTH), safeStart),
    contextAfter: text.slice(safeEnd, safeEnd + CONTEXT_LENGTH)
  };
}

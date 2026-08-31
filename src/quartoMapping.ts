import { createHash } from 'crypto';
import { offsetToPosition } from './anchors';
import { StoredRange } from './model';

export interface RenderedSelection {
  text: string;
  before: string;
  after: string;
}

export interface MappedSelection {
  range: StoredRange;
  selectedText: string;
  contextBefore: string;
  contextAfter: string;
}

const CONTEXT = 120;

export function sourceHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function occurrences(text: string, needle: string): number[] {
  const result: number[] = [];
  for (let from = 0; from <= text.length - needle.length;) {
    const index = text.indexOf(needle, from);
    if (index < 0) {
      break;
    }
    result.push(index);
    // Advance by one UTF-16 code unit so overlapping literal occurrences are
    // scored too. Selection offsets also use UTF-16 code units, and `needle` is
    // known non-empty by the caller, so this always makes progress.
    from = index + 1;
  }
  return result;
}

function suffixScore(source: string, context: string): number {
  const limit = Math.min(source.length, context.length, CONTEXT);
  let score = 0;
  while (score < limit && source[source.length - score - 1] === context[context.length - score - 1]) {
    score++;
  }
  return score;
}

function prefixScore(source: string, context: string): number {
  const limit = Math.min(source.length, context.length, CONTEXT);
  let score = 0;
  while (score < limit && source[score] === context[score]) {
    score++;
  }
  return score;
}

/**
 * Maps a browser selection back to literal QMD text. A score tie is deliberately
 * rejected: rendered HTML can contain generated/repeated text and guessing would
 * attach a discussion to the wrong source passage.
 */
export function mapRenderedSelection(source: string, selection: RenderedSelection): MappedSelection | undefined {
  const selectedText = selection.text;
  if (!selectedText || selectedText.length > 32_000 || /\0/.test(selectedText)) {
    return undefined;
  }
  const candidates = occurrences(source, selectedText);
  if (candidates.length === 0) {
    return undefined;
  }
  const scored = candidates.map(start => {
    const before = source.slice(Math.max(0, start - CONTEXT), start);
    const after = source.slice(start + selectedText.length, start + selectedText.length + CONTEXT);
    return { start, score: suffixScore(before, selection.before) * 4 + prefixScore(after, selection.after) * 4 };
  }).sort((left, right) => right.score - left.score);
  if (scored.length > 1 && scored[0].score === scored[1].score) {
    return undefined;
  }
  const start = scored[0].start;
  const end = start + selectedText.length;
  return {
    range: { start: offsetToPosition(source, start), end: offsetToPosition(source, end) },
    selectedText,
    contextBefore: source.slice(Math.max(0, start - CONTEXT), start),
    contextAfter: source.slice(end, end + CONTEXT)
  };
}

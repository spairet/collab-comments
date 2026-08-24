export interface HighlightCandidate {
  id: string;
  startLine: number;
  endLine: number;
}

/**
 * Picks the comment whose range best matches a cursor line: containing
 * ranges win, otherwise the closest start line (earlier ranges win ties).
 */
export function nearestCommentAtLine<T extends HighlightCandidate>(
  comments: T[],
  line: number
): string | null {
  let best: T | undefined;
  let bestDistance = Number.MAX_SAFE_INTEGER;
  for (const comment of comments) {
    const distance = line < comment.startLine
      ? comment.startLine - line
      : line > comment.endLine
        ? line - comment.endLine
        : 0;
    if (distance < bestDistance
      || (distance === bestDistance && best && comment.startLine < best.startLine)) {
      best = comment;
      bestDistance = distance;
    }
  }
  return best?.id ?? null;
}

/**
 * Maps a viewport position to a 0..1 fraction of the document scroll range,
 * used to scroll the review panel proportionally like Word's reviewing pane.
 */
export function viewportFraction(
  topLine: number,
  bottomLine: number,
  lineCount: number
): number {
  const span = bottomLine - topLine + 1;
  const scrollable = lineCount - span;
  if (scrollable <= 0) {
    return 0;
  }
  return Math.min(1, Math.max(0, topLine / scrollable));
}

/**
 * Picks the topmost-nearest comment visible in a line span (with a small
 * margin), or null when nothing is near — the panel then shows no highlight.
 */
export function commentInViewport<T extends HighlightCandidate>(
  comments: T[],
  topLine: number,
  bottomLine: number,
  marginLines = 2
): string | null {
  const from = topLine - marginLines;
  const to = bottomLine + marginLines;
  let best: T | undefined;
  for (const comment of comments) {
    if (comment.endLine < from || comment.startLine > to) {
      continue;
    }
    if (!best || comment.startLine < best.startLine
      || (comment.startLine === best.startLine && comment.endLine < best.endLine)) {
      best = comment;
    }
  }
  return best?.id ?? null;
}

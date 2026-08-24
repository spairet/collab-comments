export type PanelRequest =
  | { type: 'navigate'; commentId: string }
  | { type: 'reply'; commentId: string; text: string }
  | { type: 'resolve'; commentId: string; resolved: boolean }
  | { type: 'delete-thread'; commentId: string }
  | { type: 'delete-reply'; commentId: string; replyId: string }
  | { type: 'merge-tracked-changes'; commentId: string }
  | { type: 'show-resolved'; visible: boolean };

export function parsePanelRequest(data: unknown): PanelRequest | undefined {
  if (typeof data !== 'object' || data === null) {
    return undefined;
  }
  const request = data as Record<string, unknown>;
  const commentId = typeof request.commentId === 'string' && request.commentId
    ? request.commentId
    : undefined;
  switch (request.type) {
    case 'navigate':
      return commentId ? { type: 'navigate', commentId } : undefined;
    case 'reply':
      return commentId && typeof request.text === 'string' && request.text.trim()
        ? { type: 'reply', commentId, text: request.text.trim() }
        : undefined;
    case 'resolve':
      return commentId && typeof request.resolved === 'boolean'
        ? { type: 'resolve', commentId, resolved: request.resolved }
        : undefined;
    case 'delete-thread':
      return commentId ? { type: 'delete-thread', commentId } : undefined;
    case 'delete-reply':
      return commentId && typeof request.replyId === 'string' && request.replyId
        ? { type: 'delete-reply', commentId, replyId: request.replyId }
        : undefined;
    case 'merge-tracked-changes':
      return commentId ? { type: 'merge-tracked-changes', commentId } : undefined;
    case 'show-resolved':
      return typeof request.visible === 'boolean'
        ? { type: 'show-resolved', visible: request.visible }
        : undefined;
    default:
      return undefined;
  }
}

import { CommentData } from './model';

/**
 * A front-end that renders comments. The sidebar webview panel is the only
 * surface; the interface is kept so further front-ends can be added without
 * touching the store mutation logic in extension.ts.
 */
export interface ReviewSurface {
  /** Create the view for a newly restored or added comment. */
  upsert(comment: CommentData): void;
  /** Re-render an existing comment after a content change. */
  reconfigure(commentId: string, comment: CommentData): void;
  /** Drop the view for one comment. */
  remove(commentId: string): void;
  /** Drop every view. */
  clear(): void;
  dispose(): void;
}

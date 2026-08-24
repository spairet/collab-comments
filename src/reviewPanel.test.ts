import assert from 'assert';
import test from 'node:test';
import { commentInViewport, nearestCommentAtLine, viewportFraction } from './highlight.js';
import { parsePanelRequest } from './panelProtocol.js';

test('nearestCommentAtLine prefers a containing range', () => {
  const candidates = [
    { id: 'before', startLine: 1, endLine: 2 },
    { id: 'containing', startLine: 5, endLine: 9 },
    { id: 'after', startLine: 20, endLine: 21 }
  ];
  assert.strictEqual(nearestCommentAtLine(candidates, 7), 'containing');
});

test('nearestCommentAtLine falls back to closest start line', () => {
  const candidates = [
    { id: 'near', startLine: 10, endLine: 11 },
    { id: 'far', startLine: 40, endLine: 41 }
  ];
  assert.strictEqual(nearestCommentAtLine(candidates, 13), 'near');
  assert.strictEqual(nearestCommentAtLine(candidates, 38), 'far');
});

test('nearestCommentAtLine breaks ties toward the earlier range', () => {
  const candidates = [
    { id: 'later', startLine: 12, endLine: 12 },
    { id: 'earlier', startLine: 8, endLine: 8 }
  ];
  assert.strictEqual(nearestCommentAtLine(candidates, 10), 'earlier');
});

test('nearestCommentAtLine handles empty candidates', () => {
  assert.strictEqual(nearestCommentAtLine([], 3), null);
});

test('commentInViewport picks the topmost comment in the span', () => {
  const candidates = [
    { id: 'lower', startLine: 30, endLine: 31 },
    { id: 'upper', startLine: 12, endLine: 14 }
  ];
  assert.strictEqual(commentInViewport(candidates, 10, 20), 'upper');
});

test('commentInViewport applies the margin lines', () => {
  const candidates = [{ id: 'just-outside', startLine: 22, endLine: 22 }];
  assert.strictEqual(commentInViewport(candidates, 10, 20), 'just-outside');
  assert.strictEqual(commentInViewport(candidates, 10, 20, 0), null);
});

test('commentInViewport returns null when nothing is near', () => {
  const candidates = [
    { id: 'above', startLine: 1, endLine: 2 },
    { id: 'below', startLine: 90, endLine: 91 }
  ];
  assert.strictEqual(commentInViewport(candidates, 40, 50), null);
});

test('commentInViewport handles empty candidates', () => {
  assert.strictEqual(commentInViewport([], 1, 10), null);
});

test('commentInViewport breaks start-line ties toward the shorter range', () => {
  const candidates = [
    { id: 'longer', startLine: 5, endLine: 30 },
    { id: 'shorter', startLine: 5, endLine: 6 }
  ];
  assert.strictEqual(commentInViewport(candidates, 1, 10), 'shorter');
});

test('viewportFraction maps the viewport top into 0..1', () => {
  assert.strictEqual(viewportFraction(0, 9, 100), 0);
  assert.strictEqual(viewportFraction(45, 54, 100), 0.5);
  assert.strictEqual(viewportFraction(90, 99, 100), 1);
});

test('viewportFraction clamps short or fully visible documents to 0', () => {
  assert.strictEqual(viewportFraction(0, 99, 100), 0);
  assert.strictEqual(viewportFraction(0, 12, 10), 0);
  assert.strictEqual(viewportFraction(0, 5, 4), 0);
});

test('parsePanelRequest accepts valid requests', () => {
  assert.deepStrictEqual(
    parsePanelRequest({ type: 'navigate', commentId: 'c1' }),
    { type: 'navigate', commentId: 'c1' }
  );
  assert.deepStrictEqual(
    parsePanelRequest({ type: 'reply', commentId: 'c1', text: '  hello  ' }),
    { type: 'reply', commentId: 'c1', text: 'hello' }
  );
  assert.deepStrictEqual(
    parsePanelRequest({ type: 'resolve', commentId: 'c1', resolved: true }),
    { type: 'resolve', commentId: 'c1', resolved: true }
  );
  assert.deepStrictEqual(
    parsePanelRequest({ type: 'delete-reply', commentId: 'c1', replyId: 'r1' }),
    { type: 'delete-reply', commentId: 'c1', replyId: 'r1' }
  );
  assert.deepStrictEqual(
    parsePanelRequest({ type: 'show-resolved', visible: false }),
    { type: 'show-resolved', visible: false }
  );
});

test('parsePanelRequest rejects malformed requests', () => {
  assert.strictEqual(parsePanelRequest(null), undefined);
  assert.strictEqual(parsePanelRequest('navigate'), undefined);
  assert.strictEqual(parsePanelRequest({ type: 'navigate' }), undefined);
  assert.strictEqual(parsePanelRequest({ type: 'navigate', commentId: '' }), undefined);
  assert.strictEqual(parsePanelRequest({ type: 'reply', commentId: 'c1', text: '   ' }), undefined);
  assert.strictEqual(parsePanelRequest({ type: 'resolve', commentId: 'c1', resolved: 'yes' }), undefined);
  assert.strictEqual(parsePanelRequest({ type: 'unknown', commentId: 'c1' }), undefined);
});

import { strict as assert } from 'node:assert';
import * as path from 'node:path';
import { test } from 'node:test';
import { commentRootForFile, workspaceRelativePath } from './workspacePaths';

const first = path.resolve('workspace', 'first');
const second = path.resolve('workspace', 'second');
const nested = path.resolve('workspace', 'first', 'nested');

test('stores a file with the workspace folder that contains it', () => {
  const file = path.join(second, 'main.tex');
  assert.equal(commentRootForFile([first, second], file), second);
  assert.equal(workspaceRelativePath(second, file), 'main.tex');
  assert.equal(workspaceRelativePath(first, file), undefined);
});

test('keeps a file in the first folder on that folder', () => {
  const file = path.join(first, 'src', 'notes.md');
  assert.equal(commentRootForFile([first, second], file), first);
  assert.equal(workspaceRelativePath(first, file), 'src/notes.md');
});

test('rejects files outside every workspace folder', () => {
  const file = path.resolve('elsewhere', 'main.tex');
  assert.equal(commentRootForFile([first, second], file), undefined);
});

test('prefers the nested workspace folder over its parent', () => {
  const file = path.join(nested, 'chapter.qmd');
  assert.equal(commentRootForFile([first, nested], file), nested);
  assert.equal(workspaceRelativePath(nested, file), 'chapter.qmd');
});

test('does not treat a sibling directory with a shared prefix as inside the root', () => {
  const root = path.resolve('proj');
  const file = path.join(path.resolve('proj-other'), 'file.md');
  assert.equal(commentRootForFile([root], file), undefined);
  assert.equal(workspaceRelativePath(root, file), undefined);
});

test('rejects the workspace root itself and parent traversal', () => {
  assert.equal(workspaceRelativePath(first, first), undefined);
  assert.equal(workspaceRelativePath(first, path.resolve('workspace')), undefined);
});

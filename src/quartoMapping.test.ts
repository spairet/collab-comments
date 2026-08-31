import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mapRenderedSelection } from './quartoMapping';

test('maps repeated rendered text using exact surrounding QMD context', () => {
  const source = 'First item: target after one.\nSecond item: target after two.\n';
  const mapped = mapRenderedSelection(source, {
    text: 'target', before: 'Second item: ', after: ' after two.'
  });
  assert.ok(mapped);
  assert.equal(mapped.range.start.line, 1);
});

test('maps a unique selection through literal Markdown markers', () => {
  const source = 'A **bold** claim follows.\n';
  const mapped = mapRenderedSelection(source, { text: 'bold', before: 'A **', after: '** claim' });
  assert.ok(mapped);
  assert.equal(mapped.selectedText, 'bold');
  assert.equal(mapped.range.start.character, 4);
});

test('maps Unicode selections without splitting their source range', () => {
  const source = 'An 🐨 says café.\n';
  const mapped = mapRenderedSelection(source, { text: 'café', before: 'An 🐨 says ', after: '.\n' });
  assert.ok(mapped);
  assert.equal(mapped.range.start.character, 'An 🐨 says '.length);
});

test('maps an exact multiline selection and rejects rendered whitespace changes', () => {
  const source = 'First line\nsecond line\nthird line\n';
  const mapped = mapRenderedSelection(source, { text: 'line\nsecond', before: 'First ', after: ' line\nthird' });
  assert.ok(mapped);
  assert.equal(mapped.range.start.line, 0);
  assert.equal(mapped.range.end.line, 1);
  assert.equal(mapRenderedSelection(source, { text: 'line second', before: 'First ', after: ' line' }), undefined);
});

test('rejects rendered text that has no literal QMD match', () => {
  const source = 'Author-written prose only.\n';
  assert.equal(mapRenderedSelection(source, { text: 'Generated plot label', before: '', after: '' }), undefined);
});

test('rejects an ambiguous rendered selection instead of guessing', () => {
  const source = 'target\ntarget\n';
  assert.equal(mapRenderedSelection(source, { text: 'target', before: '', after: '' }), undefined);
});

test('rejects ambiguous overlapping literal occurrences instead of choosing the first', () => {
  const source = 'aaa';
  assert.equal(mapRenderedSelection(source, { text: 'aa', before: '', after: '' }), undefined);
});

test('uses context to disambiguate overlapping literal occurrences', () => {
  const source = 'aaa';
  const mapped = mapRenderedSelection(source, { text: 'aa', before: 'a', after: '' });
  assert.ok(mapped);
  assert.equal(mapped.range.start.character, 1);
  assert.equal(mapped.range.end.character, 3);
});

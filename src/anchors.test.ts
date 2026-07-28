import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { captureAnchor, locateAnchor, offsetToPosition, transformRange } from './anchors';

test('uses context to distinguish repeated selected text', () => {
  const original = 'first target end\nsecond target finish\n';
  const selectedStart = original.lastIndexOf('target');
  const anchor = captureAnchor(original, selectedStart, selectedStart + 'target'.length);
  const updated = `new target preface\n${original}`;

  const located = locateAnchor(updated, {
    range: {
      start: offsetToPosition(original, selectedStart),
      end: offsetToPosition(original, selectedStart + 'target'.length)
    },
    ...anchor
  });

  assert.equal(updated.slice(located.start, located.end), 'target');
  assert.equal(located.start, updated.lastIndexOf('target'));
});

test('uses surrounding context when selected text was edited', () => {
  const original = 'heading\nThe old wording belongs here.\nfooter\n';
  const start = original.indexOf('old wording');
  const anchor = captureAnchor(original, start, start + 'old wording'.length);
  const updated = original.replace('old wording', 'new and improved wording');

  const located = locateAnchor(updated, {
    range: {
      start: offsetToPosition(original, start),
      end: offsetToPosition(original, start + 'old wording'.length)
    },
    ...anchor
  });

  assert.equal(located.confidence, 'context');
  assert.equal(updated.slice(located.start, located.end), 'new and improved wording');
});

test('does not jump to another exact match when the selected text is edited', () => {
  const original = 'Leave this token alone.\nEdit this token in place.\n';
  const selectedStart = original.lastIndexOf('token');
  const selectedEnd = selectedStart + 'token'.length;
  const replacement = 'phrase';
  const anchor = captureAnchor(original, selectedStart, selectedEnd);
  const originalRange = {
    start: offsetToPosition(original, selectedStart),
    end: offsetToPosition(original, selectedEnd)
  };
  const updated = `${original.slice(0, selectedStart)}${replacement}${original.slice(selectedEnd)}`;
  const transformedRange = transformRange(originalRange, [{
    range: originalRange,
    text: replacement
  }]);

  const located = locateAnchor(updated, {
    range: transformedRange,
    ...anchor
  });

  assert.equal(located.confidence, 'context');
  assert.equal(updated.slice(located.start, located.end), replacement);
  assert.equal(located.start, selectedStart);
});

test('keeps the transformed range when an edited selection has too little context', () => {
  const original = 'token token';
  const selectedStart = original.lastIndexOf('token');
  const selectedEnd = selectedStart + 'token'.length;
  const originalRange = {
    start: offsetToPosition(original, selectedStart),
    end: offsetToPosition(original, selectedEnd)
  };
  const updated = 'token phrase';
  const transformedRange = transformRange(originalRange, [{
    range: originalRange,
    text: 'phrase'
  }]);

  const located = locateAnchor(updated, {
    range: transformedRange,
    ...captureAnchor(original, selectedStart, selectedEnd),
    preferRange: true
  });

  assert.equal(located.confidence, 'position');
  assert.equal(updated.slice(located.start, located.end), 'phrase');
});

test('transforms a range after lines are inserted before it', () => {
  const transformed = transformRange(
    {
      start: { line: 4, character: 2 },
      end: { line: 4, character: 7 }
    },
    [{
      range: {
        start: { line: 1, character: 0 },
        end: { line: 1, character: 0 }
      },
      text: 'one\ntwo\n'
    }]
  );

  assert.deepEqual(transformed, {
    start: { line: 6, character: 2 },
    end: { line: 6, character: 7 }
  });
});

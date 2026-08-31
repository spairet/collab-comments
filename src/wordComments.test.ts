import assert from 'node:assert/strict';
import test from 'node:test';
import { CommentData, CommentStore } from './model';
import {
  appendSafeThreadTimestamp,
  candidateSummary,
  canonicalWordText,
  MAX_PANDOC_BLOCK_NODES,
  extractWordComments,
  formatWordTranscript,
  prepareWordImport,
  stableWordId,
  wordIdForTranscript,
  wordIdCollisions
} from './wordComments';

function span(classes: string[], values: Array<[string, string]>, content: unknown[] = []): unknown {
  return { t: 'Span', c: [['', classes, values], content] };
}

function documentWithComment(id = '7', body = 'Body', selected = 'chosen'): unknown {
  const pandocApiVersion = 'pandoc-api-version';
  return {
    [pandocApiVersion]: [1, 23, 1],
    blocks: [{ t: 'Para', c: [
      { t: 'Str', c: 'Before' }, { t: 'Space' },
      span(['comment-start'], [['id', id], ['author', 'Alice'], ['date', '2026-08-29T01:02:03Z']], [{ t: 'Str', c: body }]),
      { t: 'Str', c: selected }, span(['comment-end'], [['id', id]]),
      { t: 'Space' }, { t: 'Str', c: 'After' }
    ] }]
  };
}

function comment(id = 'local-id'): CommentData {
  return {
    id, author: 'Alice', timestamp: '2026-08-29T01:02:03.000Z', text: 'Body', filePath: 'document.qmd',
    range: { start: { line: 0, character: 7 }, end: { line: 0, character: 13 } }, selectedText: 'chosen',
    contextBefore: 'Before ', contextAfter: ' After', replies: [], trackedChanges: [], resolved: false
  };
}

test('extracts portable Pandoc Word comment spans with selection context', () => {
  const extracted = extractWordComments(documentWithComment());
  assert.deepEqual(extracted.invalid, []);
  assert.equal(extracted.comments.length, 1);
  assert.deepEqual(extracted.comments[0], {
    wordId: '7', author: 'Alice', timestamp: '2026-08-29T01:02:03.000Z', text: 'Body',
    selectedText: 'chosen', contextBefore: 'Before ', contextAfter: ' After'
  });
});

test('uses explicit fallbacks and rejects malformed or unmatched markers', () => {
  const missingMetadata = documentWithComment();
  const marker = (missingMetadata as { blocks: Array<{ c: unknown[] }> }).blocks[0].c[2] as { c: [unknown, unknown[]] };
  marker.c[0] = ['', ['comment-start'], [['id', '9']]];
  const end = (missingMetadata as { blocks: Array<{ c: unknown[] }> }).blocks[0].c[4] as { c: [unknown, unknown[]] };
  end.c[0] = ['', ['comment-end'], [['id', '9']]];
  const extracted = extractWordComments(missingMetadata, '2026-01-01T00:00:00.000Z');
  assert.equal(extracted.comments[0].author, 'Word reviewer');
  assert.equal(extracted.comments[0].timestamp, '2026-01-01T00:00:00.000Z');
  const malformed = documentWithComment();
  (malformed as { blocks: Array<{ c: unknown[] }> }).blocks[0].c.splice(4, 1);
  assert.match(extractWordComments(malformed).invalid[0].reason, /unmatched/);
});

test('does not accept nested, duplicate, or non-Pandoc documents', () => {
  const nested = documentWithComment();
  const inlines = (nested as { blocks: Array<{ c: unknown[] }> }).blocks[0].c;
  inlines.splice(3, 0, span(['comment-start'], [['id', '8']], [{ t: 'Str', c: 'Nested' }]));
  const extractedNested = extractWordComments(nested);
  assert.ok(extractedNested.invalid.length > 0);
  assert.deepEqual(extractedNested.comments, []);
  const duplicate = documentWithComment();
  (duplicate as { blocks: Array<{ c: unknown[] }> }).blocks[0].c.splice(
    3,
    0,
    span(['comment-start'], [['id', '7']], [{ t: 'Str', c: 'Duplicate' }])
  );
  assert.deepEqual(extractWordComments(duplicate).comments, []);
  const mismatched = documentWithComment();
  const end = (mismatched as { blocks: Array<{ c: unknown[] }> }).blocks[0].c[4] as { c: [unknown, unknown[]] };
  end.c[0] = ['', ['comment-end'], [['id', '8']]];
  const extractedMismatched = extractWordComments(mismatched);
  assert.ok(extractedMismatched.invalid.length > 0);
  assert.deepEqual(extractedMismatched.comments, []);
  assert.deepEqual(extractWordComments({ blocks: [] }).comments, []);
  assert.match(extractWordComments({ blocks: [] }).invalid[0].reason, /invalid Pandoc/);
});

test('rejects comment markers nested in formatted inline containers', () => {
  const pandocApiVersion = 'pandoc-api-version';
  for (const container of ['Emph', 'Strong']) {
    const nested = {
      [pandocApiVersion]: [1, 23, 1],
      blocks: [{ t: 'Para', c: [{ t: container, c: [
        span(['comment-start'], [['id', '7'], ['author', 'Alice'], ['date', '2026-08-29T01:02:03Z']], [{ t: 'Str', c: 'Body' }]),
        { t: 'Str', c: 'chosen' },
        span(['comment-end'], [['id', '7']])
      ] }] }]
    };
    const extracted = extractWordComments(nested);
    assert.deepEqual(extracted.comments, []);
    assert.ok(extracted.invalid.some(item => /nested inside an unsupported inline/.test(item.reason)));
  }
});

test('reports markers hidden in unsupported blocks without rejecting ordinary unsupported blocks', () => {
  const pandocApiVersion = 'pandoc-api-version';
  const unsupported = {
    [pandocApiVersion]: [1, 23, 1],
    blocks: [{ t: 'Table', c: [span(['comment-start'], [['id', '7']], [{ t: 'Str', c: 'Body' }]) ] }]
  };
  const extracted = extractWordComments(unsupported);
  assert.deepEqual(extracted.comments, []);
  assert.match(extracted.invalid[0].reason, /unsupported Table/);
  const ordinary = extractWordComments({
    [pandocApiVersion]: [1, 23, 1],
    blocks: [{ t: 'CodeBlock', c: [['', [], []], 'ordinary code'] }]
  });
  assert.deepEqual(ordinary, { comments: [], invalid: [] });
  const wide = extractWordComments({
    [pandocApiVersion]: [1, 23, 1],
    blocks: [{ t: 'Table', c: Array(MAX_PANDOC_BLOCK_NODES + 1).fill('ordinary') }]
  });
  assert.deepEqual(wide.comments, []);
  assert.match(wide.invalid[0].reason, /traversal exceeds/);
});

test('traverses ordinary ordered lists and comment markers inside ordered-list items', () => {
  const document = documentWithComment() as { blocks: unknown[] };
  document.blocks.push({
    t: 'OrderedList',
    c: [[], [[{ t: 'Plain', c: [{ t: 'Str', c: 'ordinary' }] }]]]
  });
  assert.equal(extractWordComments(document).comments.length, 1);

  const pandocApiVersion = 'pandoc-api-version';
  const itemDocument = documentWithComment() as { blocks: unknown[] };
  const item = itemDocument.blocks[0];
  const extracted = extractWordComments({
    [pandocApiVersion]: [1, 23, 1],
    blocks: [{ t: 'OrderedList', c: [[], [[item]]] }]
  });
  assert.equal(extracted.invalid.length, 0);
  assert.equal(extracted.comments.length, 1);
  assert.equal(extracted.comments[0].wordId, '7');
});

test('stable Word IDs are deterministic UTF-8 FNV-1a vectors and collisions are detectable', () => {
  assert.equal(stableWordId('safe-id'), '1204151138');
  assert.equal(stableWordId('é'), '513665217');
  assert.equal(stableWordId('😀'), '866293256');
  const first = comment('collision-4011111104-1514174912');
  const second = comment('collision-489207954-3297958778');
  assert.equal(stableWordId(first.id), stableWordId(second.id));
  assert.equal(wordIdCollisions([first, second]).size, 1);
});

test('provenance Word IDs bind the local ID to the exact transcript bytes', () => {
  assert.equal(wordIdForTranscript('safe-id', 'Body'), '1079454490');
  assert.equal(wordIdForTranscript('é', 'Unicode body'), '965176182');
  assert.equal(wordIdForTranscript(
    'safe-id', '</script><script>window.evil=true</script> café Body  with\ttabs'
  ), '890042683');
  assert.equal(wordIdForTranscript(
    'safe-id', '</script><script>window.evil=true</script> café Body  with\ttabs\r\nCRLF second'
  ), '1481058377');
  assert.notEqual(wordIdForTranscript('safe-id', 'Body'), wordIdForTranscript('safe-id', 'Body\n'));
  assert.notEqual(wordIdForTranscript('safe-id', 'Body'), stableWordId('safe-id'));
});

test('prepares additive new, unchanged, and changed imports without overwriting local text', () => {
  const existing = comment('local-id');
  const store: CommentStore = { comments: [existing] };
  const wordId = stableWordId(existing.id);
  const source = 'Before chosen After';
  const unchanged = extractWordComments(documentWithComment(wordId));
  const unchangedCandidate = prepareWordImport(unchanged, source, 'document.qmd', store);
  assert.equal(unchangedCandidate[0].kind, 'unchanged');

  const changed = extractWordComments(documentWithComment(wordId, 'Edited in Word'));
  const changedCandidate = prepareWordImport(changed, source, 'document.qmd', store);
  assert.equal(changedCandidate[0].kind, 'changed');
  if (changedCandidate[0].kind === 'changed') {
    assert.equal(changedCandidate[0].replyAuthor, 'Word import: Alice');
    assert.equal(changedCandidate[0].replyText, 'Edited in Word');
  }

  const newComment = extractWordComments(documentWithComment('123', 'New comment'));
  const newCandidate = prepareWordImport(newComment, source, 'document.qmd', { comments: [] });
  assert.equal(newCandidate[0].kind, 'new');
  assert.equal(candidateSummary(newCandidate).new, 1);
});

test('canonicalises Pandoc horizontal whitespace for unchanged Word round trips', () => {
  const existing = comment('local-id');
  existing.text = 'Body  with\ttabs';
  const extracted = extractWordComments(documentWithComment(stableWordId(existing.id), 'Body with tabs'));
  const candidates = prepareWordImport(extracted, 'Before chosen After', 'document.qmd', { comments: [existing] });
  assert.equal(candidates[0].kind, 'unchanged');
  assert.equal(canonicalWordText(existing.text), 'Body with tabs');
  assert.equal(canonicalWordText('A\r\nB\rC'), 'A\nB\nC');
});

test('keeps a Word-native import unchanged after local replies or resolution', () => {
  const source = 'Before chosen After';
  const withReply = comment('local-id');
  const importedReply = extractWordComments(documentWithComment(wordIdForTranscript(withReply.id, 'Body'), 'Edited in Word'));
  withReply.replies.push(
    { id: 'word-reply', author: 'Word import: Alice', timestamp: '2026-08-29T01:02:03.000Z', text: 'Edited in Word' },
    { id: 'local-reply', author: 'Bob', timestamp: '2026-08-30T00:00:00.000Z', text: 'Local reply' }
  );
  assert.equal(prepareWordImport(importedReply, source, 'document.qmd', { comments: [withReply] })[0].kind, 'unchanged');

  const resolved = comment('resolved-id');
  resolved.resolved = true;
  const resolvedOriginal = extractWordComments(documentWithComment(wordIdForTranscript(resolved.id, 'Body')));
  assert.equal(prepareWordImport(resolvedOriginal, source, 'document.qmd', { comments: [resolved] })[0].kind, 'unchanged');
});

test('keeps exact historical flattened transcript snapshots unchanged', () => {
  const source = 'Before chosen After';
  const withLaterReply = comment('history-id');
  withLaterReply.replies.push({ id: 'reply-a', author: 'Bob', timestamp: '2026-08-30T00:00:00.000Z', text: 'Reply A' });
  const exportedBeforeLaterReply = formatWordTranscript(withLaterReply);
  withLaterReply.replies.push({ id: 'reply-b', author: 'Carol', timestamp: '2026-08-31T00:00:00.000Z', text: 'Reply B' });
  const historicalReplyId = wordIdForTranscript(withLaterReply.id, exportedBeforeLaterReply);
  const historicalReply = extractWordComments(documentWithComment(historicalReplyId, exportedBeforeLaterReply));
  assert.equal(prepareWordImport(historicalReply, source, 'document.qmd', { comments: [withLaterReply] })[0].kind, 'unchanged');
  const changedHistoricalReply = extractWordComments(documentWithComment(
    historicalReplyId, `${exportedBeforeLaterReply}\nEdited in Word`
  ));
  assert.equal(prepareWordImport(changedHistoricalReply, source, 'document.qmd', { comments: [withLaterReply] })[0].kind, 'changed');

  const currentReplyId = wordIdForTranscript(withLaterReply.id, formatWordTranscript(withLaterReply));
  const truncatedCurrentReply = extractWordComments(documentWithComment(currentReplyId, exportedBeforeLaterReply));
  assert.equal(prepareWordImport(truncatedCurrentReply, source, 'document.qmd', { comments: [withLaterReply] })[0].kind, 'changed');

  const resolvedAfterActivity = comment('resolved-history-id');
  resolvedAfterActivity.replies.push({ id: 'reply-a', author: 'Bob', timestamp: '2026-08-30T00:00:00.000Z', text: 'Reply A' });
  const exportedBeforeResolution = formatWordTranscript(resolvedAfterActivity);
  resolvedAfterActivity.replies.push({ id: 'reply-b', author: 'Carol', timestamp: '2026-08-31T00:00:00.000Z', text: 'Reply B' });
  resolvedAfterActivity.resolved = true;
  const historicalResolved = extractWordComments(documentWithComment(
    wordIdForTranscript(resolvedAfterActivity.id, exportedBeforeResolution), exportedBeforeResolution
  ));
  assert.equal(prepareWordImport(historicalResolved, source, 'document.qmd', { comments: [resolvedAfterActivity] })[0].kind, 'unchanged');
  const resolvedBody = formatWordTranscript(resolvedAfterActivity);
  const currentResolvedId = wordIdForTranscript(resolvedAfterActivity.id, resolvedBody);
  const withoutResolved = extractWordComments(documentWithComment(
    currentResolvedId, resolvedBody.slice('Resolved\n\n'.length)
  ));
  assert.equal(prepareWordImport(withoutResolved, source, 'document.qmd', { comments: [resolvedAfterActivity] })[0].kind, 'changed');

  const withLaterChange = comment('tracked-history-id');
  withLaterChange.trackedChanges.push({ id: 'change-a', author: 'Bob', timestamp: '2026-08-30T00:00:00.000Z', previousText: 'old', newText: 'new' });
  const exportedBeforeLaterChange = formatWordTranscript(withLaterChange);
  withLaterChange.trackedChanges.push({ id: 'change-b', author: 'Carol', timestamp: '2026-08-31T00:00:00.000Z', previousText: 'new', newText: 'newer' });
  const historicalChange = extractWordComments(documentWithComment(
    wordIdForTranscript(withLaterChange.id, exportedBeforeLaterChange), exportedBeforeLaterChange
  ));
  assert.equal(prepareWordImport(historicalChange, source, 'document.qmd', { comments: [withLaterChange] })[0].kind, 'unchanged');
});

test('timestamps imported changes after existing activity to preserve historical snapshots', () => {
  const source = 'Before chosen After';
  const existing = comment('timestamped-import-id');
  existing.replies.push({ id: 'reply-a', author: 'Bob', timestamp: '2026-08-30T00:00:00.000Z', text: 'Reply A' });
  const exportedSnapshot = formatWordTranscript(existing);
  const exportedId = wordIdForTranscript(existing.id, exportedSnapshot);
  const changed = extractWordComments(documentWithComment(exportedId, 'Edited in Word'));
  const candidate = prepareWordImport(
    changed, source, 'document.qmd', { comments: [existing] }, '2026-08-30T00:00:00.000Z'
  );
  assert.equal(candidate[0].kind, 'changed');
  if (candidate[0].kind !== 'changed') {throw new Error('expected a changed Word import');}
  assert.equal(candidate[0].replyTimestamp, '2026-08-30T00:00:00.001Z');
  existing.replies.push({ id: 'imported', author: candidate[0].replyAuthor,
    timestamp: candidate[0].replyTimestamp, text: candidate[0].replyText });
  assert.ok(existing.replies[1].timestamp > existing.replies[0].timestamp);

  const untouchedExport = extractWordComments(documentWithComment(exportedId, exportedSnapshot));
  assert.equal(prepareWordImport(untouchedExport, source, 'document.qmd', { comments: [existing] })[0].kind, 'unchanged');
});

test('keeps later activity append-safe for future-dated threads', () => {
  const source = 'Before chosen After';
  const existing = comment('future-thread-id');
  existing.timestamp = '2099-01-01T00:00:00.000Z';
  const firstTimestamp = appendSafeThreadTimestamp(existing, '2026-09-01T00:00:00.000Z');
  assert.ok(firstTimestamp);
  assert.equal(firstTimestamp, '2099-01-01T00:00:00.001Z');
  existing.replies.push({ id: 'first', author: 'Bob', timestamp: firstTimestamp, text: 'First reply' });
  const exportedSnapshot = formatWordTranscript(existing);
  const exportedId = wordIdForTranscript(existing.id, exportedSnapshot);

  const secondTimestamp = appendSafeThreadTimestamp(existing, '2026-09-02T00:00:00.000Z');
  assert.ok(secondTimestamp);
  assert.equal(secondTimestamp, '2099-01-01T00:00:00.002Z');
  existing.replies.push({ id: 'second', author: 'Carol', timestamp: secondTimestamp, text: 'Later reply' });

  const untouchedExport = extractWordComments(documentWithComment(exportedId, exportedSnapshot));
  assert.equal(prepareWordImport(untouchedExport, source, 'document.qmd', { comments: [existing] })[0].kind, 'unchanged');
});

test('fails closed when no representable append-safe timestamp exists', () => {
  const existing = comment('maximum-date-id');
  existing.replies.push({ id: 'maximum', author: 'Bob', timestamp: '+275760-09-13T00:00:00.000Z', text: 'Last date' });
  assert.equal(appendSafeThreadTimestamp(existing, '2026-09-01T00:00:00.000Z'), undefined);

  const body = formatWordTranscript(existing);
  const changed = extractWordComments(documentWithComment(wordIdForTranscript(existing.id, body), 'Edited in Word'));
  const result = prepareWordImport(
    changed, 'Before chosen After', 'document.qmd', { comments: [existing] }, '2026-09-01T00:00:00.000Z'
  );
  assert.equal(result[0].kind, 'conflict');
  if (result[0].kind === 'conflict') {
    assert.match(result[0].reason, /no safe timestamp/);
  }
});

test('allocates a batch against an evolving thread and exhausts the date range safely', () => {
  const existing = comment('timestamp-batch-id');
  const maximum = 8_640_000_000_000_000;
  existing.replies.push({
    id: 'near-maximum', author: 'Bob', timestamp: new Date(maximum - 2).toISOString(), text: 'Near maximum'
  });
  const first = appendSafeThreadTimestamp(existing, '2026-09-01T00:00:00.000Z');
  assert.equal(first, new Date(maximum - 1).toISOString());
  assert.ok(first);
  existing.replies.push({ id: 'first', author: 'Carol', timestamp: first, text: 'First batch reply' });
  const second = appendSafeThreadTimestamp(existing, '2026-09-01T00:00:00.000Z');
  assert.equal(second, new Date(maximum).toISOString());
  assert.ok(second);
  existing.replies.push({ id: 'second', author: 'Dan', timestamp: second, text: 'Second batch reply' });
  assert.equal(appendSafeThreadTimestamp(existing, '2026-09-01T00:00:00.000Z'), undefined);
});

test('formats opening first and activity in deterministic timestamp, kind, and insertion order', () => {
  const value = comment();
  value.timestamp = '2026-09-01T00:00:00.000Z';
  value.replies.push(
    { id: 'reply-a', author: 'Bob', timestamp: '2026-08-30T00:00:00.000Z', text: 'Reply A' },
    { id: 'reply-b', author: 'Carol', timestamp: '2026-08-30T00:00:00.000Z', text: 'Reply B' }
  );
  value.trackedChanges.push({ id: 'change', author: 'Dan', timestamp: '2026-08-30T00:00:00.000Z', previousText: 'old', newText: 'new' });
  assert.equal(formatWordTranscript(value), 'Body\n\n—— Reply · Bob · 2026-08-30T00:00:00.000Z ——\nReply A\n\n—— Reply · Carol · 2026-08-30T00:00:00.000Z ——\nReply B\n\n—— Tracked change · Dan · 2026-08-30T00:00:00.000Z ——\nPrevious: old\nCurrent: new');
});

test('orders legacy timestamp strings by direct ordinal comparison', () => {
  const value = comment();
  value.replies.push(
    { id: 'later', author: 'Bob', timestamp: 'z-legacy', text: 'Later ordinal' },
    { id: 'earlier', author: 'Carol', timestamp: 'A-legacy', text: 'Earlier ordinal' },
    { id: 'astral', author: 'Dan', timestamp: '𐀀', text: 'Astral ordinal' },
    { id: 'bmp', author: 'Eve', timestamp: '', text: 'BMP ordinal' }
  );
  const transcript = formatWordTranscript(value);
  assert.ok(transcript.indexOf('Earlier ordinal') < transcript.indexOf('Later ordinal'));
  assert.ok(transcript.indexOf('BMP ordinal') < transcript.indexOf('Astral ordinal'));
});

test('deduplicates missing or invalid Word timestamps despite different import fallbacks', () => {
  const source = 'Before chosen After';
  for (const date of [undefined, 'not-a-date']) {
    const firstDocument = documentWithComment('123');
    const marker = (firstDocument as { blocks: Array<{ c: unknown[] }> }).blocks[0].c[2] as { c: [unknown, unknown[]] };
    marker.c[0] = ['', ['comment-start'], [['id', '123'], ['author', 'Alice'], ...(date === undefined ? [] : [['date', date]])]];
    const first = extractWordComments(firstDocument, '2026-08-30T00:00:00.000Z');
    assert.equal(first.comments[0].timestampReliable, false);
    const initial = prepareWordImport(first, source, 'document.qmd', { comments: [] });
    assert.equal(initial[0].kind, 'new');
    if (initial[0].kind !== 'new') {throw new Error('expected a new initial Word import');}

    const second = extractWordComments(firstDocument, '2026-08-31T00:00:00.000Z');
    const reimport = prepareWordImport(second, source, 'document.qmd', { comments: [initial[0].comment] });
    assert.equal(reimport[0].kind, 'unchanged');

    const editedDocument = documentWithComment('999', 'Edited in Word');
    const editedMarker = (editedDocument as { blocks: Array<{ c: unknown[] }> }).blocks[0].c[2] as { c: [unknown, unknown[]] };
    editedMarker.c[0] = ['', ['comment-start'], [['id', '999'], ['author', 'Alice'], ...(date === undefined ? [] : [['date', date]])]];
    const edited = extractWordComments(editedDocument, '2026-09-01T00:00:00.000Z');
    const editedResult = prepareWordImport(edited, source, 'document.qmd', { comments: [initial[0].comment] });
    assert.equal(editedResult[0].kind, 'new');
  }
});

test('conflicts reused Word IDs and rejects ambiguous source selections', () => {
  const existing = comment('local-id');
  const source = 'chosen and chosen';
  const reused = extractWordComments(documentWithComment(stableWordId(existing.id), 'Body', 'other'));
  assert.equal(prepareWordImport(reused, source, 'document.qmd', { comments: [existing] })[0].kind, 'ambiguous');
  const incompatible = extractWordComments(documentWithComment(stableWordId(existing.id), 'Body', 'chosen'));
  const result = prepareWordImport(incompatible, 'Before chosen After', 'document.qmd', {
    comments: [{ ...existing, author: 'Bob' }]
  });
  assert.equal(result[0].kind, 'conflict');
});

test('requires mapped range and context evidence before reconciling Word identities', () => {
  const source = 'Before chosen After';
  const moved = comment('local-id');
  moved.range = { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } };
  const stable = extractWordComments(documentWithComment(stableWordId(moved.id)));
  assert.equal(prepareWordImport(stable, source, 'document.qmd', { comments: [moved] })[0].kind, 'conflict');

  const renumbered = extractWordComments(documentWithComment('999'));
  assert.equal(prepareWordImport(renumbered, source, 'document.qmd', { comments: [moved] })[0].kind, 'new');

  const contextMoved = comment('local-id');
  contextMoved.contextBefore = 'different context';
  const contextResult = prepareWordImport(stable, source, 'document.qmd', { comments: [contextMoved] });
  assert.equal(contextResult[0].kind, 'conflict');
});

test('formats a readable literal flattened transcript', () => {
  const value = comment();
  value.replies.push({ id: 'reply', author: 'Bob', timestamp: '2026-08-30T00:00:00.000Z', text: '<literal>' });
  value.trackedChanges.push({ id: 'change', author: 'Alice', timestamp: '2026-08-31T00:00:00.000Z', previousText: 'old', newText: 'new' });
  assert.equal(formatWordTranscript(value), 'Body\n\n—— Reply · Bob · 2026-08-30T00:00:00.000Z ——\n<literal>\n\n—— Tracked change · Alice · 2026-08-31T00:00:00.000Z ——\nPrevious: old\nCurrent: new');
});

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, test } from 'node:test';
import {
  collapseTrackedChanges,
  collapseTrackedChangesBetweenReplies,
  CommentStore,
  hasMergeableTrackedChanges,
  TrackedTextChangeData
} from './model';
import { CommentRepository } from './repository';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function makeRepository(): CommentRepository {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'comment-tracker-'));
  temporaryDirectories.push(directory);
  return new CommentRepository(directory);
}

function oneCommentStore(): CommentStore {
  return {
    comments: [{
      id: 'one',
      author: 'Tester',
      timestamp: '2026-01-01T00:00:00.000Z',
      text: 'Review this',
      filePath: 'document.md',
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 8 }
      },
      replies: [],
      trackedChanges: [],
      resolved: false
    }]
  };
}

test('does not create storage for an empty store', () => {
  const repository = makeRepository();
  repository.loadInitial();

  assert.deepEqual(repository.save({ comments: [] }), { kind: 'saved' });
  assert.equal(fs.existsSync(repository.directoryPath), false);
  assert.equal(fs.existsSync(repository.filePath), false);
});

test('removes storage when the final comment is deleted', () => {
  const repository = makeRepository();
  repository.loadInitial();
  assert.deepEqual(repository.save(oneCommentStore()), { kind: 'saved' });

  assert.deepEqual(repository.save({ comments: [] }), { kind: 'saved' });
  assert.equal(fs.existsSync(repository.filePath), false);
  assert.equal(fs.existsSync(repository.directoryPath), false);
});

test('does not overwrite an externally edited store', () => {
  const repository = makeRepository();
  repository.loadInitial();
  assert.deepEqual(repository.save(oneCommentStore()), { kind: 'saved' });
  fs.writeFileSync(repository.filePath, '{ "comments": [] }\n', 'utf8');

  const changedStore = oneCommentStore();
  changedStore.comments[0].text = 'Extension edit';
  assert.deepEqual(repository.save(changedStore), { kind: 'conflict' });
  assert.equal(fs.readFileSync(repository.filePath, 'utf8'), '{ "comments": [] }\n');
});

test('round-trips tracked selection changes', () => {
  const repository = makeRepository();
  repository.loadInitial();
  const store = oneCommentStore();
  store.comments[0].trackedChanges = [{
    id: 'change-one',
    author: 'Tester',
    timestamp: '2026-01-01T00:01:00.000Z',
    previousText: 'old wording',
    newText: 'new wording'
  }];
  assert.deepEqual(repository.save(store), { kind: 'saved' });

  const reloaded = new CommentRepository(path.dirname(repository.directoryPath)).loadInitial();
  assert.deepEqual(reloaded, store);
});

test('collapses tracked changes to the oldest removal and newest addition', () => {
  const changes: TrackedTextChangeData[] = [{
    id: 'first',
    author: 'First editor',
    timestamp: '2026-01-01T00:00:00.000Z',
    previousText: 'original',
    newText: 'middle'
  }, {
    id: 'second',
    author: 'Second editor',
    timestamp: '2026-01-01T00:01:00.000Z',
    previousText: 'middle',
    newText: 'final'
  }];

  assert.deepEqual(collapseTrackedChanges(changes), [{
    ...changes[0],
    author: 'First editor, Second editor',
    newText: 'final'
  }]);
});

test('does not merge tracked changes across a reply', () => {
  const changes: TrackedTextChangeData[] = [{
    id: 'before-reply',
    author: 'Editor',
    timestamp: '2026-01-01T00:01:00.000Z',
    previousText: 'first',
    newText: 'second'
  }, {
    id: 'after-reply',
    author: 'Editor',
    timestamp: '2026-01-01T00:03:00.000Z',
    previousText: 'second',
    newText: 'third'
  }];
  const replyTimestamps = ['2026-01-01T00:02:00.000Z'];

  assert.equal(hasMergeableTrackedChanges(changes, replyTimestamps), false);
  assert.deepEqual(
    collapseTrackedChangesBetweenReplies(changes, replyTimestamps),
    changes
  );
});

test('merges each uninterrupted run of tracked changes independently', () => {
  const changes: TrackedTextChangeData[] = [{
    id: 'first',
    author: 'Editor',
    timestamp: '2026-01-01T00:01:00.000Z',
    previousText: 'one',
    newText: 'two'
  }, {
    id: 'second',
    author: 'Editor',
    timestamp: '2026-01-01T00:02:00.000Z',
    previousText: 'two',
    newText: 'three'
  }, {
    id: 'third',
    author: 'Editor',
    timestamp: '2026-01-01T00:04:00.000Z',
    previousText: 'three',
    newText: 'four'
  }, {
    id: 'fourth',
    author: 'Editor',
    timestamp: '2026-01-01T00:05:00.000Z',
    previousText: 'four',
    newText: 'five'
  }];

  assert.equal(
    hasMergeableTrackedChanges(changes, ['2026-01-01T00:03:00.000Z']),
    true
  );
  assert.deepEqual(
    collapseTrackedChangesBetweenReplies(changes, ['2026-01-01T00:03:00.000Z']),
    [{
      ...changes[0],
      newText: 'three'
    }, {
      ...changes[2],
      newText: 'five'
    }]
  );
});

import * as fs from 'fs';
import * as path from 'path';
import { CommentStore, parseCommentStore } from './model';

export type ReloadResult =
  | { kind: 'unchanged' }
  | { kind: 'loaded'; store: CommentStore }
  | { kind: 'deleted'; store: CommentStore }
  | { kind: 'invalid'; error: Error }
  | { kind: 'failed'; error: Error };

export type SaveResult =
  | { kind: 'saved' }
  | { kind: 'conflict' }
  | { kind: 'failed'; error: Error };

export class CommentRepository {
  readonly directoryPath: string;
  readonly filePath: string;
  private knownRaw: string | undefined;

  constructor(workspacePath: string) {
    this.directoryPath = path.join(workspacePath, '.comments');
    this.filePath = path.join(this.directoryPath, 'collab-comments.json');
  }

  loadInitial(): CommentStore {
    if (!fs.existsSync(this.filePath)) {
      this.knownRaw = undefined;
      return { comments: [] };
    }
    const raw = fs.readFileSync(this.filePath, 'utf8');
    const store = parseCommentStore(raw);
    this.knownRaw = raw;
    return store;
  }

  reloadIfChanged(): ReloadResult {
    if (!fs.existsSync(this.filePath)) {
      if (this.knownRaw === undefined) {
        return { kind: 'unchanged' };
      }
      this.knownRaw = undefined;
      return { kind: 'deleted', store: { comments: [] } };
    }

    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (error) {
      return {
        kind: 'failed',
        error: error instanceof Error ? error : new Error(String(error))
      };
    }
    if (raw === this.knownRaw) {
      return { kind: 'unchanged' };
    }
    try {
      const store = parseCommentStore(raw);
      this.knownRaw = raw;
      return { kind: 'loaded', store };
    } catch (error) {
      return {
        kind: 'invalid',
        error: error instanceof Error ? error : new Error(String(error))
      };
    }
  }

  save(store: CommentStore): SaveResult {
    try {
      const currentRaw = fs.existsSync(this.filePath)
        ? fs.readFileSync(this.filePath, 'utf8')
        : undefined;
      if (currentRaw !== this.knownRaw) {
        return { kind: 'conflict' };
      }

      if (store.comments.length === 0) {
        if (currentRaw !== undefined) {
          fs.unlinkSync(this.filePath);
        }
        this.knownRaw = undefined;
        this.removeDirectoryIfEmpty();
        return { kind: 'saved' };
      }

      fs.mkdirSync(this.directoryPath, { recursive: true });
      const raw = `${JSON.stringify(store, null, 2)}\n`;
      fs.writeFileSync(this.filePath, raw, 'utf8');
      this.knownRaw = raw;
      return { kind: 'saved' };
    } catch (error) {
      return {
        kind: 'failed',
        error: error instanceof Error ? error : new Error(String(error))
      };
    }
  }

  private removeDirectoryIfEmpty(): void {
    if (!fs.existsSync(this.directoryPath)) {
      return;
    }
    if (fs.readdirSync(this.directoryPath).length === 0) {
      fs.rmdirSync(this.directoryPath);
    }
  }
}

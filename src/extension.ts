import * as path from 'path';
import * as fs from 'fs';
import { createHash, randomUUID } from 'crypto';
import * as vscode from 'vscode';
import {
  captureAnchor,
  locateAnchor,
  LocatedAnchor,
  offsetToPosition,
  positionToOffset,
  TextChange,
  transformRange
} from './anchors';
import {
  collapseTrackedChangesBetweenReplies,
  CommentData,
  CommentReplyData,
  CommentStore,
  hasMergeableTrackedChanges,
  StoredPosition,
  StoredRange,
  TrackedTextChangeData
} from './model';
import { CommentRepository, ReloadResult } from './repository';
import { commentInViewport, HighlightCandidate, nearestCommentAtLine, viewportFraction } from './highlight';
import { ReviewSurface } from './reviewSurface';
import { PanelState, WebviewSurface } from './webviewSurface';
import { PanelRequest } from './panelProtocol';
import { QuartoAction, QuartoBridgeState, QuartoPreviewBridge, shouldStartQuartoBridge } from './quartoBridge';
import { mapRenderedSelection, sourceHash } from './quartoMapping';

const SAVE_DELAY_MS = 500;
const EXTERNAL_RELOAD_DELAY_MS = 150;
const TRACKED_CHANGE_COALESCE_MS = 2_000;
const SELECTION_SYNC_DELAY_MS = 250;
const SCROLL_SYNC_DELAY_MS = 50;

let webviewSurface: WebviewSurface;
let commentHighlightDecoration: vscode.TextEditorDecorationType;
let resolvedHighlightDecoration: vscode.TextEditorDecorationType;
const surfaces: ReviewSurface[] = [];
let commentsTreeProvider: CommentsTreeProvider;
let repository: CommentRepository | undefined;
let workspaceFolder: vscode.WorkspaceFolder | undefined;
let commentStore: CommentStore = { comments: [] };
let saveTimeout: NodeJS.Timeout | undefined;
let reloadTimeout: NodeJS.Timeout | undefined;
let selectionSyncTimeout: NodeJS.Timeout | undefined;
let scrollSyncTimeout: NodeJS.Timeout | undefined;
let restoreVersion = 0;
let showResolvedComments = false;
let quartoBridge: QuartoPreviewBridge | undefined;

const anchorConfidence = new Map<string, LocatedAnchor['confidence']>();
const pendingTrackedChanges = new Map<string, {
  changeId: string;
  originalText: string;
  timeout: NodeJS.Timeout;
}>();

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (workspaceFolder) {
    repository = new CommentRepository(workspaceFolder.uri.fsPath);
    try {
      commentStore = repository.loadInitial();
    } catch (error) {
      showStoreError('Could not load the comments file', error);
    }
  }

  webviewSurface = new WebviewSurface(
    context.extensionUri,
    loadPanelState,
    request => handlePanelRequest(request)
  );
  surfaces.push(webviewSurface);
  commentHighlightDecoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'rgba(234, 179, 8, 0.18)',
    borderRadius: '3px'
  });
  resolvedHighlightDecoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'rgba(128, 128, 128, 0.12)',
    borderRadius: '3px'
  });

  commentsTreeProvider = new CommentsTreeProvider();
  await vscode.commands.executeCommand(
    'setContext',
    'commentTracker.showResolvedComments',
    showResolvedComments
  );
  context.subscriptions.push(
    commentHighlightDecoration,
    resolvedHighlightDecoration,
    vscode.window.registerWebviewViewProvider(WebviewSurface.viewId, webviewSurface),
    vscode.window.registerTreeDataProvider('commentTrackerView', commentsTreeProvider),
    vscode.workspace.onDidChangeTextDocument(handleDocumentChange),
    vscode.window.onDidChangeVisibleTextEditors(() => refreshDecorations()),
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (isStorageUri(document.uri)) {
        scheduleExternalReload(0);
      }
    }),
    vscode.window.onDidChangeActiveTextEditor(() => {
      webviewSurface.pushState();
      refreshDecorations();
    }),
    vscode.window.onDidChangeTextEditorSelection((event) => {
      if (selectionSyncTimeout) {
        clearTimeout(selectionSyncTimeout);
      }
      selectionSyncTimeout = setTimeout(() => {
        selectionSyncTimeout = undefined;
        syncPanelHighlight(event.textEditor);
      }, SELECTION_SYNC_DELAY_MS);
    }),
    vscode.window.onDidChangeTextEditorVisibleRanges((event) => {
      if (scrollSyncTimeout) {
        clearTimeout(scrollSyncTimeout);
      }
      scrollSyncTimeout = setTimeout(() => {
        scrollSyncTimeout = undefined;
        syncPanelScroll(event.textEditor, event.visibleRanges);
      }, SCROLL_SYNC_DELAY_MS);
    }),
    ...registerCommands()
  );

  if (workspaceFolder && repository) {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(workspaceFolder, '.comments/collab-comments.json')
    );
    watcher.onDidCreate(() => scheduleExternalReload(), undefined, context.subscriptions);
    watcher.onDidChange(() => scheduleExternalReload(), undefined, context.subscriptions);
    watcher.onDidDelete(() => scheduleExternalReload(), undefined, context.subscriptions);
    context.subscriptions.push(watcher);
    if (shouldStartQuartoBridge(vscode.env.remoteName)) {
      quartoBridge = new QuartoPreviewBridge(workspaceFolder.uri.fsPath, {
        state: bridgeState,
        action: bridgeAction
      });
      try {
        await quartoBridge.start();
        context.subscriptions.push({ dispose: () => quartoBridge?.dispose() });
      } catch (error) {
        quartoBridge.dispose();
        quartoBridge = undefined;
        const reason = error instanceof Error ? error.message : String(error);
        void vscode.window.showWarningMessage(`Comment Tracker Quarto preview bridge is unavailable: ${reason}`);
      }
    }
  }

  await restoreAllThreads();
}

function registerCommands(): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('comment-tracker.addComment', addComment),
    vscode.commands.registerCommand('comment-tracker.viewComments', viewComments),
    vscode.commands.registerCommand('comment-tracker.deleteComment', deleteComment),
    vscode.commands.registerCommand('comment-tracker.deleteReply', deleteReplyInteractive),
    vscode.commands.registerCommand(
      'comment-tracker.navigateToComment',
      (comment: CommentData) => navigateToComment(comment)
    ),
    vscode.commands.registerCommand('comment-tracker.exportToMarkdown', exportToMarkdown),
    vscode.commands.registerCommand('comment-tracker.deleteAllComments', deleteAllComments),
    vscode.commands.registerCommand('comment-tracker.openReviewPanel', openReviewPanel),
    vscode.commands.registerCommand(
      'comment-tracker.showResolvedComments',
      () => setResolvedCommentsVisible(true)
    ),
    vscode.commands.registerCommand(
      'comment-tracker.hideResolvedComments',
      () => setResolvedCommentsVisible(false)
    ),
    vscode.commands.registerCommand(
      'comment-tracker.resolveTreeComment',
      (item: CommentTreeItem) => setTreeCommentResolved(item, true)
    ),
    vscode.commands.registerCommand(
      'comment-tracker.unresolveTreeComment',
      (item: CommentTreeItem) => setTreeCommentResolved(item, false)
    )
  ];
}

function isStorageUri(uri: vscode.Uri): boolean {
  if (!repository) {
    return false;
  }
  const candidate = path.normalize(uri.fsPath);
  const storagePath = path.normalize(repository.filePath);
  return process.platform === 'win32'
    ? candidate.toLocaleLowerCase() === storagePath.toLocaleLowerCase()
    : candidate === storagePath;
}

function storageDocumentIsDirty(): boolean {
  return vscode.workspace.textDocuments.some(
    (document) => isStorageUri(document.uri) && document.isDirty
  );
}

function isTrackableDocument(uri: vscode.Uri): boolean {
  return uri.scheme === 'file'
    && workspaceFolder !== undefined
    && vscode.workspace.getWorkspaceFolder(uri)?.uri.toString() === workspaceFolder.uri.toString()
    && !isStorageUri(uri);
}

function relativeFilePath(uri: vscode.Uri): string | undefined {
  if (!isTrackableDocument(uri) || !workspaceFolder) {
    return undefined;
  }
  const relative = path.relative(workspaceFolder.uri.fsPath, uri.fsPath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return undefined;
  }
  return relative.split(path.sep).join('/');
}

function uriForComment(comment: CommentData): vscode.Uri | undefined {
  if (!workspaceFolder) {
    return undefined;
  }
  const segments = comment.filePath.split(/[\\/]/).filter(Boolean);
  if (segments.length === 0 || segments.some(segment => segment === '..')) {
    return undefined;
  }
  return vscode.Uri.joinPath(workspaceFolder.uri, ...segments);
}

async function ensureStoreCurrent(): Promise<boolean> {
  if (!repository) {
    vscode.window.showErrorMessage('Open a workspace folder before using Comment Tracker.');
    return false;
  }
  if (storageDocumentIsDirty()) {
    vscode.window.showWarningMessage(
      'Save or discard the open comments JSON edits before changing comments in the editor.'
    );
    return false;
  }

  const result = repository.reloadIfChanged();
  if (result.kind === 'failed') {
    showStoreError('Could not check the comments JSON for external changes', result.error);
    return false;
  }
  if (result.kind === 'invalid') {
    showStoreError('The comments JSON is invalid and will not be overwritten', result.error);
    return false;
  }
  if (result.kind === 'loaded' || result.kind === 'deleted') {
    await applyExternalStore(result, false);
  }
  return true;
}

function persistComments(showErrors = true): boolean {
  if (!repository || storageDocumentIsDirty()) {
    return false;
  }

  const result = repository.save(commentStore);
  if (result.kind === 'saved') {
    commentsTreeProvider.refresh();
    webviewSurface.pushState();
    refreshDecorations();
    return true;
  }
  if (result.kind === 'conflict') {
    scheduleExternalReload(0);
    if (showErrors) {
      vscode.window.showWarningMessage(
        'The comments JSON changed outside Comment Tracker. It was not overwritten; reloading it now.'
      );
    }
    return false;
  }
  if (showErrors) {
    showStoreError('Failed to save comments', result.error);
  }
  return false;
}

function schedulePersist(): void {
  if (saveTimeout) {
    clearTimeout(saveTimeout);
  }
  saveTimeout = setTimeout(() => {
    saveTimeout = undefined;
    persistComments(false);
  }, SAVE_DELAY_MS);
}

function scheduleExternalReload(delay = EXTERNAL_RELOAD_DELAY_MS): void {
  if (reloadTimeout) {
    clearTimeout(reloadTimeout);
  }
  reloadTimeout = setTimeout(() => {
    reloadTimeout = undefined;
    void reloadExternalStore();
  }, delay);
}

async function reloadExternalStore(): Promise<void> {
  if (!repository || storageDocumentIsDirty()) {
    return;
  }
  const result = repository.reloadIfChanged();
  if (result.kind === 'unchanged') {
    return;
  }
  if (result.kind === 'failed') {
    showStoreError('Could not reload the comments JSON', result.error);
    return;
  }
  if (result.kind === 'invalid') {
    showStoreError('The comments JSON is invalid and has not been applied', result.error);
    return;
  }
  await applyExternalStore(result, true);
}

async function applyExternalStore(
  result: Extract<ReloadResult, { kind: 'loaded' | 'deleted' }>,
  notify: boolean
): Promise<void> {
  if (saveTimeout) {
    clearTimeout(saveTimeout);
    saveTimeout = undefined;
  }
  commentStore = result.store;
  await restoreAllThreads();
  commentsTreeProvider.refresh();
  webviewSurface.pushState();
  refreshDecorations();
  if (notify) {
    vscode.window.showInformationMessage(
      result.kind === 'deleted'
        ? 'Comments were cleared because the comments JSON was removed.'
        : 'Comments reloaded from the updated JSON file.'
    );
  }
}

function showStoreError(prefix: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(prefix, error);
  vscode.window.showErrorMessage(`${prefix}: ${detail}`);
}

function toStoredRange(range: vscode.Range): StoredRange {
  return {
    start: { line: range.start.line, character: range.start.character },
    end: { line: range.end.line, character: range.end.character }
  };
}

function toVsRange(range: StoredRange): vscode.Range {
  return new vscode.Range(
    range.start.line,
    range.start.character,
    range.end.line,
    range.end.character
  );
}

function rangesEqual(left: StoredRange, right: StoredRange): boolean {
  return left.start.line === right.start.line
    && left.start.character === right.start.character
    && left.end.line === right.end.line
    && left.end.character === right.end.character;
}

function buildCommentData(
  document: vscode.TextDocument,
  range: vscode.Range,
  text: string,
  author: string
): CommentData | undefined {
  const filePath = relativeFilePath(document.uri);
  if (!filePath) {
    return undefined;
  }
  const fullText = document.getText();
  const start = document.offsetAt(range.start);
  const end = document.offsetAt(range.end);
  return {
    id: randomUUID(),
    author,
    timestamp: new Date().toISOString(),
    text,
    filePath,
    range: toStoredRange(range),
    ...captureAnchor(fullText, start, end),
    documentHash: hashDocument(fullText),
    replies: [],
    trackedChanges: [],
    resolved: false
  };
}

function commentHasMergeableTrackedChanges(comment: CommentData): boolean {
  return hasMergeableTrackedChanges(
    comment.trackedChanges ?? [],
    (comment.replies ?? []).map(reply => reply.timestamp)
  );
}

function surfaceUpsert(comment: CommentData): void {
  for (const surface of surfaces) {
    surface.upsert(comment);
  }
}

function surfaceReconfigure(commentId: string, comment: CommentData): void {
  for (const surface of surfaces) {
    surface.reconfigure(commentId, comment);
  }
}

function surfaceRemove(commentId: string): void {
  for (const surface of surfaces) {
    surface.remove(commentId);
  }
}

function surfaceClear(): void {
  for (const surface of surfaces) {
    surface.clear();
  }
}

/**
 * Keeps the always-on Word-style highlight in sync: open threads get a soft
 * amber wash, resolved ones (when visible) a faint gray one.
 */
function refreshDecorations(): void {
  for (const editor of vscode.window.visibleTextEditors) {
    const filePath = relativeFilePath(editor.document.uri);
    const active: vscode.Range[] = [];
    const resolved: vscode.Range[] = [];
    if (filePath) {
      for (const comment of commentStore.comments) {
        if (comment.filePath !== filePath) {
          continue;
        }
        if (comment.resolved) {
          if (showResolvedComments) {
            resolved.push(toVsRange(comment.range));
          }
        } else {
          active.push(toVsRange(comment.range));
        }
      }
    }
    editor.setDecorations(commentHighlightDecoration, active);
    editor.setDecorations(resolvedHighlightDecoration, resolved);
  }
}

function loadPanelState(): PanelState {
  const editor = vscode.window.activeTextEditor;
  const file = editor ? relativeFilePath(editor.document.uri) : null;
  return {
    file: file ?? null,
    showResolved: showResolvedComments,
    comments: file ? commentStore.comments.filter(comment => comment.filePath === file) : []
  };
}

function syncPanelHighlight(editor: vscode.TextEditor): void {
  const filePath = relativeFilePath(editor.document.uri);
  if (!filePath) {
    return;
  }
  const line = editor.selection.active.line;
  const candidates = visibleCandidates(filePath);
  webviewSurface.highlight(nearestCommentAtLine(candidates, line));
}

function syncPanelScroll(
  editor: vscode.TextEditor,
  visibleRanges: readonly vscode.Range[]
): void {
  if (!vscode.workspace.getConfiguration('commentTracker').get<boolean>('scrollSyncPanel', true)) {
    return;
  }
  if (editor !== vscode.window.activeTextEditor) {
    return;
  }
  const filePath = relativeFilePath(editor.document.uri);
  if (!filePath || visibleRanges.length === 0) {
    return;
  }
  const top = visibleRanges[0].start.line;
  const bottom = visibleRanges[visibleRanges.length - 1].end.line;
  webviewSurface.anchor(viewportFraction(top, bottom, editor.document.lineCount));
  webviewSurface.highlight(commentInViewport(visibleCandidates(filePath), top, bottom), false);
}

function visibleCandidates(filePath: string): HighlightCandidate[] {
  return commentStore.comments
    .filter(comment => comment.filePath === filePath && (showResolvedComments || !comment.resolved))
    .map(comment => ({
      id: comment.id,
      startLine: comment.range.start.line,
      endLine: comment.range.end.line
    }));
}

async function handlePanelRequest(request: PanelRequest): Promise<void> {
  switch (request.type) {
    case 'navigate': {
      const comment = commentStore.comments.find(item => item.id === request.commentId);
      if (comment) {
        await navigateToComment(comment);
      }
      return;
    }
    case 'reply': {
      if (!await ensureStoreCurrent()) {
        return;
      }
      await applyStoreAction({
        type: 'reply',
        threadId: request.commentId,
        author: getPassiveAuthorName(),
        text: request.text
      });
      return;
    }
    case 'resolve': {
      if (!await ensureStoreCurrent()) {
        return;
      }
      await applyStoreAction({
        type: 'set-resolved',
        threadId: request.commentId,
        resolved: request.resolved
      });
      return;
    }
    case 'delete-thread': {
      const confirmed = await vscode.window.showWarningMessage(
        'Delete this comment thread?',
        { modal: true },
        'Delete'
      );
      if (confirmed !== 'Delete' || !await ensureStoreCurrent()) {
        return;
      }
      await applyStoreAction({ type: 'delete-thread', threadId: request.commentId });
      return;
    }
    case 'delete-reply': {
      const confirmed = await vscode.window.showWarningMessage(
        'Delete this reply?',
        { modal: true },
        'Delete'
      );
      if (confirmed !== 'Delete' || !await ensureStoreCurrent()) {
        return;
      }
      await applyStoreAction({
        type: 'delete-reply',
        threadId: request.commentId,
        replyId: request.replyId
      });
      return;
    }
    case 'merge-tracked-changes': {
      const comment = commentStore.comments.find(item => item.id === request.commentId);
      if (!comment || !commentHasMergeableTrackedChanges(comment)) {
        vscode.window.showInformationMessage(
          'This thread has no consecutive tracked changes to merge.'
        );
        return;
      }
      const merged = collapseTrackedChangesBetweenReplies(
        comment.trackedChanges ?? [],
        (comment.replies ?? []).map(reply => reply.timestamp)
      );
      const removedCount = (comment.trackedChanges?.length ?? 0) - merged.length;
      const confirmed = await vscode.window.showWarningMessage(
        `Remove ${removedCount} intermediate tracked `
          + `change${removedCount === 1 ? '' : 's'}? Changes separated by replies will remain separate.`,
        { modal: true },
        'Merge'
      );
      if (confirmed !== 'Merge' || !await ensureStoreCurrent()) {
        return;
      }
      await applyStoreAction({ type: 'merge-tracked-changes', threadId: request.commentId });
      return;
    }
    case 'show-resolved': {
      await setResolvedCommentsVisible(request.visible);
      return;
    }
  }
}

type StoreAction =
  | { type: 'reply'; threadId: string; author: string; text: string }
  | { type: 'set-resolved'; threadId: string; resolved: boolean }
  | { type: 'delete-thread'; threadId: string }
  | { type: 'delete-reply'; threadId: string; replyId: string }
  | { type: 'merge-tracked-changes'; threadId: string };

/**
 * The one mutation path for thread-level store changes. The Quarto preview
 * bridge and the review panel both route through here so guards (dirty
 * storage, external edits) and rollback behave identically everywhere.
 */
async function applyStoreAction(action: StoreAction): Promise<void> {
  const snapshot = structuredClone(commentStore);
  const find = (id: string): CommentData => {
    const comment = commentStore.comments.find(item => item.id === id);
    if (!comment) {
      throw new Error('The requested comment thread no longer exists.');
    }
    return comment;
  };
  try {
    if (action.type === 'reply') {
      const comment = find(action.threadId);
      // A reply is a conversation boundary: later text edits must start a new
      // tracked-change run even if they occur within the typing debounce window.
      clearPendingTrackedChange(comment.id);
      comment.replies = [...(comment.replies ?? []), {
        id: randomUUID(),
        author: action.author,
        timestamp: new Date().toISOString(),
        text: action.text
      }];
      surfaceReconfigure(comment.id, comment);
    } else if (action.type === 'set-resolved') {
      const comment = find(action.threadId);
      comment.resolved = action.resolved;
      surfaceReconfigure(comment.id, comment);
    } else if (action.type === 'delete-thread') {
      const comment = find(action.threadId);
      commentStore.comments = commentStore.comments.filter(item => item.id !== comment.id);
      surfaceRemove(comment.id);
      anchorConfidence.delete(comment.id);
      clearPendingTrackedChange(comment.id);
    } else if (action.type === 'delete-reply') {
      const comment = find(action.threadId);
      const replies = comment.replies ?? [];
      if (!replies.some(reply => reply.id === action.replyId)) {
        throw new Error('The requested reply no longer exists.');
      }
      comment.replies = replies.filter(reply => reply.id !== action.replyId);
      surfaceReconfigure(comment.id, comment);
    } else if (action.type === 'merge-tracked-changes') {
      const comment = find(action.threadId);
      if (!commentHasMergeableTrackedChanges(comment)) {
        throw new Error('There are no consecutive tracked changes to merge.');
      }
      clearPendingTrackedChange(comment.id);
      comment.trackedChanges = collapseTrackedChangesBetweenReplies(
        comment.trackedChanges ?? [],
        (comment.replies ?? []).map(reply => reply.timestamp)
      );
      surfaceReconfigure(comment.id, comment);
    }
    if (!persistComments()) {
      // A request is not allowed to leave the UI showing a mutation that was
      // rejected because another process changed the JSON store.
      throw new Error('The comments store could not be saved without overwriting external changes.');
    }
  } catch (error) {
    commentStore = snapshot;
    await restoreAllThreads();
    throw error;
  }
}

function hashDocument(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function bridgeFileUri(filePath: string): vscode.Uri {
  return vscode.Uri.file(filePath);
}

function bridgeSource(filePath: string): { uri: vscode.Uri; relative: string; text: string } {
  const uri = bridgeFileUri(filePath);
  const relative = relativeFilePath(uri);
  if (!relative || path.extname(relative).toLowerCase() !== '.qmd') {
    throw new Error('Only QMD files in the current workspace can use preview comments.');
  }
  const open = vscode.workspace.textDocuments.find(document => document.uri.fsPath === uri.fsPath);
  if (open?.isDirty) {
    throw new Error('Save the QMD document before changing its preview comments.');
  }
  return { uri, relative, text: fs.readFileSync(uri.fsPath, 'utf8') };
}

async function bridgeState(filePath: string): Promise<QuartoBridgeState> {
  if (!await ensureStoreCurrent()) {
    throw new Error('The comments store is dirty, invalid, or changed externally.');
  }
  const source = bridgeSource(filePath);
  return {
    sourceText: source.text,
    sourceHash: sourceHash(source.text),
    author: getPassiveAuthorName(),
    comments: commentStore.comments.filter(comment => comment.filePath === source.relative),
    etag: hashDocument(`${sourceHash(source.text)}:${JSON.stringify(commentStore)}`)
  };
}

async function bridgeAction(
  filePath: string,
  action: QuartoAction
): Promise<QuartoBridgeState | { status: string }> {
  if (!await ensureStoreCurrent()) {
    throw new Error('The comments store is dirty, invalid, or changed externally.');
  }
  const source = bridgeSource(filePath);
  if (action.type === 'navigate') {
    await navigateToComment(findBridgeComment(source.relative, action.threadId));
    return { status: 'navigated' };
  }
  if (action.type === 'add') {
    const snapshot = structuredClone(commentStore);
    try {
      if (action.sourceHash !== sourceHash(source.text)) {
        throw new Error('The preview is stale. Refresh it before adding a comment.');
      }
      const mapped = mapRenderedSelection(source.text, action.selection);
      if (!mapped) {
        throw new Error('That rendered selection cannot be mapped uniquely to QMD source text.');
      }
      const comment: CommentData = {
        id: randomUUID(), author: action.author, timestamp: new Date().toISOString(), text: action.text,
        filePath: source.relative, range: mapped.range, selectedText: mapped.selectedText,
        contextBefore: mapped.contextBefore, contextAfter: mapped.contextAfter,
        documentHash: sourceHash(source.text), replies: [], trackedChanges: [], resolved: false
      };
      commentStore.comments.push(comment);
      surfaceUpsert(comment);
      anchorConfidence.set(comment.id, 'exact');
      if (!persistComments()) {
        // A bridge request is not allowed to leave VS Code showing a mutation
        // that was rejected because another process changed the JSON store.
        throw new Error('The comments store could not be saved without overwriting external changes.');
      }
    } catch (error) {
      commentStore = snapshot;
      await restoreAllThreads();
      throw error;
    }
    return bridgeState(filePath);
  }
  await applyStoreAction(action);
  return bridgeState(filePath);
}

function findBridgeComment(relative: string, threadId: string): CommentData {
  const comment = commentStore.comments.find(item => item.id === threadId && item.filePath === relative);
  if (!comment) {
    throw new Error('The requested comment thread no longer exists.');
  }
  return comment;
}

function locateComment(document: vscode.TextDocument, comment: CommentData): vscode.Range {
  const text = document.getText();
  const currentHash = hashDocument(text);
  const located = comment.documentHash === currentHash
    ? {
      start: positionToOffset(text, comment.range.start),
      end: positionToOffset(text, comment.range.end),
      confidence: 'exact' as const
    }
    : locateAnchor(text, comment);
  comment.range = {
    start: offsetToPosition(text, located.start),
    end: offsetToPosition(text, located.end)
  };
  comment.documentHash = currentHash;
  anchorConfidence.set(comment.id, located.confidence);
  return toVsRange(comment.range);
}

async function restoreAllThreads(): Promise<void> {
  const version = ++restoreVersion;
  clearAllPendingTrackedChanges();
  surfaceClear();
  anchorConfidence.clear();

  for (const comment of commentStore.comments) {
    if (version !== restoreVersion) {
      return;
    }
    const uri = uriForComment(comment);
    if (!uri) {
      continue;
    }
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      if (version !== restoreVersion) {
        return;
      }
      locateComment(document, comment);
      surfaceUpsert(comment);
    } catch (error) {
      anchorConfidence.set(comment.id, 'position');
      console.warn(`Could not restore comment ${comment.id} for ${comment.filePath}`, error);
    }
  }
  webviewSurface.pushState();
  refreshDecorations();
}

async function getAuthorName(): Promise<string | undefined> {
  const configured = vscode.workspace
    .getConfiguration('commentTracker')
    .get<string>('defaultAuthor')
    ?.trim();
  if (configured) {
    return configured;
  }
  return vscode.window.showInputBox({
    prompt: 'Enter your name (or set a default in settings)',
    placeHolder: 'Your name',
    value: process.env.USER || process.env.USERNAME || 'Anonymous'
  });
}

function getPassiveAuthorName(): string {
  return vscode.workspace
    .getConfiguration('commentTracker')
    .get<string>('defaultAuthor')
    ?.trim()
    || process.env.USER
    || process.env.USERNAME
    || 'Unknown editor';
}

async function addComment(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !isTrackableDocument(editor.document.uri)) {
    vscode.window.showErrorMessage('Open a file in the current workspace before adding a comment.');
    return;
  }
  if (!await ensureStoreCurrent()) {
    return;
  }

  const selection = editor.selection;
  const range = selection.isEmpty
    ? editor.document.lineAt(selection.start.line).range
    : new vscode.Range(selection.start, selection.end);
  const text = await vscode.window.showInputBox({
    prompt: 'Enter your comment',
    placeHolder: 'Type your comment here...'
  });
  if (!text?.trim()) {
    return;
  }
  const author = await getAuthorName();
  if (!author?.trim()) {
    return;
  }

  const comment = buildCommentData(editor.document, range, text.trim(), author.trim());
  if (!comment) {
    vscode.window.showErrorMessage('This file is outside the Comment Tracker workspace.');
    return;
  }
  surfaceUpsert(comment);
  commentStore.comments.push(comment);
  anchorConfidence.set(comment.id, 'exact');
  persistComments();
}

async function setTreeCommentResolved(
  item: CommentTreeItem | undefined,
  requestedState: boolean
): Promise<void> {
  if (!item || item.kind !== 'comment') {
    return;
  }
  await setCommentResolvedById(item.comment.id, requestedState);
}

async function setCommentResolvedById(
  commentId: string | undefined,
  requestedState: boolean
): Promise<void> {
  if (!await ensureStoreCurrent()) {
    return;
  }
  const comment = commentStore.comments.find(item => item.id === commentId);
  if (!comment) {
    vscode.window.showErrorMessage('Comment data not found.');
    return;
  }
  comment.resolved = requestedState;
  surfaceReconfigure(comment.id, comment);
  persistComments();
}

async function deleteComment(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const filePath = editor ? relativeFilePath(editor.document.uri) : undefined;
  if (!filePath || !await ensureStoreCurrent()) {
    vscode.window.showInformationMessage('No tracked file is currently open.');
    return;
  }
  const comments = commentStore.comments.filter(comment => comment.filePath === filePath);
  if (comments.length === 0) {
    vscode.window.showInformationMessage('No comments found for this file.');
    return;
  }
  const selected = await vscode.window.showQuickPick(
    comments.map(comment => ({
      label: `Line ${comment.range.start.line + 1}: ${comment.text}`,
      description: `by ${comment.author}`,
      comment
    })),
    { placeHolder: 'Select a comment to delete' }
  );
  if (!selected) {
    return;
  }
  const confirmed = await vscode.window.showWarningMessage(
    `Delete "${selected.comment.text}"?`,
    { modal: true },
    'Delete'
  );
  if (confirmed === 'Delete') {
    removeComment(selected.comment.id);
  }
}

function removeComment(id: string): void {
  commentStore.comments = commentStore.comments.filter(comment => comment.id !== id);
  surfaceRemove(id);
  anchorConfidence.delete(id);
  clearPendingTrackedChange(id);
  persistComments();
}

async function deleteReplyInteractive(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const filePath = editor ? relativeFilePath(editor.document.uri) : undefined;
  if (!filePath || !await ensureStoreCurrent()) {
    return;
  }
  const replies = commentStore.comments
    .filter(comment => comment.filePath === filePath)
    .flatMap(comment => (comment.replies ?? []).map(reply => ({ comment, reply })));
  if (replies.length === 0) {
    vscode.window.showInformationMessage('No replies found in this file.');
    return;
  }
  const selected = await vscode.window.showQuickPick(
    replies.map(item => ({
      label: item.reply.text,
      description: `Reply by ${item.reply.author}, line ${item.comment.range.start.line + 1}`,
      ...item
    })),
    { placeHolder: 'Select a reply to delete' }
  );
  if (!selected) {
    return;
  }
  const confirmed = await vscode.window.showWarningMessage(
    `Delete reply "${selected.reply.text}"?`,
    { modal: true },
    'Delete'
  );
  if (confirmed !== 'Delete') {
    return;
  }
  selected.comment.replies = (selected.comment.replies ?? [])
    .filter(reply => reply.id !== selected.reply.id);
  surfaceReconfigure(selected.comment.id, selected.comment);
  persistComments();
}

async function deleteAllComments(): Promise<void> {
  if (!await ensureStoreCurrent() || commentStore.comments.length === 0) {
    vscode.window.showInformationMessage('There are no comments to delete.');
    return;
  }
  const confirmed = await vscode.window.showWarningMessage(
    'Delete all comments for this workspace?',
    { modal: true },
    'Delete'
  );
  if (confirmed !== 'Delete') {
    return;
  }
  commentStore = { comments: [] };
  surfaceClear();
  anchorConfidence.clear();
  clearAllPendingTrackedChanges();
  persistComments();
}

function compareStoredPositions(left: StoredPosition, right: StoredPosition): number {
  return left.line - right.line || left.character - right.character;
}

function changeTouchesRange(change: TextChange, range: StoredRange): boolean {
  const changeIsInsertion = compareStoredPositions(change.range.start, change.range.end) === 0;
  if (changeIsInsertion) {
    return compareStoredPositions(change.range.start, range.start) >= 0
      && compareStoredPositions(change.range.start, range.end) <= 0;
  }
  return compareStoredPositions(change.range.start, range.end) < 0
    && compareStoredPositions(change.range.end, range.start) > 0;
}

function clearPendingTrackedChange(commentId: string): void {
  const pending = pendingTrackedChanges.get(commentId);
  if (pending) {
    clearTimeout(pending.timeout);
    pendingTrackedChanges.delete(commentId);
  }
}

function clearAllPendingTrackedChanges(): void {
  for (const pending of pendingTrackedChanges.values()) {
    clearTimeout(pending.timeout);
  }
  pendingTrackedChanges.clear();
}

function finishPendingTrackedChange(commentId: string): void {
  const pending = pendingTrackedChanges.get(commentId);
  if (pending) {
    pendingTrackedChanges.delete(commentId);
    const comment = commentStore.comments.find(item => item.id === commentId);
    if (comment) {
      surfaceReconfigure(commentId, comment);
      commentsTreeProvider.refresh();
    }
  }
}

function recordTrackedTextChange(
  comment: CommentData,
  previousText: string,
  newText: string
): boolean {
  if (previousText === newText) {
    return false;
  }

  const pending = pendingTrackedChanges.get(comment.id);
  if (pending) {
    const existing = comment.trackedChanges?.find(change => change.id === pending.changeId);
    if (existing) {
      clearTimeout(pending.timeout);
      if (newText === pending.originalText) {
        comment.trackedChanges = comment.trackedChanges?.filter(
          change => change.id !== pending.changeId
        );
        pendingTrackedChanges.delete(comment.id);
      } else {
        existing.newText = newText;
        pending.timeout = setTimeout(
          () => finishPendingTrackedChange(comment.id),
          TRACKED_CHANGE_COALESCE_MS
        );
      }
      return true;
    }
    clearPendingTrackedChange(comment.id);
  }

  const change: TrackedTextChangeData = {
    id: randomUUID(),
    author: getPassiveAuthorName(),
    timestamp: new Date().toISOString(),
    previousText,
    newText
  };
  comment.trackedChanges = [...(comment.trackedChanges ?? []), change];
  pendingTrackedChanges.set(comment.id, {
    changeId: change.id,
    originalText: previousText,
    timeout: setTimeout(
      () => finishPendingTrackedChange(comment.id),
      TRACKED_CHANGE_COALESCE_MS
    )
  });
  return true;
}

function handleDocumentChange(event: vscode.TextDocumentChangeEvent): void {
  if (isStorageUri(event.document.uri) || event.contentChanges.length === 0) {
    return;
  }
  const filePath = relativeFilePath(event.document.uri);
  if (!filePath) {
    return;
  }
  const comments = commentStore.comments.filter(comment => comment.filePath === filePath);
  if (comments.length === 0) {
    return;
  }

  const changes: TextChange[] = event.contentChanges.map(change => ({
    range: toStoredRange(change.range),
    text: change.text
  }));
  const text = event.document.getText();
  const currentHash = hashDocument(text);
  let changed = false;

  for (const comment of comments) {
    const previousRange = comment.range;
    const previousHash = comment.documentHash;
    const previousSelectedText = comment.selectedText;
    const selectionWasEdited = changes.some(change => changeTouchesRange(change, previousRange));
    const provisionalRange = transformRange(previousRange, changes);
    const located = locateAnchor(text, {
      ...comment,
      range: provisionalRange,
      preferRange: selectionWasEdited
    });
    const newRange: StoredRange = {
      start: offsetToPosition(text, located.start),
      end: offsetToPosition(text, located.end)
    };
    comment.range = newRange;
    comment.documentHash = currentHash;
    anchorConfidence.set(comment.id, located.confidence);

    let threadContentChanged = false;
    if (located.confidence === 'context'
      || (located.confidence === 'position' && selectionWasEdited)) {
      const refreshed = captureAnchor(text, located.start, located.end);
      if (previousSelectedText !== undefined) {
        threadContentChanged = recordTrackedTextChange(
          comment,
          previousSelectedText,
          refreshed.selectedText ?? ''
        );
      }
      Object.assign(comment, refreshed);
    } else if (located.confidence === 'exact') {
      const refreshed = captureAnchor(text, located.start, located.end);
      comment.contextBefore = refreshed.contextBefore;
      comment.contextAfter = refreshed.contextAfter;
    }

    if (threadContentChanged && !pendingTrackedChanges.has(comment.id)) {
      surfaceReconfigure(comment.id, comment);
    }
    changed = changed
      || !rangesEqual(previousRange, newRange)
      || previousHash !== currentHash;
  }

  if (changed) {
    commentsTreeProvider.refresh();
    schedulePersist();
    refreshDecorations();
  }
}

async function navigateToComment(comment: CommentData): Promise<void> {
  const uri = uriForComment(comment);
  if (!uri) {
    return;
  }
  try {
    const document = await vscode.workspace.openTextDocument(uri);
    const range = locateComment(document, comment);
    const editor = await vscode.window.showTextDocument(document);
    editor.selection = new vscode.Selection(range.start, range.end);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
  } catch (error) {
    vscode.window.showErrorMessage(`Could not open ${comment.filePath}: ${String(error)}`);
  }
}

async function viewComments(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const filePath = editor ? relativeFilePath(editor.document.uri) : undefined;
  if (!filePath) {
    vscode.window.showInformationMessage('No tracked file is currently open.');
    return;
  }
  const comments = commentStore.comments.filter(comment => comment.filePath === filePath);
  if (comments.length === 0) {
    vscode.window.showInformationMessage('No comments found for this file.');
    return;
  }
  const selected = await vscode.window.showQuickPick(
    comments.map(comment => ({
      label: `Line ${comment.range.start.line + 1}: ${comment.text}`,
      description: `${comment.resolved ? 'Resolved' : 'Open'} · ${comment.author}`,
      comment
    })),
    { placeHolder: 'Select a comment to view' }
  );
  if (selected) {
    await navigateToComment(selected.comment);
  }
}

async function openReviewPanel(): Promise<void> {
  try {
    await vscode.commands.executeCommand(`${WebviewSurface.viewId}.focus`);
  } catch {
    await vscode.commands.executeCommand('workbench.view.extension.comment-tracker-container');
  }
}

async function setResolvedCommentsVisible(visible: boolean): Promise<void> {
  showResolvedComments = visible;
  await vscode.commands.executeCommand(
    'setContext',
    'commentTracker.showResolvedComments',
    visible
  );
  commentsTreeProvider.refresh();
  webviewSurface.pushState();
  refreshDecorations();
}

async function exportToMarkdown(): Promise<void> {
  if (commentStore.comments.length === 0) {
    vscode.window.showInformationMessage('No comments to export.');
    return;
  }

  const grouped = new Map<string, CommentData[]>();
  for (const comment of commentStore.comments) {
    grouped.set(comment.filePath, [...(grouped.get(comment.filePath) ?? []), comment]);
  }

  let markdown = '# Comments\n\n';
  for (const [filePath, comments] of grouped) {
    markdown += `## ${filePath}\n\n`;
    for (const comment of comments) {
      markdown += `- [${comment.resolved ? 'x' : ' '}] Line ${comment.range.start.line + 1}`;
      const uri = uriForComment(comment);
      if (uri) {
        try {
          const document = await vscode.workspace.openTextDocument(uri);
          const quote = document.getText(locateComment(document, comment)).trim();
          if (quote) {
            markdown += `\n${quote.split(/\r?\n/).map(line => `> ${line}`).join('\n')}\n`;
          }
        } catch {
          // Keep the export useful even if a referenced file was removed.
        }
      }
      markdown += `\n${comment.author}: ${comment.text}\n`;
      const activity = [
        ...(comment.replies ?? []).map(reply => ({
          timestamp: reply.timestamp,
          markdown: `  - ${reply.author}: ${reply.text}\n`
        })),
        ...(comment.trackedChanges ?? []).map(change => ({
          timestamp: change.timestamp,
          markdown: `  - ${change.author} changed selected text from `
            + `\`${JSON.stringify(change.previousText).replace(/`/g, '\\`')}\` to `
            + `\`${JSON.stringify(change.newText).replace(/`/g, '\\`')}\`\n`
        }))
      ].sort((left, right) => left.timestamp.localeCompare(right.timestamp));
      for (const item of activity) {
        markdown += item.markdown;
      }
      markdown += '\n';
    }
  }

  await vscode.env.clipboard.writeText(markdown);
  const document = await vscode.workspace.openTextDocument({
    content: markdown,
    language: 'markdown'
  });
  await vscode.window.showTextDocument(document);
  vscode.window.showInformationMessage('Comments exported and copied to the clipboard.');
}

class CommentsTreeProvider implements vscode.TreeDataProvider<CommentTreeItem> {
  private readonly changeEmitter = new vscode.EventEmitter<CommentTreeItem | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  refresh(): void {
    this.changeEmitter.fire(undefined);
  }

  getTreeItem(element: CommentTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: CommentTreeItem): CommentTreeItem[] {
    if (!element) {
      return commentStore.comments
        .filter(comment => showResolvedComments || !comment.resolved)
        .sort((left, right) =>
          left.filePath.localeCompare(right.filePath)
          || left.range.start.line - right.range.start.line
        )
        .map(comment => CommentTreeItem.forComment(comment));
    }
    if (element.kind !== 'comment') {
      return [];
    }
    const activity = [
      ...(element.comment.replies ?? []).map(reply => ({
        timestamp: reply.timestamp,
        item: CommentTreeItem.forReply(element.comment, reply)
      })),
      ...(element.comment.trackedChanges ?? []).map(change => ({
        timestamp: change.timestamp,
        item: CommentTreeItem.forTrackedChange(element.comment, change)
      }))
    ].sort((left, right) => left.timestamp.localeCompare(right.timestamp));
    return [
      CommentTreeItem.forText(element.comment),
      ...activity.map(item => item.item)
    ];
  }
}

class CommentTreeItem extends vscode.TreeItem {
  private constructor(
    readonly comment: CommentData,
    readonly kind: 'comment' | 'text' | 'reply' | 'trackedChange',
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    tooltip: string
  ) {
    super(label, collapsibleState);
    this.tooltip = tooltip;
    this.command = {
      command: 'comment-tracker.navigateToComment',
      title: 'Go to Comment',
      arguments: [comment]
    };
  }

  static forComment(comment: CommentData): CommentTreeItem {
    const item = new CommentTreeItem(
      comment,
      'comment',
      `${comment.filePath}:${comment.range.start.line + 1}`,
      vscode.TreeItemCollapsibleState.Expanded,
      `${comment.author} · ${new Date(comment.timestamp).toLocaleString()}\n\n${comment.text}`
    );
    item.contextValue = comment.resolved
      ? 'commentTrackerResolvedComment'
      : 'commentTrackerOpenComment';
    item.iconPath = new vscode.ThemeIcon(
      anchorConfidence.get(comment.id) === 'position'
        ? 'warning'
        : comment.resolved
          ? 'pass-filled'
          : 'comment-discussion'
    );
    if (comment.resolved) {
      item.description = 'Resolved';
    }
    return item;
  }

  static forText(comment: CommentData): CommentTreeItem {
    const item = new CommentTreeItem(
      comment,
      'text',
      `${comment.author}: ${comment.text}`,
      vscode.TreeItemCollapsibleState.None,
      new Date(comment.timestamp).toLocaleString()
    );
    return item;
  }

  static forReply(comment: CommentData, reply: CommentReplyData): CommentTreeItem {
    return new CommentTreeItem(
      comment,
      'reply',
      `${reply.author}: ${reply.text}`,
      vscode.TreeItemCollapsibleState.None,
      new Date(reply.timestamp).toLocaleString()
    );
  }

  static forTrackedChange(
    comment: CommentData,
    change: TrackedTextChangeData
  ): CommentTreeItem {
    const previous = change.previousText.replace(/\s+/g, ' ').trim() || '(empty)';
    const next = change.newText.replace(/\s+/g, ' ').trim() || '(empty)';
    const summary = `${previous.slice(0, 30)} → ${next.slice(0, 30)}`;
    return new CommentTreeItem(
      comment,
      'trackedChange',
      `Changed: ${summary}`,
      vscode.TreeItemCollapsibleState.None,
      `${change.author} · ${new Date(change.timestamp).toLocaleString()}`
    );
  }
}

export function deactivate(): void {
  if (saveTimeout) {
    clearTimeout(saveTimeout);
    persistComments(false);
  }
  if (reloadTimeout) {
    clearTimeout(reloadTimeout);
  }
  clearAllPendingTrackedChanges();
}

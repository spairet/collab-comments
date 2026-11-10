import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
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
import { PanelState, WebviewSurface } from './webviewSurface';
import { PanelRequest } from './panelProtocol';
import { QuartoAction, QuartoBridgeState, QuartoPreviewBridge } from './quartoBridge';
import { mapRenderedSelection, sourceHash } from './quartoMapping';
import {
  appendSafeThreadTimestamp,
  candidateSummary,
  canonicalWordText,
  extractWordComments,
  MAX_DOCX_BYTES,
  MAX_PANDOC_JSON_BYTES,
  prepareWordImport,
  WordImportCandidate
} from './wordComments';
import { commentRootForFile, workspaceRelativePath } from './workspacePaths';

const SAVE_DELAY_MS = 500;
const EXTERNAL_RELOAD_DELAY_MS = 150;
const TRACKED_CHANGE_COALESCE_MS = 2_000;
const SELECTION_SYNC_DELAY_MS = 250;
const SCROLL_SYNC_DELAY_MS = 50;

interface CommentSession {
  folder: vscode.WorkspaceFolder;
  repository: CommentRepository;
  store: CommentStore;
  saveTimeout?: NodeJS.Timeout;
  reloadTimeout?: NodeJS.Timeout;
  restoreVersion: number;
}

let webviewSurface: WebviewSurface;
let commentHighlightDecoration: vscode.TextEditorDecorationType;
let resolvedHighlightDecoration: vscode.TextEditorDecorationType;
let commentsTreeProvider: CommentsTreeProvider;
const sessions = new Map<string, CommentSession>();
const sessionWatchers = new Map<string, vscode.FileSystemWatcher>();
let selectionSyncTimeout: NodeJS.Timeout | undefined;
let scrollSyncTimeout: NodeJS.Timeout | undefined;
let showResolvedComments = false;
let quartoBridge: QuartoPreviewBridge | undefined;
let quartoBridgeRoot: string | undefined;
let wordImportOutput: vscode.OutputChannel;

const anchorConfidence = new Map<string, LocatedAnchor['confidence']>();
const pendingTrackedChanges = new Map<string, {
  changeId: string;
  originalText: string;
  timeout: NodeJS.Timeout;
}>();

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    openSession(folder);
  }

  webviewSurface = new WebviewSurface(
    context.extensionUri,
    loadPanelState,
    request => handlePanelRequest(request)
  );
  commentHighlightDecoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'rgba(234, 179, 8, 0.18)',
    borderRadius: '3px'
  });
  resolvedHighlightDecoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'rgba(128, 128, 128, 0.12)',
    borderRadius: '3px'
  });

  commentsTreeProvider = new CommentsTreeProvider();
  wordImportOutput = vscode.window.createOutputChannel('Collab Comments: Word Import');
  await vscode.commands.executeCommand(
    'setContext',
    'commentTracker.showResolvedComments',
    showResolvedComments
  );
  context.subscriptions.push(
    commentHighlightDecoration,
    resolvedHighlightDecoration,
    wordImportOutput,
    vscode.window.registerWebviewViewProvider(WebviewSurface.viewId, webviewSurface),
    vscode.window.registerTreeDataProvider('commentTrackerView', commentsTreeProvider),
    vscode.workspace.onDidChangeTextDocument(handleDocumentChange),
    vscode.window.onDidChangeVisibleTextEditors(() => refreshDecorations()),
    vscode.workspace.onDidSaveTextDocument((document) => {
      const session = sessionForStorageUri(document.uri);
      if (session) {
        scheduleExternalReload(session, 0);
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(event => {
      for (const folder of event.removed) {
        closeSession(folder);
      }
      for (const folder of event.added) {
        const session = openSession(folder);
        watchSession(context, session);
        void restoreAllThreads(session);
      }
      commentsTreeProvider.refresh();
      webviewSurface.pushState();
      refreshDecorations();
    }),
    vscode.window.onDidChangeActiveTextEditor(() => {
      commentsTreeProvider.refresh();
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

  for (const session of sessions.values()) {
    watchSession(context, session);
  }
  const primary = primarySession();
  if (primary && vscode.env.remoteName === undefined) {
    quartoBridgeRoot = primary.folder.uri.toString();
    quartoBridge = new QuartoPreviewBridge(primary.folder.uri.fsPath, {
      state: bridgeState,
      action: bridgeAction
    });
    try {
      await quartoBridge.start();
      context.subscriptions.push({ dispose: () => quartoBridge?.dispose() });
    } catch (error) {
      quartoBridge.dispose();
      quartoBridge = undefined;
      quartoBridgeRoot = undefined;
      const reason = error instanceof Error ? error.message : String(error);
      void vscode.window.showWarningMessage(`Collab Comments Quarto preview bridge is unavailable: ${reason}`);
    }
  }

  for (const session of sessions.values()) {
    await restoreAllThreads(session);
  }
}

function sessionKey(folder: vscode.WorkspaceFolder): string {
  return folder.uri.toString();
}

function openSession(folder: vscode.WorkspaceFolder): CommentSession {
  const existing = sessions.get(sessionKey(folder));
  if (existing) {
    return existing;
  }
  const repository = new CommentRepository(folder.uri.fsPath);
  let store: CommentStore = { comments: [] };
  try {
    store = repository.loadInitial();
  } catch (error) {
    showStoreError('Could not load the comments file', error);
  }
  const session: CommentSession = {
    folder,
    repository,
    store,
    restoreVersion: 0
  };
  sessions.set(sessionKey(folder), session);
  return session;
}

function closeSession(folder: vscode.WorkspaceFolder): void {
  const key = sessionKey(folder);
  const session = sessions.get(key);
  if (!session) {
    return;
  }
  if (session.saveTimeout) {
    clearTimeout(session.saveTimeout);
    session.saveTimeout = undefined;
    persistComments(session, false);
  }
  if (session.reloadTimeout) {
    clearTimeout(session.reloadTimeout);
  }
  sessionWatchers.get(key)?.dispose();
  sessionWatchers.delete(key);
  sessions.delete(key);
  if (quartoBridgeRoot === key) {
    quartoBridge?.dispose();
    quartoBridge = undefined;
    quartoBridgeRoot = undefined;
  }
}

function watchSession(context: vscode.ExtensionContext, session: CommentSession): void {
  const key = sessionKey(session.folder);
  if (sessionWatchers.has(key)) {
    return;
  }
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(session.folder, '.comments/collab-comments.json')
  );
  watcher.onDidCreate(() => scheduleExternalReload(session), undefined, context.subscriptions);
  watcher.onDidChange(() => scheduleExternalReload(session), undefined, context.subscriptions);
  watcher.onDidDelete(() => scheduleExternalReload(session), undefined, context.subscriptions);
  context.subscriptions.push(watcher);
  sessionWatchers.set(key, watcher);
}

function primarySession(): CommentSession | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder ? sessions.get(sessionKey(folder)) : undefined;
}

function activeSession(): CommentSession | undefined {
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    const session = sessionForUri(editor.document.uri);
    if (session) {
      return session;
    }
  }
  return primarySession();
}

function sessionForUri(uri: vscode.Uri): CommentSession | undefined {
  if (uri.scheme !== 'file') {
    return undefined;
  }
  const root = commentRootForFile(
    [...sessions.values()].map(session => session.folder.uri.fsPath),
    uri.fsPath
  );
  if (!root) {
    return undefined;
  }
  return [...sessions.values()].find(session => path.resolve(session.folder.uri.fsPath) === root);
}

function sessionForThread(threadId: string): CommentSession | undefined {
  for (const session of sessions.values()) {
    if (session.store.comments.some(comment => comment.id === threadId)) {
      return session;
    }
  }
  return undefined;
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
    vscode.commands.registerCommand('comment-tracker.importCommentsFromWord', importCommentsFromWord),
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

function sameStoragePath(left: string, right: string): boolean {
  const candidate = path.normalize(left);
  const storagePath = path.normalize(right);
  return process.platform === 'win32'
    ? candidate.toLocaleLowerCase() === storagePath.toLocaleLowerCase()
    : candidate === storagePath;
}

function sessionForStorageUri(uri: vscode.Uri): CommentSession | undefined {
  for (const session of sessions.values()) {
    if (sameStoragePath(uri.fsPath, session.repository.filePath)) {
      return session;
    }
  }
  return undefined;
}

function isStorageUri(uri: vscode.Uri): boolean {
  return sessionForStorageUri(uri) !== undefined;
}

function storageDocumentIsDirty(session: CommentSession): boolean {
  return vscode.workspace.textDocuments.some(
    (document) => sameStoragePath(document.uri.fsPath, session.repository.filePath) && document.isDirty
  );
}

function isTrackableDocument(uri: vscode.Uri): boolean {
  return uri.scheme === 'file'
    && sessionForUri(uri) !== undefined
    && !isStorageUri(uri);
}

function relativeFilePath(uri: vscode.Uri): string | undefined {
  const session = sessionForUri(uri);
  if (!session || !isTrackableDocument(uri)) {
    return undefined;
  }
  return workspaceRelativePath(session.folder.uri.fsPath, uri.fsPath);
}

function uriForComment(comment: CommentData, session: CommentSession): vscode.Uri | undefined {
  const segments = comment.filePath.split(/[\\/]/).filter(Boolean);
  if (segments.length === 0 || segments.some(segment => segment === '..')) {
    return undefined;
  }
  return vscode.Uri.joinPath(session.folder.uri, ...segments);
}

async function ensureStoreCurrent(session: CommentSession | undefined): Promise<boolean> {
  if (!session) {
    vscode.window.showErrorMessage('Open a workspace folder before using Collab Comments.');
    return false;
  }
  if (storageDocumentIsDirty(session)) {
    vscode.window.showWarningMessage(
      'Save or discard the open comments JSON edits before changing comments in the editor.'
    );
    return false;
  }

  const result = session.repository.reloadIfChanged();
  if (result.kind === 'failed') {
    showStoreError('Could not check the comments JSON for external changes', result.error);
    return false;
  }
  if (result.kind === 'invalid') {
    showStoreError('The comments JSON is invalid and will not be overwritten', result.error);
    return false;
  }
  if (result.kind === 'loaded' || result.kind === 'deleted') {
    await applyExternalStore(session, result, false);
  }
  return true;
}

function persistComments(session: CommentSession, showErrors = true): boolean {
  if (storageDocumentIsDirty(session)) {
    return false;
  }

  const result = session.repository.save(session.store);
  if (result.kind === 'saved') {
    commentsTreeProvider.refresh();
    webviewSurface.pushState();
    refreshDecorations();
    return true;
  }
  if (result.kind === 'conflict') {
    scheduleExternalReload(session, 0);
    if (showErrors) {
      vscode.window.showWarningMessage(
        'The comments JSON changed outside Collab Comments. It was not overwritten; reloading it now.'
      );
    }
    return false;
  }
  if (showErrors) {
    showStoreError('Failed to save comments', result.error);
  }
  return false;
}

function schedulePersist(session: CommentSession): void {
  if (session.saveTimeout) {
    clearTimeout(session.saveTimeout);
  }
  session.saveTimeout = setTimeout(() => {
    session.saveTimeout = undefined;
    persistComments(session, false);
  }, SAVE_DELAY_MS);
}

function scheduleExternalReload(session: CommentSession, delay = EXTERNAL_RELOAD_DELAY_MS): void {
  if (session.reloadTimeout) {
    clearTimeout(session.reloadTimeout);
  }
  session.reloadTimeout = setTimeout(() => {
    session.reloadTimeout = undefined;
    void reloadExternalStore(session);
  }, delay);
}

async function reloadExternalStore(session: CommentSession): Promise<void> {
  if (!sessions.has(sessionKey(session.folder)) || storageDocumentIsDirty(session)) {
    return;
  }
  const result = session.repository.reloadIfChanged();
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
  await applyExternalStore(session, result, true);
}

async function applyExternalStore(
  session: CommentSession,
  result: Extract<ReloadResult, { kind: 'loaded' | 'deleted' }>,
  notify: boolean
): Promise<void> {
  if (session.saveTimeout) {
    clearTimeout(session.saveTimeout);
    session.saveTimeout = undefined;
  }
  session.store = result.store;
  await restoreAllThreads(session);
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
  filePath: string,
  range: vscode.Range,
  text: string,
  author: string
): CommentData {
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
    documentHash: sourceHash(fullText),
    replies: [],
    trackedChanges: [],
    resolved: false
  };
}

function commentHasMergeableTrackedChanges(comment: CommentData): boolean {
  return hasMergeableTrackedChanges(
    comment.trackedChanges,
    comment.replies.map(reply => reply.timestamp)
  );
}

/**
 * Keeps the always-on Word-style highlight in sync: open threads get a soft
 * amber wash, resolved ones (when visible) a faint gray one.
 */
function refreshDecorations(): void {
  for (const editor of vscode.window.visibleTextEditors) {
    const session = sessionForUri(editor.document.uri);
    const filePath = relativeFilePath(editor.document.uri);
    const active: vscode.Range[] = [];
    const resolved: vscode.Range[] = [];
    if (session && filePath) {
      for (const comment of session.store.comments) {
        if (comment.filePath !== filePath) {
          continue;
        }
        if (comment.resolved && !showResolvedComments) {
          continue;
        }
        (comment.resolved ? resolved : active).push(toVsRange(comment.range));
      }
    }
    editor.setDecorations(commentHighlightDecoration, active);
    editor.setDecorations(resolvedHighlightDecoration, resolved);
  }
}

function loadPanelState(): PanelState {
  const editor = vscode.window.activeTextEditor;
  const session = editor ? sessionForUri(editor.document.uri) : undefined;
  const file = editor ? relativeFilePath(editor.document.uri) : null;
  return {
    file: file ?? null,
    showResolved: showResolvedComments,
    comments: session && file
      ? session.store.comments.filter(comment => comment.filePath === file)
      : []
  };
}

function syncPanelHighlight(editor: vscode.TextEditor): void {
  const filePath = relativeFilePath(editor.document.uri);
  if (!filePath) {
    return;
  }
  const session = sessionForUri(editor.document.uri);
  if (!session) {
    return;
  }
  const line = editor.selection.active.line;
  const candidates = visibleCandidates(session, filePath);
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
  const session = sessionForUri(editor.document.uri);
  if (!session) {
    return;
  }
  const top = visibleRanges[0].start.line;
  const bottom = visibleRanges[visibleRanges.length - 1].end.line;
  webviewSurface.anchor(viewportFraction(top, bottom, editor.document.lineCount));
  webviewSurface.highlight(commentInViewport(visibleCandidates(session, filePath), top, bottom), false);
}

function visibleCandidates(session: CommentSession, filePath: string): HighlightCandidate[] {
  return session.store.comments
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
      const session = sessionForThread(request.commentId) ?? activeSession();
      const comment = session?.store.comments.find(item => item.id === request.commentId);
      if (comment) {
        await navigateToComment(comment);
      }
      return;
    }
    case 'reply': {
      const session = sessionForThread(request.commentId) ?? activeSession();
      if (!session) {
        return;
      }
      await applyStoreAction(session, {
        type: 'reply',
        threadId: request.commentId,
        author: getPassiveAuthorName(),
        text: request.text
      });
      return;
    }
    case 'resolve': {
      const session = sessionForThread(request.commentId) ?? activeSession();
      if (!session) {
        return;
      }
      await applyStoreAction(session, {
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
      if (confirmed !== 'Delete') {
        return;
      }
      const session = sessionForThread(request.commentId) ?? activeSession();
      if (!session) {
        return;
      }
      await applyStoreAction(session, { type: 'delete-thread', threadId: request.commentId });
      return;
    }
    case 'delete-reply': {
      const confirmed = await vscode.window.showWarningMessage(
        'Delete this reply?',
        { modal: true },
        'Delete'
      );
      if (confirmed !== 'Delete') {
        return;
      }
      const session = sessionForThread(request.commentId) ?? activeSession();
      if (!session) {
        return;
      }
      await applyStoreAction(session, {
        type: 'delete-reply',
        threadId: request.commentId,
        replyId: request.replyId
      });
      return;
    }
    case 'merge-tracked-changes': {
      const session = sessionForThread(request.commentId) ?? activeSession();
      const comment = session?.store.comments.find(item => item.id === request.commentId);
      if (!comment || !commentHasMergeableTrackedChanges(comment)) {
        vscode.window.showInformationMessage(
          'This thread has no consecutive tracked changes to merge.'
        );
        return;
      }
      const merged = collapseTrackedChangesBetweenReplies(
        comment.trackedChanges,
        comment.replies.map(reply => reply.timestamp)
      );
      const removedCount = comment.trackedChanges.length - merged.length;
      const confirmed = await vscode.window.showWarningMessage(
        `Remove ${removedCount} intermediate tracked `
          + `change${removedCount === 1 ? '' : 's'}? Changes separated by replies will remain separate.`,
        { modal: true },
        'Merge'
      );
      if (confirmed !== 'Merge' || !session) {
        return;
      }
      await applyStoreAction(session, { type: 'merge-tracked-changes', threadId: request.commentId });
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
async function applyStoreAction(
  session: CommentSession,
  action: StoreAction,
  filePath?: string
): Promise<boolean> {
  if (!await ensureStoreCurrent(session)) {
    return false;
  }
  const snapshot = structuredClone(session.store);
  const find = (id: string): CommentData => {
    const comment = session.store.comments.find(item =>
      item.id === id && (filePath === undefined || item.filePath === filePath)
    );
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
      const timestamp = appendSafeThreadTimestamp(comment, new Date().toISOString());
      if (!timestamp) {
        throw new Error('A reply cannot be ordered safely after the existing thread timestamps.');
      }
      comment.replies.push({
        id: randomUUID(),
        author: action.author,
        timestamp,
        text: action.text
      });
    } else if (action.type === 'set-resolved') {
      const comment = find(action.threadId);
      comment.resolved = action.resolved;
    } else if (action.type === 'delete-thread') {
      const comment = find(action.threadId);
      session.store.comments = session.store.comments.filter(item => item.id !== comment.id);
      anchorConfidence.delete(comment.id);
      clearPendingTrackedChange(comment.id);
    } else if (action.type === 'delete-reply') {
      const comment = find(action.threadId);
      if (!comment.replies.some(reply => reply.id === action.replyId)) {
        throw new Error('The requested reply no longer exists.');
      }
      comment.replies = comment.replies.filter(reply => reply.id !== action.replyId);
    } else if (action.type === 'merge-tracked-changes') {
      const comment = find(action.threadId);
      if (!commentHasMergeableTrackedChanges(comment)) {
        throw new Error('There are no consecutive tracked changes to merge.');
      }
      clearPendingTrackedChange(comment.id);
      comment.trackedChanges = collapseTrackedChangesBetweenReplies(
        comment.trackedChanges,
        comment.replies.map(reply => reply.timestamp)
      );
    }
    if (!persistComments(session)) {
      // A request is not allowed to leave the UI showing a mutation that was
      // rejected because another process changed the JSON store.
      throw new Error('The comments store could not be saved without overwriting external changes.');
    }
    return true;
  } catch (error) {
    session.store = snapshot;
    await restoreAllThreads(session);
    throw error;
  }
}

interface BridgeSource {
  relative: string;
  text: string;
  hash: string;
}

function bridgeSource(filePath: string): BridgeSource {
  const session = primarySession();
  const relative = session && workspaceRelativePath(session.folder.uri.fsPath, filePath);
  const owner = commentRootForFile(
    [...sessions.values()].map(item => item.folder.uri.fsPath),
    filePath
  );
  if (!session || !relative || !owner || path.resolve(session.folder.uri.fsPath) !== owner
    || path.extname(relative).toLowerCase() !== '.qmd') {
    throw new Error('Only QMD files in the current workspace can use preview comments.');
  }
  const uri = vscode.Uri.file(filePath);
  const open = vscode.workspace.textDocuments.find(document => document.uri.fsPath === uri.fsPath);
  if (open?.isDirty) {
    throw new Error('Save the QMD document before changing its preview comments.');
  }
  const text = fs.readFileSync(uri.fsPath, 'utf8');
  return { relative, text, hash: sourceHash(text) };
}

function buildBridgeState(session: CommentSession, source: BridgeSource): QuartoBridgeState {
  return {
    sourceText: source.text,
    sourceHash: source.hash,
    author: getPassiveAuthorName(),
    comments: session.store.comments.filter(comment => comment.filePath === source.relative),
    etag: sourceHash(`${source.hash}:${JSON.stringify(session.store)}`)
  };
}

async function bridgeState(filePath: string): Promise<QuartoBridgeState> {
  const session = primarySession();
  if (!session || !await ensureStoreCurrent(session)) {
    throw new Error('The comments store is dirty, invalid, or changed externally.');
  }
  const source = bridgeSource(filePath);
  return buildBridgeState(session, source);
}

async function bridgeAction(
  filePath: string,
  action: QuartoAction
): Promise<QuartoBridgeState | { status: string }> {
  const session = primarySession();
  if (!session) {
    throw new Error('The comments store is dirty, invalid, or changed externally.');
  }
  const source = bridgeSource(filePath);
  if (action.type === 'navigate') {
    if (!await ensureStoreCurrent(session)) {
      throw new Error('The comments store is dirty, invalid, or changed externally.');
    }
    await navigateToComment(findBridgeComment(session, source.relative, action.threadId));
    return { status: 'navigated' };
  }
  if (action.type === 'add') {
    if (!await ensureStoreCurrent(session)) {
      throw new Error('The comments store is dirty, invalid, or changed externally.');
    }
    const snapshot = structuredClone(session.store);
    try {
      if (action.sourceHash !== source.hash) {
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
        documentHash: source.hash, replies: [], trackedChanges: [], resolved: false
      };
      session.store.comments.push(comment);
      anchorConfidence.set(comment.id, 'exact');
      if (!persistComments(session)) {
        // A bridge request is not allowed to leave VS Code showing a mutation
        // that was rejected because another process changed the JSON store.
        throw new Error('The comments store could not be saved without overwriting external changes.');
      }
    } catch (error) {
      session.store = snapshot;
      await restoreAllThreads(session);
      throw error;
    }
    return buildBridgeState(session, source);
  }
  if (!await applyStoreAction(session, action, source.relative)) {
    throw new Error('The comments store is dirty, invalid, or changed externally.');
  }
  return buildBridgeState(session, source);
}

function findBridgeComment(session: CommentSession, relative: string, threadId: string): CommentData {
  const comment = session.store.comments.find(item => item.id === threadId && item.filePath === relative);
  if (!comment) {
    throw new Error('The requested comment thread no longer exists.');
  }
  return comment;
}

function locateComment(document: vscode.TextDocument, comment: CommentData): vscode.Range {
  const text = document.getText();
  const currentHash = sourceHash(text);
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

async function restoreAllThreads(session: CommentSession): Promise<void> {
  const version = ++session.restoreVersion;
  for (const comment of session.store.comments) {
    clearPendingTrackedChange(comment.id);
    anchorConfidence.delete(comment.id);
  }

  for (const comment of session.store.comments) {
    if (version !== session.restoreVersion) {
      return;
    }
    const uri = uriForComment(comment, session);
    if (!uri) {
      continue;
    }
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      if (version !== session.restoreVersion) {
        return;
      }
      locateComment(document, comment);
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
  const session = editor ? sessionForUri(editor.document.uri) : undefined;
  const filePath = editor && relativeFilePath(editor.document.uri);
  if (!editor || !session || !filePath) {
    vscode.window.showErrorMessage('Open a file in the current workspace before adding a comment.');
    return;
  }
  if (!await ensureStoreCurrent(session)) {
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

  const comment = buildCommentData(editor.document, filePath, range, text.trim(), author.trim());
  session.store.comments.push(comment);
  anchorConfidence.set(comment.id, 'exact');
  persistComments(session);
}

async function setTreeCommentResolved(
  item: CommentTreeItem | undefined,
  requestedState: boolean
): Promise<void> {
  if (!item || item.kind !== 'comment') {
    return;
  }
  const session = sessionForThread(item.comment.id) ?? activeSession();
  if (!session) {
    return;
  }
  await applyStoreAction(session, {
    type: 'set-resolved',
    threadId: item.comment.id,
    resolved: requestedState
  });
}

async function deleteComment(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const session = editor ? sessionForUri(editor.document.uri) : undefined;
  const filePath = editor ? relativeFilePath(editor.document.uri) : undefined;
  if (!session || !filePath || !await ensureStoreCurrent(session)) {
    vscode.window.showInformationMessage('No tracked file is currently open.');
    return;
  }
  const comments = session.store.comments.filter(comment => comment.filePath === filePath);
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
    await applyStoreAction(session, { type: 'delete-thread', threadId: selected.comment.id });
  }
}

async function deleteReplyInteractive(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const session = editor ? sessionForUri(editor.document.uri) : undefined;
  const filePath = editor ? relativeFilePath(editor.document.uri) : undefined;
  if (!session || !filePath || !await ensureStoreCurrent(session)) {
    return;
  }
  const replies = session.store.comments
    .filter(comment => comment.filePath === filePath)
    .flatMap(comment => comment.replies.map(reply => ({ comment, reply })));
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
  await applyStoreAction(session, {
    type: 'delete-reply',
    threadId: selected.comment.id,
    replyId: selected.reply.id
  });
}

async function deleteAllComments(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const session = editor ? sessionForUri(editor.document.uri) : primarySession();
  if (!session || !await ensureStoreCurrent(session) || session.store.comments.length === 0) {
    vscode.window.showInformationMessage('There are no comments to delete.');
    return;
  }
  const confirmed = await vscode.window.showWarningMessage(
    sessions.size > 1
      ? 'Delete all comments for this workspace folder?'
      : 'Delete all comments for this workspace?',
    { modal: true },
    'Delete'
  );
  if (confirmed !== 'Delete') {
    return;
  }
  for (const comment of session.store.comments) {
    anchorConfidence.delete(comment.id);
    clearPendingTrackedChange(comment.id);
  }
  session.store = { comments: [] };
  persistComments(session);
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

function recordTrackedTextChange(
  comment: CommentData,
  previousText: string,
  newText: string
): void {
  if (previousText === newText) {
    return;
  }

  const pending = pendingTrackedChanges.get(comment.id);
  if (pending) {
    const existing = comment.trackedChanges.find(change => change.id === pending.changeId);
    if (existing) {
      clearTimeout(pending.timeout);
      if (newText === pending.originalText) {
        comment.trackedChanges = comment.trackedChanges.filter(
          change => change.id !== pending.changeId
        );
        pendingTrackedChanges.delete(comment.id);
      } else {
        existing.newText = newText;
        pending.timeout = setTimeout(
          () => pendingTrackedChanges.delete(comment.id),
          TRACKED_CHANGE_COALESCE_MS
        );
      }
      return;
    }
    clearPendingTrackedChange(comment.id);
  }

  const timestamp = appendSafeThreadTimestamp(comment, new Date().toISOString());
  if (!timestamp) {
    vscode.window.showWarningMessage('A tracked change could not be recorded safely because the thread contains an unsupported timestamp.');
    return;
  }
  const change: TrackedTextChangeData = {
    id: randomUUID(),
    author: getPassiveAuthorName(),
    timestamp,
    previousText,
    newText
  };
  comment.trackedChanges.push(change);
  pendingTrackedChanges.set(comment.id, {
    changeId: change.id,
    originalText: previousText,
    timeout: setTimeout(
      () => pendingTrackedChanges.delete(comment.id),
      TRACKED_CHANGE_COALESCE_MS
    )
  });
}

function handleDocumentChange(event: vscode.TextDocumentChangeEvent): void {
  if (isStorageUri(event.document.uri) || event.contentChanges.length === 0) {
    return;
  }
  const session = sessionForUri(event.document.uri);
  const filePath = relativeFilePath(event.document.uri);
  if (!session || !filePath) {
    return;
  }
  const comments = session.store.comments.filter(comment => comment.filePath === filePath);
  if (comments.length === 0) {
    return;
  }

  const changes: TextChange[] = event.contentChanges.map(change => ({
    range: toStoredRange(change.range),
    text: change.text
  }));
  const text = event.document.getText();
  const currentHash = sourceHash(text);
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

    if (located.confidence === 'context'
      || (located.confidence === 'position' && selectionWasEdited)) {
      const refreshed = captureAnchor(text, located.start, located.end);
      if (previousSelectedText !== undefined) {
        recordTrackedTextChange(
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
    changed = changed
      || !rangesEqual(previousRange, newRange)
      || previousHash !== currentHash;
  }

  if (changed) {
    commentsTreeProvider.refresh();
    schedulePersist(session);
    refreshDecorations();
  }
}

async function navigateToComment(comment: CommentData): Promise<void> {
  const session = sessionForThread(comment.id) ?? activeSession();
  if (!session) {
    return;
  }
  const uri = uriForComment(comment, session);
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
  const session = editor ? sessionForUri(editor.document.uri) : undefined;
  const filePath = editor ? relativeFilePath(editor.document.uri) : undefined;
  if (!session || !filePath) {
    vscode.window.showInformationMessage('No tracked file is currently open.');
    return;
  }
  const comments = session.store.comments.filter(comment => comment.filePath === filePath);
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
  const editor = vscode.window.activeTextEditor;
  const session = editor ? sessionForUri(editor.document.uri) : primarySession();
  if (!session || session.store.comments.length === 0) {
    vscode.window.showInformationMessage('No comments to export.');
    return;
  }

  const grouped = new Map<string, CommentData[]>();
  for (const comment of session.store.comments) {
    const comments = grouped.get(comment.filePath);
    if (comments) {
      comments.push(comment);
    } else {
      grouped.set(comment.filePath, [comment]);
    }
  }

  let markdown = '# Comments\n\n';
  for (const [filePath, comments] of grouped) {
    markdown += `## ${filePath}\n\n`;
    for (const comment of comments) {
      markdown += `- [${comment.resolved ? 'x' : ' '}] Line ${comment.range.start.line + 1}`;
      const uri = uriForComment(comment, session);
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
        ...comment.replies.map(reply => ({
          timestamp: reply.timestamp,
          markdown: `  - ${reply.author}: ${reply.text}\n`
        })),
        ...comment.trackedChanges.map(change => ({
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

const MAX_PANDOC_STDERR_BYTES = 16 * 1024;
const MAX_WORD_IMPORT_QMD_BYTES = 20 * 1024 * 1024;

interface PandocResult {
  stdout: string;
  stderr: string;
}

function runQuartoPandoc(docxPath: string, cancellation: vscode.CancellationToken): Promise<PandocResult> {
  return new Promise((resolve, reject) => {
    const process = spawn('quarto', ['pandoc', docxPath, '--track-changes=all', '--to=json'], {
      shell: false,
      windowsHide: true
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let finished = false;
    const finish = (error?: Error, result?: PandocResult): void => {
      if (finished) {return;}
      finished = true;
      cancellationSubscription.dispose();
      if (error) {reject(error);}
      else if (result) {resolve(result);}
    };
    const cancellationSubscription = cancellation.onCancellationRequested(() => {
      process.kill();
      finish(new Error('Word import was cancelled.'));
    });
    process.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_PANDOC_JSON_BYTES) {
        process.kill();
        finish(new Error(`Pandoc JSON exceeds the ${MAX_PANDOC_JSON_BYTES} byte safety limit.`));
      } else {
        stdout.push(chunk);
      }
    });
    process.stderr.on('data', (chunk: Buffer) => {
      if (stderrBytes < MAX_PANDOC_STDERR_BYTES) {
        const remaining = MAX_PANDOC_STDERR_BYTES - stderrBytes;
        stderr.push(chunk.subarray(0, remaining));
        stderrBytes += Math.min(chunk.length, remaining);
      }
    });
    process.on('error', error => finish(new Error(`Could not start Quarto: ${error.message}`)));
    process.on('close', code => {
      const result = { stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') };
      if (code !== 0) {
        finish(new Error(`Quarto Pandoc failed (exit ${code ?? 'unknown'}): ${result.stderr.trim() || 'no diagnostic output'}`));
      } else {
        finish(undefined, result);
      }
    });
  });
}

interface WordImportTarget {
  uri: vscode.Uri;
  filePath: string;
  source: string;
}

function readWordImportTarget(uri: vscode.Uri): WordImportTarget | undefined {
  const session = primarySession();
  const filePath = session && sessionForUri(uri) === session
    ? workspaceRelativePath(session.folder.uri.fsPath, uri.fsPath)
    : undefined;
  if (!filePath || path.extname(filePath).toLowerCase() !== '.qmd') {
    vscode.window.showErrorMessage('The Word import target must be a QMD file in the first workspace folder.');
    return undefined;
  }
  const open = vscode.workspace.textDocuments.find(document => document.uri.toString() === uri.toString());
  if (open?.isDirty) {
    vscode.window.showWarningMessage('Save the QMD file before importing Word comments.');
    return undefined;
  }
  try {
    const stat = fs.statSync(uri.fsPath);
    if (!stat.isFile() || stat.size > MAX_WORD_IMPORT_QMD_BYTES) {
      vscode.window.showErrorMessage(`The Word import target QMD must be no larger than ${MAX_WORD_IMPORT_QMD_BYTES} bytes.`);
      return undefined;
    }
    const source = fs.readFileSync(uri.fsPath);
    if (source.length > MAX_WORD_IMPORT_QMD_BYTES) {
      vscode.window.showErrorMessage(`The Word import target QMD must be no larger than ${MAX_WORD_IMPORT_QMD_BYTES} bytes.`);
      return undefined;
    }
    return { uri, filePath, source: source.toString('utf8') };
  } catch (error) {
    vscode.window.showErrorMessage(`Could not read the Word import target QMD file: ${String(error)}`);
    return undefined;
  }
}

function wordImportTarget(): WordImportTarget | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage('Open a saved QMD file in the first workspace folder before importing Word comments.');
    return undefined;
  }
  return readWordImportTarget(editor.document.uri);
}

function describeWordCandidate(candidate: WordImportCandidate): string {
  if (candidate.kind === 'new') {return `New · line ${candidate.comment.range.start.line + 1} · ${candidate.wordComment.author}`;}
  if (candidate.kind === 'changed') {return `Changed · ${candidate.replyAuthor}`;}
  return candidate.kind;
}

async function importCommentsFromWord(): Promise<void> {
  const session = primarySession();
  const target = wordImportTarget();
  if (!session || !target || !await ensureStoreCurrent(session)) {return;}
  const selected = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    filters: { word: ['docx'] },
    openLabel: 'Import Word comments'
  });
  if (!selected?.[0]) {return;}
  const docxPath = selected[0].fsPath;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(docxPath);
  } catch (error) {
    vscode.window.showErrorMessage(`Could not read the selected Word document: ${String(error)}`);
    return;
  }
  if (path.extname(docxPath).toLowerCase() !== '.docx' || !stat.isFile() || stat.size > MAX_DOCX_BYTES) {
    vscode.window.showErrorMessage(`Select a readable .docx file no larger than ${MAX_DOCX_BYTES} bytes.`);
    return;
  }
  let pandoc: PandocResult;
  try {
    pandoc = await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'Collab Comments: Reading Word comments',
      cancellable: true
    }, (_, cancellation) => runQuartoPandoc(docxPath, cancellation));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    wordImportOutput.appendLine(`Pandoc read failed: ${message}`);
    wordImportOutput.show(true);
    vscode.window.showErrorMessage(`Word comments were not imported: ${message}`);
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(pandoc.stdout) as unknown;
  } catch {
    wordImportOutput.appendLine('Pandoc returned invalid JSON; no comments were imported.');
    wordImportOutput.show(true);
    vscode.window.showErrorMessage('Quarto Pandoc returned invalid JSON; no comments were imported.');
    return;
  }
  const importTimestamp = new Date().toISOString();
  const extracted = extractWordComments(parsed, importTimestamp);
  const candidates = prepareWordImport(extracted, target.source, target.filePath, session.store, importTimestamp);
  const previewStore = JSON.stringify(session.store);
  const previewSourceHash = sourceHash(target.source);
  const summary = candidateSummary(candidates);
  for (const candidate of candidates) {
    if (candidate.kind === 'ambiguous' || candidate.kind === 'conflict' || candidate.kind === 'invalid') {
      wordImportOutput.appendLine(`${candidate.kind}: ${candidate.reason}`);
    }
  }
  const safe = candidates.filter((candidate): candidate is Extract<WordImportCandidate, { kind: 'new' | 'changed' }> =>
    candidate.kind === 'new' || candidate.kind === 'changed');
  if (safe.length === 0) {
    vscode.window.showInformationMessage(`No Word changes to import. ${summary.unchanged} unchanged; ${summary.ambiguous + summary.conflict + summary.invalid} skipped.`);
    if (summary.ambiguous + summary.conflict + summary.invalid > 0) {wordImportOutput.show(true);}
    return;
  }
  const choices = await vscode.window.showQuickPick(safe.map(candidate => ({
    label: describeWordCandidate(candidate),
    description: candidate.wordComment.selectedText.slice(0, 120),
    detail: candidate.kind === 'new' ? candidate.wordComment.text.slice(0, 240) : candidate.replyText.slice(0, 240),
    picked: true,
    candidate
  })), { canPickMany: true, placeHolder: `${summary.new} new and ${summary.changed} changed comments are safe to import` });
  if (!choices?.length) {return;}
  const accepted = choices.map(choice => choice.candidate);
  const acceptedSummary = candidateSummary(accepted);
  const confirmed = await vscode.window.showWarningMessage(
    `Import ${accepted.length} selected Word comment change${accepted.length === 1 ? '' : 's'}? This will not edit QMD source.`,
    { modal: true },
    'Import'
  );
  if (confirmed !== 'Import') {return;}

  // Do not apply a preview calculated from stale source or a changed store.
  if (!await ensureStoreCurrent(session)) {return;}
  const refreshed = readWordImportTarget(target.uri);
  if (!refreshed || refreshed.filePath !== target.filePath || sourceHash(refreshed.source) !== previewSourceHash || JSON.stringify(session.store) !== previewStore) {
    vscode.window.showWarningMessage('The QMD file or comments store changed during review. Import was cancelled; run it again for a fresh preview.');
    return;
  }
  const next = structuredClone(session.store);
  for (const candidate of accepted) {
    if (candidate.kind === 'new') {
      next.comments.push(candidate.comment);
    } else {
      const existing = next.comments.find(comment => comment.id === candidate.existingId);
      if (!existing) {
        vscode.window.showWarningMessage('The comments store changed during review. Import was cancelled; run it again for a fresh preview.');
        return;
      }
      if (existing.replies.some(reply => reply.author === candidate.replyAuthor
        && canonicalWordText(reply.text) === canonicalWordText(candidate.replyText))) {
        continue;
      }
      // Multiple Word comments may reconcile semantically to one local thread.
      // Allocate against the evolving clone so every accepted reply remains
      // strictly ordered and an exhausted timestamp range aborts atomically.
      const replyTimestamp = appendSafeThreadTimestamp(existing, candidate.replyTimestamp);
      if (!replyTimestamp) {
        vscode.window.showWarningMessage('Word import was cancelled because the selected replies cannot be ordered safely after existing thread activity.');
        return;
      }
      existing.replies.push({ id: randomUUID(), author: candidate.replyAuthor,
        timestamp: replyTimestamp, text: candidate.replyText });
    }
  }
  const previous = session.store;
  session.store = next;
  if (!persistComments(session)) {
    session.store = previous;
    await restoreAllThreads(session);
    return;
  }
  wordImportOutput.appendLine(`Imported ${accepted.length} selected change(s): ${acceptedSummary.new} new, ${acceptedSummary.changed} changed; ${summary.unchanged} unchanged in the reviewed document.`);
  vscode.window.showInformationMessage(`Imported ${accepted.length} Word comment change${accepted.length === 1 ? '' : 's'}.`);
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
      const store = activeSession()?.store ?? { comments: [] };
      return store.comments
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
      ...element.comment.replies.map(reply => ({
        timestamp: reply.timestamp,
        item: CommentTreeItem.forReply(element.comment, reply)
      })),
      ...element.comment.trackedChanges.map(change => ({
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
  for (const session of sessions.values()) {
    if (session.saveTimeout) {
      clearTimeout(session.saveTimeout);
      session.saveTimeout = undefined;
      persistComments(session, false);
    }
    if (session.reloadTimeout) {
      clearTimeout(session.reloadTimeout);
      session.reloadTimeout = undefined;
    }
  }
  clearAllPendingTrackedChanges();
}

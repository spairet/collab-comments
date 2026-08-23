import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { CommentData } from './model';
import { mapRenderedSelection, sourceHash } from './quartoMapping';

const MAX_BODY_BYTES = 64 * 1024;
const MAX_TEXT_BYTES = 32 * 1024;
const DESCRIPTOR_PREFIX = 'collab-comments-preview-';
const DESCRIPTOR_TTL_MS = 45_000;
const CAPABILITY_TTL_MS = 30_000;
const DESCRIPTOR_DIRECTORY = 'collab-comments-preview';

export interface QuartoBridgeState {
  sourceText: string;
  sourceHash: string;
  author: string;
  comments: CommentData[];
  etag: string;
}

export type QuartoAction =
  | { type: 'add'; sourceHash: string; selection: { text: string; before: string; after: string }; text: string; author: string }
  | { type: 'reply'; threadId: string; text: string; author: string }
  | { type: 'set-resolved'; threadId: string; resolved: boolean }
  | { type: 'delete-thread'; threadId: string }
  | { type: 'delete-reply'; threadId: string; replyId: string }
  | { type: 'merge-tracked-changes'; threadId: string }
  | { type: 'navigate'; threadId: string };

export interface QuartoBridgeCallbacks {
  state(filePath: string): Promise<QuartoBridgeState>;
  action(filePath: string, action: QuartoAction): Promise<QuartoBridgeState | { status: string }>;
}

export interface PreviewDescriptor {
  schemaVersion: 1;
  workspace: string;
  endpoint: string;
  token: string;
  expiresAt: string;
  heartbeatAt: string;
}

export function shouldStartQuartoBridge(remoteName: string | undefined): boolean {
  return !remoteName;
}

export class QuartoPreviewBridge {
  private server: http.Server | undefined;
  private descriptorPath: string | undefined;
  private token = randomBytes(32).toString('base64url');
  private queue = Promise.resolve();
  private heartbeat: NodeJS.Timeout | undefined;
  private readonly capabilities = new Map<string, { filePath: string; expiresAt: number }>();

  constructor(private readonly workspacePath: string, private readonly callbacks: QuartoBridgeCallbacks) {}

  async start(): Promise<void> {
    this.server = http.createServer((request, response) => { void this.handle(request, response); });
    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject);
      this.server?.listen(0, '127.0.0.1', () => resolve());
    });
    try {
      this.writeDescriptor();
      this.heartbeat = setInterval(() => this.writeDescriptor(), 15_000);
    } catch (error) {
      await new Promise<void>(resolve => this.server?.close(() => resolve()));
      this.server = undefined;
      throw error;
    }
  }

  dispose(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
    }
    this.server?.close();
    this.capabilities.clear();
    if (this.descriptorPath) {
      try { fs.unlinkSync(this.descriptorPath); } catch { /* best-effort cleanup */ }
    }
  }

  /** Exposed only for the Node transport tests; descriptors remain 0600. */
  descriptorPathForTesting(): string | undefined {
    return this.descriptorPath;
  }

  private writeDescriptor(): void {
    const address = this.server?.address();
    if (!address || typeof address === 'string') {
      return;
    }
    const now = new Date();
    const descriptor: PreviewDescriptor = {
      schemaVersion: 1,
      workspace: path.resolve(this.workspacePath),
      endpoint: `http://127.0.0.1:${address.port}`,
      token: this.token,
      expiresAt: new Date(now.getTime() + DESCRIPTOR_TTL_MS).toISOString(),
      heartbeatAt: now.toISOString()
    };
    const directory = this.secureDescriptorDirectory();
    if (!this.descriptorPath) {
      const filename = `${DESCRIPTOR_PREFIX}${randomBytes(18).toString('hex')}.json`;
      this.descriptorPath = path.join(directory, filename);
    }
    const temporary = `${this.descriptorPath}.${randomBytes(8).toString('hex')}.tmp`;
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(descriptor));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, this.descriptorPath);
    fs.chmodSync(this.descriptorPath, 0o600);
  }

  private secureDescriptorDirectory(): string {
    // XDG_RUNTIME_DIR is private to the logged-in user on supported Unix
    // systems. os.tmpdir() is the portable fallback, protected by our 0700
    // child directory and ownership check below.
    const runtimeDirectory = process.env.XDG_RUNTIME_DIR;
    const base = runtimeDirectory && path.isAbsolute(runtimeDirectory) ? runtimeDirectory : os.tmpdir();
    const directory = path.join(base, DESCRIPTOR_DIRECTORY);
    if (!fs.existsSync(directory)) {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    const info = fs.lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error('Preview descriptor directory is not a safe directory.');
    }
    if (process.platform !== 'win32') {
      if ((info.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && info.uid !== process.getuid())) {
        throw new Error('Preview descriptor directory permissions are unsafe.');
      }
      fs.chmodSync(directory, 0o700);
    }
    return directory;
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const origin = request.headers.origin;
    if (!this.isAllowedOrigin(origin)) {
      this.respond(response, 401, { error: 'Unauthorised preview bridge request.' }, origin);
      return;
    }
    if (request.method === 'OPTIONS') {
      this.respond(response, 204, undefined, origin, true);
      return;
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method === 'POST' && url.pathname === '/v1/bootstrap') {
      await this.bootstrap(request, response, origin);
      return;
    }
    const filePath = url.searchParams.get('filePath') ?? '';
    const resolvedFile = this.resolveFile(filePath);
    if (!resolvedFile) {
      this.respond(response, 400, { error: 'filePath must be a QMD file inside this workspace.' }, origin);
      return;
    }
    if (!this.isAuthorised(request, resolvedFile)) {
      this.respond(response, 401, { error: 'Unauthorised preview bridge request.' }, origin);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/v1/state') {
      await this.serial(() => this.respondState(response, resolvedFile, origin, request.headers['if-none-match']));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/actions') {
      const raw = await this.readBody(request);
      if (raw === undefined) {
        this.respond(response, 413, { error: 'Request body is too large.' }, origin);
        return;
      }
      let action: QuartoAction;
      try { action = this.validateAction(JSON.parse(raw)); } catch (error) {
        this.respond(response, 400, { error: error instanceof Error ? error.message : 'Invalid action.' }, origin);
        return;
      }
      await this.serial(async () => {
        try {
          this.respond(response, 200, await this.callbacks.action(resolvedFile, action), origin);
        } catch (error) {
          this.respond(response, 409, { error: error instanceof Error ? error.message : 'Mutation rejected.' }, origin);
        }
      });
      return;
    }
    this.respond(response, 404, { error: 'Not found.' }, origin);
  }

  private async bootstrap(request: http.IncomingMessage, response: http.ServerResponse, origin: string | undefined): Promise<void> {
    if (!this.isPreviewOrigin(origin)) {
      this.respond(response, 401, { error: 'Bootstrap requires a local Quarto preview origin.' }, origin);
      return;
    }
    const raw = await this.readBody(request);
    let inputFile = '';
    try { inputFile = JSON.parse(raw ?? '').inputFile; } catch { /* handled below */ }
    const filePath = typeof inputFile === 'string' ? this.resolveFile(inputFile) : undefined;
    if (!filePath) {
      this.respond(response, 400, { error: 'Bootstrap inputFile must be a workspace QMD file.' }, origin);
      return;
    }
    const token = randomBytes(24).toString('base64url');
    const expiresAt = Date.now() + CAPABILITY_TTL_MS;
    this.capabilities.set(token, { filePath, expiresAt });
    this.respond(response, 200, { token, expiresAt: new Date(expiresAt).toISOString() }, origin);
  }

  private async respondState(
    response: http.ServerResponse,
    filePath: string,
    origin: string | undefined,
    requestedEtag: string | undefined
  ): Promise<void> {
    try {
      const state = await this.callbacks.state(filePath);
      if (requestedEtag === state.etag) {
        this.respond(response, 304, undefined, origin, false, state.etag);
      } else {
        this.respond(response, 200, state, origin, false, state.etag);
      }
    } catch (error) {
      this.respond(response, 409, { error: error instanceof Error ? error.message : 'State unavailable.' }, origin);
    }
  }

  private serial(task: () => Promise<void>): Promise<void> {
    const result = this.queue.then(task, task);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private isAllowedOrigin(origin: string | undefined): boolean {
    return !origin || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin)
      || /^vscode-webview:\/\//i.test(origin);
  }

  private isAuthorised(request: http.IncomingMessage, filePath: string): boolean {
    const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(request.headers.authorization ?? '');
    const token = match?.[1];
    if (token === this.token) {
      return true;
    }
    const capability = token ? this.capabilities.get(token) : undefined;
    if (!capability || capability.expiresAt <= Date.now() || capability.filePath !== filePath) {
      return false;
    }
    capability.expiresAt = Date.now() + CAPABILITY_TTL_MS;
    return true;
  }

  private isPreviewOrigin(origin: string | undefined): boolean {
    return !!origin && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin);
  }

  private resolveFile(filePath: string): string | undefined {
    if (!filePath) {
      return undefined;
    }
    try {
      const candidate = fs.realpathSync.native(filePath);
      const root = fs.realpathSync.native(this.workspacePath);
      const stats = fs.statSync(candidate);
      return stats.isFile()
        && path.extname(candidate).toLowerCase() === '.qmd'
        && candidate.startsWith(`${root}${path.sep}`) ? candidate : undefined;
    } catch {
      return undefined;
    }
  }

  private readBody(request: http.IncomingMessage): Promise<string | undefined> {
    return new Promise(resolve => {
      let size = 0;
      let body = '';
      let exceeded = false;
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => {
        size += Buffer.byteLength(chunk);
        if (size > MAX_BODY_BYTES) {
          exceeded = true;
        } else if (!exceeded) {
          body += chunk;
        }
      });
      request.on('end', () => resolve(exceeded ? undefined : body));
      request.on('error', () => resolve(undefined));
    });
  }

  private validateAction(value: unknown): QuartoAction {
    if (!value || typeof value !== 'object') {throw new Error('Action must be an object.');}
    const action = value as Record<string, unknown>;
    const type = action.type;
    if (typeof type !== 'string') {throw new Error('Action type is required.');}
    const id = (key: string): string => {
      const value = action[key];
      // Historical stores permit arbitrary string identifiers, including empty
      // values. Body limits bound their transport cost without changing them.
      if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_TEXT_BYTES) {throw new Error(`Invalid ${key}.`);}
      return value;
    };
    const text = (key: string): string => {
      const value = action[key];
      if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > MAX_TEXT_BYTES) {throw new Error(`Invalid ${key}.`);}
      return value.trim();
    };
    if (type === 'add') {
      const selection = action.selection as Record<string, unknown> | undefined;
      if (!selection || typeof action.sourceHash !== 'string' || !/^[a-f0-9]{64}$/i.test(action.sourceHash)) {throw new Error('Missing or invalid source hash or selection.');}
      const selected = ['text', 'before', 'after'].map(key => selection[key]);
      if (!selected.every(item => typeof item === 'string') || Buffer.byteLength(selected.join('')) > MAX_TEXT_BYTES) {throw new Error('Invalid selection.');}
      return { type, sourceHash: action.sourceHash, selection: selection as { text: string; before: string; after: string }, text: text('text'), author: text('author') };
    }
    if (type === 'reply') {return { type, threadId: id('threadId'), text: text('text'), author: text('author') };}
    if (type === 'set-resolved') {
      if (typeof action.resolved !== 'boolean') {throw new Error('Invalid resolved state.');}
      return { type, threadId: id('threadId'), resolved: action.resolved };
    }
    if (type === 'delete-thread' || type === 'merge-tracked-changes' || type === 'navigate') {return { type, threadId: id('threadId') };}
    if (type === 'delete-reply') {return { type, threadId: id('threadId'), replyId: id('replyId') };}
    throw new Error('Unsupported action.');
  }

  private respond(
    response: http.ServerResponse,
    status: number,
    payload: unknown,
    origin?: string,
    preflight = false,
    etag?: string
  ): void {
    const headers: Record<string, string> = {};
    headers['Content-Type'] = 'application/json; charset=utf-8';
    headers['Cache-Control'] = 'no-store';
    if (origin && this.isAllowedOrigin(origin)) {headers['Access-Control-Allow-Origin'] = origin;}
    if (preflight) {
      headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
      headers['Access-Control-Allow-Headers'] = 'Authorization, Content-Type, If-None-Match';
      headers['Access-Control-Max-Age'] = '60';
    }
    if (etag) {headers.ETag = etag;}
    response.writeHead(status, headers);
    response.end(payload === undefined ? undefined : JSON.stringify(payload));
  }
}

export { mapRenderedSelection, sourceHash };

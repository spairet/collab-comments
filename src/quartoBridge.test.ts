import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, test } from 'node:test';
import { QuartoAction, QuartoPreviewBridge, QuartoBridgeState, shouldStartQuartoBridge } from './quartoBridge';

const temporaryDirectories: string[] = [];
const bridges: QuartoPreviewBridge[] = [];

afterEach(() => {
  while (bridges.length) {bridges.pop()?.dispose();}
  for (const directory of temporaryDirectories.splice(0)) {fs.rmSync(directory, { recursive: true, force: true });}
});

function fixture(): { root: string; file: string; bridge: QuartoPreviewBridge; actions: QuartoAction[] } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-comments-bridge-'));
  temporaryDirectories.push(root);
  const file = path.join(root, 'document.qmd');
  fs.writeFileSync(file, 'A QMD document.\n');
  const actions: QuartoAction[] = [];
  let running = 0;
  const bridge = new QuartoPreviewBridge(root, {
    state: async (): Promise<QuartoBridgeState> => ({
      sourceText: 'A QMD document.\n', sourceHash: 'a'.repeat(64), author: 'Tester', comments: [], etag: 'state-1'
    }),
    action: async (_file, action) => {
      running++;
      assert.equal(running, 1, 'bridge actions must be serialized');
      await new Promise(resolve => setTimeout(resolve, 10));
      actions.push(action);
      running--;
      return { status: 'ok' };
    }
  });
  bridges.push(bridge);
  return { root, file, bridge, actions };
}

function request(
  endpoint: string,
  requestPath: string,
  options: { method?: string; token?: string; origin?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  const url = new URL(endpoint);
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...options.headers };
    if (options.token) { headers.Authorization = `Bearer ${options.token}`; }
    if (options.origin) { headers.Origin = options.origin; }
    const req = http.request({ hostname: url.hostname, port: url.port, path: requestPath, method: options.method ?? 'GET', headers }, response => {
      let body = '';
      response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }));
    });
    req.on('error', reject); if (options.body) {req.write(options.body);} req.end();
  });
}

test('protects bridge transport and serializes authenticated actions', async () => {
  const { root, file, bridge, actions } = fixture();
  await bridge.start();
  const descriptor = JSON.parse(fs.readFileSync(bridge.descriptorPathForTesting()!, 'utf8')) as { endpoint: string; token: string };
  assert.match(descriptor.endpoint, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(fs.statSync(bridge.descriptorPathForTesting()!).mode & 0o777, 0o600);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.dirname(bridge.descriptorPathForTesting()!)).mode & 0o777, 0o700);
  }
  const filePath = encodeURIComponent(file);
  const origin = 'http://localhost:4444';
  const preflightHeaders: Record<string, string> = {};
  preflightHeaders['Access-Control-Request-Headers'] = 'authorization, content-type';
  const preflight = await request(descriptor.endpoint, `/v1/actions?filePath=${filePath}`, { method: 'OPTIONS', origin, headers: preflightHeaders });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers['access-control-allow-headers'], 'Authorization, Content-Type, If-None-Match');
  assert.equal((await request(descriptor.endpoint, `/v1/state?filePath=${filePath}`, { origin })).status, 401);
  const rawAuthHeaders: Record<string, string> = {}; rawAuthHeaders.Authorization = descriptor.token;
  assert.equal((await request(descriptor.endpoint, `/v1/state?filePath=${filePath}`, { headers: rawAuthHeaders })).status, 401);
  assert.equal((await request(descriptor.endpoint, `/v1/state?filePath=${encodeURIComponent(path.join(root, '..', 'outside.qmd'))}`, { token: descriptor.token })).status, 400);
  const state = await request(descriptor.endpoint, `/v1/state?filePath=${filePath}`, { token: descriptor.token, origin });
  assert.equal(state.status, 200); assert.equal(JSON.parse(state.body).etag, 'state-1');
  const etagHeaders: Record<string, string> = {}; etagHeaders['If-None-Match'] = 'state-1';
  assert.equal((await request(descriptor.endpoint, `/v1/state?filePath=${filePath}`, { token: descriptor.token, headers: etagHeaders })).status, 304);
  const add = JSON.stringify({ type: 'add', sourceHash: 'a'.repeat(64), selection: { text: 'QMD', before: 'A ', after: ' document.' }, text: 'One', author: 'Tester' });
  const actionHeaders: Record<string, string> = {}; actionHeaders['Content-Type'] = 'application/json';
  const responses = await Promise.all([1, 2].map(() => request(descriptor.endpoint, `/v1/actions?filePath=${filePath}`, { method: 'POST', token: descriptor.token, headers: actionHeaders, body: add })));
  assert.deepEqual(responses.map(response => response.status), [200, 200]); assert.equal(actions.length, 2);
});

test('rejects symlinked QMD paths that escape the workspace', async () => {
  const { root, bridge } = fixture();
  const outside = path.join(os.tmpdir(), `collab-comments-outside-${Date.now()}.qmd`);
  fs.writeFileSync(outside, 'outside');
  const link = path.join(root, 'escape.qmd'); fs.symlinkSync(outside, link);
  await bridge.start();
  const descriptor = JSON.parse(fs.readFileSync(bridge.descriptorPathForTesting()!, 'utf8')) as { endpoint: string; token: string };
  const response = await request(descriptor.endpoint, `/v1/state?filePath=${encodeURIComponent(link)}`, { token: descriptor.token });
  assert.equal(response.status, 400);
  fs.unlinkSync(outside);
});

test('issues file-scoped preview capabilities and supports legacy identifiers', async () => {
  const { root, file, bridge, actions } = fixture();
  const anotherFile = path.join(root, 'another.qmd'); fs.writeFileSync(anotherFile, 'Another QMD document.\n');
  await bridge.start();
  const descriptor = JSON.parse(fs.readFileSync(bridge.descriptorPathForTesting()!, 'utf8')) as { endpoint: string };
  const contentTypeHeaders: Record<string, string> = {}; contentTypeHeaders['Content-Type'] = 'application/json';
  const bootstrap = await request(descriptor.endpoint, '/v1/bootstrap', { method: 'POST', origin: 'http://localhost:4444', headers: contentTypeHeaders, body: JSON.stringify({ inputFile: file }) });
  assert.equal(bootstrap.status, 200);
  const capability = JSON.parse(bootstrap.body).token as string;
  assert.equal((await request(descriptor.endpoint, '/v1/bootstrap', { method: 'POST', origin: 'http://[::1]:4444', headers: contentTypeHeaders, body: JSON.stringify({ inputFile: file }) })).status, 200);
  assert.equal((await request(descriptor.endpoint, '/v1/bootstrap', { method: 'POST', origin: 'https://example.com', headers: contentTypeHeaders, body: JSON.stringify({ inputFile: file }) })).status, 401);
  const reply = JSON.stringify({ type: 'reply', threadId: `legacy id.with spaces.${'x'.repeat(200)}`, text: 'reply', author: 'Tester' });
  const response = await request(descriptor.endpoint, `/v1/actions?filePath=${encodeURIComponent(file)}`, { method: 'POST', token: capability, headers: contentTypeHeaders, body: reply });
  assert.equal(response.status, 200); assert.equal(actions[0].type, 'reply');
  assert.equal((await request(descriptor.endpoint, `/v1/actions?filePath=${encodeURIComponent(anotherFile)}`, { method: 'POST', token: capability, headers: contentTypeHeaders, body: reply })).status, 401);
  const huge = 'x'.repeat(70 * 1024);
  assert.equal((await request(descriptor.endpoint, `/v1/actions?filePath=${encodeURIComponent(file)}`, { method: 'POST', token: capability, headers: contentTypeHeaders, body: huge })).status, 413);
});

test('does not start the local bridge in remote VS Code sessions', () => {
  assert.equal(shouldStartQuartoBridge(undefined), true);
  assert.equal(shouldStartQuartoBridge('ssh-remote'), false);
});

test('dispatches each supported bridge action discriminator', async () => {
  const { file, bridge, actions } = fixture();
  await bridge.start();
  const descriptor = JSON.parse(fs.readFileSync(bridge.descriptorPathForTesting()!, 'utf8')) as { endpoint: string; token: string };
  const headers: Record<string, string> = {}; headers['Content-Type'] = 'application/json';
  const filePath = encodeURIComponent(file);
  const values: QuartoAction[] = [
    { type: 'add', sourceHash: 'a'.repeat(64), selection: { text: 'QMD', before: 'A ', after: ' document.' }, text: 'Note', author: 'Tester' },
    { type: 'reply', threadId: '', text: 'Reply', author: 'Tester' },
    { type: 'set-resolved', threadId: 'thread', resolved: true },
    { type: 'set-resolved', threadId: 'thread', resolved: false },
    { type: 'delete-thread', threadId: 'thread' },
    { type: 'delete-reply', threadId: 'thread', replyId: 'reply' },
    { type: 'merge-tracked-changes', threadId: 'thread' },
    { type: 'navigate', threadId: 'thread' }
  ];
  for (const value of values) {
    const response = await request(descriptor.endpoint, `/v1/actions?filePath=${filePath}`, {
      method: 'POST', token: descriptor.token, headers, body: JSON.stringify(value)
    });
    assert.equal(response.status, 200);
  }
  assert.deepEqual(actions.map(action => action.type), values.map(action => action.type));
});

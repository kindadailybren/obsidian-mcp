import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Server } from 'node:http';
import { FileManager } from '../src/vault/fileManager.js';
import { SearchIndex } from '../src/vault/searchIndex.js';
import { VaultGraph } from '../src/vault/graph.js';
import { DailyNotesManager } from '../src/vault/dailyNotes.js';
import { createHttpServer } from '../src/transport/http.js';
import { Config } from '../src/config.js';

describe('HTTP & Authentication Transport', () => {
  let tempDir: string;
  let server: Server;
  let baseUrl: string;
  const testAuthToken = 'secret-test-token-123';

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'obsidian-http-test-'));
    const fileManager = new FileManager(tempDir, '.trash');
    const searchIndex = new SearchIndex(fileManager);
    const vaultGraph = new VaultGraph(fileManager);
    const dailyNotes = new DailyNotesManager(fileManager);

    await fileManager.createNote('Hello.md', '# Hello World\nWelcome to Obsidian MCP.');
    await searchIndex.initialize(false);

    const config: Config = {
      vaultPath: tempDir,
      port: 0, // dynamic port
      host: '127.0.0.1',
      authToken: testAuthToken,
      dailyNotesFolder: 'Daily Notes',
      dailyNotesFormat: 'YYYY-MM-DD',
      trashFolder: '.trash',
      transportMode: 'http',
    };

    const app = createHttpServer(config, {
      fileManager,
      searchIndex,
      vaultGraph,
      dailyNotesManager: dailyNotes,
    });

    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address() as any;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('allows access to unauthenticated /health endpoint', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.status).toBe('healthy');
    expect(data.authEnabled).toBe(true);
  });

  it('serves the Web Reader UI at root endpoint', async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Obsidian Vault Reader');
  });

  it('rejects protected endpoints when auth token is missing', async () => {
    const res = await fetch(`${baseUrl}/api/notes`);
    expect(res.status).toBe(401);
  });

  it('rejects protected endpoints when invalid token is provided', async () => {
    const res = await fetch(`${baseUrl}/api/notes`, {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    expect(res.status).toBe(401);
  });

  it('rejects tokens passed in query parameters for security', async () => {
    const res = await fetch(`${baseUrl}/api/notes?token=${testAuthToken}`);
    expect(res.status).toBe(401);
  });

  it('authorizes requests with Bearer token', async () => {
    const res = await fetch(`${baseUrl}/api/notes`, {
      headers: { Authorization: `Bearer ${testAuthToken}` },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.count).toBe(1);
    expect(data.notes[0].path).toBe('Hello.md');
  });

  it('authorizes requests with x-api-key header', async () => {
    const res = await fetch(`${baseUrl}/api/notes`, {
      headers: { 'x-api-key': testAuthToken },
    });
    expect(res.status).toBe(200);
  });

  it('executes REST search endpoint with query parameter', async () => {
    const res = await fetch(`${baseUrl}/api/search?q=Obsidian`, {
      headers: { Authorization: `Bearer ${testAuthToken}` },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.count).toBe(1);
    expect(data.results[0].path).toBe('Hello.md');
  });

  it('reads a specific note via /api/note endpoint', async () => {
    const res = await fetch(`${baseUrl}/api/note?name=Hello`, {
      headers: { Authorization: `Bearer ${testAuthToken}` },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.title).toBe('Hello');
    expect(data.content).toContain('Welcome to Obsidian MCP');
  });

  it('rejects /mcp requests without authorization', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0' },
        },
      }),
    });
    expect(res.status).toBe(401);
  });

  it('handles modern Streamable HTTP /mcp initialize and tools/list', async () => {
    const initRes = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${testAuthToken}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        },
      }),
    });

    expect(initRes.status).toBe(200);
    const sessionId = initRes.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();

    const toolsRes = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${testAuthToken}`,
        'mcp-session-id': sessionId!,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      }),
    });

    expect(toolsRes.status).toBe(200);
    const text = await toolsRes.text();
    expect(text).toContain('search_notes');
    expect(text).toContain('read_note');
  });

  it('supports stateless one-shot calls to /mcp', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${testAuthToken}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 99,
        method: 'tools/list',
        params: {},
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('search_notes');
  });

  it('exposes RFC 8414 and RFC 9728 OAuth discovery metadata', async () => {
    const metaRes = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
    expect(metaRes.status).toBe(200);
    const meta = (await metaRes.json()) as any;
    expect(meta.authorization_endpoint).toContain('/oauth/authorize');
    expect(meta.token_endpoint).toContain('/oauth/token');
    expect(meta.code_challenge_methods_supported).toContain('S256');

    const resourceRes = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`);
    expect(resourceRes.status).toBe(200);
    const resource = (await resourceRes.json()) as any;
    expect(resource.bearer_methods_supported).toContain('header');
  });

  it('executes full OAuth 2.1 PKCE authorization flow', async () => {
    // 1. Dynamic client registration
    const regRes = await fetch(`${baseUrl}/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Claude Test Client',
        redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
      }),
    });
    expect(regRes.status).toBe(201);
    const reg = (await regRes.json()) as any;
    expect(reg.client_id).toBeTruthy();

    // 2. PKCE setup
    const crypto = await import('node:crypto');
    const codeVerifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const codeChallenge = crypto
      .createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');

    // 3. Authorize request with auto=true
    const authUrl = `${baseUrl}/oauth/authorize?client_id=${reg.client_id}&redirect_uri=https://claude.ai/api/mcp/auth_callback&response_type=code&code_challenge=${codeChallenge}&code_challenge_method=S256&state=xyz123&auto=true`;
    const authRes = await fetch(authUrl, { redirect: 'manual' });
    expect(authRes.status).toBe(302);
    const location = authRes.headers.get('location')!;
    expect(location).toContain('https://claude.ai/api/mcp/auth_callback');
    const redirectUrl = new URL(location);
    const code = redirectUrl.searchParams.get('code');
    expect(code).toBeTruthy();
    expect(redirectUrl.searchParams.get('state')).toBe('xyz123');

    // 4. Exchange code for access token at /oauth/token
    const tokenRes = await fetch(`${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code!,
        redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
        client_id: reg.client_id,
        code_verifier: codeVerifier,
      }),
    });
    expect(tokenRes.status).toBe(200);
    const tokenData = (await tokenRes.json()) as any;
    expect(tokenData.access_token).toBe(testAuthToken);
    expect(tokenData.token_type).toBe('Bearer');

    // 5. Use returned access token to query /mcp
    const mcpRes = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenData.access_token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/list',
        params: {},
      }),
    });
    expect(mcpRes.status).toBe(200);
    const mcpBody = await mcpRes.text();
    expect(mcpBody).toContain('search_notes');
  });
});

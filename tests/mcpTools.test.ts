import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { FileManager } from '../src/vault/fileManager.js';
import { SearchIndex } from '../src/vault/searchIndex.js';
import { VaultGraph } from '../src/vault/graph.js';
import { DailyNotesManager } from '../src/vault/dailyNotes.js';
import { createObsidianMcpServer } from '../src/server.js';

describe('MCP Protocol Tools End-to-End', () => {
  let tempDir: string;
  let fileManager: FileManager;
  let searchIndex: SearchIndex;
  let client: Client;
  let clientTransport: any;
  let serverTransport: any;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'obsidian-mcp-test-'));
    fileManager = new FileManager(tempDir, '.trash');
    searchIndex = new SearchIndex(fileManager);
    const vaultGraph = new VaultGraph(fileManager);
    const dailyNotes = new DailyNotesManager(fileManager);

    await fileManager.createNote('Overview.md', '# Overview\nSystem architecture details.', { project: 'core' });
    await searchIndex.initialize(false);

    const mcpServer = createObsidianMcpServer({
      fileManager,
      searchIndex,
      vaultGraph,
      dailyNotesManager: dailyNotes,
    });

    [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test-agent', version: '1.0.0' }, { capabilities: {} });

    await mcpServer.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await searchIndex.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('lists all 8 registered MCP tools', async () => {
    const response = await client.listTools();
    const toolNames = response.tools.map((t) => t.name);

    expect(toolNames).toContain('search_notes');
    expect(toolNames).toContain('read_note');
    expect(toolNames).toContain('create_note');
    expect(toolNames).toContain('append_to_note');
    expect(toolNames).toContain('patch_note');
    expect(toolNames).toContain('list_notes');
    expect(toolNames).toContain('get_daily_note');
    expect(toolNames).toContain('get_backlinks');
    expect(toolNames.length).toBe(8);
  });

  it('calls search_notes tool via MCP protocol', async () => {
    const res = await client.callTool({
      name: 'search_notes',
      arguments: { query: 'architecture' },
    });

    expect(res.isError).toBeFalsy();
    const textContent = (res.content[0] as any).text;
    const parsed = JSON.parse(textContent);
    expect(parsed.count).toBe(1);
    expect(parsed.results[0].path).toBe('Overview.md');
  });

  it('calls create_note and read_note tools via MCP protocol', async () => {
    const createRes = await client.callTool({
      name: 'create_note',
      arguments: {
        path: 'Research/Ideas.md',
        content: '# Ideas\n- Build an autonomous agent [[Overview]]',
        tags: ['research', 'mcp'],
        frontmatter: { author: 'Bren' },
      },
    });

    expect(createRes.isError).toBeFalsy();
    const createData = JSON.parse((createRes.content[0] as any).text);
    expect(createData.status).toBe('created');
    expect(createData.path).toBe('Research/Ideas.md');

    const readRes = await client.callTool({
      name: 'read_note',
      arguments: { path: 'Research/Ideas.md' },
    });

    expect(readRes.isError).toBeFalsy();
    const readData = JSON.parse((readRes.content[0] as any).text);
    expect(readData.title).toBe('Ideas');
    expect(readData.tags).toContain('research');
    expect(readData.frontmatter.author).toBe('Bren');
  });

  it('calls get_backlinks tool via MCP protocol', async () => {
    await client.callTool({
      name: 'create_note',
      arguments: {
        path: 'Docs/Reference.md',
        content: 'Check out the [[Overview]] page for details.',
      },
    });

    const backlinksRes = await client.callTool({
      name: 'get_backlinks',
      arguments: { path: 'Overview' },
    });

    expect(backlinksRes.isError).toBeFalsy();
    const data = JSON.parse((backlinksRes.content[0] as any).text);
    expect(data.note).toBe('Overview.md');
    expect(data.backlinks.length).toBe(1);
    expect(data.backlinks[0].source).toBe('Docs/Reference.md');
  });

  it('calls get_daily_note and append_to_note tools', async () => {
    const dailyRes = await client.callTool({
      name: 'get_daily_note',
      arguments: { date: '2026-10-20' },
    });

    expect(dailyRes.isError).toBeFalsy();
    const dailyData = JSON.parse((dailyRes.content[0] as any).text);
    expect(dailyData.path).toBe('Daily Notes/2026-10-20.md');

    const appendRes = await client.callTool({
      name: 'append_to_note',
      arguments: {
        path: 'Daily Notes/2026-10-20.md',
        content: '- Completed MCP integration tests',
        section: 'Log',
      },
    });

    expect(appendRes.isError).toBeFalsy();
    const appendData = JSON.parse((appendRes.content[0] as any).text);
    expect(appendData.status).toBe('appended');
  });

  it('registers only read-only tools and blocks daily note creation when readOnly: true', async () => {
    const vaultGraph = new VaultGraph(fileManager);
    const dailyNotes = new DailyNotesManager(fileManager);

    await fileManager.createNote('Public/Shared.md', '# Shared Note\nVisible to read-only.', {}, ['public']);
    await fileManager.createNote('Private/Hidden.md', '# Hidden Note\nSecret.', {}, ['secret']);
    await searchIndex.initialize(false);

    const roServer = createObsidianMcpServer(
      {
        fileManager,
        searchIndex,
        vaultGraph,
        dailyNotesManager: dailyNotes,
      },
      {
        readOnly: true,
        scope: { allowedFolders: ['Public', 'Daily Notes'] },
      }
    );

    const [roClientTransport, roServerTransport] = InMemoryTransport.createLinkedPair();
    const roClient = new Client({ name: 'ro-test-agent', version: '1.0.0' }, { capabilities: {} });

    await roServer.connect(roServerTransport);
    await roClient.connect(roClientTransport);

    const toolsRes = await roClient.listTools();
    const roToolNames = toolsRes.tools.map((t) => t.name);

    expect(roToolNames).toEqual([
      'search_notes',
      'read_note',
      'list_notes',
      'get_daily_note',
      'get_backlinks',
    ]);
    expect(roToolNames).not.toContain('create_note');
    expect(roToolNames).not.toContain('append_to_note');
    expect(roToolNames).not.toContain('patch_note');

    // Allowed note can be read
    const allowedRead = await roClient.callTool({
      name: 'read_note',
      arguments: { path: 'Public/Shared.md' },
    });
    expect(allowedRead.isError).toBeFalsy();

    // Restricted note is blocked
    const blockedRead = await roClient.callTool({
      name: 'read_note',
      arguments: { path: 'Private/Hidden.md' },
    });
    expect(blockedRead.isError).toBe(true);
    expect((blockedRead.content[0] as any).text).toContain('outside your allowed scope');

    // get_daily_note in read-only mode does not create a missing daily note
    const missingDaily = await roClient.callTool({
      name: 'get_daily_note',
      arguments: { date: '2099-01-01', createIfMissing: true },
    });
    expect(missingDaily.isError).toBe(true);

    await roClient.close();
  });
});

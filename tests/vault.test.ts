import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { FileManager } from '../src/vault/fileManager.js';
import { SearchIndex } from '../src/vault/searchIndex.js';
import { VaultGraph } from '../src/vault/graph.js';
import { DailyNotesManager } from '../src/vault/dailyNotes.js';

describe('Obsidian Vault Engine', () => {
  let tempDir: string;
  let fileManager: FileManager;
  let searchIndex: SearchIndex;
  let vaultGraph: VaultGraph;
  let dailyNotes: DailyNotesManager;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'obsidian-test-'));
    fileManager = new FileManager(tempDir, '.trash');
    searchIndex = new SearchIndex(fileManager);
    vaultGraph = new VaultGraph(fileManager);
    dailyNotes = new DailyNotesManager(fileManager, 'Daily Notes', 'YYYY-MM-DD');
  });

  afterEach(async () => {
    await searchIndex.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('FileManager', () => {
    it('creates and reads a note with frontmatter and tags', async () => {
      const res = await fileManager.createNote(
        'Projects/Apollo.md',
        '# Apollo Project\nThis is a mission to build a distributed system.',
        { status: 'in-progress', priority: 'high' },
        ['space', 'distributed']
      );

      expect(res.path).toBe('Projects/Apollo.md');

      const note = await fileManager.readNote('Projects/Apollo.md');
      expect(note.title).toBe('Apollo');
      expect(note.frontmatter.status).toBe('in-progress');
      expect(note.frontmatter.priority).toBe('high');
      expect(note.tags).toContain('space');
      expect(note.tags).toContain('distributed');
      expect(note.content).toContain('This is a mission to build a distributed system.');
    });

    it('rejects path traversal attempts escaping the vault', async () => {
      await expect(
        fileManager.readNote('../../../etc/passwd')
      ).rejects.toThrow(/traverses outside of the vault/);

      await expect(
        fileManager.createNote('../outside.md', 'hacked')
      ).rejects.toThrow(/traverses outside of the vault/);

      // Sibling prefix bypass check (e.g. /tmp/vault-other when vault is /tmp/vault)
      const siblingDir = `${tempDir}-sibling`;
      await expect(
        fileManager.readNote(`../${path.basename(siblingDir)}/secret.md`)
      ).rejects.toThrow(/traverses outside of the vault/);

      // Hidden/system folder direct access check
      await expect(
        fileManager.readNote('.obsidian/workspace.json')
      ).rejects.toThrow(/cannot directly access hidden\/system path/);
    });

    it('enforces read-only scope policies (allowedFolders and allowedTags)', async () => {
      await fileManager.createNote('Public/Guide.md', 'Public guide', {}, ['shared']);
      await fileManager.createNote('Private/Secrets.md', 'Top secret', {}, ['private']);

      const folderScope = { allowedFolders: ['Public'] };
      const allowedNote = await fileManager.readNote('Public/Guide.md', folderScope);
      expect(allowedNote.title).toBe('Guide');

      await expect(
        fileManager.readNote('Private/Secrets.md', folderScope)
      ).rejects.toThrow(/outside your allowed scope/);

      const scopedList = await fileManager.listNotes({ scope: folderScope });
      expect(scopedList.map((n) => n.path)).toEqual(['Public/Guide.md']);

      const tagScope = { allowedTags: ['shared'] };
      const tagScopedList = await fileManager.listNotes({ scope: tagScope });
      expect(tagScopedList.map((n) => n.path)).toEqual(['Public/Guide.md']);
    });

    it('appends content under a heading and creates a backup', async () => {
      await fileManager.createNote(
        'Log.md',
        '# Main Log\n\n## Tasks\n- Task 1\n\n## Notes\nInitial notes.'
      );

      const appendRes = await fileManager.appendToNote('Log.md', '- Task 2', 'Tasks');
      expect(appendRes.path).toBe('Log.md');
      expect(appendRes.backupPath).toBeDefined();

      const updated = await fileManager.readNote('Log.md');
      expect(updated.content).toContain('- Task 1');
      expect(updated.content).toContain('- Task 2');
    });

    it('patches text safely with automatic backup in .trash', async () => {
      await fileManager.createNote('Config.md', 'timeout = 5000\nretries = 3');

      const patchRes = await fileManager.patchNote('Config.md', 'retries = 3', 'retries = 10');
      expect(patchRes.backupPath).toMatch(/^\.trash\//);

      const updated = await fileManager.readNote('Config.md');
      expect(updated.content).toBe('timeout = 5000\nretries = 10');

      // Verify backup file exists on disk
      const backupExists = await fs.stat(path.join(tempDir, patchRes.backupPath));
      expect(backupExists.isFile()).toBe(true);
    });

    it('lists notes with filtering', async () => {
      await fileManager.createNote('A.md', 'Content A', {}, ['tech']);
      await fileManager.createNote('B.md', 'Content B', {}, ['finance']);
      await fileManager.createNote('Sub/C.md', 'Content C', {}, ['tech']);

      const all = await fileManager.listNotes();
      expect(all.length).toBe(3);

      const techOnly = await fileManager.listNotes({ tag: 'tech' });
      expect(techOnly.length).toBe(2);

      const subOnly = await fileManager.listNotes({ folder: 'Sub' });
      expect(subOnly.length).toBe(1);
    });
  });

  describe('SearchIndex (BM25)', () => {
    it('indexes notes and searches with relevance and snippets', async () => {
      await fileManager.createNote(
        'AI/Agents.md',
        'Autonomous AI agents use Model Context Protocol to talk to local knowledge bases.',
        { topic: 'AI' },
        ['ai', 'agents']
      );

      await fileManager.createNote(
        'Cooking/Pasta.md',
        'Boil water with salt and cook pasta for 10 minutes.',
        { recipe: 'Pasta' },
        ['food']
      );

      await searchIndex.initialize(false);

      const searchResults = await searchIndex.search('Model Context Protocol');
      expect(searchResults.length).toBeGreaterThan(0);
      expect(searchResults[0].path).toBe('AI/Agents.md');
      expect(searchResults[0].snippet).toContain('Model Context Protocol');

      const foodResults = await searchIndex.search('pasta', { tags: ['food'] });
      expect(foodResults.length).toBe(1);
      expect(foodResults[0].path).toBe('Cooking/Pasta.md');
    });
  });

  describe('VaultGraph (Backlinks & Wiki-links)', () => {
    it('resolves wiki-links and backlinks between notes', async () => {
      await fileManager.createNote('Architecture.md', '# System Architecture\nCore design specifications.');
      await fileManager.createNote(
        'Features.md',
        '# Features\nBuilt on top of [[Architecture]] and [[NonExistent#Heading|Alternative]].'
      );
      await fileManager.createNote(
        'Daily Notes/2026-10-20.md',
        'Reviewed [[Architecture]] today with the team.'
      );

      const backlinks = await vaultGraph.getBacklinks('Architecture');
      expect(backlinks.note).toBe('Architecture.md');
      expect(backlinks.backlinks.length).toBe(2);

      const sources = backlinks.backlinks.map((b) => b.source);
      expect(sources).toContain('Features.md');
      expect(sources).toContain('Daily Notes/2026-10-20.md');

      const featureBacklink = backlinks.backlinks.find((b) => b.source === 'Features.md');
      expect(featureBacklink?.context).toContain('[[Architecture]]');
    });
  });

  describe('DailyNotesManager', () => {
    it('creates today daily note with default template if missing', async () => {
      const today = dailyNotes.formatDate();
      const note = await dailyNotes.getDailyNote({ date: today, createIfMissing: true });

      expect(note.path).toBe(`Daily Notes/${today}.md`);
      expect(note.content).toContain(`Daily Note: ${today}`);
      expect(note.tags).toContain('daily-notes');
    });

    it('appends to daily note section', async () => {
      const today = dailyNotes.formatDate();
      await dailyNotes.appendToDailyNote('- Finished MCP server tests', 'Log', today);

      const note = await dailyNotes.getDailyNote({ date: today });
      expect(note.content).toContain('- Finished MCP server tests');
    });
  });
});

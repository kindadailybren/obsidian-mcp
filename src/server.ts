import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { FileManager, ReadScopePolicy } from './vault/fileManager.js';
import { SearchIndex } from './vault/searchIndex.js';
import { VaultGraph } from './vault/graph.js';
import { DailyNotesManager } from './vault/dailyNotes.js';

export interface ServerDependencies {
  fileManager: FileManager;
  searchIndex: SearchIndex;
  vaultGraph: VaultGraph;
  dailyNotesManager: DailyNotesManager;
}

export interface McpServerOptions {
  readOnly?: boolean;
  scope?: ReadScopePolicy;
}

export function createObsidianMcpServer(
  deps: ServerDependencies,
  options: McpServerOptions = {}
): McpServer {
  const { fileManager, searchIndex, vaultGraph, dailyNotesManager } = deps;
  const isReadOnly = Boolean(options.readOnly);
  const scope = isReadOnly ? options.scope : undefined;

  const server = new McpServer({
    name: 'mcp-obsidian',
    version: '1.0.0',
  });

  // 1. search_notes
  server.tool(
    'search_notes',
    'Search notes across the Obsidian vault with BM25 relevance ranking, tag filtering, and folder filtering.',
    {
      query: z.string().describe('Search query string or keywords'),
      tags: z.array(z.string()).optional().describe('Filter notes by one or more tags'),
      folder: z.string().optional().describe('Limit search to a specific folder'),
      limit: z.number().optional().default(10).describe('Max results to return (default 10)'),
    },
    async ({ query, tags, folder, limit }) => {
      try {
        const results = await searchIndex.search(query, { tags, folder, limit, scope });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  count: results.length,
                  results: results.map((r) => ({
                    path: r.path,
                    title: r.title,
                    score: Math.round(r.score * 100) / 100,
                    tags: r.tags,
                    snippet: r.snippet,
                  })),
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [{ type: 'text', text: `Search error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // 2. read_note
  server.tool(
    'read_note',
    'Read the full markdown content, YAML frontmatter, and metadata of an Obsidian note.',
    {
      path: z.string().describe("Relative path or title of the note (e.g. 'Daily Notes/2026-10-20.md' or 'My Idea')"),
    },
    async ({ path: notePath }) => {
      try {
        const note = await fileManager.readNote(notePath, scope);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  path: note.path,
                  title: note.title,
                  tags: note.tags,
                  frontmatter: note.frontmatter,
                  modifiedAt: note.mtime.toISOString(),
                  sizeBytes: note.size,
                  content: note.content,
                  rawMarkdown: note.rawContent,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [{ type: 'text', text: `Read error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  if (!isReadOnly) {
    // 3. create_note
    server.tool(
      'create_note',
      'Create a new note in the Obsidian vault with optional frontmatter and tags.',
      {
        path: z.string().describe("Relative path where the note should be saved (e.g. 'Projects/Alpha.md')"),
        content: z.string().describe('Markdown body of the note'),
        tags: z.array(z.string()).optional().describe('Tags to attach to the note'),
        frontmatter: z.record(z.string(), z.any()).optional().describe('Key-value pairs to store in YAML frontmatter'),
        overwrite: z.boolean().optional().default(false).describe('Overwrite existing note (creates safety backup in .trash)'),
      },
      async ({ path: notePath, content, tags, frontmatter, overwrite }) => {
        try {
          const result = await fileManager.createNote(notePath, content, frontmatter, tags, overwrite);
          const createdNote = await fileManager.readNote(result.path);
          searchIndex.addOrUpdateNote(createdNote);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    status: 'created',
                    path: result.path,
                    backupPath: result.backupPath || null,
                    wikiLink: `[[${result.path.replace(/\.md$/, '')}]]`,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        } catch (err: any) {
          return {
            content: [{ type: 'text', text: `Create error: ${err.message}` }],
            isError: true,
          };
        }
      }
    );

    // 4. append_to_note
    server.tool(
      'append_to_note',
      'Append content to an existing note, or optionally insert content directly under a specific heading.',
      {
        path: z.string().describe('Relative path or title of the note'),
        content: z.string().describe('Text or markdown to append'),
        section: z.string().optional().describe("Optional heading name under which to append (e.g. 'Log' or '## Ideas')"),
      },
      async ({ path: notePath, content, section }) => {
        try {
          const result = await fileManager.appendToNote(notePath, content, section);
          const updated = await fileManager.readNote(result.path);
          searchIndex.addOrUpdateNote(updated);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    status: 'appended',
                    path: result.path,
                    section: section || 'end-of-file',
                    backupPath: result.backupPath || null,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        } catch (err: any) {
          return {
            content: [{ type: 'text', text: `Append error: ${err.message}` }],
            isError: true,
          };
        }
      }
    );

    // 5. patch_note
    server.tool(
      'patch_note',
      'Safely replace a target snippet or section inside an existing note. A backup snapshot is automatically created in .trash first.',
      {
        path: z.string().describe('Relative path or title of the note'),
        target: z.string().describe('Exact text substring to be replaced'),
        replacement: z.string().describe('New replacement text'),
      },
      async ({ path: notePath, target, replacement }) => {
        try {
          const result = await fileManager.patchNote(notePath, target, replacement);
          const updated = await fileManager.readNote(result.path);
          searchIndex.addOrUpdateNote(updated);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    status: 'patched',
                    path: result.path,
                    backupPath: result.backupPath,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        } catch (err: any) {
          return {
            content: [{ type: 'text', text: `Patch error: ${err.message}` }],
            isError: true,
          };
        }
      }
    );
  }

  // 6. list_notes
  server.tool(
    'list_notes',
    'List and browse notes in the vault with optional folder, tag, or pagination filters.',
    {
      folder: z.string().optional().describe('Subfolder to list notes from'),
      tag: z.array(z.string()).or(z.string()).optional().describe('Filter notes by tag'),
      recursive: z.boolean().optional().default(true).describe('Recurse into subdirectories (default true)'),
      limit: z.number().optional().default(50).describe('Max results (default 50)'),
    },
    async ({ folder, tag, recursive, limit }) => {
      try {
        const singleTag = Array.isArray(tag) ? tag[0] : tag;
        const notes = await fileManager.listNotes({ folder, tag: singleTag, recursive, limit, scope });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  count: notes.length,
                  notes: notes.map((n) => ({
                    path: n.path,
                    title: n.title,
                    tags: n.tags,
                    modifiedAt: n.mtime.toISOString(),
                    sizeBytes: n.size,
                  })),
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [{ type: 'text', text: `List error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // 7. get_daily_note
  server.tool(
    'get_daily_note',
    isReadOnly
      ? "Fetch today's daily note (or a specific date) in read-only mode."
      : "Fetch today's daily note (or a specific date). Creates it with a template if it does not already exist.",
    {
      date: z.string().optional().describe("Date in YYYY-MM-DD format (defaults to today's local date)"),
      createIfMissing: z
        .boolean()
        .optional()
        .default(!isReadOnly)
        .describe(
          isReadOnly
            ? 'Ignored in read-only mode (never creates missing notes)'
            : 'Create the daily note if missing (default true)'
        ),
    },
    async ({ date, createIfMissing }) => {
      try {
        const allowCreate = isReadOnly ? false : createIfMissing;
        const note = await dailyNotesManager.getDailyNote({
          date,
          createIfMissing: allowCreate,
          scope,
        });
        if (!isReadOnly) {
          searchIndex.addOrUpdateNote(note);
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  path: note.path,
                  title: note.title,
                  tags: note.tags,
                  modifiedAt: note.mtime.toISOString(),
                  content: note.content,
                  rawMarkdown: note.rawContent,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [{ type: 'text', text: `Daily note error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // 8. get_backlinks
  server.tool(
    'get_backlinks',
    'Find both forward links ([[links]] contained in this note) and backlinks (all notes referencing this note).',
    {
      path: z.string().describe('Relative path or title of the note'),
    },
    async ({ path: notePath }) => {
      try {
        const backlinks = await vaultGraph.getBacklinks(notePath, scope);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(backlinks, null, 2),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [{ type: 'text', text: `Backlinks error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  return server;
}

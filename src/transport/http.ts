import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { Config } from '../config.js';
import { createObsidianMcpServer, ServerDependencies } from '../server.js';

export function createHttpServer(config: Config, deps: ServerDependencies) {
  const app = express();
  const transports = new Map<string, SSEServerTransport>();

  app.use(cors());
  app.use(express.json({ limit: '10mb' }));

  // Authentication Middleware
  const authMiddleware = (req: Request, res: Response, next: NextFunction) => {
    // Skip auth for health check
    if (req.path === '/health') {
      return next();
    }

    if (!config.authToken) {
      return next(); // Auth disabled if no token set
    }

    const authHeader = req.headers.authorization;
    const apiKeyHeader = req.headers['x-api-key'];

    let providedToken: string | undefined;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      providedToken = authHeader.slice(7).trim();
    } else if (apiKeyHeader) {
      providedToken = String(apiKeyHeader).trim();
    }

    if (!providedToken || providedToken !== config.authToken) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Valid Bearer token or x-api-key header is required in request headers.',
      });
      return;
    }

    next();
  };

  app.use(authMiddleware);

  // Health check endpoint
  app.get('/health', async (_req: Request, res: Response) => {
    const notes = await deps.fileManager.listNotes({ limit: 1 });
    res.json({
      status: 'healthy',
      server: 'mcp-obsidian',
      version: '1.0.0',
      vaultPath: deps.fileManager.getVaultPath(),
      hasNotes: notes.length > 0,
      authEnabled: Boolean(config.authToken),
    });
  });

  // REST API helpers (for direct browser/webhook usage)
  app.get('/api/search', async (req: Request, res: Response) => {
    const q = req.query.q as string;
    if (!q) {
      res.status(400).json({ error: 'Missing query parameter q' });
      return;
    }
    const folder = req.query.folder as string | undefined;
    const tag = req.query.tag as string | undefined;
    const limit = req.query.limit ? Number(req.query.limit) : 10;
    const tags = tag ? [tag] : undefined;

    const results = await deps.searchIndex.search(q, { folder, tags, limit });
    res.json({ count: results.length, results });
  });

  app.get('/api/notes', async (req: Request, res: Response) => {
    const folder = req.query.folder as string | undefined;
    const tag = req.query.tag as string | undefined;
    const limit = req.query.limit ? Number(req.query.limit) : 50;

    const notes = await deps.fileManager.listNotes({ folder, tag, limit });
    res.json({
      count: notes.length,
      notes: notes.map((n) => ({
        path: n.path,
        title: n.title,
        tags: n.tags,
        mtime: n.mtime,
        size: n.size,
      })),
    });
  });

  // Read a specific note directly by path or title
  app.get('/api/note', async (req: Request, res: Response) => {
    const notePath = (req.query.path || req.query.name) as string | undefined;
    if (!notePath) {
      res.status(400).json({ error: 'Missing query parameter "path" or "name"' });
      return;
    }

    try {
      const note = await deps.fileManager.readNote(notePath);
      if (req.query.raw === 'true') {
        res.type('text/markdown; charset=utf-8').send(note.rawContent);
        return;
      }
      res.json({
        path: note.path,
        title: note.title,
        tags: note.tags,
        frontmatter: note.frontmatter,
        modifiedAt: note.mtime.toISOString(),
        sizeBytes: note.size,
        content: note.content,
      });
    } catch (err: any) {
      res.status(404).json({ error: err.message });
    }
  });

  // MCP SSE endpoint
  app.get('/sse', async (req: Request, res: Response) => {
    const transport = new SSEServerTransport('/messages', res);
    const sessionId = transport.sessionId;
    transports.set(sessionId, transport);

    const mcpServer = createObsidianMcpServer(deps);

    transport.onclose = () => {
      transports.delete(sessionId);
    };

    req.on('close', () => {
      transports.delete(sessionId);
    });

    await mcpServer.connect(transport);
  });

  // MCP Message endpoint
  app.post('/messages', async (req: Request, res: Response) => {
    const sessionId = req.query.sessionId as string;
    if (!sessionId) {
      res.status(400).send('Missing sessionId parameter');
      return;
    }

    const transport = transports.get(sessionId);
    if (!transport) {
      res.status(404).send(`Session not found: ${sessionId}`);
      return;
    }

    try {
      await transport.handlePostMessage(req, res, req.body);
    } catch (err: any) {
      if (!res.headersSent) {
        res.status(500).send(err.message);
      }
    }
  });

  return app;
}

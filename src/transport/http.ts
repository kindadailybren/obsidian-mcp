import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { Config } from '../config.js';
import { createObsidianMcpServer, ServerDependencies, McpServerOptions } from '../server.js';
import { registerOAuthRoutes, resolveTokenRole, AccessRole } from '../auth/oauth.js';
import { ReadScopePolicy } from '../vault/fileManager.js';

export function createHttpServer(config: Config, deps: ServerDependencies) {
  const app = express();
  const sseTransports = new Map<string, { transport: SSEServerTransport; role: AccessRole }>();
  const streamableTransports = new Map<
    string,
    { transport: StreamableHTTPServerTransport; role: AccessRole }
  >();

  app.use(cors());
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // Helper to resolve web dashboard HTML
  const getWebHtmlPath = (): string => {
    const candidate1 = path.resolve(process.cwd(), 'dist/web/index.html');
    const candidate2 = path.resolve(process.cwd(), 'src/web/index.html');
    if (fs.existsSync(candidate1)) return candidate1;
    return candidate2;
  };

  const getReadOnlyScope = (): ReadScopePolicy | undefined => {
    if (config.readOnlyFolders || config.readOnlyTags) {
      return {
        allowedFolders: config.readOnlyFolders,
        allowedTags: config.readOnlyTags,
      };
    }
    return undefined;
  };

  const getMcpOptionsForRole = (role: AccessRole): McpServerOptions => {
    if (role === 'readonly') {
      return {
        readOnly: true,
        scope: getReadOnlyScope(),
      };
    }
    return { readOnly: false };
  };

  // Register RFC 8414 / RFC 9728 OAuth 2.1 routes (Claude & Gemini auth)
  registerOAuthRoutes(app, config);

  // Authentication Middleware
  const authMiddleware = (req: Request, res: Response, next: NextFunction) => {
    // Skip auth for health check, Web UI reader, and OAuth discovery / authorization endpoints
    if (
      req.path === '/health' ||
      req.path === '/' ||
      req.path === '/view' ||
      req.path === '/favicon.ico' ||
      req.path.startsWith('/.well-known/') ||
      req.path.startsWith('/oauth/')
    ) {
      return next();
    }

    const authRequired = Boolean(config.authToken || config.readOnlyToken);
    if (!authRequired) {
      res.locals.authRole = 'admin' as AccessRole;
      return next(); // Auth disabled if no tokens set
    }

    const authHeader = req.headers.authorization;
    const apiKeyHeader = req.headers['x-api-key'];

    let providedToken: string | undefined;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      providedToken = authHeader.slice(7).trim();
    } else if (apiKeyHeader) {
      providedToken = String(apiKeyHeader).trim();
    }

    const resolved = resolveTokenRole(providedToken, config);
    if (!resolved) {
      const host = req.get('x-forwarded-host') || req.get('host') || 'notes.breindel.me';
      const proto = req.get('x-forwarded-proto') || (req.secure ? 'https' : 'http');
      const baseUrl = host.includes('notes.breindel.me') ? 'https://notes.breindel.me' : `${proto}://${host}`;
      res.setHeader(
        'WWW-Authenticate',
        `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`
      );
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Valid Bearer token or OAuth authorization required.',
      });
      return;
    }

    res.locals.authRole = resolved.role;
    res.locals.readScope = resolved.role === 'readonly' ? getReadOnlyScope() : undefined;
    next();
  };

  app.use(authMiddleware);

  // Health check endpoint (scrubbed of host filesystem paths)
  app.get('/health', async (_req: Request, res: Response) => {
    const notes = await deps.fileManager.listNotes({ limit: 1 });
    res.json({
      status: 'healthy',
      server: 'mcp-obsidian',
      version: '1.0.0',
      hasNotes: notes.length > 0,
      authEnabled: Boolean(config.authToken || config.readOnlyToken),
      readOnlyEnabled: Boolean(config.readOnlyToken),
      endpoints: {
        mcp: '/mcp',
        sse: '/sse',
        messages: '/messages',
        webUi: '/',
      },
    });
  });

  // Web Reader UI
  app.get(['/', '/view'], (_req: Request, res: Response) => {
    const htmlFile = getWebHtmlPath();
    if (fs.existsSync(htmlFile)) {
      res.sendFile(htmlFile);
    } else {
      res.send('<h1>Obsidian MCP Server</h1><p>Web UI file not found.</p>');
    }
  });

  // Inspect active token role & permissions
  app.get('/api/auth/me', (_req: Request, res: Response) => {
    const role: AccessRole = res.locals.authRole || 'admin';
    res.json({
      role,
      readOnly: role === 'readonly',
      scope: res.locals.readScope || null,
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
    const scope = res.locals.readScope as ReadScopePolicy | undefined;

    const results = await deps.searchIndex.search(q, { folder, tags, limit, scope });
    res.json({ count: results.length, results });
  });

  app.get('/api/notes', async (req: Request, res: Response) => {
    const folder = req.query.folder as string | undefined;
    const tag = req.query.tag as string | undefined;
    const limit = req.query.limit ? Number(req.query.limit) : 50;
    const scope = res.locals.readScope as ReadScopePolicy | undefined;

    try {
      const notes = await deps.fileManager.listNotes({ folder, tag, limit, scope });
      res.json({
        count: notes.length,
        role: res.locals.authRole || 'admin',
        notes: notes.map((n) => ({
          path: n.path,
          title: n.title,
          tags: n.tags,
          mtime: n.mtime,
          size: n.size,
        })),
      });
    } catch (err: any) {
      res.status(403).json({ error: err.message });
    }
  });

  // Read a specific note directly by path or title
  app.get('/api/note', async (req: Request, res: Response) => {
    const notePath = (req.query.path || req.query.name) as string | undefined;
    if (!notePath) {
      res.status(400).json({ error: 'Missing query parameter "path" or "name"' });
      return;
    }

    const scope = res.locals.readScope as ReadScopePolicy | undefined;

    try {
      const note = await deps.fileManager.readNote(notePath, scope);
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
      const status = err.message && err.message.startsWith('Access denied') ? 403 : 404;
      res.status(status).json({ error: err.message });
    }
  });

  // ===========================================================================
  // Modern MCP Streamable HTTP Transport (Single endpoint: /mcp)
  // Handles POST, GET, and DELETE requests according to the latest MCP spec.
  // ===========================================================================
  app.all('/mcp', async (req: Request, res: Response) => {
    // Streamable HTTP specification requires clients accept application/json and text/event-stream.
    // We normalize incoming Accept headers to ensure maximum client interoperability.
    const currentAccept = req.headers.accept || '';
    let normalizedAccept = currentAccept;
    if (!normalizedAccept.includes('application/json')) {
      normalizedAccept += (normalizedAccept ? ', ' : '') + 'application/json';
    }
    if (!normalizedAccept.includes('text/event-stream')) {
      normalizedAccept += (normalizedAccept ? ', ' : '') + 'text/event-stream';
    }
    req.headers.accept = normalizedAccept;

    const role: AccessRole = res.locals.authRole || 'admin';
    const rawSessionId = req.headers['mcp-session-id'];
    const sessionId = typeof rawSessionId === 'string' ? rawSessionId : undefined;

    let transport: StreamableHTTPServerTransport | undefined;

    if (sessionId && streamableTransports.has(sessionId)) {
      const entry = streamableTransports.get(sessionId)!;
      // Prevent privilege escalation across tokens sharing a session ID
      if (entry.role !== role) {
        res.status(403).json({
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Token role does not match active session role' },
          id: null,
        });
        return;
      }
      transport = entry.transport;
    } else if (!sessionId && req.method === 'POST' && isInitializeRequest(req.body)) {
      // Initialize a new stateful session
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSid) => {
          streamableTransports.set(newSid, { transport: transport!, role });
        },
      });

      transport.onclose = () => {
        const sid = transport?.sessionId;
        if (sid) {
          streamableTransports.delete(sid);
        }
      };

      const mcpServer = createObsidianMcpServer(deps, getMcpOptionsForRole(role));
      await mcpServer.connect(transport);
    } else if (sessionId) {
      // Session ID was passed but does not exist or expired
      res.status(404).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Session not found or expired' },
        id: null,
      });
      return;
    } else if (req.method === 'POST') {
      // Stateless fallback: Client sent an MCP call without prior initialize session
      const statelessTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      const mcpServer = createObsidianMcpServer(deps, getMcpOptionsForRole(role));
      await mcpServer.connect(statelessTransport);
      await statelessTransport.handleRequest(req, res, req.body);
      res.on('close', () => {
        statelessTransport.close().catch(() => {});
        mcpServer.close().catch(() => {});
      });
      return;
    } else {
      res.status(405).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method Not Allowed' },
        id: null,
      });
      return;
    }

    try {
      await transport.handleRequest(req, res, req.body);
    } catch (err: any) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: err.message || 'Internal server error' },
          id: null,
        });
      }
    }
  });

  // ===========================================================================
  // Legacy HTTP+SSE Transport (Backwards compatibility for /sse & /messages)
  // ===========================================================================
  app.get('/sse', async (req: Request, res: Response) => {
    const role: AccessRole = res.locals.authRole || 'admin';
    const transport = new SSEServerTransport('/messages', res);
    const sessionId = transport.sessionId;
    sseTransports.set(sessionId, { transport, role });

    const mcpServer = createObsidianMcpServer(deps, getMcpOptionsForRole(role));

    transport.onclose = () => {
      sseTransports.delete(sessionId);
    };

    req.on('close', () => {
      sseTransports.delete(sessionId);
    });

    await mcpServer.connect(transport);
  });

  app.post('/messages', async (req: Request, res: Response) => {
    const sessionId = req.query.sessionId as string;
    if (!sessionId) {
      res.status(400).send('Missing sessionId parameter');
      return;
    }

    const entry = sseTransports.get(sessionId);
    if (!entry) {
      res.status(404).send(`Session not found: ${sessionId}`);
      return;
    }

    const role: AccessRole = res.locals.authRole || 'admin';
    if (entry.role !== role) {
      res.status(403).send('Token role mismatch for session');
      return;
    }

    try {
      await entry.transport.handlePostMessage(req, res, req.body);
    } catch (err: any) {
      if (!res.headersSent) {
        res.status(500).send(err.message);
      }
    }
  });

  return app;
}

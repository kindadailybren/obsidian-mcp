import { Express, Request, Response } from 'express';
import crypto from 'node:crypto';
import { Config } from '../config.js';

interface AuthorizationCodeRecord {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  scope?: string;
  expiresAt: number;
}

interface RegisteredClient {
  clientId: string;
  clientName?: string;
  redirectUris: string[];
  createdAt: number;
}

export function registerOAuthRoutes(app: Express, config: Config) {
  const authCodes = new Map<string, AuthorizationCodeRecord>();
  const registeredClients = new Map<string, RegisteredClient>();

  // Clean expired authorization codes every 5 minutes
  setInterval(() => {
    const now = Date.now();
    for (const [code, rec] of authCodes.entries()) {
      if (rec.expiresAt < now) {
        authCodes.delete(code);
      }
    }
  }, 5 * 60 * 1000).unref();

  // Helper to determine base URL
  const getBaseUrl = (req: Request): string => {
    const host = req.get('x-forwarded-host') || req.get('host') || `localhost:${config.port}`;
    const proto = req.get('x-forwarded-proto') || (req.secure ? 'https' : 'http');
    // If accessing via custom domain, prefer https
    if (host.includes('notes.breindel.me')) {
      return 'https://notes.breindel.me';
    }
    return `${proto}://${host}`;
  };

  // ===========================================================================
  // RFC 9728: OAuth 2.0 Protected Resource Metadata
  // ===========================================================================
  app.get('/.well-known/oauth-protected-resource', (req: Request, res: Response) => {
    const baseUrl = getBaseUrl(req);
    res.json({
      resource: baseUrl,
      authorization_servers: [baseUrl],
      bearer_methods_supported: ['header'],
      scopes_supported: ['notes:read', 'notes:write'],
    });
  });

  // ===========================================================================
  // RFC 8414: OAuth 2.0 Authorization Server Metadata
  // ===========================================================================
  const handleAuthServerMetadata = (req: Request, res: Response) => {
    const baseUrl = getBaseUrl(req);
    res.json({
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/oauth/authorize`,
      token_endpoint: `${baseUrl}/oauth/token`,
      registration_endpoint: `${baseUrl}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      client_id_metadata_document_supported: true,
      scopes_supported: ['notes:read', 'notes:write'],
    });
  };

  app.get('/.well-known/oauth-authorization-server', handleAuthServerMetadata);
  app.get('/.well-known/openid-configuration', handleAuthServerMetadata);

  // ===========================================================================
  // RFC 7591: Dynamic Client Registration (DCR)
  // ===========================================================================
  app.post('/oauth/register', (req: Request, res: Response) => {
    const body = req.body || {};
    const clientId = body.client_id || crypto.randomUUID();
    const clientName = body.client_name || 'Claude / MCP Client';
    const redirectUris = Array.isArray(body.redirect_uris)
      ? body.redirect_uris
      : ['https://claude.ai/api/mcp/auth_callback'];

    registeredClients.set(clientId, {
      clientId,
      clientName,
      redirectUris,
      createdAt: Date.now(),
    });

    res.status(201).json({
      client_id: clientId,
      client_name: clientName,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
  });

  // ===========================================================================
  // Authorization Endpoint: GET /oauth/authorize (Consent Page)
  // ===========================================================================
  app.get('/oauth/authorize', (req: Request, res: Response) => {
    const clientId = String(req.query.client_id || '');
    const redirectUri = String(req.query.redirect_uri || 'https://claude.ai/api/mcp/auth_callback');
    const responseType = String(req.query.response_type || 'code');
    const codeChallenge = req.query.code_challenge ? String(req.query.code_challenge) : undefined;
    const codeChallengeMethod = req.query.code_challenge_method
      ? String(req.query.code_challenge_method)
      : undefined;
    const state = req.query.state ? String(req.query.state) : '';
    const scope = req.query.scope ? String(req.query.scope) : 'notes:read notes:write';

    // Auto-approve if requested or render consent screen
    if (req.query.auto === 'true') {
      const code = crypto.randomUUID();
      authCodes.set(code, {
        code,
        clientId,
        redirectUri,
        codeChallenge,
        codeChallengeMethod,
        scope,
        expiresAt: Date.now() + 5 * 60 * 1000,
      });

      const redirectTarget = new URL(redirectUri);
      redirectTarget.searchParams.set('code', code);
      if (state) redirectTarget.searchParams.set('state', state);
      res.redirect(redirectTarget.toString());
      return;
    }

    // Render modern dark-themed authorization screen
    const clientDisplay = clientId.startsWith('http')
      ? 'Claude.ai'
      : (registeredClients.get(clientId)?.clientName || 'Claude / AI Assistant');

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Authorize Obsidian MCP</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: #0d1117;
      color: #e6edf3;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      padding: 16px;
    }
    .card {
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 12px;
      max-width: 440px;
      width: 100%;
      padding: 32px;
      box-shadow: 0 16px 40px rgba(0,0,0,0.5);
    }
    .header {
      display: flex;
      align-items: center;
      gap: 16px;
      margin-bottom: 24px;
    }
    .icon {
      width: 48px;
      height: 48px;
      border-radius: 12px;
      background: linear-gradient(135deg, #7c3aed, #4f46e5);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 24px;
      box-shadow: 0 4px 12px rgba(124, 58, 237, 0.3);
    }
    h1 {
      font-size: 1.25rem;
      font-weight: 600;
      margin: 0;
      color: #f0f6fc;
    }
    .subtitle {
      font-size: 0.85rem;
      color: #8b949e;
      margin-top: 4px;
    }
    p {
      color: #c9d1d9;
      font-size: 0.95rem;
      line-height: 1.5;
      margin: 0 0 20px;
    }
    .permissions {
      background: #0d1117;
      border: 1px solid #21262d;
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 24px;
    }
    .perm-title {
      font-size: 0.8rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: #8b949e;
      font-weight: 600;
      margin-bottom: 12px;
    }
    .perm-item {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      font-size: 0.88rem;
      margin-bottom: 10px;
      color: #e6edf3;
    }
    .perm-item:last-child { margin-bottom: 0; }
    .check {
      color: #2ea043;
      font-weight: bold;
      flex-shrink: 0;
      margin-top: 2px;
    }
    .actions {
      display: flex;
      gap: 12px;
    }
    button {
      flex: 1;
      padding: 12px 16px;
      border-radius: 8px;
      font-size: 0.95rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .btn-approve {
      background: #7c3aed;
      border: 1px solid #7c3aed;
      color: #fff;
    }
    .btn-approve:hover {
      background: #6d28d9;
      border-color: #6d28d9;
    }
    .btn-deny {
      background: transparent;
      border: 1px solid #30363d;
      color: #c9d1d9;
    }
    .btn-deny:hover {
      background: #21262d;
      color: #fff;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <div class="icon">💎</div>
      <div>
        <h1>Obsidian MCP Server</h1>
        <div class="subtitle">notes.breindel.me</div>
      </div>
    </div>

    <p><strong>${clientDisplay}</strong> is requesting authorization to connect with your private Obsidian Vault.</p>

    <div class="permissions">
      <div class="perm-title">Permissions Requested</div>
      <div class="perm-item"><span class="check">✓</span> <span>Search notes with BM25 keyword ranking</span></div>
      <div class="perm-item"><span class="check">✓</span> <span>Read markdown notes & YAML frontmatter</span></div>
      <div class="perm-item"><span class="check">✓</span> <span>Create and update notes with backup history</span></div>
      <div class="perm-item"><span class="check">✓</span> <span>Access daily notes & graph backlinks</span></div>
    </div>

    <form method="POST" action="/oauth/authorize">
      <input type="hidden" name="client_id" value="${clientId}">
      <input type="hidden" name="redirect_uri" value="${redirectUri}">
      <input type="hidden" name="response_type" value="${responseType}">
      <input type="hidden" name="code_challenge" value="${codeChallenge || ''}">
      <input type="hidden" name="code_challenge_method" value="${codeChallengeMethod || ''}">
      <input type="hidden" name="state" value="${state}">
      <input type="hidden" name="scope" value="${scope}">
      <div class="actions">
        <button type="submit" name="action" value="deny" class="btn-deny">Deny</button>
        <button type="submit" name="action" value="approve" class="btn-approve">Authorize</button>
      </div>
    </form>
  </div>
</body>
</html>`;

    res.type('text/html; charset=utf-8').send(html);
  });

  // ===========================================================================
  // Authorization Endpoint: POST /oauth/authorize (Form Submit)
  // ===========================================================================
  app.post('/oauth/authorize', (req: Request, res: Response) => {
    const { action, redirect_uri, state, client_id, code_challenge, code_challenge_method, scope } =
      req.body;

    const redirectUri = redirect_uri || 'https://claude.ai/api/mcp/auth_callback';

    if (action !== 'approve') {
      const redirectTarget = new URL(redirectUri);
      redirectTarget.searchParams.set('error', 'access_denied');
      redirectTarget.searchParams.set('error_description', 'The user denied the authorization request.');
      if (state) redirectTarget.searchParams.set('state', state);
      res.redirect(redirectTarget.toString());
      return;
    }

    const code = crypto.randomUUID();
    authCodes.set(code, {
      code,
      clientId: client_id || '',
      redirectUri,
      codeChallenge: code_challenge || undefined,
      codeChallengeMethod: code_challenge_method || undefined,
      scope: scope || 'notes:read notes:write',
      expiresAt: Date.now() + 5 * 60 * 1000,
    });

    const redirectTarget = new URL(redirectUri);
    redirectTarget.searchParams.set('code', code);
    if (state) redirectTarget.searchParams.set('state', state);
    res.redirect(redirectTarget.toString());
  });

  // ===========================================================================
  // Token Endpoint: POST /oauth/token
  // ===========================================================================
  app.post('/oauth/token', (req: Request, res: Response) => {
    const grantType = req.body.grant_type;
    const code = req.body.code;
    const codeVerifier = req.body.code_verifier;

    if (grantType === 'authorization_code') {
      if (!code) {
        res.status(400).json({ error: 'invalid_request', error_description: 'Missing code parameter' });
        return;
      }

      const record = authCodes.get(code);
      if (!record || record.expiresAt < Date.now()) {
        authCodes.delete(code);
        res.status(400).json({ error: 'invalid_grant', error_description: 'Authorization code is invalid or expired' });
        return;
      }

      // Verify PKCE if a code_challenge was registered
      if (record.codeChallenge) {
        if (!codeVerifier) {
          res.status(400).json({ error: 'invalid_grant', error_description: 'Missing code_verifier for PKCE' });
          return;
        }

        const calculatedChallenge = crypto
          .createHash('sha256')
          .update(codeVerifier)
          .digest('base64url');

        if (calculatedChallenge !== record.codeChallenge) {
          res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
          return;
        }
      }

      // Consume authorization code
      authCodes.delete(code);

      // Return valid Bearer token matching config.authToken
      res.json({
        access_token: config.authToken,
        token_type: 'Bearer',
        expires_in: 31536000, // 1 year
        refresh_token: crypto.randomUUID(),
        scope: record.scope || 'notes:read notes:write',
      });
      return;
    }

    if (grantType === 'refresh_token') {
      res.json({
        access_token: config.authToken,
        token_type: 'Bearer',
        expires_in: 31536000,
        scope: 'notes:read notes:write',
      });
      return;
    }

    res.status(400).json({
      error: 'unsupported_grant_type',
      error_description: `Grant type '${grantType}' is not supported.`,
    });
  });
}

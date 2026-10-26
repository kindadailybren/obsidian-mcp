import { Express, Request, Response } from 'express';
import crypto from 'node:crypto';
import { Config } from '../config.js';

export type AccessRole = 'admin' | 'readonly';

interface AuthorizationCodeRecord {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  scope?: string;
  role: AccessRole;
  grantedToken: string;
  expiresAt: number;
}

interface RefreshTokenRecord {
  refreshToken: string;
  role: AccessRole;
  grantedToken: string;
  scope: string;
  expiresAt: number;
}

interface RegisteredClient {
  clientId: string;
  clientName?: string;
  redirectUris: string[];
  createdAt: number;
}

export function safeCompareTokens(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  const bufA = Buffer.from(a, 'utf-8');
  const bufB = Buffer.from(b, 'utf-8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function resolveTokenRole(
  providedToken: string | undefined,
  config: Config
): { role: AccessRole; token: string } | null {
  if (!providedToken) return null;
  if (config.authToken && safeCompareTokens(providedToken, config.authToken)) {
    return { role: 'admin', token: config.authToken };
  }
  if (config.readOnlyToken && safeCompareTokens(providedToken, config.readOnlyToken)) {
    return { role: 'readonly', token: config.readOnlyToken };
  }
  return null;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function registerOAuthRoutes(app: Express, config: Config) {
  const authCodes = new Map<string, AuthorizationCodeRecord>();
  const refreshTokens = new Map<string, RefreshTokenRecord>();
  const registeredClients = new Map<string, RegisteredClient>();

  // Clean expired authorization codes and refresh tokens every 5 minutes
  setInterval(() => {
    const now = Date.now();
    for (const [code, rec] of authCodes.entries()) {
      if (rec.expiresAt < now) {
        authCodes.delete(code);
      }
    }
    for (const [rt, rec] of refreshTokens.entries()) {
      if (rec.expiresAt < now) {
        refreshTokens.delete(rt);
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

  const renderConsentHtml = (params: {
    clientId: string;
    clientDisplay: string;
    redirectUri: string;
    responseType: string;
    codeChallenge?: string;
    codeChallengeMethod?: string;
    state: string;
    scope: string;
    authRequired: boolean;
    errorMessage?: string;
  }) => {
    const {
      clientId,
      clientDisplay,
      redirectUri,
      responseType,
      codeChallenge,
      codeChallengeMethod,
      state,
      scope,
      authRequired,
      errorMessage,
    } = params;

    return `<!DOCTYPE html>
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
      margin-bottom: 20px;
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
    .token-box {
      margin-bottom: 20px;
    }
    .token-label {
      display: block;
      font-size: 0.82rem;
      color: #8b949e;
      margin-bottom: 6px;
      font-weight: 600;
    }
    .token-input {
      width: 100%;
      padding: 10px 12px;
      border-radius: 8px;
      background: #0d1117;
      border: 1px solid #30363d;
      color: #f0f6fc;
      font-size: 0.9rem;
      outline: none;
    }
    .token-input:focus {
      border-color: #7c3aed;
    }
    .error-banner {
      background: rgba(248, 81, 73, 0.15);
      border: 1px solid #f85149;
      color: #ff7b72;
      padding: 10px 12px;
      border-radius: 8px;
      font-size: 0.85rem;
      margin-bottom: 16px;
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

    <p><strong>${escapeHtml(clientDisplay)}</strong> is requesting authorization to connect with your Obsidian Vault.</p>

    ${errorMessage ? `<div class="error-banner">${escapeHtml(errorMessage)}</div>` : ''}

    <div class="permissions">
      <div class="perm-title">Permissions Requested</div>
      <div class="perm-item"><span class="check">✓</span> <span>Search notes with BM25 keyword ranking</span></div>
      <div class="perm-item"><span class="check">✓</span> <span>Read markdown notes & YAML frontmatter</span></div>
      <div class="perm-item"><span class="check">✓</span> <span>Create and update notes (Admin token only)</span></div>
      <div class="perm-item"><span class="check">✓</span> <span>Access daily notes & graph backlinks</span></div>
    </div>

    <form method="POST" action="/oauth/authorize">
      <input type="hidden" name="client_id" value="${escapeHtml(clientId)}">
      <input type="hidden" name="redirect_uri" value="${escapeHtml(redirectUri)}">
      <input type="hidden" name="response_type" value="${escapeHtml(responseType)}">
      <input type="hidden" name="code_challenge" value="${escapeHtml(codeChallenge || '')}">
      <input type="hidden" name="code_challenge_method" value="${escapeHtml(codeChallengeMethod || '')}">
      <input type="hidden" name="state" value="${escapeHtml(state)}">
      <input type="hidden" name="scope" value="${escapeHtml(scope)}">

      ${
        authRequired
          ? `<div class="token-box">
        <label class="token-label" for="auth_token">Vault Token (Enter Admin or Read-Only Token)</label>
        <input type="password" id="auth_token" name="auth_token" class="token-input" placeholder="Paste your token..." autofocus>
      </div>`
          : ''
      }

      <div class="actions">
        <button type="submit" name="action" value="deny" class="btn-deny">Deny</button>
        <button type="submit" name="action" value="approve" class="btn-approve">Authorize</button>
      </div>
    </form>
  </div>
</body>
</html>`;
  };

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

    const authRequired = Boolean(config.authToken || config.readOnlyToken);

    const clientDisplay = clientId.startsWith('http')
      ? 'Claude.ai'
      : registeredClients.get(clientId)?.clientName || 'Claude / AI Assistant';

    const html = renderConsentHtml({
      clientId,
      clientDisplay,
      redirectUri,
      responseType,
      codeChallenge,
      codeChallengeMethod,
      state,
      scope,
      authRequired,
    });

    res.type('text/html; charset=utf-8').send(html);
  });

  // ===========================================================================
  // Authorization Endpoint: POST /oauth/authorize (Form Submit)
  // ===========================================================================
  app.post('/oauth/authorize', (req: Request, res: Response) => {
    const {
      action,
      redirect_uri,
      state,
      client_id,
      response_type,
      code_challenge,
      code_challenge_method,
      scope,
      auth_token,
    } = req.body;

    const redirectUri = redirect_uri || 'https://claude.ai/api/mcp/auth_callback';

    if (action !== 'approve') {
      const redirectTarget = new URL(redirectUri);
      redirectTarget.searchParams.set('error', 'access_denied');
      redirectTarget.searchParams.set('error_description', 'The user denied the authorization request.');
      if (state) redirectTarget.searchParams.set('state', state);
      res.redirect(redirectTarget.toString());
      return;
    }

    const authRequired = Boolean(config.authToken || config.readOnlyToken);
    let role: AccessRole = 'admin';
    let grantedToken = config.authToken || '';
    let grantedScope = scope || 'notes:read notes:write';

    if (authRequired) {
      const resolved = resolveTokenRole(
        typeof auth_token === 'string' ? auth_token.trim() : undefined,
        config
      );
      if (!resolved) {
        const clientId = String(client_id || '');
        const clientDisplay = clientId.startsWith('http')
          ? 'Claude.ai'
          : registeredClients.get(clientId)?.clientName || 'Claude / AI Assistant';

        const html = renderConsentHtml({
          clientId,
          clientDisplay,
          redirectUri,
          responseType: String(response_type || 'code'),
          codeChallenge: code_challenge || undefined,
          codeChallengeMethod: code_challenge_method || undefined,
          state: String(state || ''),
          scope: String(scope || 'notes:read notes:write'),
          authRequired: true,
          errorMessage: 'Invalid vault token. Please enter a valid Admin or Read-Only token.',
        });
        res.status(401).type('text/html; charset=utf-8').send(html);
        return;
      }

      role = resolved.role;
      grantedToken = resolved.token;
      if (role === 'readonly') {
        grantedScope = 'notes:read';
      }
    }

    const code = crypto.randomUUID();
    authCodes.set(code, {
      code,
      clientId: client_id || '',
      redirectUri,
      codeChallenge: code_challenge || undefined,
      codeChallengeMethod: code_challenge_method || undefined,
      scope: grantedScope,
      role,
      grantedToken,
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

      const newRefreshToken = crypto.randomUUID();
      refreshTokens.set(newRefreshToken, {
        refreshToken: newRefreshToken,
        role: record.role,
        grantedToken: record.grantedToken,
        scope: record.scope || (record.role === 'readonly' ? 'notes:read' : 'notes:read notes:write'),
        expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000, // 1 year
      });

      res.json({
        access_token: record.grantedToken,
        token_type: 'Bearer',
        expires_in: 31536000, // 1 year
        refresh_token: newRefreshToken,
        scope: record.scope || (record.role === 'readonly' ? 'notes:read' : 'notes:read notes:write'),
        role: record.role,
      });
      return;
    }

    if (grantType === 'refresh_token') {
      const providedRefresh = req.body.refresh_token;
      if (!providedRefresh || typeof providedRefresh !== 'string') {
        res.status(400).json({ error: 'invalid_request', error_description: 'Missing refresh_token parameter' });
        return;
      }

      const rtRecord = refreshTokens.get(providedRefresh);
      if (!rtRecord || rtRecord.expiresAt < Date.now()) {
        refreshTokens.delete(providedRefresh);
        res.status(400).json({ error: 'invalid_grant', error_description: 'Refresh token is invalid or expired' });
        return;
      }

      res.json({
        access_token: rtRecord.grantedToken,
        token_type: 'Bearer',
        expires_in: 31536000,
        scope: rtRecord.scope,
        role: rtRecord.role,
      });
      return;
    }

    res.status(400).json({
      error: 'unsupported_grant_type',
      error_description: `Grant type '${grantType}' is not supported.`,
    });
  });
}

# Obsidian MCP Server

A Model Context Protocol (MCP) server for Obsidian vaults with direct filesystem access, in-memory BM25 full-text search, bidirectional wiki-links and backlinks resolution, and dual transport support (local `stdio` and remote `HTTP/SSE` with Bearer token authentication).

Designed to run locally on your machine 24/7 and expose secure HTTPS access through your custom domain via Cloudflare Tunnel, eliminating cloud sync lag, cold starts, and AWS hosting bills.

---

## Features

- **Direct Filesystem Access**: Operates 24/7 on your vault Markdown files without requiring the Obsidian desktop app to be open.
- **Fast BM25 Search**: In-memory relevance-ranked search across note titles, tags, frontmatter, and file content with contextual snippets using MiniSearch.
- **Wiki-link & Backlinks Graph**: Extracts `[[note]]`, `[[note|alias]]`, and `[[note#heading]]` links, resolving bidirectional backlinks across your entire vault.
- **Daily Notes Support**: Automatic creation and append operations for daily notes following your custom date format (`YYYY-MM-DD`).
- **Safety Guardrails**: Path traversal protection sandboxed strictly within the vault root. Automatic timestamped backup snapshots created in `.trash/` before modifying or overwriting any file.
- **Dual Transport**:
  - `stdio`: For local desktop clients like Claude Desktop, Cursor, or CLI agents.
  - `HTTP/SSE`: For web agents, browser integrations (Claude, Gemini), or remote clients via HTTPS.
- **Security**: Bearer token and `x-api-key` header authentication for all remote requests.

---

## 8 MCP Tools Provided

| Tool | Description | Inputs |
| :--- | :--- | :--- |
| `search_notes` | BM25 relevance search across notes | `query`, `tags?`, `folder?`, `limit?` |
| `read_note` | Read full Markdown content, YAML frontmatter, and tags | `path` |
| `create_note` | Create a note with optional frontmatter & tags | `path`, `content`, `tags?`, `frontmatter?`, `overwrite?` |
| `append_to_note` | Append content (or insert under a specific heading) | `path`, `content`, `section?` |
| `patch_note` | Safely replace text within a note (auto `.trash` backup) | `path`, `target`, `replacement` |
| `list_notes` | List and browse notes with folder/tag filters | `folder?`, `tag?`, `recursive?`, `limit?` |
| `get_daily_note` | Retrieve or create today's (or specific date) daily note | `date?`, `createIfMissing?` |
| `get_backlinks` | Resolve forward wiki-links and vault-wide backlinks | `path` |

---

## Quickstart

### 1. Installation & Build

```bash
git clone <repo-url> mcp-obsidian
cd mcp-obsidian
npm install
npm run build
```

### 2. Configuration

Copy the sample environment file:
```bash
cp .env.example .env
```

Edit `.env`:
```env
OBSIDIAN_VAULT_PATH=/home/username/Documents/MyVault
AUTH_TOKEN=your-super-secret-token
PORT=3000
HOST=0.0.0.0
TRANSPORT_MODE=http
```

### 3. Running the Server

#### HTTP / SSE Mode (Default for Web & Remote Agents):
```bash
npm start
# or during development:
npm run dev
```

Output:
```
📂 Vault Path:    /home/username/Documents/MyVault
🔒 Auth Token:    Active (Protected)
🚀 Server listening on http://0.0.0.0:3000
📡 MCP SSE Endpoint:     http://localhost:3000/sse
💬 MCP Message Endpoint: http://localhost:3000/messages
🩺 Health check:         http://localhost:3000/health
```

#### Stdio Mode (For Local Claude Desktop / CLI):
```bash
npm start -- --stdio
```

---

## Connecting Your Agents

### 1. Claude Desktop (Local stdio)
Add to your `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "obsidian": {
      "command": "node",
      "args": ["/storage2/coding/mcp-obsidian/dist/index.js", "--stdio"],
      "env": {
        "OBSIDIAN_VAULT_PATH": "/path/to/your/obsidian/vault"
      }
    }
  }
}
```

### 2. Remote / Browser Clients via Cloudflare Tunnel
Expose your local port 3000 through your custom domain (e.g. `notes.yourdomain.com`):

1. **Install cloudflared**:
   ```bash
   curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
   sudo dpkg -i cloudflared.deb
   ```

2. **Authenticate & Create Tunnel**:
   ```bash
   cloudflared tunnel login
   cloudflared tunnel create obsidian-mcp
   cloudflared tunnel route dns obsidian-mcp notes.yourdomain.com
   ```

3. **Run Tunnel**:
   Using `deployment/cloudflared.yml`:
   ```bash
   cloudflared tunnel --config deployment/cloudflared.yml run
   ```

Now your MCP server is accessible at:
- `https://notes.yourdomain.com/sse`
- `https://notes.yourdomain.com/messages`
- Protected by `Authorization: Bearer <AUTH_TOKEN>`

---

## Running as a Linux Systemd Daemon

To ensure the server starts automatically on boot:

1. Copy the systemd unit file:
   ```bash
   sudo cp deployment/obsidian-mcp.service /etc/systemd/system/
   ```

2. Reload and enable:
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now obsidian-mcp
   ```

3. Check logs:
   ```bash
   journalctl -u obsidian-mcp -f
   ```

---

## Running Tests

Run the test suite (unit tests for vault operations, search, backlinks, and HTTP auth):
```bash
npm test
```

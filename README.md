# Obsidian Model Context Protocol (MCP) Server

[![Live Deployment](https://img.shields.io/badge/Live-notes.breindel.me-8b5cf6?style=for-the-badge&logo=cloudflare)](https://notes.breindel.me)
[![MCP Compliant](https://img.shields.io/badge/MCP-Spec%201.0-blue?style=for-the-badge)](https://modelcontextprotocol.io)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-3178C6?style=for-the-badge&logo=typescript)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg?style=for-the-badge)](LICENSE)

A high-performance, secure **Model Context Protocol (MCP)** server for local Obsidian vaults. It provides AI agents (Claude, Gemini, Antigravity, Cursor) with real-time access to your personal knowledge base using fast in-memory BM25 search, bidirectional wiki-links, daily note management, and automated backup safeguards.

🌐 **Live Web Reader & Vault Interface:** [https://notes.breindel.me](https://notes.breindel.me)

---

## 🌟 Key Highlights

- **Direct Filesystem Access**: Directly operates on `.md` files in your vault. Works 24/7 without requiring the Obsidian desktop app to be open.
- **Fast In-Memory BM25 Search**: Instant relevance-ranked full-text search across titles, tags, frontmatter, and note body with context snippet generation via MiniSearch.
- **Interactive Web Reader Dashboard**: A modern, dark-mode web reader served at [notes.breindel.me](https://notes.breindel.me) with KaTeX math rendering, syntax highlighting, live search, and clickable `[[wiki-links]]`.
- **Bidirectional Graph & Backlinks**: Automatically resolves `[[Target]]`, `[[Target|Alias]]`, `[[Target#Heading]]`, and extracts incoming vault backlinks.
- **Dual Transport Mechanisms**:
  - `stdio`: For local desktop clients (Claude Desktop, Cursor, local CLI).
  - `HTTP / SSE`: Streamable Server-Sent Events for remote agents and web assistants.
- **Strict Edge Security**: Protected by Cloudflare Tunnel (hiding origin IP) and strictly enforces header-only authentication (`Authorization: Bearer <TOKEN>` or `x-api-key: <TOKEN>`). Query-string token leakage is actively prevented.
- **Safety Guardrails**: Path traversal protection sandboxed strictly within the vault root. Automated timestamped backup snapshots in `.trash/` before modifying or overwriting any note.

---

## 🛠️ 8 MCP Tools Provided

All tools strictly follow the Model Context Protocol specification with Zod parameter validation:

| Tool | Description | Key Parameters |
| :--- | :--- | :--- |
| `search_notes` | BM25 relevance search across note content, titles, and tags | `query` (str), `tags?` (str[]), `folder?` (str), `limit?` (num) |
| `read_note` | Read full Markdown content, YAML frontmatter, tags, and stats | `path` (str, relative path or note title) |
| `create_note` | Create a new note with optional frontmatter, tags, and overwrite protection | `path` (str), `content` (str), `tags?`, `frontmatter?`, `overwrite?` |
| `append_to_note` | Append text to end of note, or directly under a specific heading | `path` (str), `content` (str), `section?` (str, heading name) |
| `patch_note` | Safely replace exact substring or section (auto `.trash` backup) | `path` (str), `target` (str), `replacement` (str) |
| `list_notes` | Browse notes with folder, tag, and pagination filters | `folder?` (str), `tag?` (str), `recursive?` (bool), `limit?` (num) |
| `get_daily_note` | Retrieve or create today's (or target date) daily note from template | `date?` (str, YYYY-MM-DD), `createIfMissing?` (bool) |
| `get_backlinks` | Resolve forward wiki-links and vault-wide incoming backlinks | `path` (str, relative path or note title) |

---

## 🌐 The Built-in Web Reader

Access your vault anywhere via the built-in single-page web app at **[https://notes.breindel.me](https://notes.breindel.me)**:

- **Local Storage Auth:** Prompts for your `AUTH_TOKEN` once, storing it in browser `localStorage`.
- **Automatic Header Injection:** Every API request made by the web app automatically includes the secure `Authorization: Bearer` header.
- **Folder Navigation:** Groups notes by subject folder (`CMSC 173`, `DevOps`, `Machine Learning`, etc.).
- **LaTeX Math Rendering:** Renders math formulas ($\LaTeX$) via KaTeX.
- **Interactive Wiki-links:** Click any `[[note-link]]` to seamlessly jump to that note.

---

## 🚀 Quickstart

### 1. Clone & Install
```bash
git clone https://github.com/your-username/mcp-obsidian.git
cd mcp-obsidian
npm install
npm run build
```

### 2. Environment Configuration
Create your `.env` file from the example:
```bash
cp .env.example .env
```

Configure `.env`:
```env
# Path to your Obsidian vault on disk
OBSIDIAN_VAULT_PATH=/storage2/knowledgeBase

# Port & Host
PORT=3000
HOST=0.0.0.0

# Secret Token for Bearer and API Key authentication
AUTH_TOKEN=your-super-secret-token-here

# Daily notes folder name inside your vault
DAILY_NOTES_FOLDER=Daily Notes

# Transport mode ("http" or "stdio")
TRANSPORT_MODE=http
```

### 3. Run the Server
```bash
# Start in HTTP / SSE mode:
npm start

# Or in development mode:
npm run dev

# Or in Stdio mode for local CLI / Claude Desktop:
npm start -- --stdio
```

---

## 🔒 Security & Authentication

All API and MCP endpoints (except `/health` and the Web UI root `/`) strictly enforce header authentication.

### Supported Authentication Headers:
```http
Authorization: Bearer <AUTH_TOKEN>
```
*or*
```http
x-api-key: <AUTH_TOKEN>
```

> **Note on Security:** Passing tokens via URL parameters (`?token=...`) is explicitly rejected with `401 Unauthorized` to prevent token leakage in browser history, server access logs, and HTTP `Referer` headers.

---

## 🤖 Connecting Your AI Agents

### 1. Claude Desktop (Local Stdio)
Add the following to your `claude_desktop_config.json` (on Linux: `~/.config/Claude/claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "obsidian": {
      "command": "node",
      "args": ["/storage2/coding/mcp-obsidian/dist/index.js", "--stdio"],
      "env": {
        "OBSIDIAN_VAULT_PATH": "/storage2/knowledgeBase"
      }
    }
  }
}
```

### 2. Antigravity / Cursor / Custom Agents
Add to `~/.gemini/config/mcp_config.json`:
```json
{
  "mcpServers": {
    "obsidian": {
      "command": "node",
      "args": ["/storage2/coding/mcp-obsidian/dist/index.js", "--stdio"],
      "env": {
        "OBSIDIAN_VAULT_PATH": "/storage2/knowledgeBase"
      }
    }
  }
}
```

### 3. Remote AI Agents (Claude Web, Gemini, Custom Webhooks)
- **SSE Endpoint:** `https://notes.breindel.me/sse`
- **Messages Endpoint:** `https://notes.breindel.me/messages`
- **Headers:** `Authorization: Bearer <AUTH_TOKEN>`

---

## ☁️ Cloudflare Tunnel Configuration

To expose your local MCP server through your custom domain ([notes.breindel.me](https://notes.breindel.me)) without opening router ports:

1. Install `cloudflared`:
   ```bash
   curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
   sudo dpkg -i cloudflared.deb
   ```

2. Run using the included configuration:
   ```bash
   cloudflared tunnel --config deployment/cloudflared.yml run
   ```

---

## 🐧 Running 24/7 as a Linux Systemd Service

To keep your MCP server running silently in the background and auto-restart on computer boot:

```bash
# 1. Install & enable the Obsidian MCP systemd service
sudo cp deployment/obsidian-mcp.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now obsidian-mcp

# 2. Check service status
sudo systemctl status obsidian-mcp

# 3. View live logs
journalctl -u obsidian-mcp -f
```

---

## 📡 REST API Reference

| Endpoint | Method | Auth | Description |
| :--- | :--- | :--- | :--- |
| `/` | `GET` | None | Serves the interactive Obsidian Web Reader UI |
| `/health` | `GET` | None | Health check & vault status inspection |
| `/api/notes` | `GET` | Required | Lists notes in the vault (`folder`, `tag`, `limit`) |
| `/api/note` | `GET` | Required | Retrieves note content by `name` or `path` (`raw=true` for raw text) |
| `/api/search` | `GET` | Required | BM25 search across notes (`q=keyword`, `folder`, `tag`) |
| `/sse` | `GET` | Required | MCP Server-Sent Events stream connection |
| `/messages` | `POST` | Required | MCP JSON-RPC message delivery |

---

## 🧪 Testing

Run the full automated test suite (23 unit and integration tests):
```bash
npm test
```

Tests cover:
- Path traversal rejection (`../../etc/passwd`).
- YAML frontmatter and inline tag parsing.
- Safe patch operations and automated `.trash/` backups.
- MiniSearch BM25 keyword ranking and snippet extraction.
- Wiki-link graph extraction and backlinks discovery.
- Daily note generation and heading appends.
- Strict HTTP header authentication and URL-token rejection.

---

## 📄 License
MIT © 2026 Breindel Medina. All rights reserved.

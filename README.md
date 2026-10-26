# Obsidian Model Context Protocol (MCP) Server

[![MCP Spec](https://img.shields.io/badge/MCP-Spec%201.0-blue?style=for-the-badge)](https://modelcontextprotocol.io)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-3178C6?style=for-the-badge&logo=typescript)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg?style=for-the-badge)](LICENSE)

A high-performance, secure **Model Context Protocol (MCP)** server built in TypeScript for local Obsidian vaults. It gives AI agents (such as Claude, Gemini, Antigravity, and Cursor) structured, real-time access to a personal knowledge base using fast in-memory BM25 search, bidirectional wiki-links, daily note management, and automated backup safeguards.

---

## 💡 What This Project Does

This server connects your markdown-based knowledge vault to modern LLMs and agentic tools following the official Model Context Protocol specifications:

1. **Direct Vault Operations**: Operates directly on `.md` files on the filesystem without requiring the Obsidian desktop application to be running.
2. **Relevance-Ranked Full-Text Search**: Uses an in-memory BM25 search index with customizable field boosting (title, tags, body) and context-aware snippet extraction.
3. **Graph & Link Intelligence**: Automatically parses bidirectional Obsidian links (`[[Target]]`, `[[Target|Alias]]`, `[[Target#Heading]]`) and calculates vault-wide backlinks dynamically.
4. **Interactive Web Reader**: Provides a clean, dark-mode web reader interface with syntax highlighting, LaTeX math formula rendering ($\KaTeX$), and clickable wiki-links.
5. **Multi-Tiered Access & Sharing**: Supports dual authentication roles:
   - **Admin Access**: Full read and write capabilities across the vault.
   - **Read-Only Sharing**: Secure read-only tokens that disallow write tools (`create_note`, `append_to_note`, `patch_note`) and optionally restrict viewing to configured folders or tags.
6. **Dual Transport Layers**:
   - `stdio`: For local, zero-network desktop tools and IDE assistants.
   - `HTTP / SSE` & `Streamable HTTP`: For remote agents, webhooks, and browser-based interfaces.
7. **Production Security Guardrails**:
   - RFC 8414 & RFC 9728 OAuth 2.1 authentication flow with PKCE and token challenge verification.
   - Strict path traversal prevention sandboxed within the vault boundary.
   - Constant-time token verification to mitigate timing attacks.
   - DOMPurify XSS sanitization for all rendered markdown content.
   - Automatic pre-modification backups stored in `.trash/` before modifying or patching notes.

---

## 🛠️ MCP Tools Architecture

The server provides 8 specialized tools to AI assistants:

| Tool | Capability | Description |
| :--- | :--- | :--- |
| `search_notes` | Read | BM25 relevance search across note content, titles, and tags with query snippets |
| `read_note` | Read | Retrieves full markdown content, frontmatter metadata, and note statistics |
| `list_notes` | Read | Explores vault directory hierarchies with optional folder, tag, and recursive filters |
| `get_daily_note` | Read / Write | Retrieves today's (or a specific date's) daily journal note |
| `get_backlinks` | Read | Maps outgoing wiki-links and calculates incoming vault-wide backlink references |
| `create_note` | Write (Admin) | Creates new notes with frontmatter, tags, and overwrite safeguards |
| `append_to_note` | Write (Admin) | Appends content to notes or injects entries under designated markdown headings |
| `patch_note` | Write (Admin) | Safely replaces specific sections with automatic timestamped backup in `.trash/` |

> When connecting with a **Read-Only Token**, write tools are omitted from the protocol registry, and `get_daily_note` operates in non-destructive mode without creating missing notes.

---

## 🔒 Security Architecture

- **Header-Only Authentication**: Enforces `Authorization: Bearer <TOKEN>` or `x-api-key: <TOKEN>`. Tokens in URL query strings are explicitly rejected with `401 Unauthorized` to prevent credential leakage in proxy logs, browser histories, and referer headers.
- **Role Isolation**: Admin and Read-Only sessions are kept strictly separated. Stateful MCP sessions cannot cross privilege boundaries.
- **Safety Backups**: Any file overwrite, patch, or append operation triggers an atomic backup copy under `.trash/` before persisting changes.
- **Path Sanitization**: Relative file resolution checks for path traversal escapes and blocks unauthorized access to internal dot-directories (e.g. `.obsidian`, `.trash`).

---

## 🧪 Automated Testing

The codebase includes comprehensive integration and unit tests covering:
- Path traversal and security sandbox boundary enforcement.
- BM25 indexing, relevance scoring, and query snippet extraction.
- Wiki-link graph traversal and reverse backlink indexing.
- OAuth 2.1 PKCE verification and token authorization challenges.
- Role-based tool access restrictions (Admin vs Read-Only).
- HTTP transport security and authentication validation.

Run tests locally:
```bash
npm test
```

---

## 📄 License
MIT © 2026. All rights reserved.

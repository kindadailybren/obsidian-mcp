#!/usr/bin/env node
import { loadConfig } from './config.js';
import { FileManager } from './vault/fileManager.js';
import { SearchIndex } from './vault/searchIndex.js';
import { VaultGraph } from './vault/graph.js';
import { DailyNotesManager } from './vault/dailyNotes.js';
import { runStdioServer } from './transport/stdio.js';
import { createHttpServer } from './transport/http.js';

async function main() {
  const config = loadConfig();

  // Initialize vault components
  const fileManager = new FileManager(config.vaultPath, config.trashFolder);
  const searchIndex = new SearchIndex(fileManager);
  const vaultGraph = new VaultGraph(fileManager);
  const dailyNotesManager = new DailyNotesManager(
    fileManager,
    config.dailyNotesFolder,
    config.dailyNotesFormat
  );

  const deps = {
    fileManager,
    searchIndex,
    vaultGraph,
    dailyNotesManager,
  };

  if (config.transportMode === 'stdio') {
    // In stdio mode, do NOT write debug logs to process.stdout (stdout is reserved for JSON-RPC)
    // Only write to stderr if needed
    process.stderr.write(`[mcp-obsidian] Starting in stdio mode for vault: ${config.vaultPath}\n`);
    await searchIndex.initialize(false);
    await runStdioServer(deps);
  } else {
    // HTTP / SSE mode
    console.log('========================================================');
    console.log('       Obsidian Model Context Protocol (MCP) Server     ');
    console.log('========================================================');
    console.log(`📂 Vault Path:    ${config.vaultPath}`);
    console.log(`🔒 Admin Token:   ${config.authToken ? 'Active (Protected)' : 'Disabled (Open)'}`);
    console.log(`👁️  Read-Only:     ${config.readOnlyToken ? 'Active' : 'Not configured'}`);
    console.log(`📅 Daily Notes:   ${config.dailyNotesFolder}`);
    console.log(`🗑️  Trash Backup:  ${config.trashFolder}`);
    console.log('--------------------------------------------------------');

    console.log('🔍 Indexing notes...');
    await searchIndex.initialize(true);
    console.log('✅ Indexing complete and file watcher active.');

    const app = createHttpServer(config, deps);
    const server = app.listen(config.port, config.host, () => {
      console.log(`🚀 Server listening on http://${config.host}:${config.port}`);
      console.log(`🌐 MCP Streamable HTTP:  http://localhost:${config.port}/mcp`);
      console.log(`📡 Legacy MCP SSE:       http://localhost:${config.port}/sse`);
      console.log(`💬 MCP Message Endpoint: http://localhost:${config.port}/messages`);
      console.log(`🩺 Health check:         http://localhost:${config.port}/health`);
      console.log('========================================================\n');
    });

    const shutdown = async () => {
      console.log('\n🛑 Shutting down gracefully...');
      await searchIndex.close();
      server.close(() => {
        console.log('Server closed.');
        process.exit(0);
      });
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }
}

main().catch((err) => {
  console.error('Fatal error starting Obsidian MCP server:', err);
  process.exit(1);
});

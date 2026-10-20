import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createObsidianMcpServer, ServerDependencies } from '../server.js';

export async function runStdioServer(deps: ServerDependencies): Promise<void> {
  const mcpServer = createObsidianMcpServer(deps);
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  // Stdio transport runs continuously on process.stdin / stdout
}

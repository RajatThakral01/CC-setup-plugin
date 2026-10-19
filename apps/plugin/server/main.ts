import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './index.js';
import { log } from './log.js';

const server = createServer();
await server.connect(new StdioServerTransport());
log('info', 'setup-agent MCP server started');

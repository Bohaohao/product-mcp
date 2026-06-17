import type { Request, Response } from 'express';
import type { Express } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { loadConfig, type ProductMcpConfig } from './config.js';
import { createProductMcpServer } from './mcpServer.js';
import { getRequestContext } from './requestContext.js';
import { toErrorPayload } from './errors.js';

export function createProductMcpExpressApp(config: ProductMcpConfig): Express {
  const app = createMcpExpressApp({
    host: config.host,
    allowedHosts: config.allowedHosts
  });

  app.get('/healthz', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      name: 'product-mcp',
      version: '0.1.0'
    });
  });

  app.post(config.path, async (req: Request, res: Response) => {
    let transport: StreamableHTTPServerTransport | undefined;
    let server: ReturnType<typeof createProductMcpServer> | undefined;

    try {
      const context = getRequestContext(req, config.defaultLanguage);
      server = createProductMcpServer(config, context);
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (!res.headersSent) {
        const requestId = `req_${Date.now().toString(36)}`;
        const payload = toErrorPayload(error, requestId);
        const httpStatus = payload.code === 'AUTH_TOKEN_MISSING' || payload.code === 'AUTH_TOKEN_INVALID' ? 401 : 500;

        res.status(httpStatus).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: payload.message,
            data: payload
          },
          id: req.body?.id ?? null
        });
      }
    } finally {
      res.on('close', () => {
        transport?.close();
        server?.close();
      });
    }
  });

  app.get(config.path, (_req: Request, res: Response) => {
    res.status(405).json({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'Method not allowed.'
      },
      id: null
    });
  });

  app.delete(config.path, (_req: Request, res: Response) => {
    res.status(405).json({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'Method not allowed.'
      },
      id: null
    });
  });

  return app;
}

export function startProductMcpServer(config: ProductMcpConfig = loadConfig()) {
  const app = createProductMcpExpressApp(config);
  const httpServer = app.listen(config.port, config.host, (error?: Error) => {
    if (error) {
      console.error('Failed to start Product MCP server:', error);
      process.exit(1);
    }

    console.log(`Product MCP server listening on ${config.host}:${config.port}, path ${config.path}`);
  });

  return httpServer;
}

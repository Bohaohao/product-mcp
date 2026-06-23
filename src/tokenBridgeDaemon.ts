import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ProductMcpError } from './errors.js';
import {
  LOCAL_BRIDGE_VERSION,
  ProductTokenBridge,
  TOKEN_CACHE_TTL_MS,
  browserTokenAuthStatusPayload,
  bridgeErrorPayload,
  loadConfig,
  type ResolvedBridgeConfig
} from './localBridge.js';
import { PRODUCT_TOKEN_DAEMON_SECRET_ENV, sanitizeForModel } from './tokenDaemonClient.js';

const HOST = '127.0.0.1';
const MAX_BODY_BYTES = 64 * 1024;
const ENDPOINT_TIMEOUT_MS = 150_000;
let authOperationQueue: Promise<unknown> = Promise.resolve();

function runSerializedAuthOperation<T>(run: () => Promise<T>): Promise<T> {
  const next = authOperationQueue.catch(() => undefined).then(run);
  authOperationQueue = next.catch(() => undefined);
  return next;
}

function parseArgs(): { configPath: string } {
  const index = process.argv.indexOf('--config');
  const configPath = index >= 0 ? process.argv[index + 1] : process.env.PRODUCT_MCP_BRIDGE_CONFIG;

  if (!configPath) {
    throw new Error('Missing --config <path> or PRODUCT_MCP_BRIDGE_CONFIG.');
  }

  return { configPath };
}

function createRequestId(): string {
  return `token_daemon_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function sendJson(res: ServerResponse, status: number, payload: unknown, options: { allowToken?: boolean } = {}): void {
  const body = options.allowToken ? payload : sanitizeForModel(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function secretMatches(actual: string | undefined, expected: string): boolean {
  const prefix = 'Bearer ';
  if (!actual?.startsWith(prefix)) return false;

  const provided = actual.slice(prefix.length);
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  return providedBuffer.length === expectedBuffer.length && timingSafeEqual(providedBuffer, expectedBuffer);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new ProductMcpError('MCP_INPUT_INVALID', 'Request body is too large.', {
        details: { maxBodyBytes: MAX_BODY_BYTES }
      });
    }
    chunks.push(buffer);
  }

  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};

  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('JSON body must be an object.');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new ProductMcpError('MCP_INPUT_INVALID', 'Request body must be valid JSON object.', {
      details: { parseError: error instanceof Error ? error.message : String(error) }
    });
  }
}

async function withEndpointTimeout<T>(endpoint: string, requestId: string, run: () => Promise<T>): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => {
          reject(
            new ProductMcpError('TOKEN_DAEMON_TIMEOUT', `Product token daemon endpoint timed out: ${endpoint}.`, {
              details: {
                endpoint,
                requestId,
                timeoutMs: ENDPOINT_TIMEOUT_MS
              }
            })
          );
        }, ENDPOINT_TIMEOUT_MS);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function daemonMeta(endpoint: string, requestId: string, startedAtMs: number): Record<string, unknown> {
  return {
    requestId,
    endpoint,
    elapsedMs: Date.now() - startedAtMs,
    version: LOCAL_BRIDGE_VERSION
  };
}

function withDaemonMeta(payload: unknown, endpoint: string, requestId: string, startedAtMs: number): Record<string, unknown> {
  const record = payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
  return {
    ...record,
    daemon: daemonMeta(endpoint, requestId, startedAtMs)
  };
}

function healthPayload(config: ResolvedBridgeConfig, configPath: string): Record<string, unknown> {
  return {
    ok: true,
    name: 'product-token-bridge-daemon',
    version: LOCAL_BRIDGE_VERSION,
    pid: process.pid,
    host: HOST,
    uptimeSeconds: Math.round(process.uptime()),
    config: {
      configPath,
      environment: config.selectedEnvironment,
      projectUrl: config.projectUrl,
      matchUrlPrefixes: config.matchUrlPrefixes?.length ? config.matchUrlPrefixes : [config.projectUrl],
      tokenStorageKey: config.tokenStorageKey
    },
    tokenCache: {
      enabled: true,
      maxTtlSeconds: TOKEN_CACHE_TTL_MS / 1000
    }
  };
}

async function handlePostEndpoint(
  req: IncomingMessage,
  res: ServerResponse,
  endpoint: '/auth/status' | '/auth/token' | '/auth/invalidate',
  config: ResolvedBridgeConfig,
  bridge: ProductTokenBridge
): Promise<void> {
  const requestId = createRequestId();
  const startedAtMs = Date.now();

  try {
    const body = await readJsonBody(req);
    const forceRefresh = Boolean(body.forceRefresh);
    let payload: unknown;

    if (endpoint === '/auth/status') {
      const token = await withEndpointTimeout(endpoint, requestId, () =>
        runSerializedAuthOperation(() => bridge.getBrowserToken({ forceRefresh }))
      );
      payload = browserTokenAuthStatusPayload(config, token, 'token_bridge_daemon');
      sendJson(res, 200, withDaemonMeta(payload, endpoint, requestId, startedAtMs));
      return;
    }

    if (endpoint === '/auth/token') {
      const token = await withEndpointTimeout(endpoint, requestId, () =>
        runSerializedAuthOperation(() => bridge.getBrowserToken({ forceRefresh }))
      );
      sendJson(
        res,
        200,
        withDaemonMeta(
          {
            ok: true,
            ...token,
            tokenProvider: 'token_bridge_daemon'
          },
          endpoint,
          requestId,
          startedAtMs
        ),
        { allowToken: true }
      );
      return;
    }

    await withEndpointTimeout(endpoint, requestId, () => runSerializedAuthOperation(() => bridge.invalidateTokenCache()));
    payload = {
      ok: true,
      invalidated: true
    };
    sendJson(res, 200, withDaemonMeta(payload, endpoint, requestId, startedAtMs));
  } catch (error) {
    const payload = withDaemonMeta(
      bridgeErrorPayload(error, config, 'PRODUCT_TOKEN_DAEMON_FAILED'),
      endpoint,
      requestId,
      startedAtMs
    );
    const status = error instanceof ProductMcpError && error.code === 'MCP_INPUT_INVALID' ? 400 : 200;
    sendJson(res, status, payload);
  }
}

async function main(): Promise<void> {
  const { configPath } = parseArgs();
  const config = loadConfig(configPath);
  const secret = process.env[PRODUCT_TOKEN_DAEMON_SECRET_ENV]?.trim() || randomBytes(32).toString('hex');
  const bridge = new ProductTokenBridge(config, { useTokenDaemon: false });

  const server = createServer((req, res) => {
    void (async () => {
      if (!secretMatches(req.headers.authorization, secret)) {
        sendJson(res, 401, {
          ok: false,
          code: 'TOKEN_DAEMON_AUTH_FAILED',
          message: 'Missing or invalid Product token daemon Authorization header.'
        });
        return;
      }

      if (req.method === 'GET' && req.url === '/healthz') {
        sendJson(res, 200, healthPayload(config, configPath));
        return;
      }

      if (req.method === 'POST' && (req.url === '/auth/status' || req.url === '/auth/token' || req.url === '/auth/invalidate')) {
        await handlePostEndpoint(req, res, req.url, config, bridge);
        return;
      }

      sendJson(res, 404, {
        ok: false,
        code: 'TOKEN_DAEMON_NOT_FOUND',
        message: 'Unknown Product token daemon endpoint.'
      });
    })().catch((error) => {
      sendJson(res, 500, {
        ok: false,
        code: 'TOKEN_DAEMON_REQUEST_FAILED',
        message: error instanceof Error ? error.message : String(error)
      });
    });
  });

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close();
    bridge.close().finally(() => process.exit(0));
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.stdin.on('end', shutdown);
  process.stdin.on('close', shutdown);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, HOST, () => resolve());
  });

  const address = server.address() as AddressInfo;
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      url: `http://${HOST}:${address.port}`,
      secret,
      pid: process.pid,
      version: LOCAL_BRIDGE_VERSION
    })}\n`
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});

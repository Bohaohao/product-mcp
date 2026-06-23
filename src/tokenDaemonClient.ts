import { ProductMcpError, type ProductMcpErrorCode } from './errors.js';

export const PRODUCT_TOKEN_DAEMON_URL_ENV = 'PRODUCT_TOKEN_DAEMON_URL';
export const PRODUCT_TOKEN_DAEMON_SECRET_ENV = 'PRODUCT_TOKEN_DAEMON_SECRET';

const TOKEN_DAEMON_TOKEN_TIMEOUT_MS = 140_000;
const TOKEN_DAEMON_STATUS_TIMEOUT_MS = 140_000;
const TOKEN_DAEMON_FAST_TIMEOUT_MS = 5_000;

const SENSITIVE_KEYS = new Set([
  'token',
  'admintoken',
  'admin-token',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'authorization',
  'secret',
  'cookie',
  'set-cookie',
  'password'
]);

const KNOWN_PRODUCT_ERROR_CODES: readonly ProductMcpErrorCode[] = [
  'MCP_TOOL_NOT_ALLOWED',
  'MCP_INPUT_INVALID',
  'AUTH_TOKEN_MISSING',
  'AUTH_TOKEN_INVALID',
  'PERMISSION_DENIED',
  'CHROME_TAB_NOT_MATCHED',
  'CHROME_PAGE_CONTEXT_MISMATCH',
  'CHROME_STAGE_TIMEOUT',
  'TOKEN_DAEMON_CONFIG_INVALID',
  'TOKEN_DAEMON_UNAVAILABLE',
  'TOKEN_DAEMON_AUTH_FAILED',
  'TOKEN_DAEMON_REQUEST_FAILED',
  'TOKEN_DAEMON_TIMEOUT',
  'BACKEND_VALIDATION_FAILED',
  'BACKEND_REQUEST_FAILED',
  'RATE_LIMITED',
  'FILE_UPLOAD_FAILED'
];

export interface TokenDaemonEnv {
  url: string;
  secret: string;
}

export interface TokenDaemonBrowserToken {
  token: string;
  pageUrl: string;
  origin: string;
  fetchedAt: string;
  expiresAt: string;
  expiresInSeconds: number;
  fromCache: boolean;
}

export interface TokenDaemonStatus {
  ok: true;
  [key: string]: unknown;
}

interface TokenDaemonRequestOptions {
  timeoutMs: number;
  allowTokenInResponse?: boolean;
}

function redactSensitiveString(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>')
    .replace(/\b(Admin-Token|token|authorization|secret)\b\s*[:=]\s*["']?[^"',\s}]+/gi, '$1=<redacted>');
}

export function sanitizeForModel(value: unknown, depth = 0): unknown {
  if (depth > 8) return '<redacted-depth-limit>';
  if (typeof value === 'string') return redactSensitiveString(value);
  if (!value || typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizeForModel(item, depth + 1));
  }

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      result[key] = '<redacted>';
      continue;
    }
    result[key] = sanitizeForModel(entry, depth + 1);
  }
  return result;
}

function normalizeDaemonUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'http:') {
    throw new ProductMcpError('TOKEN_DAEMON_CONFIG_INVALID', 'Product token daemon URL must use http://127.0.0.1.', {
      details: { url: parsed.toString(), expectedHost: '127.0.0.1' }
    });
  }

  if (parsed.hostname !== '127.0.0.1') {
    throw new ProductMcpError('TOKEN_DAEMON_CONFIG_INVALID', 'Product token daemon URL must be bound to 127.0.0.1.', {
      details: { url: parsed.toString(), expectedHost: '127.0.0.1' }
    });
  }

  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/$/, '');
}

export function readTokenDaemonEnv(env: NodeJS.ProcessEnv = process.env): TokenDaemonEnv | undefined {
  const url = env[PRODUCT_TOKEN_DAEMON_URL_ENV]?.trim();
  const secret = env[PRODUCT_TOKEN_DAEMON_SECRET_ENV]?.trim();

  if (!url && !secret) return undefined;

  if (!url || !secret) {
    throw new ProductMcpError(
      'TOKEN_DAEMON_CONFIG_INVALID',
      `Both ${PRODUCT_TOKEN_DAEMON_URL_ENV} and ${PRODUCT_TOKEN_DAEMON_SECRET_ENV} are required when using the Product token daemon.`,
      {
        details: {
          urlConfigured: Boolean(url),
          secretConfigured: Boolean(secret)
        }
      }
    );
  }

  return {
    url: normalizeDaemonUrl(url),
    secret
  };
}

export function describeTokenDaemonEnv(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const url = env[PRODUCT_TOKEN_DAEMON_URL_ENV]?.trim();
  const secret = env[PRODUCT_TOKEN_DAEMON_SECRET_ENV]?.trim();

  if (!url && !secret) {
    return {
      configured: false,
      mode: 'local_fallback'
    };
  }

  try {
    const normalized = readTokenDaemonEnv(env);
    return {
      configured: true,
      mode: 'daemon',
      url: normalized?.url,
      secretConfigured: Boolean(secret)
    };
  } catch (error) {
    return {
      configured: true,
      mode: 'invalid',
      urlConfigured: Boolean(url),
      secretConfigured: Boolean(secret),
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function mapDaemonCode(code: unknown): ProductMcpErrorCode {
  const normalized = String(code || '').toUpperCase();
  if ((KNOWN_PRODUCT_ERROR_CODES as readonly string[]).includes(normalized)) {
    return normalized as ProductMcpErrorCode;
  }
  if (normalized.includes('AUTH') || normalized.includes('UNAUTHORIZED') || normalized.includes('FORBIDDEN')) {
    return 'TOKEN_DAEMON_AUTH_FAILED';
  }
  if (normalized.includes('TIMEOUT')) return 'TOKEN_DAEMON_TIMEOUT';
  return 'TOKEN_DAEMON_REQUEST_FAILED';
}

function asDaemonError(payload: unknown, status: number, fallbackMessage: string): ProductMcpError {
  const record = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  const daemonCode = record.code;
  const message = typeof record.message === 'string' && record.message ? record.message : fallbackMessage;
  return new ProductMcpError(mapDaemonCode(daemonCode), message, {
    status,
    details: {
      daemonCode,
      daemonPayload: sanitizeForModel(payload)
    }
  });
}

function validateTokenResponse(payload: unknown): TokenDaemonBrowserToken {
  const record = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : undefined;
  if (
    !record ||
    record.ok !== true ||
    typeof record.token !== 'string' ||
    typeof record.pageUrl !== 'string' ||
    typeof record.origin !== 'string' ||
    typeof record.fetchedAt !== 'string' ||
    typeof record.expiresAt !== 'string' ||
    typeof record.expiresInSeconds !== 'number' ||
    typeof record.fromCache !== 'boolean'
  ) {
    throw new ProductMcpError('TOKEN_DAEMON_REQUEST_FAILED', 'Product token daemon returned an invalid token response.', {
      details: { daemonPayload: sanitizeForModel(payload) }
    });
  }

  return {
    token: record.token,
    pageUrl: record.pageUrl,
    origin: record.origin,
    fetchedAt: record.fetchedAt,
    expiresAt: record.expiresAt,
    expiresInSeconds: record.expiresInSeconds,
    fromCache: record.fromCache
  };
}

export class ProductTokenDaemonClient {
  private readonly baseUrl: string;
  private readonly secret: string;

  constructor(env: TokenDaemonEnv) {
    this.baseUrl = normalizeDaemonUrl(env.url);
    this.secret = env.secret;
  }

  async healthz(): Promise<Record<string, unknown>> {
    return await this.requestJson('/healthz', undefined, { timeoutMs: TOKEN_DAEMON_FAST_TIMEOUT_MS });
  }

  async authStatus(options: { forceRefresh?: boolean } = {}): Promise<TokenDaemonStatus> {
    const payload = await this.requestJson('/auth/status', options, {
      timeoutMs: TOKEN_DAEMON_STATUS_TIMEOUT_MS
    });
    const sanitized = sanitizeForModel(payload) as Record<string, unknown>;
    if (sanitized.ok !== true) {
      throw asDaemonError(sanitized, 200, 'Product token daemon auth status failed.');
    }
    return sanitized as TokenDaemonStatus;
  }

  async getToken(options: { forceRefresh?: boolean } = {}): Promise<TokenDaemonBrowserToken> {
    const payload = await this.requestJson('/auth/token', options, {
      timeoutMs: TOKEN_DAEMON_TOKEN_TIMEOUT_MS,
      allowTokenInResponse: true
    });
    return validateTokenResponse(payload);
  }

  async invalidate(): Promise<Record<string, unknown>> {
    return await this.requestJson('/auth/invalidate', {}, { timeoutMs: TOKEN_DAEMON_FAST_TIMEOUT_MS });
  }

  private async requestJson(pathname: string, body: unknown, options: TokenDaemonRequestOptions): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
    const url = new URL(pathname, `${this.baseUrl}/`);

    try {
      const response = await fetch(url, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          authorization: `Bearer ${this.secret}`
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal
      });
      const text = await response.text();
      const payload = text ? JSON.parse(text) : {};

      if (!response.ok) {
        const code = response.status === 401 || response.status === 403 ? 'TOKEN_DAEMON_AUTH_FAILED' : 'TOKEN_DAEMON_REQUEST_FAILED';
        throw new ProductMcpError(code, `Product token daemon request failed with HTTP ${response.status}.`, {
          status: response.status,
          details: { daemonPayload: sanitizeForModel(payload) }
        });
      }

      if (payload && typeof payload === 'object' && (payload as Record<string, unknown>).ok === false) {
        throw asDaemonError(payload, response.status, 'Product token daemon returned an error.');
      }

      return (options.allowTokenInResponse ? payload : sanitizeForModel(payload)) as Record<string, unknown>;
    } catch (error) {
      if (error instanceof ProductMcpError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new ProductMcpError('TOKEN_DAEMON_TIMEOUT', 'Timed out while calling the Product token daemon.', {
          details: {
            url: url.toString(),
            timeoutMs: options.timeoutMs
          }
        });
      }

      throw new ProductMcpError('TOKEN_DAEMON_UNAVAILABLE', 'Could not call the Product token daemon.', {
        details: {
          url: url.toString(),
          error: error instanceof Error ? error.message : String(error)
        }
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function createProductTokenDaemonClientFromEnv(
  env: NodeJS.ProcessEnv = process.env
): ProductTokenDaemonClient | undefined {
  const daemonEnv = readTokenDaemonEnv(env);
  return daemonEnv ? new ProductTokenDaemonClient(daemonEnv) : undefined;
}

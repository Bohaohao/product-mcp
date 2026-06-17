export interface ProductMcpConfig {
  port: number;
  host: string;
  allowedHosts?: string[];
  path: string;
  backendBaseUrl: string;
  clientId: string;
  requestTimeoutMs: number;
  defaultLanguage: string;
}

const DEFAULT_CLIENT_ID = 'e5cd7e4891bf95d1d19206ce24a7b32e';

function readNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return '/mcp';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

function readCsvEnv(name: string): string[] | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;

  const values = raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  return values.length ? values : undefined;
}

export function loadConfig(): ProductMcpConfig {
  const backendBaseUrl = process.env.PRODUCT_MCP_BACKEND_BASE_URL;

  if (!backendBaseUrl) {
    throw new Error('Missing required env PRODUCT_MCP_BACKEND_BASE_URL');
  }

  return {
    port: readNumberEnv('PRODUCT_MCP_PORT', 8787),
    host: process.env.PRODUCT_MCP_HOST || '127.0.0.1',
    allowedHosts: readCsvEnv('PRODUCT_MCP_ALLOWED_HOSTS'),
    path: normalizePath(process.env.PRODUCT_MCP_PATH ?? '/mcp'),
    backendBaseUrl: normalizeBaseUrl(backendBaseUrl),
    clientId: process.env.PRODUCT_MCP_CLIENT_ID || DEFAULT_CLIENT_ID,
    requestTimeoutMs: readNumberEnv('PRODUCT_MCP_REQUEST_TIMEOUT_MS', 50000),
    defaultLanguage: process.env.PRODUCT_MCP_DEFAULT_LANGUAGE || 'zh_CN'
  };
}

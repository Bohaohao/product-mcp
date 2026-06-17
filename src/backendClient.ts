import type { ProductMcpConfig } from './config.js';
import type { ProductRequestContext } from './requestContext.js';
import { ProductMcpError } from './errors.js';

interface BackendEnvelope<T> {
  code?: number | string;
  msg?: string;
  message?: string;
  data?: T;
  rows?: T;
  [key: string]: unknown;
}

type QueryValue = string | number | boolean | null | undefined;
type QueryParams = Record<string, QueryValue | QueryValue[]>;

export class BackendClient {
  constructor(
    private readonly config: ProductMcpConfig,
    private readonly context: ProductRequestContext
  ) {}

  async get<T>(path: string, query?: QueryParams): Promise<T> {
    return this.request<T>('GET', path, undefined, query);
  }

  async post<T>(path: string, data: unknown): Promise<T> {
    return this.request<T>('POST', path, data);
  }

  private async request<T>(method: string, path: string, data?: unknown, query?: QueryParams): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    const headers: Record<string, string> = {
      Authorization: this.context.authorization,
      clientid: this.config.clientId,
      'Content-Language': this.context.language,
      locale: this.context.language,
      Accept: 'application/json'
    };

    if (data !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    try {
      const response = await fetch(this.buildUrl(path, query), {
        method,
        headers,
        body: data === undefined ? undefined : JSON.stringify(data),
        signal: controller.signal
      });

      const text = await response.text();
      const body = text ? this.parseJson<T>(text) : undefined;

      if (!response.ok) {
        throw this.mapHttpError(response.status, body);
      }

      if (body && body.code !== undefined && String(body.code) !== '200') {
        throw this.mapBusinessError(Number(body.code), body);
      }

      if (body && 'data' in body) return body.data as T;
      return body as T;
    } catch (error) {
      if (error instanceof ProductMcpError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new ProductMcpError('BACKEND_REQUEST_FAILED', '后端接口请求超时');
      }
      throw new ProductMcpError('BACKEND_REQUEST_FAILED', '后端服务暂时不可用', { details: String(error) });
    } finally {
      clearTimeout(timeout);
    }
  }

  private buildUrl(path: string, query?: QueryParams): string {
    const url = new URL(`${this.config.backendBaseUrl}${path}`);

    for (const [key, rawValue] of Object.entries(query || {})) {
      const values = Array.isArray(rawValue) ? rawValue : [rawValue];
      for (const value of values) {
        if (value === undefined || value === null || value === '') continue;
        url.searchParams.append(key, String(value));
      }
    }

    return url.toString();
  }

  private parseJson<T>(text: string): BackendEnvelope<T> {
    try {
      return JSON.parse(text) as BackendEnvelope<T>;
    } catch {
      throw new ProductMcpError('BACKEND_REQUEST_FAILED', '后端接口返回了非 JSON 响应');
    }
  }

  private mapHttpError(status: number, body?: BackendEnvelope<unknown>): ProductMcpError {
    const message = body?.msg || body?.message;

    if (status === 401) {
      return new ProductMcpError('AUTH_TOKEN_INVALID', message || '登录凭证无效或已过期', { status });
    }

    if (status === 403) {
      return new ProductMcpError('PERMISSION_DENIED', message || '当前用户没有执行该操作的权限', { status });
    }

    if (status === 429) {
      return new ProductMcpError('RATE_LIMITED', message || '调用过于频繁，请稍后再试', { status });
    }

    if (status >= 400 && status < 500) {
      return new ProductMcpError('BACKEND_VALIDATION_FAILED', message || '后端业务校验失败', { status, details: body });
    }

    return new ProductMcpError('BACKEND_REQUEST_FAILED', message || '后端服务暂时不可用', { status, details: body });
  }

  private mapBusinessError(code: number, body: BackendEnvelope<unknown>): ProductMcpError {
    const message = body.msg || body.message;

    if (code === 401) {
      return new ProductMcpError('AUTH_TOKEN_INVALID', message || '登录凭证无效或已过期', { details: body });
    }

    if (code === 403) {
      return new ProductMcpError('PERMISSION_DENIED', message || '当前用户没有执行该操作的权限', { details: body });
    }

    if (code === 429) {
      return new ProductMcpError('RATE_LIMITED', message || '调用过于频繁，请稍后再试', { details: body });
    }

    return new ProductMcpError('BACKEND_VALIDATION_FAILED', message || '后端业务校验失败', { details: body });
  }
}

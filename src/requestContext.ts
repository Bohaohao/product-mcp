import type { Request } from 'express';
import { ProductMcpError } from './errors.js';

export interface ProductRequestContext {
  authorization: string;
  requestId: string;
  language: string;
}

function headerValue(req: Request, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}

function createRequestId(): string {
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function getRequestContext(req: Request, defaultLanguage: string): ProductRequestContext {
  const authorization = headerValue(req, 'authorization');

  if (!authorization || !authorization.trim()) {
    throw new ProductMcpError('AUTH_TOKEN_MISSING', '缺少登录凭证');
  }

  if (!authorization.startsWith('Bearer ')) {
    throw new ProductMcpError('AUTH_TOKEN_INVALID', '登录凭证格式不正确');
  }

  return {
    authorization,
    requestId: headerValue(req, 'x-request-id') || createRequestId(),
    language: headerValue(req, 'content-language') || headerValue(req, 'locale') || defaultLanguage
  };
}

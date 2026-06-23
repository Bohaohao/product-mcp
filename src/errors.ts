export type ProductMcpErrorCode =
  | 'MCP_TOOL_NOT_ALLOWED'
  | 'MCP_INPUT_INVALID'
  | 'AUTH_TOKEN_MISSING'
  | 'AUTH_TOKEN_INVALID'
  | 'PERMISSION_DENIED'
  | 'CHROME_TAB_NOT_MATCHED'
  | 'CHROME_PAGE_CONTEXT_MISMATCH'
  | 'BACKEND_VALIDATION_FAILED'
  | 'BACKEND_REQUEST_FAILED'
  | 'RATE_LIMITED'
  | 'FILE_UPLOAD_FAILED';

export class ProductMcpError extends Error {
  readonly code: ProductMcpErrorCode;
  readonly status?: number;
  readonly details?: unknown;

  constructor(code: ProductMcpErrorCode, message: string, options: { status?: number; details?: unknown } = {}) {
    super(message);
    this.name = 'ProductMcpError';
    this.code = code;
    this.status = options.status;
    this.details = options.details;
  }
}

export function mapUnknownError(error: unknown): ProductMcpError {
  if (error instanceof ProductMcpError) return error;
  if (error instanceof Error) {
    return new ProductMcpError('BACKEND_REQUEST_FAILED', error.message);
  }
  return new ProductMcpError('BACKEND_REQUEST_FAILED', '后端服务暂时不可用');
}

export function toErrorPayload(error: unknown, requestId: string) {
  const mapped = mapUnknownError(error);
  return {
    ok: false as const,
    code: mapped.code,
    message: mapped.message,
    requestId,
    details: mapped.details
  };
}

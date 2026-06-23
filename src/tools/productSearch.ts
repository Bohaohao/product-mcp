import * as z from 'zod/v4';
import type { BackendClient } from '../backendClient.js';

interface ProductListResponse {
  pageNum?: number;
  pageSize?: number;
  rows?: ProductListRow[];
  total?: number;
  [key: string]: unknown;
}

interface ProductListRow {
  id?: string | number;
  commodityId?: string | number;
  productId?: string | number;
  spuId?: string | number;
  productName?: string;
  productNameCn?: string;
  productNameEn?: string;
  spuName?: string;
  spuNameCn?: string;
  spuName_zh?: string;
  productCode?: string;
  categoryFirstName?: string;
  categorySecondName?: string;
  categoryThirdName?: string;
  unitName?: string;
  createTime?: string;
  updateTime?: string;
  [key: string]: unknown;
}

export const productCheckNameDuplicateInputSchema = {
  productNameCn: z
    .string()
    .trim()
    .min(1)
    .describe('Chinese product name from the package draft. Used to check whether an ERP product with the same name already exists.'),
  pageSize: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(20)
    .describe('Maximum number of keyword candidates to fetch before exact duplicate matching.'),
  includeCandidates: z
    .boolean()
    .default(false)
    .describe('When true, include non-duplicate keyword candidates for diagnostics. Keep false during normal creation workflows.'),
  includeRaw: z.boolean().default(false).describe('When true, include the raw backend list response.')
};

const productCheckNameDuplicateObjectSchema = z.object(productCheckNameDuplicateInputSchema);
type ProductCheckNameDuplicateInput = z.infer<typeof productCheckNameDuplicateObjectSchema>;

function compactText(value: string): string {
  return value.replace(/\s+/g, '');
}

function normalizeName(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text || undefined;
}

function searchKeyword(productNameCn: string): string {
  return compactText(productNameCn).slice(0, 100) || productNameCn.slice(0, 100);
}

function rowChineseName(row: ProductListRow): string | undefined {
  return normalizeName(row.productNameCn ?? row.spuNameCn ?? row.spuName_zh ?? row.productName ?? row.spuName);
}

function rowId(row: ProductListRow): string | undefined {
  const value = row.commodityId ?? row.productId ?? row.id ?? row.spuId;
  if (value === undefined || value === null || value === '') return undefined;
  return String(value);
}

function categoryPath(row: ProductListRow): string | undefined {
  const names = [row.categoryFirstName, row.categorySecondName, row.categoryThirdName]
    .map((name) => normalizeName(name))
    .filter((name): name is string => Boolean(name));
  return names.length ? names.join(' > ') : undefined;
}

function normalizeCandidate(row: ProductListRow, requestedName: string) {
  const productNameCn = rowChineseName(row);
  const trimmedNameMatched = productNameCn === requestedName;
  const compactNameMatched = Boolean(productNameCn && compactText(productNameCn) === compactText(requestedName));

  return {
    id: rowId(row),
    productNameCn,
    productNameEn: normalizeName(row.productNameEn),
    productCode: normalizeName(row.productCode),
    categoryPath: categoryPath(row),
    unitName: normalizeName(row.unitName),
    createTime: normalizeName(row.createTime),
    updateTime: normalizeName(row.updateTime),
    matchType: trimmedNameMatched ? ('exact' as const) : compactNameMatched ? ('compact' as const) : undefined
  };
}

function extractRows(response: ProductListResponse): ProductListRow[] {
  return Array.isArray(response.rows) ? response.rows : [];
}

export async function productCheckNameDuplicate(
  backend: BackendClient,
  rawInput: unknown,
  requestId: string
) {
  const input: ProductCheckNameDuplicateInput = productCheckNameDuplicateObjectSchema.parse(rawInput);
  const productNameCn = input.productNameCn.trim();
  const keyword = searchKeyword(productNameCn);
  const raw = await backend.post<ProductListResponse>('/user/erp/product/_page', {
    pageNum: 1,
    pageSize: input.pageSize,
    keyword
  });

  const candidates = extractRows(raw).map((row) => normalizeCandidate(row, productNameCn));
  const duplicates = candidates.filter((candidate) => candidate.matchType);
  const exists = duplicates.length > 0;

  return {
    ok: true as const,
    exists,
    blocking: exists,
    productNameCn,
    searchKeyword: keyword,
    endpoint: '/user/erp/product/_page',
    total: Number(raw.total || 0),
    candidateCount: candidates.length,
    duplicateCount: duplicates.length,
    duplicates,
    candidates: input.includeCandidates ? candidates : undefined,
    raw: input.includeRaw ? raw : undefined,
    agentGuidance: exists
      ? '同名商品已存在。立即中断本商品的文件上传和 product_create；如果当前是多商品并行 worker，向总控返回失败通知，包含 productNameCn、duplicates 和 packagePath。'
      : '未发现同名商品。可继续解析 ID、上传文件，并在用户确认后创建商品。',
    requestId
  };
}

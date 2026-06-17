import * as z from 'zod/v4';
import type { BackendClient } from '../backendClient.js';

interface CategoryConfigItem {
  id?: string | number;
  name?: string;
  unitName?: string;
  categoryId?: string | number;
  categoryName?: string;
  categoryLevel?: number;
  status?: string | number;
  defaultValue?: string;
  i18nName?: string;
  i18nDefaultValue?: string;
  items?: CategoryOptionalConfigItem[];
  [key: string]: unknown;
}

interface CategoryOptionalConfigItem {
  id?: string | number;
  name?: string;
  configValue?: string;
  price?: number | string;
  priceDiffCny?: number;
  priceDiffUsd?: number;
  status?: string | number;
  i18nName?: string;
  [key: string]: unknown;
}

interface CategoryConfigResponse {
  unitList?: CategoryConfigItem[];
  baseList?: CategoryConfigItem[];
  fieldList?: CategoryConfigItem[];
  optionalList?: CategoryConfigItem[];
  [key: string]: unknown;
}

interface SupplierNode {
  id?: string | number;
  parentId?: string | number;
  classificationName?: string;
  status?: string | number;
  children?: SupplierNode[];
  supplierList?: SupplierItem[];
  supplierCount?: number;
  [key: string]: unknown;
}

interface SupplierItem {
  id?: string | number;
  name?: string;
  code?: string;
  rating?: string;
  productPositioning?: string;
  paymentPeriod?: number;
  mainItem?: string;
  address?: string;
  [key: string]: unknown;
}

interface RegionItem {
  id?: string | number;
  nameZh?: string;
  nameEn?: string;
  orgCode?: string;
  continentDictValue?: string;
  description?: string;
  remark?: string;
  [key: string]: unknown;
}

interface DictItem {
  dictCode?: string | number;
  dictSort?: number;
  dictLabel?: string;
  dictValue?: string;
  dictType?: string;
  listClass?: string;
  isDefault?: string;
  remark?: string;
  [key: string]: unknown;
}

export const productGetCategoryConfigInputSchema = {
  categoryId: z.string().trim().min(1).describe('Product category id, usually the selected leaf category id.'),
  enabledOnly: z.boolean().default(true).describe('When true, keep only config rows with status === 0.'),
  includeRaw: z.boolean().default(false).describe('When true, include the raw backend response.')
};

export const productListSuppliersInputSchema = {
  keyword: z.string().trim().optional().describe('Optional keyword to filter by supplier id, name, code, rating, main item, or classification name.'),
  classificationId: z.string().trim().optional().describe('Optional supplier classification id. Returns suppliers under this subtree.'),
  enabledOnly: z.boolean().default(true).describe('When true, keep only classification nodes with status === 0.'),
  includeTree: z.boolean().default(true).describe('When true, include the normalized classification tree.')
};

export const productListRegionsInputSchema = {
  keyword: z.string().trim().optional().describe('Optional keyword passed to backend and used for local filtering.'),
  enabledOnly: z.boolean().default(true).describe('Reserved for consistency; current backend response has no status field.'),
  includeRaw: z.boolean().default(false).describe('When true, include the raw backend response.')
};

export const productGetDictInputSchema = {
  dictType: z.string().trim().min(1).describe('System dict type, for example erp_customer_type.'),
  keyword: z.string().trim().optional().describe('Optional keyword to filter by label or value.'),
  includeRaw: z.boolean().default(false).describe('When true, include the raw backend response.')
};

export type ProductGetCategoryConfigInput = {
  categoryId: string;
  enabledOnly?: boolean;
  includeRaw?: boolean;
};

export type ProductListSuppliersInput = {
  keyword?: string;
  classificationId?: string;
  enabledOnly?: boolean;
  includeTree?: boolean;
};

export type ProductListRegionsInput = {
  keyword?: string;
  enabledOnly?: boolean;
  includeRaw?: boolean;
};

export type ProductGetDictInput = {
  dictType: string;
  keyword?: string;
  includeRaw?: boolean;
};

function isEnabled(item: { status?: string | number }): boolean {
  return String(item.status ?? '0') === '0';
}

function matchesKeyword(values: unknown[], keyword?: string): boolean {
  const normalizedKeyword = keyword?.trim().toLowerCase();
  if (!normalizedKeyword) return true;
  return values
    .filter((value) => value !== undefined && value !== null)
    .some((value) => String(value).toLowerCase().includes(normalizedKeyword));
}

function normalizeConfigItem(item: CategoryConfigItem, type: 'unit' | 'base' | 'field' | 'optional') {
  const name = type === 'unit' ? item.unitName : item.name;
  return {
    id: item.id === undefined || item.id === null ? undefined : String(item.id),
    name: name ? String(name) : item.id === undefined ? undefined : String(item.id),
    unitName: item.unitName ? String(item.unitName) : undefined,
    categoryId: item.categoryId === undefined || item.categoryId === null ? undefined : String(item.categoryId),
    categoryName: item.categoryName ? String(item.categoryName) : undefined,
    categoryLevel: item.categoryLevel,
    enabled: isEnabled(item),
    defaultValue: item.defaultValue,
    i18nName: item.i18nName,
    i18nDefaultValue: item.i18nDefaultValue,
    items: Array.isArray(item.items)
      ? item.items.map((option) => ({
          id: option.id === undefined || option.id === null ? undefined : String(option.id),
          name: option.name ? String(option.name) : undefined,
          configValue: option.configValue ? String(option.configValue) : option.name ? String(option.name) : undefined,
          price: option.price,
          priceDiffCny: option.priceDiffCny,
          priceDiffUsd: option.priceDiffUsd,
          enabled: isEnabled(option),
          i18nName: option.i18nName
        }))
      : undefined
  };
}

function normalizeConfigList(items: CategoryConfigItem[] | undefined, type: 'unit' | 'base' | 'field' | 'optional', enabledOnly: boolean) {
  const normalized = (items || []).map((item) => normalizeConfigItem(item, type));
  return enabledOnly ? normalized.filter((item) => item.enabled) : normalized;
}

export async function productGetCategoryConfig(
  backend: BackendClient,
  input: ProductGetCategoryConfigInput,
  requestId: string
) {
  const raw = await backend.get<CategoryConfigResponse>('/user/erp/productCategory/configList', {
    categoryId: input.categoryId
  });
  const enabledOnly = input.enabledOnly !== false;

  return {
    ok: true as const,
    categoryId: input.categoryId,
    units: normalizeConfigList(raw.unitList, 'unit', enabledOnly),
    baseConfigs: normalizeConfigList(raw.baseList, 'base', enabledOnly),
    technicalParams: normalizeConfigList(raw.fieldList, 'field', enabledOnly),
    optionalConfigs: normalizeConfigList(raw.optionalList, 'optional', enabledOnly),
    raw: input.includeRaw ? raw : undefined,
    requestId
  };
}

function normalizeSupplier(supplier: SupplierItem, classificationPath: string[]) {
  return {
    id: supplier.id === undefined || supplier.id === null ? undefined : String(supplier.id),
    name: supplier.name ? String(supplier.name) : supplier.id === undefined ? undefined : String(supplier.id),
    code: supplier.code ? String(supplier.code) : undefined,
    rating: supplier.rating ? String(supplier.rating) : undefined,
    productPositioning: supplier.productPositioning ? String(supplier.productPositioning) : undefined,
    paymentPeriod: supplier.paymentPeriod,
    mainItem: supplier.mainItem ? String(supplier.mainItem) : undefined,
    address: supplier.address ? String(supplier.address) : undefined,
    classificationPath
  };
}

type NormalizedSupplier = ReturnType<typeof normalizeSupplier>;

function normalizeSupplierNode(
  node: SupplierNode,
  input: ProductListSuppliersInput,
  path: string[] = [],
  supplierMap = new Map<string, NormalizedSupplier>()
): SupplierNode | undefined {
  if (input.enabledOnly !== false && !isEnabled(node)) return undefined;

  const label = String(node.classificationName || node.id || '');
  const nextPath = label ? [...path, label] : path;
  const children = (node.children || [])
    .map((child) => normalizeSupplierNode(child, input, nextPath, supplierMap))
    .filter((child): child is SupplierNode => Boolean(child));
  const suppliers = (node.supplierList || [])
    .map((supplier) => normalizeSupplier(supplier, nextPath))
    .filter((supplier) =>
      matchesKeyword([supplier.id, supplier.name, supplier.code, supplier.rating, supplier.mainItem, ...supplier.classificationPath], input.keyword)
    );

  for (const supplier of suppliers) {
    if (supplier.id && !supplierMap.has(supplier.id)) supplierMap.set(supplier.id, supplier);
  }

  return {
    id: node.id === undefined || node.id === null ? undefined : String(node.id),
    parentId: node.parentId === undefined || node.parentId === null ? undefined : String(node.parentId),
    classificationName: label,
    enabled: isEnabled(node),
    supplierCount: node.supplierCount,
    supplierList: suppliers,
    children: children.length ? children : undefined
  };
}

function findSupplierSubtree(nodes: SupplierNode[], classificationId?: string): SupplierNode[] {
  if (!classificationId) return nodes;

  for (const node of nodes) {
    if (String(node.id) === classificationId) return [node];
    const found = findSupplierSubtree(node.children || [], classificationId);
    if (found.length) return found;
  }

  return [];
}

export async function productListSuppliers(backend: BackendClient, input: ProductListSuppliersInput, requestId: string) {
  const rawTree = await backend.get<SupplierNode[]>('/user/erp/supplier/classification/tree');
  const subtree = findSupplierSubtree(rawTree, input.classificationId);
  const supplierMap = new Map<string, NormalizedSupplier>();
  const tree = subtree
    .map((node) => normalizeSupplierNode(node, input, [], supplierMap))
    .filter((node): node is SupplierNode => Boolean(node));
  const suppliers = Array.from(supplierMap.values()).filter((supplier) =>
    matchesKeyword([supplier.id, supplier.name, supplier.code, supplier.rating, supplier.mainItem, ...supplier.classificationPath], input.keyword)
  );

  return {
    ok: true as const,
    suppliers,
    tree: input.includeTree === false ? undefined : tree,
    requestId
  };
}

function normalizeRegion(region: RegionItem) {
  return {
    id: region.id === undefined || region.id === null ? undefined : String(region.id),
    name: String(region.nameZh || region.nameEn || region.id || ''),
    nameZh: region.nameZh ? String(region.nameZh) : undefined,
    nameEn: region.nameEn ? String(region.nameEn) : undefined,
    orgCode: region.orgCode ? String(region.orgCode) : undefined,
    continentDictValue: region.continentDictValue ? String(region.continentDictValue) : undefined,
    description: region.description ? String(region.description) : undefined,
    remark: region.remark ? String(region.remark) : undefined
  };
}

export async function productListRegions(backend: BackendClient, input: ProductListRegionsInput, requestId: string) {
  const raw = await backend.get<RegionItem[]>('/user/regionalOrganizations/continents?value=');
  const regions = (raw || [])
    .map((region) => normalizeRegion(region))
    .filter((region) => matchesKeyword([region.name, region.nameZh, region.nameEn, region.orgCode, region.continentDictValue], input.keyword));

  return {
    ok: true as const,
    regions,
    raw: input.includeRaw ? raw : undefined,
    requestId
  };
}

function normalizeDict(item: DictItem) {
  return {
    code: item.dictCode === undefined || item.dictCode === null ? undefined : String(item.dictCode),
    label: item.dictLabel ? String(item.dictLabel) : undefined,
    value: item.dictValue ? String(item.dictValue) : undefined,
    type: item.dictType ? String(item.dictType) : undefined,
    sort: item.dictSort,
    listClass: item.listClass ? String(item.listClass) : undefined,
    isDefault: item.isDefault ? String(item.isDefault) : undefined,
    remark: item.remark ? String(item.remark) : undefined
  };
}

export async function productGetDict(backend: BackendClient, input: ProductGetDictInput, requestId: string) {
  const raw = await backend.get<DictItem[]>(`/user/system/dict/data/type/${encodeURIComponent(input.dictType)}`);
  const items = (raw || [])
    .map((item) => normalizeDict(item))
    .filter((item) => matchesKeyword([item.label, item.value, item.code, item.remark], input.keyword));

  return {
    ok: true as const,
    dictType: input.dictType,
    items,
    raw: input.includeRaw ? raw : undefined,
    requestId
  };
}

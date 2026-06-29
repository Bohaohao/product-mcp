import * as z from 'zod/v4';
import type { BackendClient } from '../backendClient.js';
import { ProductMcpError } from '../errors.js';
import { buildFieldCoverage, buildProtocolTrace, buildSubmissionPreview, toActionableIssues } from '../protocol.js';
import { throwValidationIssues, validateFrontendAlignedSubmission, validateResolvedUploads } from '../submissionValidation.js';

const idSchema = z.union([z.string().trim().min(1), z.number()]);
const optionalIdSchema = idSchema.optional();
const scalarSchema = z.union([z.string(), z.number(), z.boolean()]).optional();
const numberLikeSchema = z.union([z.number(), z.string().trim().min(1)]).optional();
const zeroOneSchema = z.union([z.literal(0), z.literal(1)]);
const zeroOneLikeSchema = z.union([z.literal(0), z.literal(1), z.literal('0'), z.literal('1'), z.boolean()]);
const objectArraySchema = z.array(z.record(z.string(), z.any())).optional();

const skuPackageSchema = z.looseObject({
  id: optionalIdSchema,
  skuId: optionalIdSchema,
  skuCode: z.string().trim().optional(),
  skuModel: z.string().trim().optional(),
  pkgLength: numberLikeSchema,
  pkgWidth: numberLikeSchema,
  pkgHeight: numberLikeSchema,
  pkgVolume: numberLikeSchema,
  pkgWeight: numberLikeSchema,
  grossWeight: numberLikeSchema,
  pkgFee: numberLikeSchema
});

const regionSchema = z.looseObject({
  id: optionalIdSchema,
  regionId: optionalIdSchema,
  regionName: z.string().trim().optional(),
  isAll: z.union([z.literal(0), z.literal(1)]).optional(),
  customerType: z.union([z.string(), z.array(z.string())]).optional(),
  originPlace: z.string().trim().optional(),
  sortNo: z.number().int().positive().optional(),
  remark: z.string().optional()
});

const mediaSchema = z.looseObject({
  id: optionalIdSchema,
  mediaType: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  mediaUrl: z.string().trim().min(1),
  mediaId: optionalIdSchema,
  mediaName: z.string().trim().optional(),
  mediaTitle: z.string().optional(),
  mediaSubtitle: z.string().optional(),
  mediaDesc: z.string().optional(),
  imageCategory: z.number().int().positive().optional(),
  videoCategory: z.number().int().positive().optional(),
  otherCategory: z.number().int().positive().optional(),
  language: z.string().trim().optional(),
  languageList: z.array(z.enum(['zh', 'en'])).optional(),
  sort: z.number().int().positive().optional(),
  remark: z.string().optional(),
  duration: z.number().nonnegative().optional()
});

const packageFieldSchemas = {
  palletInfo: z.string().optional(),
  cartonMark: z.string().optional(),
  stackingReq: z.string().optional(),
  moistureProofReq: z.string().optional(),
  waterproofReq: z.string().optional(),
  packingListTemplate: z.string().optional(),
  packLength: numberLikeSchema,
  packWidth: numberLikeSchema,
  packHeight: numberLikeSchema,
  packCubic: numberLikeSchema,
  packingFee: numberLikeSchema,
  containerFt20: numberLikeSchema,
  containerFt40: numberLikeSchema,
  containerHc40: numberLikeSchema,
  containerFrame: numberLikeSchema,
  bulkCarrier: numberLikeSchema,
  packWeight: numberLikeSchema,
  netWeight: numberLikeSchema
};

const packageInfoSchema = z.looseObject(packageFieldSchemas);

const priceTierSchema = z.looseObject({
  id: optionalIdSchema,
  minPriceQuantity: numberLikeSchema,
  maxPriceQuantity: numberLikeSchema,
  unitPrice: numberLikeSchema,
  profitRate: numberLikeSchema,
  minDeliveryDays: numberLikeSchema,
  maxDeliveryDays: numberLikeSchema
});

const supplierSchema = z.looseObject({
  id: optionalIdSchema,
  supplierId: idSchema,
  supplierName: z.string().trim().optional(),
  productionCycle: numberLikeSchema,
  cycleUnit: numberLikeSchema,
  remark: z.string().optional()
});

const tagObjectSchema = z.looseObject({
  id: optionalIdSchema,
  tagName: z.string().trim().min(1),
  remark: z.string().optional()
});

export const productCreateInputSchema = {
  confirm: z.boolean().optional().describe('Required true unless previewOnly=true. This tool creates a real product when previewOnly is not enabled.'),
  previewOnly: z.boolean().default(false).describe('When true, validate and build the final submission preview but do not call the ERP create API.'),
  mode: z.enum(['create', 'retry', 'update', 'clone']).default('create').describe('Execution mode. product_create currently only executes create/retry; update/clone are rejected for safety.'),
  clientRequestId: z.string().trim().max(100).optional(),

  id: optionalIdSchema,
  tenantId: z.string().trim().optional(),
  createBy: optionalIdSchema,
  createDept: optionalIdSchema,
  language: z.string().trim().optional(),
  productNameCn: z.string().trim().min(1).describe('Product Chinese name.'),
  productNameEn: z.string().trim().optional().describe('Optional product English name.'),
  productType: z.union([z.literal(1), z.literal(2), z.literal(3)]).describe('1=whole machine, 2=part, 3=service.'),
  status: z.union([z.literal(1), z.literal(2), z.literal(3)]).describe('1=on shelf, 2=off shelf, 3=void.'),
  level: scalarSchema,

  categoryFirstId: optionalIdSchema.describe('Required first-level category id. Kept schema-optional so product_create can return a grouped MCP validation issue.'),
  categorySecondId: optionalIdSchema,
  categoryThirdId: optionalIdSchema,
  unitId: optionalIdSchema.describe('Required unit id. If omitted, product_create can resolve it from unitName and selected category config.'),
  unitName: z.string().trim().optional(),

  supplierId: optionalIdSchema,
  supplierName: z.string().trim().optional(),
  supplierProductionCycle: z.number().int().positive().optional(),
  supplierCycleUnit: z.number().int().positive().optional(),
  suppliers: z.array(supplierSchema).optional(),

  useAllRegions: z.boolean().default(false).describe('When true, create one global region row.'),
  regions: z.array(regionSchema).optional(),

  productMainImageUrl: z.string().trim().min(1).optional(),
  productMainImageName: z.string().trim().optional(),
  medias: z.array(mediaSchema).optional(),

  productCode: z.string().trim().optional(),
  commodityId: z.number().int().positive().optional(),
  hsCode: z.string().trim().optional(),
  productModel: z.string().optional().describe('Optional product model. If present, only English letters, digits, and spaces are allowed.'),
  spuModel: z.string().optional().describe('Compatibility alias for productModel. productModel wins when both are present.'),
  brand: z.string().trim().optional(),
  remark: z.string().optional(),
  usagePurpose: z.string().trim().optional(),
  relatedCommodityId: z.string().trim().optional(),
  supportConsolidation: zeroOneSchema,
  canExhibit: zeroOneSchema,
  needInstallation: zeroOneSchema,
  hasAfterSalesThreshold: zeroOneSchema,
  supportSample: zeroOneSchema,
  samplePrice: numberLikeSchema,
  taxRefundRate: numberLikeSchema,
  independentPkg: zeroOneLikeSchema.optional().describe('Whether SKU rows use independent package info.'),
  skuList: z.array(skuPackageSchema).optional().describe('Optional SKU list when independentPkg is enabled.'),

  standardDeliveryDays: numberLikeSchema,
  shortestDeliveryDays: numberLikeSchema,
  urgentOrderDays: numberLikeSchema,
  supportPartsAlone: zeroOneSchema,
  supportOem: zeroOneSchema,
  supportOdm: zeroOneSchema,
  moq: numberLikeSchema,
  warrantyPeriod: numberLikeSchema,
  warrantyPeriodUnit: z.union([z.literal(1), z.literal(2), z.literal('month'), z.literal('year')]).optional(),
  supportSmallTrial: zeroOneSchema,
  minTrialQuantity: numberLikeSchema,
  hasSpotStock: zeroOneSchema,
  hasOverseasWarehouseStock: zeroOneSchema,

  suggestedPrice: numberLikeSchema,
  minPrice: numberLikeSchema,
  referenceCostCny: numberLikeSchema,
  referenceCostUsd: numberLikeSchema,
  profitMargin: numberLikeSchema,
  exFactoryPrice: numberLikeSchema,
  specialCustomFee: numberLikeSchema,
  clashSupport: z.string().optional(),
  rebateSupport: z.string().optional(),
  rebateCondition: z.string().optional(),
  rebateRate: numberLikeSchema,
  priceTiers: z.array(priceTierSchema).optional(),

  isInnerTreasury: z.number().int().optional(),
  externalAddress: z.string().optional(),
  externalStatus: z.union([z.literal(1), z.literal(2)]).optional(),
  proofreadStatus: z.union([z.literal(0), z.literal(1)]).optional(),
  skipTranslation: z.boolean().optional(),

  ...packageFieldSchemas,
  packageInfo: packageInfoSchema.optional(),
  tags: z.array(z.union([z.string().trim().min(1), tagObjectSchema])).optional(),
  baseConfigs: objectArraySchema,
  technicalParams: objectArraySchema,
  optionalConfigs: objectArraySchema,
  partLists: objectArraySchema,
  certifications: objectArraySchema,
  salesSupports: objectArraySchema,
  competitors: objectArraySchema,
  customerCases: objectArraySchema,

  extraBody: z.record(z.string(), z.any()).optional().describe('Advanced escape hatch for backend fields not exposed by this minimal schema.')
};

const productCreateObjectSchema = z.object(productCreateInputSchema);

export type ProductCreateInput = z.infer<typeof productCreateObjectSchema>;

type ProductCreateResponse = string | number | Record<string, unknown> | null | undefined;

interface CategoryConfigItem {
  id?: string | number;
  name?: string;
  unitName?: string;
  status?: string | number;
  defaultValue?: string;
  items?: CategoryOptionalConfigItem[];
  [key: string]: unknown;
}

interface CategoryOptionalConfigItem {
  id?: string | number;
  name?: string;
  configValue?: string;
  optionalId?: string | number;
  price?: string | number;
  priceDiffCny?: string | number;
  priceDiffUsd?: string | number;
  status?: string | number;
  [key: string]: unknown;
}

interface CategoryConfigResponse {
  unitList?: CategoryConfigItem[];
  baseList?: CategoryConfigItem[];
  fieldList?: CategoryConfigItem[];
  optionalList?: CategoryConfigItem[];
  [key: string]: unknown;
}

interface ProductCategoryNode {
  id?: string | number;
  status?: string | number;
  children?: ProductCategoryNode[];
}

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '';
}

function toIdValue(value: string | number): string | number {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new ProductMcpError(
        'MCP_INPUT_INVALID',
        'Large numeric IDs must be passed as strings to avoid JavaScript precision loss.'
      );
    }
    return value;
  }
  if (!/^\d+$/.test(value)) return value;

  const numberValue = Number(value);
  return Number.isSafeInteger(numberValue) ? numberValue : value;
}

function toNumberValue(value: unknown, fieldName: string): number | undefined {
  if (!isPresent(value)) return undefined;
  const numberValue = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numberValue)) {
    throw new ProductMcpError('MCP_INPUT_INVALID', `${fieldName} must be a number.`);
  }
  return numberValue;
}

function toRequiredNumberValue(value: unknown, fieldName: string): number {
  const numberValue = toNumberValue(value, fieldName);
  if (numberValue === undefined) {
    throw new ProductMcpError('MCP_INPUT_INVALID', `${fieldName} is required.`);
  }
  return numberValue;
}

function toRequiredIdValue(value: unknown, fieldName: string): string | number {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new ProductMcpError('MCP_INPUT_INVALID', `${fieldName} is required.`);
  }
  if (!isPresent(value)) {
    throw new ProductMcpError('MCP_INPUT_INVALID', `${fieldName} is required.`);
  }
  return toIdValue(value);
}

function toOptionalIdValue(value: unknown): string | number | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  if (!isPresent(value)) return undefined;
  return toIdValue(value);
}

function toOptionalNumberValue(value: unknown, fieldName: string): number | undefined {
  return toNumberValue(value, fieldName);
}

function stringValue(value: unknown): string | undefined {
  if (!isPresent(value)) return undefined;
  return String(value).trim() || undefined;
}

function normalizeLookupText(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

function isEnabled(item: { status?: string | number }): boolean {
  return String(item.status ?? '0') === '0';
}

function toStringId(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  if (!isPresent(value)) return undefined;
  return String(toIdValue(value));
}

function itemLabel(item: CategoryConfigItem | CategoryOptionalConfigItem): string | undefined {
  return stringValue(item.name) || stringValue(item.configValue) || stringValue(item.unitName);
}

function findCategoryConfigItem(
  items: CategoryConfigItem[] | undefined,
  input: Record<string, unknown>,
  idKeys: string[],
  nameKeys: string[],
  fieldName: string
): CategoryConfigItem | undefined {
  const enabledItems = (items || []).filter(isEnabled);
  const directId = idKeys.map((key) => stringValue(input[key])).find(Boolean);
  if (directId) {
    const matched = enabledItems.find((item) => toStringId(item.id) === directId);
    if (!matched) {
      throw new ProductMcpError('MCP_INPUT_INVALID', `${fieldName} id not found or disabled: ${directId}.`);
    }
    return matched;
  }

  const lookupName = nameKeys.map((key) => normalizeLookupText(input[key])).find(Boolean);
  if (!lookupName) return undefined;

  const matched = enabledItems.find((item) => normalizeLookupText(itemLabel(item)) === lookupName);
  if (!matched) {
    throw new ProductMcpError('MCP_INPUT_INVALID', `${fieldName} not found in selected category config: ${lookupName}.`);
  }
  return matched;
}

function findOptionalConfigOption(
  config: CategoryConfigItem,
  input: Record<string, unknown>,
  rowIndex: number
): CategoryOptionalConfigItem | undefined {
  const items = (config.items || []).filter(isEnabled);
  const directId = stringValue(input.categoryOptionalConfigId);
  if (directId) {
    const matched = items.find((item) => toStringId(item.id) === directId);
    if (!matched) {
      throw new ProductMcpError('MCP_INPUT_INVALID', `optionalConfigs[${rowIndex}].categoryOptionalConfigId not found or disabled: ${directId}.`);
    }
    return matched;
  }

  const optionText = normalizeLookupText(input.configValue);
  if (!optionText) return undefined;

  const matched = items.find((item) => normalizeLookupText(itemLabel(item)) === optionText);
  if (!matched) {
    const allowed = items.map((item) => itemLabel(item)).filter(Boolean).join(', ');
    throw new ProductMcpError(
      'MCP_INPUT_INVALID',
      `optionalConfigs[${rowIndex}].configValue is not valid for ${itemLabel(config) || 'selected config'}: ${String(
        input.configValue
      )}. Allowed values: ${allowed || 'none'}.`
    );
  }
  return matched;
}

function toTaxRefundRate(value: unknown): string | undefined {
  if (!isPresent(value)) return undefined;
  return String(value);
}

function toCsv(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    const csv = value.map((item) => item.trim()).filter(Boolean).join(',');
    return csv || undefined;
  }
  return value?.trim() || undefined;
}

function fileNameFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const name = pathname.split('/').filter(Boolean).at(-1);
    return name ? decodeURIComponent(name) : url;
  } catch {
    const name = url.split(/[\\/]/).filter(Boolean).at(-1);
    return name || url;
  }
}

function normalizeRegions(input: ProductCreateInput): Array<Record<string, unknown>> | undefined {
  if (input.useAllRegions) {
    return [
      {
        originPlace: undefined,
        customerType: undefined,
        isAll: 1,
        regionId: '',
        regionName: 'global',
        sortNo: 1
      }
    ];
  }

  const regions = input.regions || [];
  if (!regions.length) {
    return undefined;
  }

  return regions.map((region, index) => {
    const isAll = region.isAll ?? 0;
    return {
      ...region,
      id: toOptionalIdValue(region.id),
      originPlace: region.originPlace,
      customerType: toCsv(region.customerType),
      isAll,
      regionId: isAll === 1 ? toOptionalIdValue(region.regionId) ?? '' : toRequiredIdValue(region.regionId, `regions[${index}].regionId`),
      regionName: region.regionName,
      sortNo: region.sortNo ?? index + 1,
      remark: region.remark
    };
  });
}

function isEnabledCategory(node: ProductCategoryNode): boolean {
  return String(node.status ?? '0') === '0';
}

function findCategoryNode(nodes: ProductCategoryNode[] | undefined, id: string): ProductCategoryNode | undefined {
  for (const node of nodes || []) {
    if (node.id !== undefined && String(node.id) === id) return node;
    const found = findCategoryNode(node.children, id);
    if (found) return found;
  }
  return undefined;
}

async function validateCategorySelection(backend: BackendClient, input: ProductCreateInput): Promise<void> {
  if (!isPresent(input.categoryFirstId) && !isPresent(input.categorySecondId) && !isPresent(input.categoryThirdId)) {
    return;
  }

  const rawTree = await backend.get<ProductCategoryNode[]>('/user/erp/productCategory/tree');
  const firstId = String(toRequiredIdValue(input.categoryFirstId, 'categoryFirstId'));
  const firstNode = findCategoryNode(rawTree, firstId);
  if (!firstNode) {
    throw new ProductMcpError('MCP_INPUT_INVALID', `categoryFirstId not found: ${firstId}.`);
  }

  const enabledSecondLevel = (firstNode.children || []).filter(isEnabledCategory);
  if (enabledSecondLevel.length > 0 && !isPresent(input.categorySecondId)) {
    throw new ProductMcpError('MCP_INPUT_INVALID', '当前一级分类下仍有可用二级分类，categorySecondId 必填。');
  }

  if (!isPresent(input.categorySecondId)) return;
  const secondId = String(toRequiredIdValue(input.categorySecondId, 'categorySecondId'));
  const secondNode = enabledSecondLevel.find((node) => node.id !== undefined && String(node.id) === secondId) || findCategoryNode(enabledSecondLevel, secondId);
  if (!secondNode) {
    throw new ProductMcpError('MCP_INPUT_INVALID', `categorySecondId not found under selected categoryFirstId: ${secondId}.`);
  }

  const enabledThirdLevel = (secondNode.children || []).filter(isEnabledCategory);
  if (enabledThirdLevel.length > 0 && !isPresent(input.categoryThirdId)) {
    throw new ProductMcpError('MCP_INPUT_INVALID', '当前二级分类下仍有可用三级分类，categoryThirdId 必填。');
  }
}

function normalizeTags(tags: ProductCreateInput['tags']): Array<{ tagName: string }> {
  return (tags || []).map((tag) => (typeof tag === 'string' ? { tagName: tag } : tag));
}

function normalizeUnitId(input: ProductCreateInput, categoryConfig?: CategoryConfigResponse): string | number {
  if (isPresent(input.unitId)) return toRequiredIdValue(input.unitId, 'unitId');
  const unit = findCategoryConfigItem(categoryConfig?.unitList, input, [], ['unitName'], 'unitId');
  if (unit?.id !== undefined && unit.id !== null) return toRequiredIdValue(unit.id, 'unitId');
  throw new ProductMcpError('MCP_INPUT_INVALID', 'unitId is required. Provide unitId or a unitName that exists in the selected category config.');
}

function normalizeSupplier(input: ProductCreateInput): Array<Record<string, unknown>> {
  if (input.suppliers?.length) {
    return input.suppliers.map((supplier, index) => ({
      ...supplier,
      id: toOptionalIdValue(supplier.id),
      supplierId: toRequiredIdValue(supplier.supplierId, `suppliers[${index}].supplierId`),
      supplierName: supplier.supplierName,
      productionCycle: toOptionalNumberValue(supplier.productionCycle, `suppliers[${index}].productionCycle`),
      cycleUnit: toOptionalNumberValue(supplier.cycleUnit, `suppliers[${index}].cycleUnit`),
      remark: supplier.remark
    }));
  }

  const supplier: Record<string, unknown> = {
    supplierId: toRequiredIdValue(input.supplierId, 'supplierId'),
    supplierName: input.supplierName
  };

  if (input.supplierProductionCycle !== undefined) {
    supplier.productionCycle = input.supplierProductionCycle;
    supplier.cycleUnit = input.supplierCycleUnit;
  }

  return [supplier];
}

function createMainImageMedia(input: ProductCreateInput): Record<string, unknown> | undefined {
  if (!input.productMainImageUrl) return undefined;
  return {
    mediaType: 1,
    imageCategory: 1,
    mediaName: input.productMainImageName || fileNameFromUrl(input.productMainImageUrl),
    mediaTitle: '',
    mediaSubtitle: '',
    mediaDesc: '',
    languageList: ['zh', 'en'],
    mediaUrl: input.productMainImageUrl,
    remark: '',
    sort: 1
  };
}

function normalizeMedias(input: ProductCreateInput): Array<Record<string, unknown>> {
  const medias: Array<Record<string, unknown>> = [];
  const mainImage = createMainImageMedia(input);
  if (mainImage) medias.push(mainImage);

  for (const media of input.medias || []) {
    const isDuplicateMainImage =
      mainImage &&
      media.mediaType === 1 &&
      media.imageCategory === 1 &&
      media.mediaUrl === mainImage.mediaUrl;
    if (isDuplicateMainImage) continue;

    const { id: _id, ...mediaWithoutId } = media;
    medias.push({
      ...mediaWithoutId,
      mediaName: media.mediaName || fileNameFromUrl(media.mediaUrl),
      sort: media.sort ?? medias.length + 1
    });
  }

  return medias;
}

function stripCreateId(row: Record<string, unknown>): Record<string, unknown> {
  const { id: _id, ...rest } = row;
  return rest;
}

function stripCreateIds(rows: Array<Record<string, unknown>> | undefined): Array<Record<string, unknown>> | undefined {
  if (!rows?.length) return undefined;
  return rows.map((row) => stripCreateId(row));
}

function normalizePartLists(input: ProductCreateInput, categoryConfig?: CategoryConfigResponse): Array<Record<string, unknown>> | undefined {
  if (!input.partLists?.length) return undefined;
  return input.partLists.map((row, index) => {
    const normalized = stripCreateId(row);
    if (!isPresent(normalized.unitId) && isPresent(normalized.unitName)) {
      const unit = findCategoryConfigItem(categoryConfig?.unitList, normalized, [], ['unitName'], `partLists[${index}].unitId`);
      if (unit?.id !== undefined && unit.id !== null) normalized.unitId = toStringId(unit.id);
      if (!normalized.unitName) normalized.unitName = itemLabel(unit || {});
    }
    return normalized;
  });
}

function normalizeCustomerCases(input: ProductCreateInput): Array<Record<string, unknown>> | undefined {
  if (!input.customerCases?.length) return undefined;
  return input.customerCases.map((row) => {
    const normalized = stripCreateId(row);
    if (Array.isArray(normalized.medias)) {
      normalized.medias = (normalized.medias as Array<Record<string, unknown>>).map((media) => stripCreateId(media));
    }
    return normalized;
  });
}

function addIfPresent(target: Record<string, unknown>, key: string, value: unknown): void {
  if (isPresent(value)) target[key] = value;
}

function mergePackageFields(target: Record<string, unknown>, source: Record<string, unknown> | undefined, prefix: string): void {
  if (!source) return;
  const textKeys = new Set(['palletInfo', 'cartonMark', 'stackingReq', 'moistureProofReq', 'waterproofReq', 'packingListTemplate']);
  for (const key of Object.keys(packageFieldSchemas)) {
    const value = source[key];
    if (textKeys.has(key)) {
      addIfPresent(target, key, value);
    } else {
      const fieldName = prefix ? `${prefix}.${key}` : key;
      addIfPresent(target, key, toNumberValue(value, fieldName));
    }
  }
}

function mergePackageInfo(target: Record<string, unknown>, packageInfo: ProductCreateInput['packageInfo']): void {
  mergePackageFields(target, packageInfo, 'packageInfo');
}

function normalizePriceTiers(priceTiers: ProductCreateInput['priceTiers']): Array<Record<string, unknown>> | undefined {
  if (!priceTiers?.length) return undefined;
  return priceTiers.map((tier, index) => ({
    minPriceQuantity: toNumberValue(tier.minPriceQuantity, `priceTiers[${index}].minPriceQuantity`),
    maxPriceQuantity: toNumberValue(tier.maxPriceQuantity, `priceTiers[${index}].maxPriceQuantity`),
    unitPrice: toNumberValue(tier.unitPrice, `priceTiers[${index}].unitPrice`),
    profitRate: toNumberValue(tier.profitRate, `priceTiers[${index}].profitRate`),
    minDeliveryDays: toNumberValue(tier.minDeliveryDays, `priceTiers[${index}].minDeliveryDays`),
    maxDeliveryDays: toNumberValue(tier.maxDeliveryDays, `priceTiers[${index}].maxDeliveryDays`)
  }));
}

function normalizeWarrantyPeriodUnit(value: ProductCreateInput['warrantyPeriodUnit']): number | undefined {
  if (value === 'month') return 1;
  if (value === 'year') return 2;
  return value;
}

function normalizeBaseConfigs(input: ProductCreateInput, categoryConfig?: CategoryConfigResponse): Array<Record<string, unknown>> | undefined {
  if (!input.baseConfigs?.length) return input.baseConfigs;
  return input.baseConfigs.map((row, index) => {
    const item = findCategoryConfigItem(
      categoryConfig?.baseList,
      row,
      ['categoryBaseId'],
      ['name'],
      `baseConfigs[${index}]`
    );
    return {
      ...row,
      categoryBaseId: item ? toStringId(item.id) : toOptionalIdValue(row.categoryBaseId),
      name: stringValue(row.name) || itemLabel(item || {}),
      configValue: stringValue(row.configValue),
      remark: row.remark
    };
  });
}

function normalizeTechnicalParams(input: ProductCreateInput, categoryConfig?: CategoryConfigResponse): Array<Record<string, unknown>> | undefined {
  if (!input.technicalParams?.length) return input.technicalParams;
  return input.technicalParams.map((row, index) => {
    const item = findCategoryConfigItem(
      categoryConfig?.fieldList,
      row,
      ['categoryBaseId'],
      ['name'],
      `technicalParams[${index}]`
    );
    return {
      ...row,
      categoryBaseId: item ? toStringId(item.id) : toOptionalIdValue(row.categoryBaseId),
      name: stringValue(row.name) || itemLabel(item || {}),
      paramValue: stringValue(row.paramValue),
      remark: row.remark
    };
  });
}

function normalizeOptionalConfigs(input: ProductCreateInput, categoryConfig?: CategoryConfigResponse): Array<Record<string, unknown>> | undefined {
  if (!input.optionalConfigs?.length) return input.optionalConfigs;
  return input.optionalConfigs.map((row, index) => {
    const config = findCategoryConfigItem(
      categoryConfig?.optionalList,
      row,
      ['categoryOptionalId'],
      ['name'],
      `optionalConfigs[${index}]`
    );
    if (!config) return row;

    const option = findOptionalConfigOption(config, row, index);
    return {
      ...row,
      categoryOptionalId: toStringId(config.id),
      name: itemLabel(config),
      categoryOptionalConfigId: option ? toStringId(option.id) : toOptionalIdValue(row.categoryOptionalConfigId),
      configValue: option ? itemLabel(option) : stringValue(row.configValue),
      priceDiffCny: toOptionalNumberValue(row.priceDiffCny ?? option?.priceDiffCny ?? option?.price, `optionalConfigs[${index}].priceDiffCny`),
      priceDiffUsd: toOptionalNumberValue(row.priceDiffUsd, `optionalConfigs[${index}].priceDiffUsd`),
      status: toOptionalNumberValue(row.status, `optionalConfigs[${index}].status`) ?? 0,
      remark: row.remark
    };
  });
}

function normalizeIndependentPkg(value: ProductCreateInput['independentPkg']): 0 | 1 | undefined {
  if (value === undefined) return undefined;
  return value === true || value === 1 || value === '1' ? 1 : 0;
}

function normalizeSkuList(input: ProductCreateInput): Array<Record<string, unknown>> | undefined {
  if (!input.skuList?.length) return undefined;
  return input.skuList.map((row, index) => ({
    ...row,
    id: toOptionalIdValue(row.id),
    skuId: toOptionalIdValue(row.skuId),
    skuCode: row.skuCode,
    skuModel: row.skuModel,
    pkgLength: toOptionalNumberValue(row.pkgLength, `skuList[${index}].pkgLength`),
    pkgWidth: toOptionalNumberValue(row.pkgWidth, `skuList[${index}].pkgWidth`),
    pkgHeight: toOptionalNumberValue(row.pkgHeight, `skuList[${index}].pkgHeight`),
    pkgVolume: toOptionalNumberValue(row.pkgVolume, `skuList[${index}].pkgVolume`),
    pkgWeight: toOptionalNumberValue(row.pkgWeight, `skuList[${index}].pkgWeight`),
    grossWeight: toOptionalNumberValue(row.grossWeight, `skuList[${index}].grossWeight`),
    pkgFee: toOptionalNumberValue(row.pkgFee, `skuList[${index}].pkgFee`)
  }));
}

function normalizeProductModel(input: ProductCreateInput): string | undefined {
  const value = input.productModel ?? input.spuModel;
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text || undefined;
}

function buildProductI18nList(input: ProductCreateInput): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [
    {
      langCode: 'zh',
      spuName: input.productNameCn,
      productName: input.productNameCn,
      unitName: input.unitName
    }
  ];

  if (isPresent(input.productNameEn)) {
    rows.push({
      langCode: 'en',
      spuName: input.productNameEn,
      productName: input.productNameEn,
      unitName: input.unitName
    });
  }

  return rows;
}

function buildRequestBody(input: ProductCreateInput, categoryConfig?: CategoryConfigResponse): Record<string, unknown> {
  const body: Record<string, unknown> = {
    ...(input.extraBody || {}),
    id: toOptionalIdValue(input.id),
    tenantId: input.tenantId,
    createBy: toOptionalIdValue(input.createBy),
    createDept: toOptionalIdValue(input.createDept),
    language: input.language || 'zh',
    commodityId: input.commodityId,
    productType: input.productType,
    level: input.level,
    status: input.status,
    unitId: normalizeUnitId(input, categoryConfig),
    unitName: input.unitName,
    productCode: input.productCode,
    hsCode: input.hsCode,
    productNameCn: input.productNameCn,
    productNameEn: input.productNameEn,
    spuName_zh: input.productNameCn,
    spuName_en: input.productNameEn,
    spuNameCn: input.productNameCn,
    spuNameEn: input.productNameEn,
    i18nList: buildProductI18nList(input),
    productModel: normalizeProductModel(input),
    brand: input.brand,
    remark: input.remark,
    relatedCommodityId: input.relatedCommodityId,
    categoryFirstId: toOptionalIdValue(input.categoryFirstId),
    categorySecondId: toOptionalIdValue(input.categorySecondId),
    categoryThirdId: toOptionalIdValue(input.categoryThirdId),
    usagePurpose: input.usagePurpose,
    supportConsolidation: input.supportConsolidation,
    canExhibit: input.canExhibit,
    needInstallation: input.needInstallation,
    hasAfterSalesThreshold: input.hasAfterSalesThreshold,
    supportSample: input.supportSample,
    samplePrice: toNumberValue(input.samplePrice, 'samplePrice'),
    taxRefundRate: toTaxRefundRate(input.taxRefundRate),
    independentPkg: normalizeIndependentPkg(input.independentPkg),
    skuList: normalizeSkuList(input),
    standardDeliveryDays: toNumberValue(input.standardDeliveryDays, 'standardDeliveryDays'),
    shortestDeliveryDays: toNumberValue(input.shortestDeliveryDays, 'shortestDeliveryDays'),
    urgentOrderDays: toNumberValue(input.urgentOrderDays, 'urgentOrderDays'),
    supportPartsAlone: input.supportPartsAlone,
    supportOem: input.supportOem,
    supportOdm: input.supportOdm,
    moq: toNumberValue(input.moq, 'moq'),
    warrantyPeriod: toNumberValue(input.warrantyPeriod, 'warrantyPeriod'),
    warrantyPeriodUnit: normalizeWarrantyPeriodUnit(input.warrantyPeriodUnit),
    supportSmallTrial: input.supportSmallTrial,
    minTrialQuantity: toNumberValue(input.minTrialQuantity, 'minTrialQuantity'),
    hasSpotStock: input.hasSpotStock,
    hasOverseasWarehouseStock: input.hasOverseasWarehouseStock,
    suggestedPrice: toNumberValue(input.suggestedPrice, 'suggestedPrice'),
    minPrice: toNumberValue(input.minPrice, 'minPrice'),
    referenceCostCny: toNumberValue(input.referenceCostCny, 'referenceCostCny'),
    referenceCostUsd: toNumberValue(input.referenceCostUsd, 'referenceCostUsd'),
    profitMargin: toNumberValue(input.profitMargin, 'profitMargin'),
    exFactoryPrice: toNumberValue(input.exFactoryPrice, 'exFactoryPrice'),
    specialCustomFee: toNumberValue(input.specialCustomFee, 'specialCustomFee'),
    clashSupport: input.clashSupport,
    rebateSupport: input.rebateSupport,
    rebateCondition: input.rebateCondition,
    rebateRate: toNumberValue(input.rebateRate, 'rebateRate'),
    priceTiers: normalizePriceTiers(input.priceTiers),
    isInnerTreasury: input.isInnerTreasury,
    externalAddress: input.externalAddress,
    externalStatus: input.externalStatus,
    proofreadStatus: input.proofreadStatus,
    skipTranslation: input.skipTranslation,
    tags: normalizeTags(input.tags),
    regions: normalizeRegions(input),
    suppliers: normalizeSupplier(input),
    baseConfigs: normalizeBaseConfigs(input, categoryConfig),
    technicalParams: normalizeTechnicalParams(input, categoryConfig),
    optionalConfigs: normalizeOptionalConfigs(input, categoryConfig),
    partLists: normalizePartLists(input, categoryConfig),
    medias: normalizeMedias(input),
    certifications: stripCreateIds(input.certifications),
    salesSupports: stripCreateIds(input.salesSupports),
    competitors: input.competitors,
    customerCases: normalizeCustomerCases(input)
  };

  mergePackageInfo(body, input.packageInfo);
  mergePackageFields(body, input as Record<string, unknown>, '');

  return body;
}

function findId(value: unknown): string | undefined {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (!value || typeof value !== 'object') return undefined;

  const record = value as Record<string, unknown>;
  for (const key of ['id', 'productId', 'commodityId', 'spuId']) {
    const candidate = record[key];
    if (typeof candidate === 'string' || typeof candidate === 'number') return String(candidate);
  }

  return findId(record.data);
}

export async function productCreate(backend: BackendClient, rawInput: unknown, requestId: string) {
  const input = productCreateObjectSchema.parse(rawInput);
  const validationIssues = [
    ...(input.previewOnly || input.confirm === true
      ? []
      : [
          {
            code: 'CONFIRM_REQUIRED',
            message: 'product_create 会创建真实商品；除 previewOnly=true 外必须传入 confirm=true。',
            section: '创建确认',
            field: 'confirm'
          }
        ]),
    ...validateFrontendAlignedSubmission(input as unknown as Record<string, unknown>),
    ...validateResolvedUploads(input as unknown as Record<string, unknown>)
  ];
  throwValidationIssues('商品创建参数未通过前端硬拦截校验。', validationIssues);
  await validateCategorySelection(backend, input);
  const needsUnitLookup = (!isPresent(input.unitId) && isPresent(input.unitName)) ||
    Boolean(input.partLists?.some((row) => !isPresent(row.unitId) && isPresent(row.unitName)));
  const needsCategoryConfig = Boolean(
    needsUnitLookup || input.baseConfigs?.length || input.technicalParams?.length || input.optionalConfigs?.length
  );
  const categoryConfigId = input.categoryThirdId || input.categorySecondId || input.categoryFirstId;
  const categoryConfig = needsCategoryConfig && isPresent(categoryConfigId)
    ? await backend.get<CategoryConfigResponse>('/user/erp/productCategory/configList', {
        categoryId: categoryConfigId
      })
    : undefined;
  const body = buildRequestBody(input, categoryConfig);
  const submissionPreview = buildSubmissionPreview(input as unknown as Record<string, unknown>, body);
  const fieldCoverage = buildFieldCoverage(input as unknown as Record<string, unknown>, {
    knownTopLevelFields: Object.keys(productCreateInputSchema)
  });
  const previewTrace = buildProtocolTrace('product_create', requestId, [
    {
      name: 'validate_input',
      ok: true,
      counts: {
        validationIssues: 0
      }
    },
    {
      name: 'resolve_category_config',
      ok: true,
      summary: categoryConfig ? 'Category config loaded for ID/name normalization.' : 'Category config was not required.',
      counts: {
        baseConfigs: input.baseConfigs?.length || 0,
        technicalParams: input.technicalParams?.length || 0,
        optionalConfigs: input.optionalConfigs?.length || 0
      }
    },
    {
      name: 'build_submission_preview',
      ok: true,
      counts: submissionPreview.counts
    }
  ]);

  if (input.previewOnly) {
    return {
      ok: true as const,
      previewOnly: true,
      requestId,
      clientRequestId: input.clientRequestId,
      submissionPreview,
      fieldCoverage,
      actionableIssues: toActionableIssues([]),
      trace: previewTrace,
      note: 'previewOnly=true, no ERP create API call was made.'
    };
  }

  const response = await backend.post<ProductCreateResponse>('/user/erp/commodity', body);
  const id = findId(response);

  return {
    ok: true as const,
    id,
    productId: id,
    frontendEditPath: id ? `/erp/commodity/editCommodity/${id}` : undefined,
    frontendViewPath: id ? `/erp/commodity/viewCommodity/${id}` : undefined,
    requestId,
    clientRequestId: input.clientRequestId,
    submissionPreview,
    fieldCoverage,
    trace: buildProtocolTrace('product_create', requestId, [
      ...previewTrace.stages,
      {
        name: 'post_create',
        ok: true,
        summary: id ? `Created product ${id}.` : 'Backend returned success without a discoverable product id.'
      }
    ]),
    warning: id ? undefined : 'Backend returned success but product id was not found in the response. Verify the product list before retrying.',
    backendResponse: response
  };
}

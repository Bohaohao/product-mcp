import * as z from 'zod/v4';
import type { BackendClient } from '../backendClient.js';
import { ProductMcpError } from '../errors.js';

const idSchema = z.union([z.string().trim().min(1), z.number()]);
const optionalIdSchema = idSchema.optional();
const scalarSchema = z.union([z.string(), z.number(), z.boolean()]).optional();
const numberLikeSchema = z.union([z.number(), z.string().trim().min(1)]).optional();
const zeroOneSchema = z.union([z.literal(0), z.literal(1)]);
const objectArraySchema = z.array(z.record(z.string(), z.any())).optional();

const regionSchema = z.object({
  regionId: optionalIdSchema,
  regionName: z.string().trim().optional(),
  isAll: z.union([z.literal(0), z.literal(1)]).optional(),
  customerType: z.union([z.string(), z.array(z.string())]).optional(),
  originPlace: z.string().trim().optional(),
  sortNo: z.number().int().positive().optional()
});

const mediaSchema = z.object({
  mediaType: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  mediaUrl: z.string().trim().min(1),
  mediaName: z.string().trim().optional(),
  mediaTitle: z.string().optional(),
  mediaSubtitle: z.string().optional(),
  mediaDesc: z.string().optional(),
  imageCategory: z.number().int().positive().optional(),
  videoCategory: z.number().int().positive().optional(),
  otherCategory: z.number().int().positive().optional(),
  languageList: z.array(z.enum(['zh', 'en'])).optional(),
  sort: z.number().int().positive().optional(),
  remark: z.string().optional(),
  duration: z.number().nonnegative().optional()
});

const packageInfoSchema = z.object({
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
});

const priceTierSchema = z.object({
  minPriceQuantity: numberLikeSchema,
  maxPriceQuantity: numberLikeSchema,
  unitPrice: numberLikeSchema,
  profitRate: numberLikeSchema,
  minDeliveryDays: numberLikeSchema,
  maxDeliveryDays: numberLikeSchema
});

export const productCreateInputSchema = {
  confirm: z.literal(true).describe('Required confirmation. This tool creates a real product.'),
  clientRequestId: z.string().trim().max(100).optional(),

  productNameCn: z.string().trim().min(1).describe('Product Chinese name.'),
  productNameEn: z.string().trim().min(1).describe('Product English name.'),
  productType: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(1).describe('1=whole machine, 2=part, 3=service.'),
  status: z.union([z.literal(1), z.literal(2)]).default(1).describe('1=on shelf, 2=off shelf. Creating status=3 is not allowed.'),
  level: scalarSchema,

  categoryFirstId: idSchema,
  categorySecondId: optionalIdSchema,
  categoryThirdId: optionalIdSchema,
  unitId: idSchema,
  unitName: z.string().trim().optional(),

  supplierId: idSchema,
  supplierName: z.string().trim().optional(),
  supplierProductionCycle: z.number().int().positive().optional(),
  supplierCycleUnit: z.number().int().positive().optional(),

  useAllRegions: z.boolean().default(false).describe('When true, create one global region row.'),
  regions: z.array(regionSchema).optional(),

  productMainImageUrl: z.string().trim().min(1).optional(),
  productMainImageName: z.string().trim().optional(),
  medias: z.array(mediaSchema).optional(),

  productCode: z.string().trim().optional(),
  commodityId: z.number().int().positive().optional(),
  hsCode: z.string().trim().optional(),
  productModel: z.string().trim().optional(),
  brand: z.string().trim().optional(),
  remark: z.string().optional(),
  usagePurpose: z.string().trim().optional(),
  supportConsolidation: zeroOneSchema.default(0),
  canExhibit: zeroOneSchema.default(0),
  needInstallation: zeroOneSchema.default(0),
  hasAfterSalesThreshold: zeroOneSchema.default(0),
  supportSample: zeroOneSchema.default(0),
  samplePrice: numberLikeSchema,
  taxRefundRate: numberLikeSchema,

  standardDeliveryDays: numberLikeSchema,
  shortestDeliveryDays: numberLikeSchema,
  urgentOrderDays: numberLikeSchema,
  supportPartsAlone: zeroOneSchema.default(0),
  supportOem: zeroOneSchema.default(0),
  supportOdm: zeroOneSchema.default(0),
  moq: numberLikeSchema,
  warrantyPeriod: numberLikeSchema,
  warrantyPeriodUnit: z.union([z.literal(1), z.literal(2), z.literal('month'), z.literal('year')]).optional(),
  supportSmallTrial: zeroOneSchema.default(0),
  minTrialQuantity: numberLikeSchema,
  hasSpotStock: zeroOneSchema.default(0),
  hasOverseasWarehouseStock: zeroOneSchema.default(0),

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

  packageInfo: packageInfoSchema.optional(),
  tags: z.array(z.union([z.string().trim().min(1), z.object({ tagName: z.string().trim().min(1) })])).optional(),
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
  baseList?: CategoryConfigItem[];
  fieldList?: CategoryConfigItem[];
  optionalList?: CategoryConfigItem[];
  [key: string]: unknown;
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

function normalizeRegions(input: ProductCreateInput): Array<Record<string, unknown>> {
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
    throw new ProductMcpError(
      'MCP_INPUT_INVALID',
      'product_create requires either useAllRegions=true or at least one regions item.'
    );
  }

  return regions.map((region, index) => {
    const isAll = region.isAll ?? 0;
    return {
      originPlace: region.originPlace,
      customerType: toCsv(region.customerType),
      isAll,
      regionId: isAll === 1 ? toOptionalIdValue(region.regionId) ?? '' : toRequiredIdValue(region.regionId, `regions[${index}].regionId`),
      regionName: region.regionName,
      sortNo: region.sortNo ?? index + 1
    };
  });
}

function normalizeTags(tags: ProductCreateInput['tags']): Array<{ tagName: string }> {
  return (tags || []).map((tag) => (typeof tag === 'string' ? { tagName: tag } : { tagName: tag.tagName }));
}

function normalizeSupplier(input: ProductCreateInput): Array<Record<string, unknown>> {
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

    medias.push({
      ...media,
      mediaName: media.mediaName || fileNameFromUrl(media.mediaUrl),
      sort: media.sort ?? medias.length + 1
    });
  }

  return medias;
}

function addIfPresent(target: Record<string, unknown>, key: string, value: unknown): void {
  if (isPresent(value)) target[key] = value;
}

function mergePackageInfo(target: Record<string, unknown>, packageInfo: ProductCreateInput['packageInfo']): void {
  if (!packageInfo) return;
  const textKeys = new Set(['palletInfo', 'cartonMark', 'stackingReq', 'moistureProofReq', 'waterproofReq', 'packingListTemplate']);
  for (const [key, value] of Object.entries(packageInfo)) {
    if (textKeys.has(key)) {
      addIfPresent(target, key, value);
    } else {
      addIfPresent(target, key, toNumberValue(value, `packageInfo.${key}`));
    }
  }
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

function buildProductI18nList(input: ProductCreateInput): Array<Record<string, unknown>> {
  return [
    {
      langCode: 'zh',
      spuName: input.productNameCn,
      productName: input.productNameCn,
      unitName: input.unitName
    },
    {
      langCode: 'en',
      spuName: input.productNameEn,
      productName: input.productNameEn,
      unitName: input.unitName
    }
  ];
}

function buildRequestBody(input: ProductCreateInput, categoryConfig?: CategoryConfigResponse): Record<string, unknown> {
  const body: Record<string, unknown> = {
    ...(input.extraBody || {}),
    language: 'zh',
    commodityId: input.commodityId,
    productType: input.productType,
    level: input.level,
    status: input.status,
    unitId: toRequiredIdValue(input.unitId, 'unitId'),
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
    productModel: input.productModel,
    brand: input.brand,
    remark: input.remark,
    categoryFirstId: toRequiredIdValue(input.categoryFirstId, 'categoryFirstId'),
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
    partLists: input.partLists,
    medias: normalizeMedias(input),
    certifications: input.certifications,
    salesSupports: input.salesSupports,
    competitors: input.competitors,
    customerCases: input.customerCases
  };

  mergePackageInfo(body, input.packageInfo);

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
  const needsCategoryConfig = Boolean(input.baseConfigs?.length || input.technicalParams?.length || input.optionalConfigs?.length);
  const categoryConfig = needsCategoryConfig
    ? await backend.get<CategoryConfigResponse>('/user/erp/productCategory/configList', {
        categoryId: input.categoryThirdId || input.categorySecondId || input.categoryFirstId
      })
    : undefined;
  const body = buildRequestBody(input, categoryConfig);
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
    warning: id ? undefined : 'Backend returned success but product id was not found in the response. Verify the product list before retrying.',
    backendResponse: response
  };
}

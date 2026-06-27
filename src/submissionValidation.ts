import { ProductMcpError } from './errors.js';

export interface SubmissionValidationIssue {
  code: string;
  message: string;
  section?: string;
  row?: number;
  field?: string;
}

type UnknownRecord = Record<string, unknown>;

interface FrontendValidationOptions {
  allowReferenceNames?: boolean;
  skipCertificationValidation?: boolean;
  skipMediaValidation?: boolean;
  skipSalesValidation?: boolean;
}

function hasValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  return true;
}

function stringValue(value: unknown): string | undefined {
  if (!hasValue(value)) return undefined;
  const text = String(value).trim();
  return text || undefined;
}

function numberValue(value: unknown): number | undefined {
  if (!hasValue(value)) return undefined;
  const parsed = typeof value === 'number' ? value : Number(String(value).trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeFlag(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

function productTypeValue(input: UnknownRecord): number | undefined {
  const parsed = numberValue(input.productType);
  return parsed === undefined ? undefined : parsed;
}

function addIssue(
  issues: SubmissionValidationIssue[],
  code: string,
  message: string,
  section?: string,
  row?: number,
  field?: string
): void {
  issues.push({ code, message, section, row, field });
}

function rowHasAnyValue(row: UnknownRecord | undefined, fields: string[]): boolean {
  if (!row) return false;
  return fields.some((field) => hasValue(row[field]));
}

function rawOptionalText(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return String(value);
}

function validateProductModel(input: UnknownRecord, issues: SubmissionValidationIssue[]): void {
  for (const field of ['productModel', 'spuModel']) {
    const value = rawOptionalText(input[field]);
    if (value === undefined) continue;
    if (value !== value.trim() || /[\u4e00-\u9fa5]/.test(value) || /[^A-Za-z0-9 ]/.test(value)) {
      addIssue(
        issues,
        'PRODUCT_MODEL_FORMAT_INVALID',
        `${field} 仅支持英文大小写、数字和空格，且不能有首尾空格、中文或特殊符号。`,
        '基础信息',
        undefined,
        field
      );
    }
  }
}

function validateReferences(input: UnknownRecord, issues: SubmissionValidationIssue[], options: FrontendValidationOptions): void {
  const hasFirstCategory = hasValue(input.categoryFirstId) || (options.allowReferenceNames && hasValue(input.categoryFirstName));
  if (!hasFirstCategory) {
    addIssue(issues, 'CATEGORY_FIRST_REQUIRED', '一级分类必填。', '分类、单位、供应商', undefined, 'categoryFirstId');
  }

  const suppliers = Array.isArray(input.suppliers) ? (input.suppliers as UnknownRecord[]) : [];
  const hasSupplier =
    suppliers.some((supplier) => hasValue(supplier.supplierId) || (options.allowReferenceNames && hasValue(supplier.supplierName))) ||
    hasValue(input.supplierId) ||
    (options.allowReferenceNames && hasValue(input.supplierName));
  if (!hasSupplier) {
    addIssue(issues, 'SUPPLIER_REQUIRED', '供应商必填。', '分类、单位、供应商', undefined, 'suppliers');
  }
}

function validateRegions(input: UnknownRecord, issues: SubmissionValidationIssue[], options: FrontendValidationOptions): void {
  if (input.useAllRegions === true) return;
  const regions = Array.isArray(input.regions) ? (input.regions as UnknownRecord[]) : [];
  if (!regions.length) {
    addIssue(issues, 'REGION_REQUIRED', '适用范围/适用区域必填；可使用 useAllRegions=true 表示全球。', '适用区域', undefined, 'regions');
    return;
  }

  regions.forEach((region, index) => {
    if (normalizeFlag(region.isAll)) return;
    const hasRegionRef = hasValue(region.regionId) || (options.allowReferenceNames && hasValue(region.regionName));
    if (!hasRegionRef) {
      addIssue(
        issues,
        'REGION_ID_REQUIRED',
        `适用区域第 ${index + 1} 行必须有 regionId${options.allowReferenceNames ? ' 或区域名称' : ''}。`,
        '适用区域',
        index + 1,
        'regions'
      );
    }
  });
}

function detectMainImage(input: UnknownRecord): boolean {
  if (stringValue(input.productMainImageUrl)) return true;
  const medias = Array.isArray(input.medias) ? (input.medias as UnknownRecord[]) : [];
  return medias.some(
    (media) =>
      numberValue(media.mediaType) === 1 &&
      numberValue(media.imageCategory) === 1 &&
      Boolean(stringValue(media.mediaUrl))
  );
}

function validateSamplePrice(input: UnknownRecord, issues: SubmissionValidationIssue[]): void {
  const samplePrice = input.samplePrice;
  if (!hasValue(samplePrice)) return;
  const parsed = numberValue(samplePrice);
  if (parsed === undefined || parsed <= 0) {
    addIssue(
      issues,
      'SAMPLE_PRICE_INVALID',
      '样品价填写后必须大于 0。',
      '销售、交付、售后',
      undefined,
      'samplePrice'
    );
  }
}

function valueFromPackage(input: UnknownRecord, field: string): unknown {
  if (hasValue(input[field])) return input[field];
  const packageInfo = input.packageInfo;
  if (packageInfo && typeof packageInfo === 'object') {
    return (packageInfo as UnknownRecord)[field];
  }
  return undefined;
}

function validateRequiredPositiveField(
  input: UnknownRecord,
  issues: SubmissionValidationIssue[],
  field: string,
  label: string,
  code: string
): void {
  const value = valueFromPackage(input, field);
  const parsed = numberValue(value);
  if (!hasValue(value) || parsed === undefined || parsed <= 0) {
    addIssue(issues, code, `${label}必填，且必须为大于 0 的数字。`, '包装与物流', undefined, field);
  }
}

function validateRequiredNonNegativeField(
  input: UnknownRecord,
  issues: SubmissionValidationIssue[],
  field: string,
  label: string,
  code: string
): void {
  const value = valueFromPackage(input, field);
  const parsed = numberValue(value);
  if (!hasValue(value) || parsed === undefined || parsed < 0) {
    addIssue(issues, code, `${label}必填，且必须为不小于 0 的数字。`, '包装与物流', undefined, field);
  }
}

function validateUnifiedPackage(input: UnknownRecord, issues: SubmissionValidationIssue[]): void {
  const productType = productTypeValue(input);
  if (productType !== 1 && productType !== 2) return;
  if (normalizeFlag(input.independentPkg)) return;

  validateRequiredPositiveField(input, issues, 'packLength', '包装长 mm', 'PACKAGE_LENGTH_REQUIRED');
  validateRequiredPositiveField(input, issues, 'packWidth', '包装宽 mm', 'PACKAGE_WIDTH_REQUIRED');
  validateRequiredPositiveField(input, issues, 'packHeight', '包装高 mm', 'PACKAGE_HEIGHT_REQUIRED');
  validateRequiredNonNegativeField(input, issues, 'packingFee', '包装费', 'PACKAGE_FEE_REQUIRED');
  validateRequiredNonNegativeField(input, issues, 'packWeight', '包装重量 kg', 'PACKAGE_WEIGHT_REQUIRED');
  validateRequiredNonNegativeField(input, issues, 'netWeight', '净重 kg', 'NET_WEIGHT_REQUIRED');
}

function validateWholeMachineConfig(input: UnknownRecord, issues: SubmissionValidationIssue[]): void {
  if (productTypeValue(input) !== 1) return;
  const requiredFields = [
    ['level', '产品等级', 'PRODUCT_LEVEL_REQUIRED'],
    ['referenceCostCny', '参考成本价（人民币）', 'REFERENCE_COST_CNY_REQUIRED'],
    ['profitMargin', '利润率', 'PROFIT_MARGIN_REQUIRED']
  ] as const;
  for (const [field, label, code] of requiredFields) {
    if (!hasValue(input[field])) {
      addIssue(issues, code, `整机商品必须填写${label}。`, '商品配置', undefined, field);
    }
  }

  const baseConfigs = Array.isArray(input.baseConfigs) ? (input.baseConfigs as UnknownRecord[]) : [];
  if (!baseConfigs.length) {
    addIssue(issues, 'BASE_CONFIG_REQUIRED', '整机商品至少需要填写一行基础配置。', '商品配置', undefined, 'baseConfigs');
  }
  baseConfigs.forEach((row, index) => {
    if (!hasValue(row.configValue)) {
      addIssue(issues, 'BASE_CONFIG_VALUE_REQUIRED', `基础配置第 ${index + 1} 行必须填写配置值。`, '商品配置', index + 1, 'baseConfigs');
    }
  });

  const technicalParams = Array.isArray(input.technicalParams) ? (input.technicalParams as UnknownRecord[]) : [];
  technicalParams.forEach((row, index) => {
    if (!hasValue(row.paramValue)) {
      addIssue(issues, 'TECHNICAL_PARAM_VALUE_REQUIRED', `技术参数第 ${index + 1} 行必须填写参数值。`, '商品配置', index + 1, 'technicalParams');
    }
  });
}

function validateTags(input: UnknownRecord, issues: SubmissionValidationIssue[]): void {
  const tags = Array.isArray(input.tags) ? input.tags : [];
  if (tags.length > 10) {
    addIssue(issues, 'TAGS_COUNT_EXCEEDED', '商品标签最多 10 个。', '基础信息', undefined, 'tags');
  }

  tags.forEach((tag, index) => {
    const tagName =
      typeof tag === 'string' ? stringValue(tag) : tag && typeof tag === 'object' ? stringValue((tag as UnknownRecord).tagName) : undefined;
    if (tagName && tagName.length > 10) {
      addIssue(
        issues,
        'TAG_NAME_TOO_LONG',
        `商品标签第 ${index + 1} 项长度不能超过 10 个字符。`,
        '基础信息',
        index + 1,
        'tags'
      );
    }
  });
}

function validatePartLists(input: UnknownRecord, issues: SubmissionValidationIssue[]): void {
  const rows = Array.isArray(input.partLists) ? (input.partLists as UnknownRecord[]) : [];
  rows.forEach((row, index) => {
    const rowNumber = index + 1;
    const hasContent = rowHasAnyValue(row, ['partName', 'specAttr', 'costPrice', 'suggestedPrice', 'suggestedStock', 'unitName']);
    if (!hasContent) return;

    if (!hasValue(row.partName)) {
      addIssue(issues, 'PART_NAME_REQUIRED', `配件第 ${rowNumber} 行必须填写名称。`, '配件、备件、易损件', rowNumber, 'partLists');
    }
    if (!hasValue(row.specAttr)) {
      addIssue(issues, 'PART_MODEL_REQUIRED', `配件第 ${rowNumber} 行必须填写规格属性。`, '配件、备件、易损件', rowNumber, 'partLists');
    }

    const costPrice = numberValue(row.costPrice);
    if (!hasValue(row.costPrice) || costPrice === undefined || costPrice <= 0) {
      addIssue(issues, 'PART_COST_PRICE_INVALID', `配件第 ${rowNumber} 行成本价必须为正数。`, '配件、备件、易损件', rowNumber, 'partLists');
    }

    const suggestedPrice = numberValue(row.suggestedPrice);
    if (!hasValue(row.suggestedPrice) || suggestedPrice === undefined || suggestedPrice <= 0) {
      addIssue(issues, 'PART_SUGGESTED_PRICE_INVALID', `配件第 ${rowNumber} 行建议售价必须为正数。`, '配件、备件、易损件', rowNumber, 'partLists');
    }

    const suggestedStock = numberValue(row.suggestedStock);
    if (
      !hasValue(row.suggestedStock) ||
      suggestedStock === undefined ||
      suggestedStock < 0 ||
      !Number.isInteger(suggestedStock)
    ) {
      addIssue(
        issues,
        'PART_SUGGESTED_STOCK_INVALID',
        `配件第 ${rowNumber} 行建议库存必须为不小于 0 的整数。`,
        '配件、备件、易损件',
        rowNumber,
        'partLists'
      );
    }

    if (!hasValue(row.unitName)) {
      addIssue(issues, 'PART_UNIT_REQUIRED', `配件第 ${rowNumber} 行必须填写单位。`, '配件、备件、易损件', rowNumber, 'partLists');
    }
  });
}

function validatePositiveNumber(
  row: UnknownRecord,
  issues: SubmissionValidationIssue[],
  field: string,
  code: string,
  label: string,
  rowNumber: number
): void {
  const parsed = numberValue(row[field]);
  if (!hasValue(row[field]) || parsed === undefined || parsed <= 0) {
    addIssue(issues, code, `SKU 第 ${rowNumber} 行${label}必须为大于 0 的数字。`, 'SKU 包装', rowNumber, `skuList.${field}`);
  }
}

function validateNonNegativeNumber(
  row: UnknownRecord,
  issues: SubmissionValidationIssue[],
  field: string,
  code: string,
  label: string,
  rowNumber: number
): void {
  const parsed = numberValue(row[field]);
  if (!hasValue(row[field]) || parsed === undefined || parsed < 0) {
    addIssue(issues, code, `SKU 第 ${rowNumber} 行${label}必须为不小于 0 的数字。`, 'SKU 包装', rowNumber, `skuList.${field}`);
  }
}

function validateSkuPackages(input: UnknownRecord, issues: SubmissionValidationIssue[]): void {
  if (!normalizeFlag(input.independentPkg) && !Array.isArray(input.skuList)) return;

  const rows = Array.isArray(input.skuList) ? (input.skuList as UnknownRecord[]) : [];
  if (!rows.length) {
    addIssue(issues, 'SKU_LIST_REQUIRED', '启用独立 SKU 包装时，skuList 至少需要 1 行。', 'SKU 包装', undefined, 'skuList');
    return;
  }

  rows.forEach((row, index) => {
    const rowNumber = index + 1;
    validatePositiveNumber(row, issues, 'pkgLength', 'SKU_PACKAGE_LENGTH_REQUIRED', '包装长', rowNumber);
    validatePositiveNumber(row, issues, 'pkgWidth', 'SKU_PACKAGE_WIDTH_REQUIRED', '包装宽', rowNumber);
    validatePositiveNumber(row, issues, 'pkgHeight', 'SKU_PACKAGE_HEIGHT_REQUIRED', '包装高', rowNumber);
    validateNonNegativeNumber(row, issues, 'grossWeight', 'SKU_GROSS_WEIGHT_REQUIRED', '毛重', rowNumber);
    validateNonNegativeNumber(row, issues, 'pkgWeight', 'SKU_PACKAGE_WEIGHT_REQUIRED', '净重', rowNumber);
    validateNonNegativeNumber(row, issues, 'pkgFee', 'SKU_PACKAGE_FEE_REQUIRED', '包装费', rowNumber);
  });
}

function validateMedias(input: UnknownRecord, issues: SubmissionValidationIssue[]): void {
  if (!detectMainImage(input)) {
    addIssue(issues, 'PRODUCT_MAIN_IMAGE_REQUIRED', '商品主图必填。', '商品图片');
  }
}

function validateCertifications(input: UnknownRecord, issues: SubmissionValidationIssue[]): void {
  const rows = Array.isArray(input.certifications) ? (input.certifications as UnknownRecord[]) : [];
  rows.forEach((row, index) => {
    const rowNumber = index + 1;
    const hasContent = rowHasAnyValue(row, [
      'fileCategory',
      'name',
      'certificateType',
      'certificateNo',
      'fileUrl',
      'mainImageUrl',
      'coverRegions',
      'coverRegionIds',
      'effectiveDate',
      'expiryDate',
      'isPermanent'
    ]);
    if (!hasContent) return;

    if (!hasValue(row.fileCategory)) {
      addIssue(issues, 'CERT_FILE_CATEGORY_REQUIRED', `认证资料第 ${rowNumber} 行必须填写文件分类。`, '认证资料', rowNumber, 'certifications');
    }
    if (!hasValue(row.fileUrl)) {
      addIssue(issues, 'CERT_FILE_REQUIRED', `认证资料第 ${rowNumber} 行必须上传证书文件。`, '认证资料', rowNumber, 'certifications');
    }
    if (!hasValue(row.mainImageUrl)) {
      addIssue(issues, 'CERT_MAIN_IMAGE_REQUIRED', `认证资料第 ${rowNumber} 行必须上传主图。`, '认证资料', rowNumber, 'certifications');
    }
    if (!hasValue(row.name)) {
      addIssue(issues, 'CERT_NAME_REQUIRED', `认证资料第 ${rowNumber} 行必须填写证书名称。`, '认证资料', rowNumber, 'certifications');
    }
    if (!hasValue(row.certificateType)) {
      addIssue(issues, 'CERT_TYPE_REQUIRED', `认证资料第 ${rowNumber} 行必须填写证书类型。`, '认证资料', rowNumber, 'certifications');
    }
    if (!hasValue(row.coverRegions) && !hasValue(row.coverRegionIds)) {
      addIssue(issues, 'CERT_REGION_REQUIRED', `认证资料第 ${rowNumber} 行必须填写覆盖区域。`, '认证资料', rowNumber, 'certifications');
    }
    if (!hasValue(row.certificateNo)) {
      addIssue(issues, 'CERT_NO_REQUIRED', `认证资料第 ${rowNumber} 行必须填写证书编号。`, '认证资料', rowNumber, 'certifications');
    }

    const isPermanent = normalizeFlag(row.isPermanent);
    if (!isPermanent) {
      const effectiveDate = stringValue(row.effectiveDate);
      const expiryDate = stringValue(row.expiryDate);
      if (!effectiveDate) {
        addIssue(issues, 'CERT_EFFECTIVE_DATE_REQUIRED', `认证资料第 ${rowNumber} 行必须填写生效日期。`, '认证资料', rowNumber, 'certifications');
      }
      if (!expiryDate) {
        addIssue(issues, 'CERT_EXPIRY_DATE_REQUIRED', `认证资料第 ${rowNumber} 行必须填写到期日期。`, '认证资料', rowNumber, 'certifications');
      }
      if (effectiveDate && expiryDate) {
        const effectiveTime = Date.parse(effectiveDate);
        const expiryTime = Date.parse(expiryDate);
        if (Number.isFinite(effectiveTime) && Number.isFinite(expiryTime) && expiryTime <= effectiveTime) {
          addIssue(
            issues,
            'CERT_DATE_ORDER_INVALID',
            `认证资料第 ${rowNumber} 行到期日期必须晚于生效日期。`,
            '认证资料',
            rowNumber,
            'certifications'
          );
        }
      }
    }
  });
}

function validateSalesSupports(input: UnknownRecord, issues: SubmissionValidationIssue[]): void {
  const rows = Array.isArray(input.salesSupports) ? (input.salesSupports as UnknownRecord[]) : [];
  rows.forEach((row, index) => {
    const rowNumber = index + 1;
    const type = numberValue(row.type);
    if (type === 2 || type === 3) {
      const hasContent = rowHasAnyValue(row, ['title', 'content', 'fileUrl']);
      if (!hasContent) return;
      if (!hasValue(row.title) || !hasValue(row.content) || !hasValue(row.fileUrl)) {
        addIssue(
          issues,
          'SALES_IMAGE_TEXT_ROW_INCOMPLETE',
          `销售支持第 ${rowNumber} 行（图文类）必须同时填写标题、内容、文件。`,
          '销售支持',
          rowNumber,
          'salesSupports'
        );
      }
      return;
    }

    if (type === 4 || type === 5) {
      const hasContent = rowHasAnyValue(row, ['title', 'content']);
      if (!hasContent) return;
      if (!hasValue(row.title) || !hasValue(row.content)) {
        addIssue(
          issues,
          'SALES_QA_ROW_INCOMPLETE',
          `销售支持第 ${rowNumber} 行必须同时填写标题和内容。`,
          '销售支持',
          rowNumber,
          'salesSupports'
        );
      }
    }
  });

  const competitors = Array.isArray(input.competitors) ? (input.competitors as UnknownRecord[]) : [];
  competitors.forEach((row, index) => {
    const rowNumber = index + 1;
    const hasContent = rowHasAnyValue(row, ['dimensionName', 'ourProductValue', 'competitorValue']);
    if (!hasContent) return;
    if (!hasValue(row.dimensionName) || !hasValue(row.ourProductValue) || !hasValue(row.competitorValue)) {
      addIssue(
        issues,
        'COMPETITOR_ROW_INCOMPLETE',
        `竞品对比第 ${rowNumber} 行必须同时填写对比维度、我方产品值、竞品值。`,
        '竞品对比',
        rowNumber,
        'competitors'
      );
    }
  });

  const customerCases = Array.isArray(input.customerCases) ? (input.customerCases as UnknownRecord[]) : [];
  customerCases.forEach((row, index) => {
    const rowNumber = index + 1;
    const medias = Array.isArray(row.medias) ? (row.medias as UnknownRecord[]) : [];
    const hasContent =
      rowHasAnyValue(row, ['productName', 'customerName', 'purchaseQuantity', 'applicationScene', 'caseHighlight']) || medias.length > 0;
    if (!hasContent) return;

    const imageCount = medias.filter(
      (media) => numberValue(media.mediaType) === 1 && Boolean(stringValue(media.mediaUrl))
    ).length;
    if (imageCount === 0) {
      addIssue(
        issues,
        'CUSTOMER_CASE_IMAGE_REQUIRED',
        `客户案例第 ${rowNumber} 行至少需要 1 张图片。`,
        '客户案例',
        rowNumber,
        'customerCases'
      );
    }
    if (!hasValue(row.productName)) {
      addIssue(issues, 'CUSTOMER_CASE_PRODUCT_REQUIRED', `客户案例第 ${rowNumber} 行必须填写产品名称。`, '客户案例', rowNumber, 'customerCases');
    }
    if (!hasValue(row.customerName)) {
      addIssue(issues, 'CUSTOMER_CASE_CUSTOMER_REQUIRED', `客户案例第 ${rowNumber} 行必须填写客户名称。`, '客户案例', rowNumber, 'customerCases');
    }
    const quantity = numberValue(row.purchaseQuantity);
    if (!hasValue(row.purchaseQuantity) || quantity === undefined || quantity <= 0 || !Number.isInteger(quantity)) {
      addIssue(
        issues,
        'CUSTOMER_CASE_QUANTITY_INVALID',
        `客户案例第 ${rowNumber} 行采购数量必须为正整数。`,
        '客户案例',
        rowNumber,
        'customerCases'
      );
    }
    if (!hasValue(row.applicationScene)) {
      addIssue(issues, 'CUSTOMER_CASE_SCENE_REQUIRED', `客户案例第 ${rowNumber} 行必须填写应用场景。`, '客户案例', rowNumber, 'customerCases');
    }
    if (!hasValue(row.caseHighlight)) {
      addIssue(issues, 'CUSTOMER_CASE_HIGHLIGHT_REQUIRED', `客户案例第 ${rowNumber} 行必须填写案例亮点。`, '客户案例', rowNumber, 'customerCases');
    }
  });
}

export function validateFrontendAlignedSubmission(
  input: UnknownRecord,
  options: FrontendValidationOptions = {}
): SubmissionValidationIssue[] {
  const issues: SubmissionValidationIssue[] = [];
  validateProductModel(input, issues);
  validateReferences(input, issues, options);
  validateRegions(input, issues, options);
  validateSamplePrice(input, issues);
  validateTags(input, issues);
  validateWholeMachineConfig(input, issues);
  validateUnifiedPackage(input, issues);
  validatePartLists(input, issues);
  validateSkuPackages(input, issues);
  if (!options.skipMediaValidation) {
    validateMedias(input, issues);
  }
  if (!options.skipCertificationValidation) {
    validateCertifications(input, issues);
  }
  if (!options.skipSalesValidation) {
    validateSalesSupports(input, issues);
  }
  return issues;
}

const URL_PLACEHOLDER_PATTERNS = [
  /\{\{[^}]*\}\}/,
  /\$\{[^}]*\}/,
  /<<[^>]*>>/,
  /__(?:placeholder|upload|binding|todo|pending)[^_]*__/i
];

function isLocalPathValue(text: string): boolean {
  return (
    /^[a-z]:[\\/]/i.test(text) ||
    text.startsWith('\\\\') ||
    text.startsWith('/') ||
    text.startsWith('./') ||
    text.startsWith('../') ||
    text.startsWith('~') ||
    text.toLowerCase().startsWith('file:')
  );
}

function isResolvedHttpUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (!text) return false;
  if (URL_PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(text))) return false;
  if (isLocalPathValue(text)) return false;
  return /^https?:\/\//i.test(text);
}

function assertResolvedUrl(
  issues: SubmissionValidationIssue[],
  value: unknown,
  field: string,
  section: string,
  row?: number
): void {
  if (!hasValue(value)) return;
  if (!isResolvedHttpUrl(value)) {
    addIssue(
      issues,
      'UNRESOLVED_UPLOAD_BINDING',
      `${field} 必须为已上传的 http(s) URL，不能使用本地路径或未解析的上传占位符。`,
      section,
      row,
      field
    );
  }
}

/**
 * Safety block for product_create: reject unresolved upload binding placeholders
 * and local filesystem paths in URL fields before submitting to the backend.
 * This runs unconditionally (independent of the skip* options) and is only wired
 * into product_create, not the precheck draft which intentionally carries local paths.
 */
export function validateResolvedUploads(input: UnknownRecord): SubmissionValidationIssue[] {
  const issues: SubmissionValidationIssue[] = [];

  assertResolvedUrl(issues, input.productMainImageUrl, 'productMainImageUrl', '商品图片');

  const medias = Array.isArray(input.medias) ? (input.medias as UnknownRecord[]) : [];
  medias.forEach((media, index) => {
    assertResolvedUrl(issues, media.mediaUrl, `medias[${index}].mediaUrl`, '商品图片', index + 1);
  });

  const certifications = Array.isArray(input.certifications) ? (input.certifications as UnknownRecord[]) : [];
  certifications.forEach((row, index) => {
    assertResolvedUrl(issues, row.fileUrl, `certifications[${index}].fileUrl`, '认证资料', index + 1);
    assertResolvedUrl(issues, row.mainImageUrl, `certifications[${index}].mainImageUrl`, '认证资料', index + 1);
  });

  const salesSupports = Array.isArray(input.salesSupports) ? (input.salesSupports as UnknownRecord[]) : [];
  salesSupports.forEach((row, index) => {
    assertResolvedUrl(issues, row.fileUrl, `salesSupports[${index}].fileUrl`, '销售支持', index + 1);
  });

  const customerCases = Array.isArray(input.customerCases) ? (input.customerCases as UnknownRecord[]) : [];
  customerCases.forEach((row, caseIndex) => {
    const caseMedias = Array.isArray(row.medias) ? (row.medias as UnknownRecord[]) : [];
    caseMedias.forEach((media, mediaIndex) => {
      assertResolvedUrl(
        issues,
        media.mediaUrl,
        `customerCases[${caseIndex}].medias[${mediaIndex}].mediaUrl`,
        '客户案例',
        caseIndex + 1
      );
    });
  });

  return issues;
}

export function throwValidationIssues(summary: string, issues: SubmissionValidationIssue[]): void {
  if (!issues.length) return;
  const preview = issues
    .slice(0, 4)
    .map((issue) => issue.message)
    .join('；');
  throw new ProductMcpError('MCP_INPUT_INVALID', `${summary} ${preview}`, {
    details: {
      issueCount: issues.length,
      issues
    }
  });
}

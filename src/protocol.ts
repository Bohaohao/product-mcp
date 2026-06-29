type UnknownRecord = Record<string, unknown>;

export interface ProtocolStage {
  name: string;
  ok: boolean;
  summary?: string;
  counts?: Record<string, number>;
  detail?: Record<string, unknown>;
}

export interface ActionableIssue {
  code: string;
  message: string;
  severity: 'error' | 'warning' | 'info';
  blocking: boolean;
  section?: string;
  row?: number;
  field?: string;
  location?: string;
  impact: string;
  suggestion: string;
}

export interface FieldContractItem {
  path: string;
  label: string;
  section: string;
  required?: boolean;
  note?: string;
}

const PRODUCT_FIELD_CONTRACT: FieldContractItem[] = [
  { path: 'productNameCn', label: '商品中文名称', section: '基础信息', required: true },
  { path: 'productNameEn', label: '商品英文名称', section: '基础信息' },
  { path: 'productType', label: '产品类型', section: '基础信息', required: true },
  { path: 'status', label: '上架状态', section: '基础信息', required: true },
  { path: 'productModel', label: '产品型号', section: '基础信息' },
  { path: 'categoryFirstId', label: '一级分类 ID', section: '分类、单位、供应商', required: true },
  { path: 'categorySecondId', label: '二级分类 ID', section: '分类、单位、供应商' },
  { path: 'categoryThirdId', label: '三级分类 ID', section: '分类、单位、供应商' },
  { path: 'unitId', label: '计量单位 ID', section: '分类、单位、供应商', required: true },
  { path: 'unitName', label: '计量单位名称', section: '分类、单位、供应商' },
  { path: 'suppliers[].supplierId', label: '供应商 ID', section: '分类、单位、供应商', required: true },
  { path: 'suppliers[].supplierName', label: '供应商名称', section: '分类、单位、供应商' },
  { path: 'useAllRegions', label: '是否全球适用', section: '适用区域' },
  { path: 'regions[].regionId', label: '区域 ID', section: '适用区域' },
  { path: 'regions[].regionName', label: '区域名称', section: '适用区域' },
  { path: 'productMainImageUrl', label: '商品主图 URL', section: '商品图片', required: true },
  { path: 'medias[].mediaUrl', label: '媒体 URL', section: '媒体资料' },
  { path: 'medias[].mediaType', label: '媒体类型', section: '媒体资料' },
  { path: 'baseConfigs[].categoryBaseId', label: '基础配置 ID', section: '基础配置' },
  { path: 'baseConfigs[].configValue', label: '基础配置值', section: '基础配置' },
  { path: 'technicalParams[].categoryBaseId', label: '技术参数 ID', section: '技术参数' },
  { path: 'technicalParams[].paramValue', label: '技术参数值', section: '技术参数' },
  { path: 'optionalConfigs[].categoryOptionalId', label: '可选配置 ID', section: '可选配置' },
  { path: 'optionalConfigs[].categoryOptionalConfigId', label: '可选配置选项 ID', section: '可选配置' },
  { path: 'partLists[].partName', label: '配件/备件/易损件名称', section: '配件清单' },
  { path: 'certifications[].name', label: '认证名称', section: '认证资料' },
  { path: 'certifications[].fileUrl', label: '认证文件 URL', section: '认证资料' },
  { path: 'salesSupports[].type', label: '销售支持类型', section: '销售支持' },
  { path: 'competitors[].dimensionName', label: '竞品对比维度', section: '竞品对比' },
  { path: 'customerCases[].customerName', label: '客户案例客户名称', section: '客户案例' },
  { path: 'customerCases[].medias[].mediaUrl', label: '客户案例媒体 URL', section: '客户案例' },
  { path: 'priceTiers[].minPriceQuantity', label: '价格阶梯最小数量', section: '价格信息' },
  { path: 'packageInfo.packLength', label: '包装长', section: '包装与物流' },
  { path: 'packageInfo.packWidth', label: '包装宽', section: '包装与物流' },
  { path: 'packageInfo.packHeight', label: '包装高', section: '包装与物流' },
  { path: 'packageInfo.packingFee', label: '包装费', section: '包装与物流' },
  { path: 'packageInfo.packWeight', label: '包装重量', section: '包装与物流' },
  { path: 'packageInfo.netWeight', label: '净重', section: '包装与物流' }
];

const DEFAULT_KNOWN_TOP_LEVEL_FIELDS = new Set(
  PRODUCT_FIELD_CONTRACT.map((item) => item.path.split('.')[0].replace(/\[\]$/, '')).concat([
    'confirm',
    'previewOnly',
    'mode',
    'clientRequestId',
    'id',
    'tenantId',
    'createBy',
    'createDept',
    'language',
    'level',
    'supplierId',
    'supplierName',
    'supplierProductionCycle',
    'supplierCycleUnit',
    'productCode',
    'commodityId',
    'hsCode',
    'spuModel',
    'brand',
    'remark',
    'usagePurpose',
    'relatedCommodityId',
    'supportConsolidation',
    'canExhibit',
    'needInstallation',
    'hasAfterSalesThreshold',
    'supportSample',
    'samplePrice',
    'taxRefundRate',
    'independentPkg',
    'skuList',
    'standardDeliveryDays',
    'shortestDeliveryDays',
    'urgentOrderDays',
    'supportPartsAlone',
    'supportOem',
    'supportOdm',
    'moq',
    'warrantyPeriod',
    'warrantyPeriodUnit',
    'supportSmallTrial',
    'minTrialQuantity',
    'hasSpotStock',
    'hasOverseasWarehouseStock',
    'suggestedPrice',
    'minPrice',
    'referenceCostCny',
    'referenceCostUsd',
    'profitMargin',
    'exFactoryPrice',
    'specialCustomFee',
    'clashSupport',
    'rebateSupport',
    'rebateCondition',
    'rebateRate',
    'isInnerTreasury',
    'externalAddress',
    'externalStatus',
    'proofreadStatus',
    'skipTranslation',
    'tags',
    'extraBody',
    'packLength',
    'packWidth',
    'packHeight',
    'packCubic',
    'packingFee',
    'containerFt20',
    'containerFt40',
    'containerHc40',
    'containerFrame',
    'bulkCarrier',
    'packWeight',
    'netWeight',
    'palletInfo',
    'cartonMark',
    'stackingReq',
    'moistureProofReq',
    'waterproofReq',
    'packingListTemplate'
  ])
);

const URL_PLACEHOLDER_PATTERNS = [/\{\{[^}]*\}\}/, /\$\{[^}]*\}/, /<<[^>]*>>/, /__(?:placeholder|upload|binding|todo|pending)[^_]*__/i];

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function valuePreview(value: unknown): unknown {
  if (typeof value === 'string') return value.length > 120 ? `${value.slice(0, 117)}...` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return `[${value.length} items]`;
  if (isRecord(value)) return '{...}';
  return value === null ? null : typeof value;
}

function pathTokens(path: string): string[] {
  return path.split('.').filter(Boolean);
}

function valuesAtPath(root: unknown, path: string): unknown[] {
  let current: unknown[] = [root];
  for (const token of pathTokens(path)) {
    const isArrayToken = token.endsWith('[]');
    const key = isArrayToken ? token.slice(0, -2) : token;
    const next: unknown[] = [];
    for (const item of current) {
      if (!isRecord(item)) continue;
      const value = item[key];
      if (isArrayToken) {
        if (Array.isArray(value)) next.push(...value);
      } else {
        next.push(value);
      }
    }
    current = next;
  }
  return current;
}

function normalizePath(path: string): string {
  return path.replace(/\[\d+\]/g, '[]');
}

function flattenValuePaths(value: unknown, basePath = ''): Array<{ path: string; normalizedPath: string; value: unknown }> {
  if (Array.isArray(value)) {
    const rows: Array<{ path: string; normalizedPath: string; value: unknown }> = [];
    value.forEach((item, index) => {
      rows.push(...flattenValuePaths(item, `${basePath}[${index}]`));
    });
    if (!value.length && basePath) rows.push({ path: basePath, normalizedPath: normalizePath(basePath), value });
    return rows;
  }

  if (isRecord(value)) {
    const rows: Array<{ path: string; normalizedPath: string; value: unknown }> = [];
    for (const [key, child] of Object.entries(value)) {
      const childPath = basePath ? `${basePath}.${key}` : key;
      rows.push(...flattenValuePaths(child, childPath));
    }
    if (!rows.length && basePath) rows.push({ path: basePath, normalizedPath: normalizePath(basePath), value });
    return rows;
  }

  return basePath ? [{ path: basePath, normalizedPath: normalizePath(basePath), value }] : [];
}

function countArray(input: UnknownRecord, key: string): number {
  const value = input[key];
  return Array.isArray(value) ? value.length : 0;
}

function stringValue(value: unknown): string | undefined {
  if (!hasValue(value)) return undefined;
  return String(value).trim();
}

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

function looksLikeUrlField(path: string): boolean {
  return /(?:url|html)$/i.test(path) || /mediaUrl|fileUrl|mainImageUrl/i.test(path);
}

function findUrlRisks(input: UnknownRecord): Array<{ path: string; code: string; valuePreview: unknown }> {
  const risks: Array<{ path: string; code: string; valuePreview: unknown }> = [];
  for (const item of flattenValuePaths(input)) {
    if (!looksLikeUrlField(item.path) || typeof item.value !== 'string') continue;
    const text = item.value.trim();
    if (!text) continue;
    if (URL_PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(text))) {
      risks.push({ path: item.path, code: 'UNRESOLVED_UPLOAD_BINDING', valuePreview: valuePreview(text) });
    } else if (isLocalPathValue(text)) {
      risks.push({ path: item.path, code: 'LOCAL_PATH_IN_SUBMISSION', valuePreview: valuePreview(text) });
    }
  }
  return risks;
}

function countMediaBy(input: UnknownRecord, key: string): Record<string, number> {
  const medias = Array.isArray(input.medias) ? (input.medias as UnknownRecord[]) : [];
  return medias.reduce<Record<string, number>>((acc, row) => {
    const value = String(row[key] ?? 'unset');
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}

function issueSuggestion(code: string): string {
  const suggestions: Record<string, string> = {
    CONFIRM_REQUIRED: '确认最终提交摘要无误后，重新调用并传入 confirm=true。',
    CREATE_MODE_ID_FORBIDDEN: '创建新商品时移除顶层 id；如果是维护已有商品，应使用 update 模式/工具。',
    CREATE_MODE_UNSUPPORTED: '当前 product_create 只执行新建；请改用 mode=create 或等待对应模式工具。',
    CATEGORY_FIRST_REQUIRED: '先解析用户填写的分类路径，并回填 categoryFirstId/categorySecondId/categoryThirdId。',
    UNIT_REQUIRED: '通过分类配置或单位列表按 unitName 精确匹配后回填 unitId。',
    SUPPLIER_REQUIRED: '通过供应商查询按 supplierName 精确匹配后回填 suppliers[].supplierId。',
    REGION_REQUIRED: '选择 useAllRegions=true，或按区域名称查询并回填 regions[].regionId。',
    REGION_ID_REQUIRED: '按区域名称查询并回填该行 regionId；全球行可使用 isAll=1。',
    PRODUCT_MAIN_IMAGE_REQUIRED: '补充商品主图，并在上传后把 OSS URL 回填到 productMainImageUrl 或 medias 主图项。',
    UNRESOLVED_UPLOAD_BINDING: '先完成 product_upload_file，并用返回的 OSS URL 替换占位符或本地路径。',
    LOCAL_PATH_IN_SUBMISSION: '提交给 product_create 前必须把本地路径替换成 OSS URL。',
    PRODUCT_MODEL_FORMAT_INVALID: '产品型号只保留英文大小写、数字和空格，去掉首尾空格、中文和标点。',
    SKU_PACKAGE_FEE_REQUIRED: '独立 SKU 包装行补齐包装费。',
    REQUIRED_FIELD_MISSING: '按字段位置补齐真实业务值；不确定时先向用户确认。'
  };
  return suggestions[code] || '按字段路径定位资料表对应位置，补齐、修正或移除不应提交的值后重新预检。';
}

function issueImpact(code: string): string {
  if (code.includes('UPLOAD') || code.includes('PATH')) return '可能导致已引用素材没有进入最终商品，或把本地路径误提交给后端。';
  if (code.includes('CATEGORY') || code.includes('UNIT') || code.includes('SUPPLIER') || code.includes('REGION')) return '会导致 ERP 无法保存引用关系，必须先解析实体 ID。';
  if (code.includes('MODE') || code.includes('CONFIRM')) return '会影响创建动作的安全边界，避免误创建或误更新。';
  return '该问题会影响创建成功率或商品详情完整度。';
}

export function toActionableIssues(
  rawIssues: Array<{
    code?: unknown;
    message?: unknown;
    severity?: unknown;
    section?: unknown;
    row?: unknown;
    field?: unknown;
    path?: unknown;
  }>,
  defaultSeverity: 'error' | 'warning' | 'info' = 'error'
): ActionableIssue[] {
  return rawIssues.map((issue) => {
    const code = String(issue.code || 'UNKNOWN_ISSUE');
    const severity = issue.severity === 'warning' || issue.severity === 'info' || issue.severity === 'error' ? issue.severity : defaultSeverity;
    const section = stringValue(issue.section);
    const field = stringValue(issue.field || issue.path);
    const row = typeof issue.row === 'number' ? issue.row : undefined;
    const location = [section, row ? `第 ${row} 行` : undefined, field].filter(Boolean).join(' / ') || undefined;
    return {
      code,
      message: String(issue.message || code),
      severity,
      blocking: severity === 'error',
      section,
      row,
      field,
      location,
      impact: issueImpact(code),
      suggestion: issueSuggestion(code)
    };
  });
}

export function buildProtocolTrace(operation: string, requestId: string | undefined, stages: ProtocolStage[]) {
  return {
    traceId: requestId ? `trace_${requestId}` : `trace_${Date.now().toString(36)}`,
    operation,
    requestId,
    generatedAt: new Date().toISOString(),
    stages
  };
}

export function buildFieldCoverage(
  input: unknown,
  options: { knownTopLevelFields?: string[]; contract?: FieldContractItem[] } = {}
) {
  const record = isRecord(input) ? input : {};
  const contract = options.contract || PRODUCT_FIELD_CONTRACT;
  const knownTopLevelFields = new Set([...(options.knownTopLevelFields || []), ...DEFAULT_KNOWN_TOP_LEVEL_FIELDS]);
  const flattened = flattenValuePaths(record).filter((item) => hasValue(item.value));
  const populatedPathSet = new Set(flattened.map((item) => item.normalizedPath));
  const recognized = contract.map((field) => {
    const values = valuesAtPath(record, field.path).filter(hasValue);
    return {
      path: field.path,
      label: field.label,
      section: field.section,
      required: Boolean(field.required),
      status: values.length ? 'recognized' : field.required ? 'missing' : 'empty',
      valueCount: values.length,
      sample: values.length ? valuePreview(values[0]) : undefined,
      note: field.note
    };
  });
  const contractPathSet = new Set(contract.map((field) => field.path));
  const uncontractedPopulatedPaths = [...populatedPathSet]
    .filter((path) => !contractPathSet.has(path))
    .slice(0, 200);
  const ignoredTopLevelValues = Object.entries(record)
    .filter(([key, value]) => hasValue(value) && !knownTopLevelFields.has(key))
    .map(([key, value]) => ({ field: key, valuePreview: valuePreview(value), reason: 'Not part of the current Product MCP create contract.' }));

  return {
    contractVersion: 'product-mcp-protocol-2026-06-29.1',
    recognized,
    counts: {
      contractFields: contract.length,
      recognizedFields: recognized.filter((item) => item.status === 'recognized').length,
      missingRequiredFields: recognized.filter((item) => item.status === 'missing').length,
      populatedPaths: populatedPathSet.size,
      uncontractedPopulatedPaths: uncontractedPopulatedPaths.length,
      ignoredTopLevelValues: ignoredTopLevelValues.length
    },
    uncontractedPopulatedPaths,
    ignoredTopLevelValues
  };
}

export function buildSubmissionPreview(input: unknown, normalizedBody?: unknown) {
  const source = isRecord(input) ? input : {};
  const body = isRecord(normalizedBody) ? normalizedBody : source;
  const urlRisks = findUrlRisks(body);
  const inputIdRisks = ['id', 'commodityId'].filter((key) => hasValue(source[key]));

  return {
    mode: stringValue(source.mode) || 'create',
    product: {
      productNameCn: source.productNameCn,
      productNameEn: source.productNameEn,
      productType: source.productType,
      status: source.status,
      productModel: source.productModel || source.spuModel
    },
    references: {
      categoryFirstId: body.categoryFirstId,
      categorySecondId: body.categorySecondId,
      categoryThirdId: body.categoryThirdId,
      unitId: body.unitId,
      supplierCount: countArray(body, 'suppliers'),
      regionCount: countArray(body, 'regions')
    },
    counts: {
      medias: countArray(body, 'medias'),
      baseConfigs: countArray(body, 'baseConfigs'),
      technicalParams: countArray(body, 'technicalParams'),
      optionalConfigs: countArray(body, 'optionalConfigs'),
      partLists: countArray(body, 'partLists'),
      certifications: countArray(body, 'certifications'),
      salesSupports: countArray(body, 'salesSupports'),
      competitors: countArray(body, 'competitors'),
      customerCases: countArray(body, 'customerCases'),
      priceTiers: countArray(body, 'priceTiers'),
      skuList: countArray(body, 'skuList')
    },
    mediaBreakdown: {
      byMediaType: countMediaBy(body, 'mediaType'),
      byImageCategory: countMediaBy(body, 'imageCategory'),
      byVideoCategory: countMediaBy(body, 'videoCategory'),
      byOtherCategory: countMediaBy(body, 'otherCategory')
    },
    riskSummary: {
      unresolvedUrlFieldCount: urlRisks.length,
      createModeInputIdCount: inputIdRisks.length,
      hasExtraBody: hasValue(source.extraBody)
    },
    risks: [
      ...urlRisks.map((risk) => ({
        code: risk.code,
        path: risk.path,
        blocking: true,
        valuePreview: risk.valuePreview,
        suggestion: issueSuggestion(risk.code)
      })),
      ...inputIdRisks.map((field) => ({
        code: 'CREATE_MODE_ID_PRESENT',
        path: field,
        blocking: field === 'id',
        valuePreview: valuePreview(source[field]),
        suggestion: field === 'id' ? issueSuggestion('CREATE_MODE_ID_FORBIDDEN') : '确认该字段确实是创建所需的业务关联字段，否则从资料包中移除。'
      }))
    ]
  };
}

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import * as z from 'zod/v4';
import type { BackendClient } from '../backendClient.js';
import { precheckProductPackage } from '../packagePrecheck.js';
import { productOcrCertifications, productOcrOptionsSchema } from '../ocr/certificationOcr.js';
import { buildFieldCoverage, buildProtocolTrace, buildSubmissionPreview, toActionableIssues, type ProtocolStage } from '../protocol.js';
import { productCheckNameDuplicate } from '../tools/productSearch.js';
import { productCreate } from '../tools/createProduct.js';
import { productGetDetail } from '../tools/productDetail.js';
import { productListCategories } from '../tools/categories.js';
import { productGetCategoryConfig, productListRegions, productListSuppliers } from '../tools/references.js';
import type { ProductUploadFileInput } from '../upload/policies.js';

type UnknownRecord = Record<string, unknown>;

export const productCreateFromPackageInputSchema = {
  packagePath: z.string().trim().min(1).describe('Local product package directory or 商品资料.md path.'),
  markdownFileName: z.string().trim().default('商品资料.md'),
  runMode: z.enum(['preview', 'create']).default('preview').describe('preview does not upload or create; create requires confirm=true.'),
  confirm: z.boolean().optional().describe('Required true when runMode=create.'),
  clientRequestId: z.string().trim().max(100).optional(),
  ocrMode: z
    .enum(['off', 'auto', 'strict', 'suggest', 'apply'])
    .default('auto')
    .describe('Certification OCR assistance before precheck. auto applies local OCR when possible and returns Codex native vision fallback requests when needed.'),
  ocrOptions: productOcrOptionsSchema,
  responseMode: z.enum(['summary', 'standard', 'debug']).default('summary'),
  includeDetailSections: z
    .array(z.enum(['base', 'medias', 'sales', 'parts', 'certifications']))
    .default(['base', 'medias', 'sales', 'parts', 'certifications'])
};

const productCreateFromPackageObjectSchema = z.object(productCreateFromPackageInputSchema);
export type ProductCreateFromPackageInput = z.infer<typeof productCreateFromPackageObjectSchema>;

export type UploadLocalFile = (input: ProductUploadFileInput) => Promise<UnknownRecord>;

interface CreateFromPackageRuntime {
  uploadLocalFile: UploadLocalFile;
}

interface JournalUpload {
  key: string;
  status: 'success' | 'error';
  url?: string;
  objectKey?: string;
  attempts: number;
  error?: string;
  sourceRelativePath?: string;
  sourceLocalPath?: string;
  usage?: string;
  updatedAt: string;
}

interface WorkflowJournal {
  workflowId: string;
  clientRequestId: string;
  packagePath: string;
  status: string;
  productId?: string;
  createdAt: string;
  updatedAt: string;
  uploads: Record<string, JournalUpload>;
  stages: ProtocolStage[];
  snapshots?: Record<string, unknown>;
}

interface ResolutionIssue {
  code: string;
  message: string;
  severity: 'error';
  section?: string;
  field?: string;
  candidates?: unknown[];
}

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text || undefined;
}

function hasValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  return true;
}

function normalizeMatch(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120) || 'workflow';
}

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function defaultClientRequestId(input: ProductCreateFromPackageInput): string {
  return `pkg_${sha(path.resolve(input.packagePath)).slice(0, 20)}`;
}

function shouldRunCertificationOcr(mode: ProductCreateFromPackageInput['ocrMode']): boolean {
  return mode !== 'off';
}

function certificationOcrHelperMode(mode: ProductCreateFromPackageInput['ocrMode']): 'suggest' | 'apply' {
  return mode === 'suggest' ? 'suggest' : 'apply';
}

function strictOcrMode(mode: ProductCreateFromPackageInput['ocrMode']): boolean {
  return mode === 'strict';
}

function workflowDir(): string {
  return path.join(homedir(), '.erp-product', 'workflows');
}

function workflowPath(clientRequestId: string): string {
  return path.join(workflowDir(), `${safeName(clientRequestId)}.json`);
}

async function readJournal(clientRequestId: string): Promise<WorkflowJournal | undefined> {
  try {
    return JSON.parse(await readFile(workflowPath(clientRequestId), 'utf8')) as WorkflowJournal;
  } catch {
    return undefined;
  }
}

async function writeJournal(journal: WorkflowJournal): Promise<void> {
  journal.updatedAt = new Date().toISOString();
  await mkdir(workflowDir(), { recursive: true });
  await writeFile(workflowPath(journal.clientRequestId), JSON.stringify(journal, null, 2), 'utf8');
}

function initialJournal(input: ProductCreateFromPackageInput, clientRequestId: string): WorkflowJournal {
  const now = new Date().toISOString();
  return {
    workflowId: `wf_${sha(`${clientRequestId}:${path.resolve(input.packagePath)}`).slice(0, 20)}`,
    clientRequestId,
    packagePath: path.resolve(input.packagePath),
    status: 'started',
    createdAt: now,
    updatedAt: now,
    uploads: {},
    stages: [],
    snapshots: {}
  };
}

function addStage(journal: WorkflowJournal, stage: ProtocolStage): void {
  journal.stages.push(stage);
}

function exactMatches<T extends UnknownRecord>(items: T[], value: unknown, keys: string[]): T[] {
  const target = normalizeMatch(value);
  if (!target) return [];
  return items.filter((item) => keys.some((key) => normalizeMatch(item[key]) === target));
}

function issue(code: string, message: string, field?: string, section?: string, candidates?: unknown[]): ResolutionIssue {
  return { code, message, severity: 'error', field, section, candidates };
}

function flattenCategories(nodes: UnknownRecord[], pathNames: string[] = []): Array<UnknownRecord & { pathNames: string[] }> {
  const rows: Array<UnknownRecord & { pathNames: string[] }> = [];
  for (const node of nodes) {
    const name = stringValue(node.name) || stringValue(node.i18nName) || stringValue(node.id) || '';
    const nextPath = name ? [...pathNames, name] : pathNames;
    rows.push({ ...node, pathNames: nextPath });
    const children = Array.isArray(node.children) ? (node.children as UnknownRecord[]) : [];
    rows.push(...flattenCategories(children, nextPath));
  }
  return rows;
}

function matchCategoryPath(
  categories: UnknownRecord[],
  draft: UnknownRecord
): { ids: Record<string, string>; selected?: UnknownRecord; issues: ResolutionIssue[] } {
  const issues: ResolutionIssue[] = [];
  const ids: Record<string, string> = {};
  if (hasValue(draft.categoryFirstId)) ids.categoryFirstId = String(draft.categoryFirstId);
  if (hasValue(draft.categorySecondId)) ids.categorySecondId = String(draft.categorySecondId);
  if (hasValue(draft.categoryThirdId)) ids.categoryThirdId = String(draft.categoryThirdId);
  if (ids.categoryThirdId || ids.categorySecondId || ids.categoryFirstId) return { ids, issues };

  const names = [draft.categoryFirstName, draft.categorySecondName, draft.categoryThirdName].map(stringValue);
  if (!names[0]) {
    issues.push(issue('CATEGORY_NAME_REQUIRED', '分类名称缺失，无法自动解析 categoryFirstId。', 'categoryFirstName', '分类'));
    return { ids, issues };
  }

  let level = categories;
  let selected: UnknownRecord | undefined;
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index];
    if (!name) {
      if (selected && Array.isArray(selected.children) && selected.children.length > 0) {
        issues.push(issue('CATEGORY_CHILD_REQUIRED', `分类 ${stringValue(selected.name) || selected.id} 下仍有可用子级，必须填写到末级分类。`, `categoryLevel${index + 1}`, '分类'));
      }
      break;
    }
    const matches = exactMatches(level, name, ['name', 'i18nName']);
    if (matches.length !== 1) {
      issues.push(
        issue(
          matches.length ? 'CATEGORY_AMBIGUOUS' : 'CATEGORY_NOT_FOUND',
          matches.length ? `分类 ${name} 匹配到多个候选。` : `分类 ${name} 未找到精确匹配。`,
          `categoryLevel${index + 1}`,
          '分类',
          matches.length ? matches.map((row) => ({ id: row.id, name: row.name, i18nName: row.i18nName })) : flattenCategories(categories).slice(0, 20)
        )
      );
      return { ids, issues };
    }
    selected = matches[0];
    const id = stringValue(selected.id);
    if (id) {
      if (index === 0) ids.categoryFirstId = id;
      if (index === 1) ids.categorySecondId = id;
      if (index === 2) ids.categoryThirdId = id;
    }
    level = Array.isArray(selected.children) ? (selected.children as UnknownRecord[]) : [];
  }

  if (selected && Array.isArray(selected.children) && selected.children.length > 0) {
    issues.push(issue('CATEGORY_LEAF_REQUIRED', '当前分类不是末级分类，必须补齐下级分类。', 'categoryThirdName', '分类'));
  }

  return { ids, selected, issues };
}

function resolveUnit(draft: UnknownRecord, categoryConfig: UnknownRecord | undefined, issues: ResolutionIssue[]): void {
  if (hasValue(draft.unitId)) return;
  const unitName = stringValue(draft.unitName);
  if (!unitName) {
    issues.push(issue('UNIT_NAME_REQUIRED', '计量单位名称缺失，无法自动解析 unitId。', 'unitName', '单位'));
    return;
  }
  const units = Array.isArray(categoryConfig?.units) ? (categoryConfig.units as UnknownRecord[]) : [];
  const matches = exactMatches(units, unitName, ['name', 'unitName']);
  if (matches.length === 1 && hasValue(matches[0].id)) {
    draft.unitId = String(matches[0].id);
    return;
  }
  issues.push(
    issue(matches.length ? 'UNIT_AMBIGUOUS' : 'UNIT_NOT_FOUND', matches.length ? `单位 ${unitName} 匹配到多个候选。` : `单位 ${unitName} 未在分类配置中找到。`, 'unitName', '单位', matches)
  );
}

async function resolveSuppliers(backend: BackendClient, draft: UnknownRecord, requestId: string, issues: ResolutionIssue[]): Promise<void> {
  const supplierRows = Array.isArray(draft.suppliers) ? (draft.suppliers as UnknownRecord[]) : [];
  const fallbackSupplierName = stringValue(draft.supplierName);
  const rows = supplierRows.length ? supplierRows : fallbackSupplierName ? [{ supplierName: fallbackSupplierName }] : [];
  if (!rows.length) {
    issues.push(issue('SUPPLIER_NAME_REQUIRED', '供应商名称缺失，无法自动解析 supplierId。', 'suppliers', '供应商'));
    return;
  }

  for (const row of rows) {
    if (hasValue(row.supplierId)) continue;
    const supplierName = stringValue(row.supplierName);
    if (!supplierName) {
      issues.push(issue('SUPPLIER_NAME_REQUIRED', '供应商行缺少 supplierName。', 'suppliers[].supplierName', '供应商'));
      continue;
    }
    const result = await productListSuppliers(backend, { keyword: supplierName, includeTree: false, enabledOnly: true }, requestId);
    const suppliers = Array.isArray(result.suppliers) ? (result.suppliers as UnknownRecord[]) : [];
    const matches = exactMatches(suppliers, supplierName, ['name']);
    if (matches.length === 1 && hasValue(matches[0].id)) {
      row.supplierId = String(matches[0].id);
      row.supplierName = stringValue(matches[0].name) || supplierName;
    } else {
      issues.push(
        issue(
          matches.length ? 'SUPPLIER_AMBIGUOUS' : 'SUPPLIER_NOT_FOUND',
          matches.length ? `供应商 ${supplierName} 匹配到多个候选。` : `供应商 ${supplierName} 未找到精确匹配。`,
          'suppliers[].supplierName',
          '供应商',
          matches.length ? matches : suppliers.slice(0, 20)
        )
      );
    }
  }
  draft.suppliers = rows;
}

async function resolveRegions(backend: BackendClient, draft: UnknownRecord, requestId: string, issues: ResolutionIssue[]): Promise<void> {
  if (draft.useAllRegions === true) return;
  const regions = Array.isArray(draft.regions) ? (draft.regions as UnknownRecord[]) : [];
  if (!regions.length) return;

  for (const row of regions) {
    if (row.isAll === 1 || row.isAll === '1' || row.isAll === true || hasValue(row.regionId)) continue;
    const regionName = stringValue(row.regionName);
    if (!regionName) {
      issues.push(issue('REGION_NAME_REQUIRED', '区域行缺少 regionName。', 'regions[].regionName', '区域'));
      continue;
    }
    const result = await productListRegions(backend, { keyword: regionName, enabledOnly: true, includeRaw: false }, requestId);
    const regionRows = Array.isArray(result.regions) ? (result.regions as UnknownRecord[]) : [];
    const matches = exactMatches(regionRows, regionName, ['name', 'nameZh', 'nameEn']);
    if (matches.length === 1 && hasValue(matches[0].id)) {
      row.regionId = String(matches[0].id);
      row.regionName = stringValue(matches[0].name) || regionName;
    } else {
      issues.push(
        issue(
          matches.length ? 'REGION_AMBIGUOUS' : 'REGION_NOT_FOUND',
          matches.length ? `区域 ${regionName} 匹配到多个候选。` : `区域 ${regionName} 未找到精确匹配。`,
          'regions[].regionName',
          '区域',
          matches.length ? matches : regionRows.slice(0, 20)
        )
      );
    }
  }
}

function resolveConfigRows(draft: UnknownRecord, categoryConfig: UnknownRecord | undefined, issues: ResolutionIssue[]): void {
  const baseList = Array.isArray(categoryConfig?.baseConfigs) ? (categoryConfig.baseConfigs as UnknownRecord[]) : [];
  const fieldList = Array.isArray(categoryConfig?.technicalParams) ? (categoryConfig.technicalParams as UnknownRecord[]) : [];
  const optionalList = Array.isArray(categoryConfig?.optionalConfigs) ? (categoryConfig.optionalConfigs as UnknownRecord[]) : [];

  for (const row of Array.isArray(draft.baseConfigs) ? (draft.baseConfigs as UnknownRecord[]) : []) {
    if (hasValue(row.categoryBaseId)) continue;
    const name = stringValue(row.name);
    if (!name) continue;
    const matches = exactMatches(baseList, name, ['name']);
    if (matches.length === 1 && hasValue(matches[0].id)) row.categoryBaseId = String(matches[0].id);
    else issues.push(issue(matches.length ? 'BASE_CONFIG_AMBIGUOUS' : 'BASE_CONFIG_NOT_FOUND', `基础配置 ${name} 无法唯一解析。`, 'baseConfigs[].name', '基础配置', matches));
  }

  for (const row of Array.isArray(draft.technicalParams) ? (draft.technicalParams as UnknownRecord[]) : []) {
    if (hasValue(row.categoryBaseId)) continue;
    const name = stringValue(row.name);
    if (!name) continue;
    const matches = exactMatches(fieldList, name, ['name']);
    if (matches.length === 1 && hasValue(matches[0].id)) row.categoryBaseId = String(matches[0].id);
    else issues.push(issue(matches.length ? 'TECH_PARAM_AMBIGUOUS' : 'TECH_PARAM_NOT_FOUND', `技术参数 ${name} 无法唯一解析。`, 'technicalParams[].name', '技术参数', matches));
  }

  for (const row of Array.isArray(draft.optionalConfigs) ? (draft.optionalConfigs as UnknownRecord[]) : []) {
    const name = stringValue(row.name);
    let config: UnknownRecord | undefined;
    if (hasValue(row.categoryOptionalId)) {
      config = optionalList.find((item) => String(item.id) === String(row.categoryOptionalId));
    } else if (name) {
      const configMatches = exactMatches(optionalList, name, ['name']);
      if (configMatches.length === 1) {
        config = configMatches[0];
      } else {
        issues.push(
          issue(
            configMatches.length ? 'OPTIONAL_CONFIG_AMBIGUOUS' : 'OPTIONAL_CONFIG_NOT_FOUND',
            configMatches.length ? `可选配置 ${name} 匹配到多个候选。` : `可选配置 ${name} 无法解析。`,
            'optionalConfigs[].name',
            '可选配置',
            configMatches
          )
        );
        continue;
      }
    }
    if (!config) {
      if (name) issues.push(issue('OPTIONAL_CONFIG_NOT_FOUND', `可选配置 ${name} 无法解析。`, 'optionalConfigs[].name', '可选配置'));
      continue;
    }
    if (!hasValue(row.categoryOptionalId) && hasValue(config.id)) row.categoryOptionalId = String(config.id);
    if (!hasValue(row.name)) row.name = stringValue(config.name);
    if (!hasValue(row.categoryOptionalConfigId) && hasValue(row.configValue)) {
      const options = Array.isArray(config.items) ? (config.items as UnknownRecord[]) : [];
      const matches = exactMatches(options, row.configValue, ['name', 'configValue']);
      if (matches.length === 1 && hasValue(matches[0].id)) row.categoryOptionalConfigId = String(matches[0].id);
      else issues.push(issue(matches.length ? 'OPTIONAL_VALUE_AMBIGUOUS' : 'OPTIONAL_VALUE_NOT_FOUND', `可选配置值 ${row.configValue} 无法唯一解析。`, 'optionalConfigs[].configValue', '可选配置', matches));
    }
  }
}

async function resolveReferences(backend: BackendClient, draft: UnknownRecord, requestId: string) {
  const issues: ResolutionIssue[] = [];
  const resolution: UnknownRecord = {};
  const categoriesResult = await productListCategories(backend, { enabledOnly: true }, requestId);
  const categories = Array.isArray(categoriesResult.categories) ? (categoriesResult.categories as unknown as UnknownRecord[]) : [];
  const categoryMatch = matchCategoryPath(categories, draft);
  Object.assign(draft, categoryMatch.ids);
  issues.push(...categoryMatch.issues);
  resolution.category = {
    ids: categoryMatch.ids,
    selected: categoryMatch.selected
      ? { id: categoryMatch.selected.id, name: categoryMatch.selected.name, i18nName: categoryMatch.selected.i18nName }
      : undefined
  };

  const categoryId = stringValue(draft.categoryThirdId) || stringValue(draft.categorySecondId) || stringValue(draft.categoryFirstId);
  let categoryConfig: UnknownRecord | undefined;
  if (categoryId) {
    categoryConfig = await productGetCategoryConfig(backend, { categoryId, enabledOnly: true, includeRaw: false }, requestId);
    resolution.categoryConfig = {
      categoryId,
      unitCount: Array.isArray(categoryConfig.units) ? categoryConfig.units.length : 0,
      baseConfigCount: Array.isArray(categoryConfig.baseConfigs) ? categoryConfig.baseConfigs.length : 0,
      technicalParamCount: Array.isArray(categoryConfig.technicalParams) ? categoryConfig.technicalParams.length : 0,
      optionalConfigCount: Array.isArray(categoryConfig.optionalConfigs) ? categoryConfig.optionalConfigs.length : 0
    };
  }

  resolveUnit(draft, categoryConfig, issues);
  resolveConfigRows(draft, categoryConfig, issues);
  await resolveSuppliers(backend, draft, requestId, issues);
  await resolveRegions(backend, draft, requestId, issues);

  return {
    ok: issues.length === 0,
    issues,
    resolution
  };
}

function uploadKey(item: UnknownRecord): string {
  return String(item.dedupeKey || item.sourceLocalPath || item.sourceRelativePath || item.localPath || sha(JSON.stringify(item)));
}

async function uploadOne(
  item: UnknownRecord,
  journal: WorkflowJournal,
  runtime: CreateFromPackageRuntime
): Promise<JournalUpload> {
  const key = uploadKey(item);
  const existing = journal.uploads[key];
  if (existing?.status === 'success' && existing.url) return existing;

  let lastError = '';
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const result = await runtime.uploadLocalFile(item as ProductUploadFileInput);
      const url = stringValue(result.url);
      if (!url) throw new Error('Upload finished without url.');
      const upload: JournalUpload = {
        key,
        status: 'success',
        url,
        objectKey: stringValue(result.objectKey),
        attempts: attempt,
        sourceRelativePath: stringValue(item.sourceRelativePath),
        sourceLocalPath: stringValue(item.sourceLocalPath) || stringValue(item.localPath),
        usage: stringValue(item.usage),
        updatedAt: new Date().toISOString()
      };
      journal.uploads[key] = upload;
      await writeJournal(journal);
      return upload;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  const failed: JournalUpload = {
    key,
    status: 'error',
    attempts: 2,
    error: lastError,
    sourceRelativePath: stringValue(item.sourceRelativePath),
    sourceLocalPath: stringValue(item.sourceLocalPath) || stringValue(item.localPath),
    usage: stringValue(item.usage),
    updatedAt: new Date().toISOString()
  };
  journal.uploads[key] = failed;
  await writeJournal(journal);
  return failed;
}

function replaceString(text: string, replacements: Map<string, string>): string {
  let result = text;
  for (const [placeholder, url] of replacements) {
    result = result.split(placeholder).join(url);
  }
  return result;
}

function deepReplace(value: unknown, replacements: Map<string, string>): unknown {
  if (typeof value === 'string') return replaceString(value, replacements);
  if (Array.isArray(value)) return value.map((item) => deepReplace(item, replacements));
  if (isRecord(value)) {
    const next: UnknownRecord = {};
    for (const [key, child] of Object.entries(value)) {
      next[key] = deepReplace(child, replacements);
    }
    return next;
  }
  return value;
}

function buildReplacements(uploadQueue: UnknownRecord[], uploads: Record<string, JournalUpload>): Map<string, string> {
  const replacements = new Map<string, string>();
  for (const item of uploadQueue) {
    const binding = isRecord(item.draftBinding) ? item.draftBinding : undefined;
    const placeholder = stringValue(binding?.placeholder);
    const upload = uploads[uploadKey(item)];
    if (placeholder && upload?.status === 'success' && upload.url) {
      replacements.set(placeholder, upload.url);
    }
  }
  return replacements;
}

async function uploadAll(
  uploadQueue: UnknownRecord[],
  draft: UnknownRecord,
  journal: WorkflowJournal,
  runtime: CreateFromPackageRuntime
) {
  const uploads: JournalUpload[] = [];
  for (const item of uploadQueue) {
    uploads.push(await uploadOne(item, journal, runtime));
  }

  const replacements = buildReplacements(uploadQueue, journal.uploads);
  const boundDraft = deepReplace(draft, replacements) as UnknownRecord;
  const failures = uploads.filter((upload) => upload.status === 'error');
  return {
    boundDraft,
    uploads,
    failures,
    uploadSummary: {
      total: uploadQueue.length,
      successCount: uploads.filter((upload) => upload.status === 'success').length,
      errorCount: failures.length,
      retryPolicy: 'Each failed file is retried once, then marked error while remaining files continue.'
    }
  };
}

function collectHttpUrls(value: unknown, urls = new Set<string>()): Set<string> {
  if (typeof value === 'string' && /^https?:\/\//i.test(value.trim())) urls.add(value.trim());
  else if (Array.isArray(value)) value.forEach((item) => collectHttpUrls(item, urls));
  else if (isRecord(value)) Object.values(value).forEach((item) => collectHttpUrls(item, urls));
  return urls;
}

function findFirstByKey(value: unknown, key: string): unknown {
  if (isRecord(value)) {
    if (value[key] !== undefined) return value[key];
    for (const child of Object.values(value)) {
      const found = findFirstByKey(child, key);
      if (found !== undefined) return found;
    }
  } else if (Array.isArray(value)) {
    for (const child of value) {
      const found = findFirstByKey(child, key);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function countRows(value: unknown): number | undefined {
  if (Array.isArray(value)) return value.length;
  if (isRecord(value)) {
    for (const key of ['rows', 'list', 'data', 'records']) {
      if (Array.isArray(value[key])) return value[key].length;
    }
  }
  return undefined;
}

function uploadQueueSummary(uploadQueue: unknown): UnknownRecord {
  const rows = Array.isArray(uploadQueue) ? (uploadQueue as UnknownRecord[]) : [];
  return {
    total: rows.length,
    items: rows.map((item) => ({
      dedupeKey: stringValue(item.dedupeKey),
      sourceRelativePath: stringValue(item.sourceRelativePath),
      sourceLocalPath: stringValue(item.sourceLocalPath) || stringValue(item.localPath),
      usage: stringValue(item.usage),
      target: isRecord(item.draftBinding) ? stringValue(item.draftBinding.target) : undefined,
      placeholder: isRecord(item.draftBinding) ? stringValue(item.draftBinding.placeholder) : undefined
    }))
  };
}

function precheckContext(precheck: UnknownRecord): UnknownRecord {
  return {
    precheckIssues: precheck.issues,
    uploadQueueSummary: uploadQueueSummary(precheck.uploadQueue),
    sourceInventorySummary: precheck.sourceInventorySummary,
    sourceMappingSummary: precheck.sourceMappingSummary,
    sourceCoverageReport: precheck.sourceCoverageReport,
    videoMetadataSummary: precheck.videoMetadataSummary,
    videoMetadataReport: precheck.videoMetadataReport,
    ocrFallback: precheck.ocrFallback,
    visionExtractionRequest: isRecord(precheck.ocrFallback) ? precheck.ocrFallback.visionExtractionRequest : undefined
  };
}

function buildDiffReport(submitted: UnknownRecord, detail: UnknownRecord | undefined) {
  if (!detail) {
    return {
      matched: [],
      backendChanged: [],
      missingInDetail: [],
      backendDefaulted: [],
      unchecked: ['detail lookup was skipped or unavailable']
    };
  }

  const matched: unknown[] = [];
  const backendChanged: unknown[] = [];
  for (const field of ['productNameCn', 'productNameEn', 'productType', 'status', 'productModel', 'categoryFirstId', 'categorySecondId', 'categoryThirdId', 'unitId']) {
    const submittedValue = submitted[field];
    if (!hasValue(submittedValue)) continue;
    const detailValue = findFirstByKey(detail, field);
    if (!hasValue(detailValue)) continue;
    if (String(detailValue) === String(submittedValue)) matched.push({ field, value: submittedValue });
    else backendChanged.push({ field, submitted: submittedValue, detail: detailValue });
  }

  const submittedUrls = collectHttpUrls(submitted);
  const detailUrls = collectHttpUrls(detail);
  const missingInDetail = [...submittedUrls]
    .filter((url) => !detailUrls.has(url))
    .map((url) => ({ type: 'url', value: url }));

  const submittedPreview = buildSubmissionPreview(submitted);
  const detailCounts: Record<string, number | undefined> = {};
  for (const key of ['medias', 'parts', 'certifications', 'sales']) {
    detailCounts[key] = countRows(detail[key]);
  }

  return {
    matched,
    backendChanged,
    missingInDetail,
    backendDefaulted: [],
    unchecked: [
      'Nested detail DTOs may use backend-specific shapes; V1 compares key scalar fields, URL presence, and section counts only.'
    ],
    counts: {
      submitted: submittedPreview.counts,
      detail: detailCounts
    }
  };
}

function packageResult(result: UnknownRecord, responseMode: ProductCreateFromPackageInput['responseMode']): UnknownRecord {
  if (responseMode === 'debug') return result;
  if (responseMode === 'standard') {
    const { journal, ...standard } = result;
    return standard;
  }
  return {
    ok: result.ok,
    blocked: result.blocked,
    code: result.code,
    workflowId: result.workflowId,
    clientRequestId: result.clientRequestId,
    tracePath: result.tracePath,
    summary: result.summary,
    readiness: result.readiness,
    fieldCoverage: result.fieldCoverage,
    submissionPreview: result.submissionPreview,
    sourceInventorySummary: result.sourceInventorySummary,
    sourceMappingSummary: result.sourceMappingSummary,
    sourceCoverageReport: result.sourceCoverageReport,
    videoMetadataSummary: result.videoMetadataSummary,
    videoMetadataReport: result.videoMetadataReport,
    certificationOcr: result.certificationOcr,
    ocrFallback: result.ocrFallback,
    visionExtractionRequest: result.visionExtractionRequest,
    duplicateCheck: result.duplicateCheck,
    referenceResolution: result.referenceResolution,
    uploadSummary: result.uploadSummary,
    uploadErrors: result.uploadErrors,
    uploadQueueSummary: result.uploadQueueSummary,
    precheckIssues: result.precheckIssues,
    createResult: result.createResult,
    diffReport: result.diffReport,
    actionableIssues: result.actionableIssues,
    trace: result.trace
  };
}

function blockingResult(
  journal: WorkflowJournal,
  code: string,
  summary: string,
  extra: UnknownRecord,
  responseMode: ProductCreateFromPackageInput['responseMode']
) {
  const result = {
    ok: false,
    blocked: true,
    code,
    workflowId: journal.workflowId,
    clientRequestId: journal.clientRequestId,
    tracePath: workflowPath(journal.clientRequestId),
    summary,
    trace: buildProtocolTrace('product_create_from_package', journal.workflowId, journal.stages),
    journal,
    ...extra
  };
  return packageResult(result, responseMode);
}

export async function productCreateFromPackage(
  backend: BackendClient,
  rawInput: unknown,
  requestId: string,
  runtime: CreateFromPackageRuntime
) {
  const input = productCreateFromPackageObjectSchema.parse(rawInput);
  const clientRequestId = input.clientRequestId || defaultClientRequestId(input);
  let journal = (await readJournal(clientRequestId)) || initialJournal(input, clientRequestId);
  journal.status = input.runMode;
  await writeJournal(journal);

  if (input.runMode === 'create' && journal.productId) {
    const detail = await productGetDetail(backend, { productId: journal.productId, includeSections: input.includeDetailSections }, requestId);
    journal.snapshots = { ...(journal.snapshots || {}), idempotentReplayDetail: detail };
    addStage(journal, { name: 'idempotent_replay', ok: true, summary: `Existing product ${journal.productId} returned without another create call.` });
    await writeJournal(journal);
    return packageResult(
      {
        ok: true,
        reused: true,
        workflowId: journal.workflowId,
        clientRequestId,
        productId: journal.productId,
        tracePath: workflowPath(clientRequestId),
        detail,
        trace: buildProtocolTrace('product_create_from_package', journal.workflowId, journal.stages),
        journal
      },
      input.responseMode
    );
  }

  if (input.runMode === 'create' && input.confirm !== true) {
    addStage(journal, { name: 'confirm_create', ok: false, summary: 'confirm=true is required for create mode.' });
    await writeJournal(journal);
    return blockingResult(
      journal,
      'CONFIRM_REQUIRED',
      'runMode=create 必须传入 confirm=true。',
      { actionableIssues: toActionableIssues([{ code: 'CONFIRM_REQUIRED', message: 'runMode=create 必须传入 confirm=true。', severity: 'error', field: 'confirm' }]) },
      input.responseMode
    );
  }

  const certificationOcr =
    shouldRunCertificationOcr(input.ocrMode)
      ? await productOcrCertifications({
          packagePath: input.packagePath,
          markdownFileName: input.markdownFileName,
          mode: certificationOcrHelperMode(input.ocrMode),
          ocrOptions: input.ocrOptions
        })
      : undefined;
  if (certificationOcr) {
    journal.snapshots = { ...(journal.snapshots || {}), certificationOcr };
    addStage(journal, {
      name: 'ocr_certifications',
      ok: certificationOcr.ok === true,
      summary: certificationOcr.ocrSummary?.wrote ? 'OCR filled blank certification fields.' : 'OCR returned certification suggestions.',
      counts: certificationOcr.ocrSummary
        ? {
            scannedFileCount: certificationOcr.ocrSummary.scannedFileCount,
            ocrSuccessCount: certificationOcr.ocrSummary.ocrSuccessCount,
            ocrFailureCount: certificationOcr.ocrSummary.ocrFailureCount,
            autoFilledCount: certificationOcr.ocrSummary.autoFilledCount,
            suggestedCount: certificationOcr.ocrSummary.suggestedCount,
            needsManualCount: certificationOcr.ocrSummary.needsManualCount,
            conflictCount: certificationOcr.ocrSummary.conflictCount,
            skippedByDatePolicyCount: certificationOcr.ocrSummary.skippedByDatePolicyCount
          }
        : undefined
    });
    await writeJournal(journal);
    if (strictOcrMode(input.ocrMode) && certificationOcr.fallbackRequired === true) {
      return blockingResult(
        journal,
        String(certificationOcr.code || 'OCR_PROVIDER_UNAVAILABLE'),
        'Certification OCR failed in strict mode; no upload or create was attempted.',
        {
          certificationOcr,
          ocrFallback: {
            code: certificationOcr.code,
            fallbackRequired: certificationOcr.fallbackRequired,
            fallbackType: certificationOcr.fallbackType,
            visionExtractionRequest: certificationOcr.visionExtractionRequest,
            providerErrors: certificationOcr.providerErrors,
            warnings: certificationOcr.warnings
          },
          visionExtractionRequest: certificationOcr.visionExtractionRequest,
          actionableIssues: toActionableIssues([
            {
              code: String(certificationOcr.code || 'OCR_PROVIDER_UNAVAILABLE'),
              message: 'Certification OCR failed in strict mode. Use ocrMode=auto for Codex native vision fallback, or fill certification fields manually.',
              severity: 'error',
              field: 'ocrMode'
            }
          ])
        },
        input.responseMode
      );
    }
  }

  const precheck = (await precheckProductPackage({
    packagePath: input.packagePath,
    markdownFileName: input.markdownFileName,
    includeDraft: true,
    responseMode: 'standard',
    ocrMode: input.ocrMode === 'off' ? 'off' : 'suggest',
    ocrOptions: input.ocrOptions
  })) as UnknownRecord;
  journal.snapshots = {
    ...(journal.snapshots || {}),
    precheckSummary: precheck.summary,
    precheckReadiness: precheck.readiness,
    precheckIssues: precheck.issues,
    precheckFieldCoverage: precheck.fieldCoverage,
    precheckSubmissionPreview: precheck.submissionPreview,
    sourceInventorySummary: precheck.sourceInventorySummary,
    sourceMappingSummary: precheck.sourceMappingSummary,
    sourceCoverageReport: precheck.sourceCoverageReport,
    videoMetadataSummary: precheck.videoMetadataSummary,
    videoMetadataReport: precheck.videoMetadataReport,
    ocrFallback: precheck.ocrFallback,
    certificationOcr,
    draftCreateInput: precheck.draftCreateInput,
    uploadQueue: precheck.uploadQueue
  };
  addStage(journal, {
    name: 'precheck_package',
    ok: precheck.ok === true,
    counts: {
      uploadQueue: Array.isArray(precheck.uploadQueue) ? precheck.uploadQueue.length : 0,
      issueCount: Array.isArray(precheck.issues) ? precheck.issues.length : 0
    }
  });
  await writeJournal(journal);

  if (precheck.ok !== true || !isRecord(precheck.draftCreateInput)) {
    return blockingResult(
      journal,
      'PRECHECK_BLOCKED',
      '商品资料预检未通过，未进入上传或创建。',
      {
        precheck,
        ...precheckContext(precheck),
        readiness: precheck.readiness,
        certificationOcr,
        fieldCoverage: precheck.fieldCoverage,
        submissionPreview: precheck.submissionPreview,
        actionableIssues: precheck.actionableIssues || toActionableIssues(Array.isArray(precheck.issues) ? precheck.issues : [])
      },
      input.responseMode
    );
  }

  const draft = JSON.parse(JSON.stringify(precheck.draftCreateInput)) as UnknownRecord;
  const productNameCn = stringValue(draft.productNameCn);
  let duplicateCheck: UnknownRecord | undefined;
  if (productNameCn) {
    duplicateCheck = await productCheckNameDuplicate(backend, { productNameCn }, requestId);
    addStage(journal, { name: 'duplicate_check', ok: duplicateCheck.blocking !== true, counts: { duplicateCount: Number(duplicateCheck.duplicateCount || 0) } });
    await writeJournal(journal);
    if (duplicateCheck.blocking === true || duplicateCheck.exists === true) {
      return blockingResult(
        journal,
        'DUPLICATE_PRODUCT_NAME',
        '同名商品已存在，未上传、未创建。',
        {
          duplicateCheck,
          ...precheckContext(precheck),
          actionableIssues: toActionableIssues([{ code: 'DUPLICATE_PRODUCT_NAME', message: '同名商品已存在。', severity: 'error', field: 'productNameCn' }])
        },
        input.responseMode
      );
    }
  }

  const referenceResolution = await resolveReferences(backend, draft, requestId);
  journal.snapshots = { ...(journal.snapshots || {}), referenceResolution, resolvedDraftCreateInput: draft };
  addStage(journal, { name: 'resolve_references', ok: referenceResolution.ok, counts: { issueCount: referenceResolution.issues.length } });
  await writeJournal(journal);
  if (!referenceResolution.ok) {
    return blockingResult(
      journal,
      'REFERENCE_RESOLUTION_FAILED',
      '引用 ID 自动解析失败，未上传、未创建。',
      {
        duplicateCheck,
        referenceResolution,
        ...precheckContext(precheck),
        fieldCoverage: buildFieldCoverage(draft),
        submissionPreview: buildSubmissionPreview(draft),
        actionableIssues: toActionableIssues(referenceResolution.issues)
      },
      input.responseMode
    );
  }

  const uploadQueue = Array.isArray(precheck.uploadQueue) ? (precheck.uploadQueue as UnknownRecord[]) : [];
  const previewDraft = { ...draft, clientRequestId, previewOnly: true, mode: 'create' };
  const preview = buildSubmissionPreview(previewDraft);
  journal.snapshots = { ...(journal.snapshots || {}), previewDraft, preview };
  addStage(journal, { name: 'build_preview', ok: true, counts: preview.counts });
  await writeJournal(journal);

  if (input.runMode === 'preview') {
    return packageResult(
      {
        ok: true,
        previewOnly: true,
        workflowId: journal.workflowId,
        clientRequestId,
        tracePath: workflowPath(clientRequestId),
        summary: precheck.summary,
        readiness: precheck.readiness,
        duplicateCheck,
        referenceResolution,
        certificationOcr,
        ...precheckContext(precheck),
        fieldCoverage: buildFieldCoverage(previewDraft),
        submissionPreview: preview,
        actionableIssues: [],
        trace: buildProtocolTrace('product_create_from_package', journal.workflowId, journal.stages),
        draftCreateInput: input.responseMode === 'debug' ? previewDraft : undefined,
        journal
      },
      input.responseMode
    );
  }

  const uploadResult = await uploadAll(uploadQueue, draft, journal, runtime);
  journal.snapshots = {
    ...(journal.snapshots || {}),
    uploadSummary: uploadResult.uploadSummary,
    uploadErrors: uploadResult.failures,
    boundDraftCreateInput: uploadResult.boundDraft
  };
  addStage(journal, {
    name: 'upload_all',
    ok: uploadResult.failures.length === 0,
    counts: {
      total: uploadResult.uploadSummary.total,
      successCount: uploadResult.uploadSummary.successCount,
      errorCount: uploadResult.uploadSummary.errorCount
    }
  });
  await writeJournal(journal);

  if (uploadResult.failures.length > 0) {
    const boundPreview = buildSubmissionPreview(uploadResult.boundDraft);
    return blockingResult(
      journal,
      'UPLOAD_FAILED',
      '存在有效引用文件上传失败，已完成其余文件上传，但不会创建商品。',
      {
        duplicateCheck,
        referenceResolution,
        certificationOcr,
        ...precheckContext(precheck),
        uploadSummary: uploadResult.uploadSummary,
        uploadErrors: uploadResult.failures,
        fieldCoverage: buildFieldCoverage(uploadResult.boundDraft),
        submissionPreview: boundPreview,
        actionableIssues: toActionableIssues(
          uploadResult.failures.map((failure) => ({
            code: 'UPLOAD_FAILED',
            message: `${failure.sourceRelativePath || failure.sourceLocalPath || failure.key} 上传失败：${failure.error || 'unknown error'}`,
            severity: 'error',
            field: failure.sourceRelativePath || failure.sourceLocalPath || failure.key
          }))
        )
      },
      input.responseMode
    );
  }

  const createInput = {
    ...uploadResult.boundDraft,
    clientRequestId,
    confirm: true,
    mode: 'create'
  };
  const createPreview = buildSubmissionPreview(createInput);
  if (createPreview.riskSummary.unresolvedUrlFieldCount > 0) {
    return blockingResult(
      journal,
      'UNRESOLVED_UPLOAD_BINDING',
      '创建前仍存在上传占位符或本地路径，未调用 product_create。',
      {
        duplicateCheck,
        referenceResolution,
        ...precheckContext(precheck),
        uploadSummary: uploadResult.uploadSummary,
        fieldCoverage: buildFieldCoverage(createInput),
        submissionPreview: createPreview,
        actionableIssues: toActionableIssues(
          createPreview.risks.map((risk) => ({
            code: risk.code,
            message: `${risk.path} 仍未解析为可提交 URL。`,
            severity: 'error',
            field: risk.path
          }))
        )
      },
      input.responseMode
    );
  }

  const createResult = await productCreate(backend, createInput, requestId);
  const productId = stringValue((createResult as UnknownRecord).productId) || stringValue((createResult as UnknownRecord).id);
  if (productId) {
    journal.productId = productId;
    journal.status = 'created';
  }
  journal.snapshots = { ...(journal.snapshots || {}), createInput, createPreview, createResult };
  addStage(journal, { name: 'create_product', ok: Boolean(productId), summary: productId ? `Created product ${productId}.` : 'Create returned without productId.' });
  await writeJournal(journal);

  const detail = productId ? await productGetDetail(backend, { productId, includeSections: input.includeDetailSections }, requestId) : undefined;
  const diffReport = buildDiffReport(createInput, isRecord(detail) ? detail : undefined);
  journal.snapshots = { ...(journal.snapshots || {}), detail, diffReport };
  addStage(journal, { name: 'verify_detail', ok: Boolean(detail), counts: { missingInDetail: diffReport.missingInDetail.length, backendChanged: diffReport.backendChanged.length } });
  await writeJournal(journal);

  return packageResult(
    {
      ok: true,
      workflowId: journal.workflowId,
      clientRequestId,
      productId,
      tracePath: workflowPath(clientRequestId),
      summary: precheck.summary,
      readiness: {
        ...(precheck.readiness as UnknownRecord),
        uploadedCount: uploadResult.uploadSummary.successCount,
        uploadErrorCount: uploadResult.uploadSummary.errorCount
      },
      duplicateCheck,
      referenceResolution,
      certificationOcr,
      ...precheckContext(precheck),
      uploadSummary: uploadResult.uploadSummary,
      createResult,
      detail,
      diffReport,
      fieldCoverage: buildFieldCoverage(createInput),
      submissionPreview: createPreview,
      trace: buildProtocolTrace('product_create_from_package', journal.workflowId, journal.stages),
      journal
    },
    input.responseMode
  );
}

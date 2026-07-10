import { constants as fsConstants } from 'node:fs';
import { access, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as z from 'zod/v4';
import { applyMaterialTemplate, parseMarkdownTables, type MaterialTemplateIssue, type TableMergeSpec } from './materialTemplate.js';
import {
  directParentCategoryFromPath,
  resolveMediaClassification,
  sourceClassificationFromRecord,
  validateMediaClassificationRow,
  type MediaClassificationKind
} from './classificationBoundary.js';
import { buildSourceCoverageAudit } from './sourceCoverageAudit.js';
import { collectSourceInventory, sourceInventorySummary } from './sourceInventory.js';
import { mapSourcesToStructuredRows } from './sourceTargetMapper.js';
import { assertMaterialPackageWrite } from './materialWriteBoundary.js';
import {
  isTestingVideoMetadataSidecar,
  resolveTestingVideoMetadata,
  testingVideoCategoryFromValue,
  videoMetadataForPath,
  type TestingVideoCandidate,
  type VideoMetadataResolution
} from './videoMetadataPairs.js';

type UnknownRow = Record<string, unknown>;
type IssueSeverity = 'error' | 'warning' | 'info';

export const batchMaterialPackageInputSchema = {
  materialsRoot: z.string().trim().min(1).describe('Root directory containing one material folder per product.'),
  rows: z.array(z.record(z.string(), z.unknown())).min(1).describe('Spreadsheet rows. row.productNameCn is used for exact folder matching.'),
  templatePath: z.string().trim().optional().describe('Optional 商品资料模板.md path. Defaults to templates/商品资料模板.md.'),
  markdownFileName: z.string().trim().default('商品资料.md'),
  dryRun: z.boolean().default(false)
};

const batchMaterialPackageObjectSchema = z.object(batchMaterialPackageInputSchema);
export type BatchMaterialPackageInput = z.infer<typeof batchMaterialPackageObjectSchema>;

export interface BatchMaterialIssue {
  severity: IssueSeverity;
  code: string;
  message: string;
  rowIndex?: number;
  productNameCn?: string;
  packageDir?: string;
  field?: string;
}

export interface BatchMaterialRowResult {
  rowIndex: number;
  productNameCn?: string;
  ok: boolean;
  status: 'created' | 'updated' | 'rebuilt' | 'missing' | 'error' | 'dryRun';
  packageDir?: string;
  markdownPath?: string;
  wrote: boolean;
  templateMode?: 'created' | 'updated' | 'rebuilt';
  fieldCount: number;
  classifiedCounts?: Record<string, number>;
  sourceInventorySummary?: ReturnType<typeof sourceInventorySummary>;
  sourceCoverageSummary?: ReturnType<typeof buildSourceCoverageAudit>['summary'];
  videoMetadataSummary?: VideoMetadataResolution['summary'];
  videoMetadataReport?: VideoMetadataResolution['reports'];
  issues: BatchMaterialIssue[];
}

export interface BatchMaterialPackageResult {
  ok: boolean;
  summary: {
    totalRows: number;
    preparedCount: number;
    missingPackageCount: number;
    errorCount: number;
    dryRun: boolean;
  };
  results: BatchMaterialRowResult[];
  issues: BatchMaterialIssue[];
}

export interface PreparedBatchMaterialPackageResult {
  ok: boolean;
  packageDir?: string;
  markdownPath?: string;
  status: BatchMaterialRowResult['status'];
  wrote: boolean;
  issues: BatchMaterialIssue[];
  result?: BatchMaterialRowResult;
}

interface FileInventoryItem {
  absolutePath: string;
  relativePath: string;
  fileName: string;
  baseName: string;
  ext: string;
  size: number;
  lowerSearchText: string;
  pathParts: string[];
}

interface ClassifiedMaterialRows {
  productImages: Array<Record<string, string>>;
  productMedia: Array<Record<string, string>>;
  detailCards: Array<Record<string, string>>;
  richTextMaterials: Array<Record<string, string>>;
  advantageRows: Array<Record<string, string>>;
  scenarioRows: Array<Record<string, string>>;
  faqRows: Array<Record<string, string>>;
  afterSalesRows: Array<Record<string, string>>;
  warrantyRows: Array<Record<string, string>>;
  certifications: Array<Record<string, string>>;
  caseRows: Array<Record<string, string>>;
  caseMediaRows: Array<Record<string, string>>;
  accessoryRows: Array<Record<string, string>>;
  spareRows: Array<Record<string, string>>;
  wearPartRows: Array<Record<string, string>>;
  testingVideoSidecarPaths: string[];
  issues: BatchMaterialIssue[];
  counts: Record<string, number>;
}

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png']);
const VIDEO_EXTENSIONS = new Set(['mp4']);
const MODEL_EXTENSIONS = new Set(['glb']);
const PDF_EXTENSIONS = new Set(['pdf']);
const RICH_TEXT_ATTACHMENT_EXTENSIONS = new Set(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'pdf', 'txt', 'rar', '7z', 'csv']);

const PRODUCT_NAME_ALIASES = ['productNameCn', '商品中文名称', '商品中文名', '商品名称'];

function normalizeKey(key: string): string {
  return key.trim().toLowerCase().replace(/[\s_\-/.（）()]+/g, '');
}

function stringifyCell(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.map((item) => stringifyCell(item)).filter(Boolean).join('、');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value).trim();
}

function findCell(row: UnknownRow, aliases: string[]): { found: boolean; value: string; raw?: unknown } {
  for (const alias of aliases) {
    if (Object.prototype.hasOwnProperty.call(row, alias)) {
      return { found: true, value: stringifyCell(row[alias]), raw: row[alias] };
    }
  }

  const normalizedAliases = new Set(aliases.map(normalizeKey));
  for (const [key, value] of Object.entries(row)) {
    if (normalizedAliases.has(normalizeKey(key))) {
      return { found: true, value: stringifyCell(value), raw: value };
    }
  }

  return { found: false, value: '' };
}

function normalizeNumberText(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  const normalized = trimmed
    .replace(/,/g, '')
    .replace(/%$/g, '')
    .replace(/\s*(mm|毫米|kg|公斤|千克|人民币|美元|usd|rmb|元)$/i, '')
    .trim();
  return normalized || trimmed;
}

function normalizeProductType(value: string): string {
  const text = value.trim();
  const map: Record<string, string> = {
    '1': '整机',
    '2': '配件',
    '3': '服务',
    machine: '整机',
    accessory: '配件',
    service: '服务'
  };
  return map[text.toLowerCase()] || text;
}

function normalizeStatus(value: string): string {
  const text = value.trim();
  const map: Record<string, string> = {
    '1': '上架',
    '2': '下架',
    '3': '作废',
    active: '上架',
    inactive: '下架',
    disabled: '作废'
  };
  return map[text.toLowerCase()] || text;
}

function splitCategoryPath(value: string): string[] {
  return value
    .split(/\s*(?:>|\/|\\|》|＞|,|，)\s*/g)
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 3);
}

function splitRegionNames(value: string): string[] {
  return value
    .split(/\s*(?:,|，|;|；|\/|\\|\n|、)\s*/g)
    .map((part) => part.trim())
    .filter(Boolean);
}

function fieldValue(markdown: string | undefined, fieldName: string): string {
  if (!markdown) return '';
  for (const table of parseMarkdownTables(markdown)) {
    if (!table.headers.includes('字段') || !table.headers.includes('填写值')) continue;
    for (const row of table.rows) {
      if (row['字段'] === fieldName) return row['填写值'] || '';
    }
  }
  return '';
}

function buildFieldUpdates(row: UnknownRow): Record<string, string> {
  const fields: Record<string, string> = {};

  const setFromAliases = (field: string, aliases: string[], normalizer: (value: string) => string = (value) => value.trim()) => {
    const cell = findCell(row, aliases);
    if (cell.found) fields[field] = normalizer(cell.value);
  };

  const category = findCell(row, ['分类', '分类路径', 'category', 'categoryPath']);
  if (category.found) {
    const parts = splitCategoryPath(category.value);
    if (parts[0] !== undefined) fields['一级分类'] = parts[0];
    if (parts[1] !== undefined) fields['二级分类'] = parts[1];
    if (parts[2] !== undefined) fields['三级分类'] = parts[2];
  }

  setFromAliases('商品中文名称', PRODUCT_NAME_ALIASES);
  setFromAliases('产品类型', ['产品类型', 'productType', 'productTypeName'], normalizeProductType);
  setFromAliases('一级分类', ['一级分类', 'categoryFirstName', 'firstCategoryName']);
  setFromAliases('二级分类', ['二级分类', 'categorySecondName', 'secondCategoryName']);
  setFromAliases('三级分类', ['三级分类', 'categoryThirdName', 'thirdCategoryName']);
  setFromAliases('产品型号', ['产品型号', 'productModel', 'spuModel', 'model']);
  setFromAliases('计量单位', ['计量单位', 'unitName', 'unit']);
  setFromAliases('上架状态', ['上架状态', 'status', 'listingStatus'], normalizeStatus);
  setFromAliases('供应商', ['供应商', 'supplierName', 'supplier']);
  setFromAliases('产品等级', ['产品等级', 'level', 'productLevel']);
  setFromAliases('参考成本价 人民币', ['参考成本价 人民币', '参考成本价人民币', 'referenceCostCny', 'costCny'], normalizeNumberText);
  setFromAliases('参考成本价 美元', ['参考成本价 美元', '参考成本价美元', 'referenceCostUsd', 'costUsd'], normalizeNumberText);
  setFromAliases('利润率 %', ['利润率 %', '利润率', 'profitMargin'], normalizeNumberText);
  setFromAliases('包装长 mm', ['包装长 mm', '包装长', 'packLength', 'packageLength', 'lengthMm'], normalizeNumberText);
  setFromAliases('包装宽 mm', ['包装宽 mm', '包装宽', 'packWidth', 'packageWidth', 'widthMm'], normalizeNumberText);
  setFromAliases('包装高 mm', ['包装高 mm', '包装高', 'packHeight', 'packageHeight', 'heightMm'], normalizeNumberText);
  setFromAliases('包装重量 kg', ['包装重量 kg', '包装重量', '毛重', '毛重 kg', 'grossWeight', 'grossWeightKg', 'packWeight', 'packageWeight'], normalizeNumberText);
  setFromAliases('包装费', ['包装费', 'packingFee', 'packageFee'], normalizeNumberText);

  const scope = findCell(row, ['适用范围/区域', '适用范围', 'applicableScope', 'regionScope', 'salesScope']);
  if (scope.found) {
    const scopeValue = scope.value.trim();
    if (scopeValue === '全球' || /^all$/i.test(scopeValue) || /^global$/i.test(scopeValue)) {
      fields['适用范围'] = '全球';
    } else if (scopeValue === '指定区域') {
      fields['适用范围'] = '指定区域';
    } else if (scopeValue) {
      fields['适用范围'] = '指定区域';
    } else {
      fields['适用范围'] = '';
    }
  }

  return fields;
}

function regionRowsFromRow(row: UnknownRow): Array<Record<string, string>> {
  const scope = findCell(row, ['适用范围/区域', '适用范围', 'applicableScope', 'regionScope', 'salesScope']);
  const explicitRegions = findCell(row, ['适用区域', '区域', '区域名称', 'regions', 'regionName', 'applicableRegions']);
  const regionSource =
    explicitRegions.found && explicitRegions.value
      ? explicitRegions.value
      : scope.found && scope.value && !['全球', '指定区域'].includes(scope.value.trim())
        ? scope.value
        : '';

  return splitRegionNames(regionSource).map((regionName, index) => ({
    区域名称: regionName,
    排序: String(index + 1)
  }));
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function moduleRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

async function readTemplateMarkdown(templatePath?: string): Promise<{ markdown: string; path: string }> {
  const candidates = [
    templatePath ? path.resolve(templatePath) : undefined,
    path.join(process.cwd(), 'templates', '商品资料模板.md'),
    path.join(moduleRoot(), 'templates', '商品资料模板.md')
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    if (!(await fileExists(candidate))) continue;
    return {
      markdown: await readFile(candidate, 'utf8'),
      path: candidate
    };
  }

  throw new Error(`商品资料模板.md not found. Tried: ${candidates.join(', ')}`);
}

function toMarkdownRelativePath(packageDir: string, absolutePath: string): string {
  const relative = path.relative(packageDir, absolutePath).replace(/\\/g, '/');
  return relative.startsWith('.') ? relative : `./${relative}`;
}

function normalizeMaterialRelativePath(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

function extractReferencedMaterialPaths(markdown: string | undefined): Set<string> {
  const paths = new Set<string>();
  if (!markdown) return paths;

  const pathHeaders = new Set(['文件路径', '主图路径', '图片路径', '附件路径', '文件路径或内容']);
  for (const table of parseMarkdownTables(markdown)) {
    for (const row of table.rows) {
      for (const header of table.headers) {
        if (!pathHeaders.has(header)) continue;
        const value = stringifyCell(row[header]);
        if (!value || /^https?:\/\//i.test(value) || value.startsWith('{{')) continue;
        if (!/[\\/]/.test(value) && !/\.[a-z0-9]{2,5}$/i.test(value)) continue;
        paths.add(normalizeMaterialRelativePath(value));
      }
    }
  }

  return paths;
}

async function collectMaterialFiles(packageDir: string, markdownFileName: string): Promise<FileInventoryItem[]> {
  const files: FileInventoryItem[] = [];
  const ignoredDirs = new Set(['.git', '.generated', 'node_modules']);

  async function walk(currentDir: string): Promise<void> {
    const entries = await readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (ignoredDirs.has(entry.name)) continue;
        await walk(path.join(currentDir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name === markdownFileName) continue;

      const absolutePath = path.join(currentDir, entry.name);
      const stats = await stat(absolutePath);
      const relativePath = toMarkdownRelativePath(packageDir, absolutePath);
      const fileName = entry.name;
      const ext = path.extname(fileName).replace(/^\./, '').toLowerCase();
      const baseName = path.basename(fileName, path.extname(fileName));
      const pathParts = relativePath.split('/').filter(Boolean);
      files.push({
        absolutePath,
        relativePath,
        fileName,
        baseName,
        ext,
        size: stats.size,
        lowerSearchText: `${relativePath} ${baseName}`.toLowerCase(),
        pathParts
      });
    }
  }

  await walk(packageDir);
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath, 'zh-Hans-CN'));
}

function includesAny(text: string, needles: string[]): boolean {
  return needles.some((needle) => text.includes(needle.toLowerCase()));
}

function isImage(file: FileInventoryItem): boolean {
  return IMAGE_EXTENSIONS.has(file.ext);
}

function isVideo(file: FileInventoryItem): boolean {
  return VIDEO_EXTENSIONS.has(file.ext);
}

function isModel(file: FileInventoryItem): boolean {
  return MODEL_EXTENSIONS.has(file.ext);
}

function isPdf(file: FileInventoryItem): boolean {
  return PDF_EXTENSIONS.has(file.ext);
}

function isRichTextAttachment(file: FileInventoryItem): boolean {
  return RICH_TEXT_ATTACHMENT_EXTENSIONS.has(file.ext);
}

function pathSuggestsCertification(file: FileInventoryItem): boolean {
  return includesAny(file.lowerSearchText, ['认证', '证书', '检测', '报告', 'certificate', 'certification', 'ce', 'fcc', 'iso', 'rohs']);
}

function certificationKey(file: FileInventoryItem): string {
  const withoutCertificateWords = file.baseName.replace(
    /(证书|认证|检测报告|检测|报告|certificate|certification|cert|report)/gi,
    ' '
  );
  const withoutAuxiliarySuffix = withoutCertificateWords.replace(
    /(?:[-_\s]*(?:main|cover|front|preview|thumb|thumbnail|page[-_\s]*\d+|p\d+|render(?:ed)?|screenshot|scan|主图|封面图?|首页|第一页|渲染图|截图))+$/gi,
    ''
  );
  const normalized = withoutAuxiliarySuffix
    .trim()
    .toLowerCase()
    .replace(/[\s_\-./()（）]+/g, '');
  return normalized || file.baseName.trim().toLowerCase().replace(/[\s_\-./()（）]+/g, '');
}

function certificationDisplayName(file: FileInventoryItem): string {
  const cleaned = file.baseName
    .replace(/(证书|认证|检测报告|检测|报告|certificate|certification|cert|report)/gi, '')
    .replace(/(?:[-_\s]*(?:main|cover|front|preview|thumb|thumbnail|page[-_\s]*\d+|p\d+|render(?:ed)?|screenshot|scan|主图|封面图?|首页|第一页|渲染图|截图))+$/gi, '')
    .trim();
  return cleaned || file.baseName;
}

function isCertificateAuxiliaryImage(file: FileInventoryItem): boolean {
  if (!isImage(file)) return false;
  const base = file.baseName.toLowerCase();
  return (
    /(^|[-_\s])(main|cover|front|preview|thumb|thumbnail|page[-_\s]*\d+|p\d+|render(?:ed)?|screenshot|scan)([-_\s]|$)/i.test(base) ||
    /(主图|封面图?|首页|第一页|渲染图|截图)/.test(file.baseName)
  );
}

function pathSuggestsCase(file: FileInventoryItem): boolean {
  return includesAny(file.lowerSearchText, ['案例', '客户', 'case', 'customer']);
}

function pathSuggestsPart(file: FileInventoryItem): boolean {
  return includesAny(file.lowerSearchText, ['配件', '备件', '易损', 'parts', 'spare', 'accessor']);
}

function partKind(file: FileInventoryItem): 'accessory' | 'spare' | 'wear' {
  if (includesAny(file.lowerSearchText, ['备件', 'spare'])) return 'spare';
  if (includesAny(file.lowerSearchText, ['易损', 'wear'])) return 'wear';
  return 'accessory';
}

function productImageLabel(file: FileInventoryItem): string | undefined {
  const text = file.lowerSearchText;
  if (includesAny(text, ['主图', 'main', 'cover', '封面'])) return '商品主图';
  if (includesAny(text, ['banner', '横幅', '头图', '海报'])) return 'Banner 图';
  if (includesAny(text, ['细节', 'detail-image'])) return '细节图';
  if (includesAny(text, ['尺寸', '尺码', 'size'])) return '尺寸图';
  if (includesAny(text, ['场景', '应用', 'scene', 'scenario'])) return '场景图';
  if (includesAny(text, ['包装', 'package', 'packing'])) return '包装图';
  if (includesAny(text, ['多角度', '实拍', 'multi-angle', 'multiangle'])) return '多角度实拍图';
  if (includesAny(text, ['配件图', 'accessories'])) return '配件图';
  return undefined;
}

function videoLabel(file: FileInventoryItem): string {
  const text = file.lowerSearchText;
  if (includesAny(text, ['装柜', 'loading'])) return '装柜视频';
  if (includesAny(text, ['作业', 'work'])) return '作业视频';
  if (includesAny(text, ['安装', 'install'])) return '安装视频';
  if (includesAny(text, ['包装', 'packing', 'package'])) return '包装视频';
  if (includesAny(text, ['链界', 'link'])) return '链界实测视频';
  if (includesAny(text, ['三方', 'third'])) return '三方实测视频';
  return '实拍视频';
}

function testingVideoCandidates(
  files: FileInventoryItem[],
  existingMarkdown: string | undefined,
  sourceClassification: string
): TestingVideoCandidate[] {
  const candidates = new Map<string, TestingVideoCandidate>();
  const keyFor = (value: string) => normalizeMaterialRelativePath(value);

  if (existingMarkdown) {
    const table = parseMarkdownTables(existingMarkdown).find(
      (candidate) =>
        candidate.heading.includes('商品视频、3D 与附件') &&
        candidate.headers.includes('资料用途') &&
        candidate.headers.includes('文件路径')
    );
    table?.rows.forEach((row, index) => {
      const categoryLabel = testingVideoCategoryFromValue(row['资料用途'] || '');
      const videoPath = String(row['文件路径'] || '').trim();
      if (!categoryLabel || !videoPath) return;
      const normalizedVideoPath = videoPath.replace(/\\/g, '/');
      const fallbackTitle = path.posix.basename(normalizedVideoPath, path.posix.extname(normalizedVideoPath));
      const existingTitle = String(row['标题'] || '').trim();
      candidates.set(keyFor(videoPath), {
        videoPath,
        categoryLabel,
        title: existingTitle === fallbackTitle ? undefined : existingTitle,
        description: row['描述'],
        remark: row['备注'],
        row: index + 1
      });
    });
  }

  for (const file of files.filter(isVideo)) {
    const decision = resolveMediaClassification({
      kind: 'media',
      directParentCategory: directParentCategoryFromPath(file.relativePath),
      fallbackLabel: videoLabel(file),
      sourceClassification
    });
    const categoryLabel = testingVideoCategoryFromValue(decision.label);
    const key = keyFor(file.relativePath);
    if (!categoryLabel || candidates.has(key)) continue;
    candidates.set(key, {
      videoPath: file.relativePath,
      categoryLabel,
      remark: decision.remark
    });
  }

  return [...candidates.values()];
}

function customerNameFromPath(file: FileInventoryItem): string {
  const parts = file.pathParts.map((part) => part.replace(/^\.+\//, ''));
  const caseIndex = parts.findIndex((part) => includesAny(part.toLowerCase(), ['案例', '客户', 'case', 'customer']));
  const nextPart = caseIndex >= 0 ? parts[caseIndex + 1] : undefined;
  if (nextPart && nextPart !== file.fileName) return path.basename(nextPart, path.extname(nextPart));

  const parent = parts.length > 1 ? parts[parts.length - 2] : '';
  if (parent && !includesAny(parent.toLowerCase(), ['案例', '客户', 'case', 'customer'])) return parent;
  return file.baseName;
}

function increment(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] || 0) + 1;
}

function classifyMaterialFiles(
  files: FileInventoryItem[],
  productNameCn: string,
  sourceClassification = '',
  boundRelativePaths: Set<string> = new Set(),
  videoMetadata?: VideoMetadataResolution
): ClassifiedMaterialRows {
  const classified: ClassifiedMaterialRows = {
    productImages: [],
    productMedia: [],
    detailCards: [],
    richTextMaterials: [],
    advantageRows: [],
    scenarioRows: [],
    faqRows: [],
    afterSalesRows: [],
    warrantyRows: [],
    certifications: [],
    caseRows: [],
    caseMediaRows: [],
    accessoryRows: [],
    spareRows: [],
    wearPartRows: [],
    testingVideoSidecarPaths: videoMetadata ? [...videoMetadata.sidecarTextPaths] : [],
    issues: [],
    counts: {}
  };

  const singletonImageLabels = new Set(['商品主图', 'Banner 图']);
  const usedSingletonImageLabels = new Set<string>();
  const certRowsByName = new Map<string, Record<string, string>>();
  const certImageCandidatesByName = new Map<string, FileInventoryItem[]>();
  const caseRowsByCustomer = new Map<string, Record<string, string>>();
  const partRowsByKindAndName = new Map<string, Record<string, string>>();

  const classifyMedia = (kind: MediaClassificationKind, file: FileInventoryItem, fallbackLabel: string) =>
    resolveMediaClassification({
      kind,
      directParentCategory: directParentCategoryFromPath(file.relativePath),
      fallbackLabel,
      sourceClassification
    });

  const withClassificationRemark = (row: Record<string, string>, remark?: string): Record<string, string> => {
    if (remark) row['备注'] = row['备注'] ? `${row['备注']}；${remark}` : remark;
    return row;
  };

  const pushProductImage = (label: string, file: FileInventoryItem) => {
    const decision = classifyMedia('image', file, label);
    label = decision.label;
    if (singletonImageLabels.has(label)) {
      if (usedSingletonImageLabels.has(label)) {
        classified.issues.push({
          severity: 'warning',
          code: 'MULTIPLE_SINGLETON_MEDIA_CANDIDATES',
          productNameCn,
          message: `${label} 识别到多个候选文件，已保留排序最靠前的一个：${file.relativePath}`
        });
        return;
      }
      usedSingletonImageLabels.add(label);
    }
    classified.productImages.push(withClassificationRemark({
      图片用途: label,
      文件路径: file.relativePath,
      标题: file.baseName
    }, decision.remark));
    increment(classified.counts, 'productImages');
  };

  const attachCertificationMainImage = (key: string, row: Record<string, string>) => {
    if (row['主图路径']) return;
    const candidates = certImageCandidatesByName.get(key);
    if (!candidates?.length) return;
    const preferred = candidates.sort((a, b) => Number(!isCertificateAuxiliaryImage(a)) - Number(!isCertificateAuxiliaryImage(b)))[0];
    row['主图路径'] = preferred.relativePath;
    increment(classified.counts, 'certificationImagesBound');
  };

  const rememberCertificationImage = (file: FileInventoryItem) => {
    const key = certificationKey(file);
    const existingRow = certRowsByName.get(key);
    if (existingRow?.['文件路径'] && !existingRow['主图路径']) {
      existingRow['主图路径'] = file.relativePath;
      increment(classified.counts, 'certificationImagesBound');
      return;
    }
    const candidates = certImageCandidatesByName.get(key) || [];
    candidates.push(file);
    certImageCandidatesByName.set(key, candidates);
    increment(classified.counts, 'certificationImageCandidates');
  };

  const pushCertification = (file: FileInventoryItem) => {
    if (isImage(file)) {
      rememberCertificationImage(file);
      return;
    }
    if (!isPdf(file)) return;

    const key = certificationKey(file);
    const created = !certRowsByName.has(key);
    const row = certRowsByName.get(key) || { 证书名称: certificationDisplayName(file), 文件分类: '认证资料' };
    row['文件路径'] = file.relativePath;
    certRowsByName.set(key, row);
    attachCertificationMainImage(key, row);
    if (created) increment(classified.counts, 'certifications');
  };

  const pushCase = (file: FileInventoryItem) => {
    if (!isImage(file) && !isVideo(file)) return;
    const customerName = customerNameFromPath(file);
    if (!caseRowsByCustomer.has(customerName)) {
      caseRowsByCustomer.set(customerName, {
        客户名称: customerName,
        产品名称: productNameCn
      });
    }
    classified.caseMediaRows.push({
      所属客户名称: customerName,
      媒体类型: isVideo(file) ? '视频' : '图片',
      文件路径: file.relativePath,
      媒体名称: file.baseName
    });
    increment(classified.counts, 'caseMedia');
  };

  const pushPart = (file: FileInventoryItem) => {
    const kind = partKind(file);
    const key = `${kind}:${file.baseName}`;
    const row = partRowsByKindAndName.get(key) || { 名称: file.baseName };
    if (isImage(file)) row['图片路径'] = file.relativePath;
    else if (isPdf(file)) row['附件路径'] = file.relativePath;
    else return;
    partRowsByKindAndName.set(key, row);
    increment(classified.counts, `${kind}PartRows`);
  };

  for (const file of files) {
    if (isTestingVideoMetadataSidecar(videoMetadata, file.relativePath)) {
      increment(classified.counts, 'testingVideoMetadataSidecars');
      continue;
    }

    const testingMetadata = isVideo(file) ? videoMetadataForPath(videoMetadata, file.relativePath) : undefined;
    if (boundRelativePaths.has(normalizeMaterialRelativePath(file.relativePath)) && !testingMetadata) {
      increment(classified.counts, 'alreadyBoundFilesSkipped');
      continue;
    }

    if (pathSuggestsCertification(file)) {
      pushCertification(file);
      continue;
    }

    if (pathSuggestsCase(file)) {
      pushCase(file);
      continue;
    }

    if (pathSuggestsPart(file)) {
      pushPart(file);
      continue;
    }

    if (isImage(file)) {
      const imageLabel = productImageLabel(file) || '图片';
      pushProductImage(imageLabel, file);
      continue;
    }

    if (isVideo(file)) {
      const decision = classifyMedia('media', file, videoLabel(file));
      classified.productMedia.push(withClassificationRemark({
        资料用途: decision.label,
        文件路径: file.relativePath,
        标题: testingMetadata?.title || file.baseName,
        描述: testingMetadata?.description || '',
        备注: testingMetadata?.effectiveRemark || ''
      }, decision.remark));
      increment(classified.counts, 'productMedia');
      continue;
    }

    if (isModel(file)) {
      const decision = classifyMedia('media', file, '3D 展示');
      classified.productMedia.push(withClassificationRemark({
        资料用途: decision.label,
        文件路径: file.relativePath,
        标题: file.baseName
      }, decision.remark));
      increment(classified.counts, 'models3d');
      continue;
    }

    if (isPdf(file)) {
      const decision = classifyMedia('media', file, '商品附件');
      classified.productMedia.push(withClassificationRemark({
        资料用途: decision.label,
        文件路径: file.relativePath,
        标题: file.baseName
      }, decision.remark));
      increment(classified.counts, 'productAttachments');
      continue;
    }

    if (isRichTextAttachment(file)) {
      const decision = classifyMedia('richText', file, '富文本附件');
      classified.richTextMaterials.push(withClassificationRemark({
        资料用途: decision.label,
        文件路径或内容: file.relativePath,
        标题: file.baseName
      }, decision.remark));
      increment(classified.counts, 'richTextMaterials');
    }
  }

  classified.certifications = [...certRowsByName.values()];
  classified.caseRows = [...caseRowsByCustomer.values()];

  for (const [key, row] of partRowsByKindAndName.entries()) {
    if (key.startsWith('spare:')) classified.spareRows.push(row);
    else if (key.startsWith('wear:')) classified.wearPartRows.push(row);
    else classified.accessoryRows.push(row);
  }

  return classified;
}

function buildTableMerges(classified: ClassifiedMaterialRows, regionRows: Array<Record<string, string>>): TableMergeSpec[] {
  return [
    {
      headingIncludes: '地域信息',
      requiredHeaders: ['区域名称', '区域ID'],
      rows: regionRows,
      uniqueHeaders: ['区域名称']
    },
    {
      headingIncludes: '商品图片',
      requiredHeaders: ['图片用途', '文件路径'],
      rows: classified.productImages,
      pathHeaders: ['文件路径'],
      labelHeader: '图片用途',
      singletonLabels: ['商品主图', 'Banner 图']
    },
    {
      headingIncludes: '商品视频、3D 与附件',
      requiredHeaders: ['资料用途', '文件路径'],
      rows: classified.productMedia,
      pathHeaders: ['文件路径'],
      labelHeader: '资料用途',
      replaceFileStemHeaders: ['标题']
    },
    {
      headingIncludes: '图文详情卡片',
      requiredHeaders: ['标题', '图片路径'],
      rows: classified.detailCards,
      pathHeaders: ['图片路径'],
      uniqueHeaders: ['图片路径']
    },
    {
      headingIncludes: '图文详情富文本素材',
      requiredHeaders: ['资料用途', '文件路径或内容'],
      rows: classified.richTextMaterials,
      pathHeaders: ['文件路径或内容'],
      labelHeader: '资料用途',
      removePathValues: classified.testingVideoSidecarPaths
    },
    {
      headingIncludes: '核心优势',
      requiredHeaders: ['标题', '内容'],
      rows: classified.advantageRows,
      pathHeaders: ['图片路径'],
      uniqueHeaders: ['标题']
    },
    {
      headingIncludes: '应用场景',
      requiredHeaders: ['标题', '内容'],
      rows: classified.scenarioRows,
      pathHeaders: ['图片路径'],
      uniqueHeaders: ['标题']
    },
    {
      headingIncludes: '常见问题',
      requiredHeaders: ['问题', '回答'],
      rows: classified.faqRows,
      uniqueHeaders: ['问题']
    },
    {
      headingIncludes: '售后服务承诺',
      requiredHeaders: ['承诺事项', '说明'],
      rows: classified.afterSalesRows,
      uniqueHeaders: ['承诺事项']
    },
    {
      requiredHeaders: ['政策标题', '政策内容'],
      rows: classified.warrantyRows,
      uniqueHeaders: ['政策标题']
    },
    {
      headingIncludes: '认证资料',
      requiredHeaders: ['证书名称', '文件路径', '主图路径'],
      rows: classified.certifications,
      pathHeaders: ['文件路径', '主图路径'],
      uniqueHeaders: ['证书名称']
    },
    {
      headingIncludes: '客户案例',
      requiredHeaders: ['客户名称', '产品名称'],
      rows: classified.caseRows,
      uniqueHeaders: ['客户名称']
    },
    {
      headingIncludes: '客户案例',
      requiredHeaders: ['所属客户名称', '文件路径'],
      rows: classified.caseMediaRows,
      pathHeaders: ['文件路径'],
      uniqueHeaders: ['所属客户名称', '文件路径']
    },
    {
      headingIncludes: '配件清单',
      requiredHeaders: ['名称', '图片路径', '附件路径'],
      rows: classified.accessoryRows,
      pathHeaders: ['图片路径', '附件路径'],
      uniqueHeaders: ['名称']
    },
    {
      headingIncludes: '备件清单',
      requiredHeaders: ['名称', '图片路径', '附件路径'],
      rows: classified.spareRows,
      pathHeaders: ['图片路径', '附件路径'],
      uniqueHeaders: ['名称']
    },
    {
      headingIncludes: '易损件清单',
      requiredHeaders: ['名称', '图片路径', '附件路径'],
      rows: classified.wearPartRows,
      pathHeaders: ['图片路径', '附件路径'],
      uniqueHeaders: ['名称']
    }
  ];
}

function templateIssuesToBatchIssues(
  issues: MaterialTemplateIssue[],
  rowIndex: number,
  productNameCn: string | undefined,
  packageDir: string
): BatchMaterialIssue[] {
  return issues.map((issue) => ({
    severity: issue.severity,
    code: issue.code,
    message: issue.message,
    rowIndex,
    productNameCn,
    packageDir,
    field: issue.field
  }));
}

function mediaClassificationIssues(
  markdown: string,
  rowIndex: number,
  productNameCn: string | undefined,
  packageDir: string
): BatchMaterialIssue[] {
  const issues: BatchMaterialIssue[] = [];
  const tables = parseMarkdownTables(markdown);
  const checks: Array<{
    headingIncludes: string;
    labelHeader: string;
    pathHeader: string;
    kind: MediaClassificationKind;
  }> = [
    { headingIncludes: '商品图片', labelHeader: '图片用途', pathHeader: '文件路径', kind: 'image' },
    { headingIncludes: '商品视频、3D 与附件', labelHeader: '资料用途', pathHeader: '文件路径', kind: 'media' },
    { headingIncludes: '图文详情', labelHeader: '资料用途', pathHeader: '文件路径或内容', kind: 'richText' }
  ];

  for (const check of checks) {
    const table = tables.find(
      (candidate) =>
        candidate.heading.includes(check.headingIncludes) &&
        candidate.headers.includes(check.labelHeader) &&
        candidate.headers.includes(check.pathHeader)
    );
    if (!table) continue;

    table.rows.forEach((tableRow, tableRowIndex) => {
      const issue = validateMediaClassificationRow({
        kind: check.kind,
        label: tableRow[check.labelHeader],
        pathValue: tableRow[check.pathHeader],
        remark: tableRow['备注'],
        fieldPath: `${check.headingIncludes}[${tableRowIndex + 1}].${check.labelHeader}`
      });
      if (!issue) return;
      issues.push({
        severity: 'error',
        code: issue.code,
        message: issue.message,
        rowIndex,
        productNameCn,
        packageDir,
        field: issue.fieldPath
      });
    });
  }

  return issues;
}

async function findPackageDir(materialsRoot: string, productNameCn: string): Promise<string | undefined> {
  const entries = await readdir(materialsRoot, { withFileTypes: true });
  const matched = entries.find((entry) => entry.isDirectory() && entry.name === productNameCn);
  return matched ? path.join(materialsRoot, matched.name) : undefined;
}

async function readExistingMarkdown(markdownPath: string): Promise<string | undefined> {
  if (!(await fileExists(markdownPath))) return undefined;
  return readFile(markdownPath, 'utf8');
}

export async function prepareBatchMaterialPackages(rawInput: unknown): Promise<BatchMaterialPackageResult> {
  const input = batchMaterialPackageObjectSchema.parse(rawInput);
  const materialsRoot = path.resolve(input.materialsRoot);
  const rootStats = await stat(materialsRoot);
  if (!rootStats.isDirectory()) {
    throw new Error(`materialsRoot is not a directory: ${materialsRoot}`);
  }

  const template = await readTemplateMarkdown(input.templatePath);
  const results: BatchMaterialRowResult[] = [];

  for (const [rowIndex, row] of input.rows.entries()) {
    const issues: BatchMaterialIssue[] = [];
    const productNameCell = findCell(row, PRODUCT_NAME_ALIASES);
    const productNameCn = productNameCell.value;

    if (!productNameCn) {
      issues.push({
        severity: 'error',
        code: 'ROW_PRODUCT_NAME_REQUIRED',
        rowIndex,
        message: '表格行缺少 productNameCn / 商品中文名称，无法匹配资料包。'
      });
      results.push({
        rowIndex,
        ok: false,
        status: 'error',
        wrote: false,
        fieldCount: 0,
        issues
      });
      continue;
    }

    const packageDir = await findPackageDir(materialsRoot, productNameCn);
    if (!packageDir) {
      issues.push({
        severity: 'error',
        code: 'MATERIAL_PACKAGE_MISSING',
        rowIndex,
        productNameCn,
        message: `materialsRoot 下未找到与 productNameCn 精确同名的文件夹：${productNameCn}`
      });
      results.push({
        rowIndex,
        productNameCn,
        ok: false,
        status: 'missing',
        wrote: false,
        fieldCount: 0,
        issues
      });
      continue;
    }

    try {
      const markdownPath = path.join(packageDir, input.markdownFileName);
      const existingMarkdown = await readExistingMarkdown(markdownPath);
      const fieldUpdates = buildFieldUpdates(row);
      const regionRows = regionRowsFromRow(row);
      const sourceClassification = sourceClassificationFromRecord(row);
      const inventory = await collectMaterialFiles(packageDir, input.markdownFileName);
      const sourceInventory = await collectSourceInventory(packageDir, { markdownFileName: input.markdownFileName });
      const boundRelativePaths = extractReferencedMaterialPaths(existingMarkdown);
      const videoMetadata = await resolveTestingVideoMetadata({
        sources: sourceInventory,
        candidates: testingVideoCandidates(inventory, existingMarkdown, sourceClassification),
        productNameCn
      });
      const classified = classifyMaterialFiles(inventory, productNameCn, sourceClassification, boundRelativePaths, videoMetadata);
      const structuredRows = await mapSourcesToStructuredRows(sourceInventory, productNameCn);
      classified.advantageRows.push(...structuredRows.advantageRows);
      classified.scenarioRows.push(...structuredRows.scenarioRows);
      classified.faqRows.push(...structuredRows.faqRows);
      classified.afterSalesRows.push(...structuredRows.afterSalesRows);
      classified.warrantyRows.push(...structuredRows.warrantyRows);
      classified.caseRows.push(...structuredRows.caseRows);
      classified.caseMediaRows.push(...structuredRows.caseMediaRows);
      Object.assign(classified.counts, Object.fromEntries(Object.entries(structuredRows.counts).map(([key, value]) => [key, (classified.counts[key] || 0) + value])));
      issues.push(...classified.issues.map((issue) => ({ ...issue, rowIndex, packageDir })));
      issues.push(...videoMetadata.issues.map((issue) => ({ ...issue, rowIndex, productNameCn, packageDir })));

      const hasGrossWeight = findCell(row, ['包装重量 kg', '包装重量', '毛重', '毛重 kg', 'grossWeight', 'grossWeightKg', 'packWeight', 'packageWeight']).found;
      const existingNetWeight = fieldValue(existingMarkdown, '净重 kg');
      if (hasGrossWeight && !existingNetWeight) {
        issues.push({
          severity: 'warning',
          code: 'NET_WEIGHT_LEFT_BLANK',
          rowIndex,
          productNameCn,
          packageDir,
          field: '净重 kg',
          message: '表格仅提供毛重，已写入“包装重量 kg”；“净重 kg”不做猜测并保持空白，后续预检会要求补充。'
        });
      }

      const applied = applyMaterialTemplate({
        templateMarkdown: template.markdown,
        existingMarkdown,
        fieldValues: fieldUpdates,
        tableMerges: buildTableMerges(classified, regionRows)
      });
      issues.push(...templateIssuesToBatchIssues(applied.issues, rowIndex, productNameCn, packageDir));
      issues.push(...mediaClassificationIssues(applied.markdown, rowIndex, productNameCn, packageDir));
      const sourceCoverage = buildSourceCoverageAudit({
        sources: sourceInventory,
        markdown: applied.markdown,
        videoMetadataReport: videoMetadata.reports
      });
      issues.push(
        ...sourceCoverage.issues.map((issue) => ({
          severity: issue.severity,
          code: issue.code,
          message: issue.message,
          rowIndex,
          productNameCn,
          packageDir,
          field: issue.field
        }))
      );

      if (!input.dryRun) {
        assertMaterialPackageWrite({
          packageDir,
          targetPath: markdownPath,
          kind: 'materialMarkdown',
          markdownFileName: input.markdownFileName
        });
        await writeFile(markdownPath, applied.markdown, 'utf8');
      }

      results.push({
        rowIndex,
        productNameCn,
        ok: !issues.some((issue) => issue.severity === 'error'),
        status: input.dryRun ? 'dryRun' : applied.mode,
        packageDir,
        markdownPath,
        wrote: !input.dryRun,
        templateMode: applied.mode,
        fieldCount: Object.keys(fieldUpdates).length,
        classifiedCounts: classified.counts,
        sourceInventorySummary: sourceInventorySummary(sourceInventory),
        sourceCoverageSummary: sourceCoverage.summary,
        videoMetadataSummary: videoMetadata.summary,
        videoMetadataReport: videoMetadata.reports,
        issues
      });
    } catch (error) {
      issues.push({
        severity: 'error',
        code: 'MATERIAL_PACKAGE_PREPARE_FAILED',
        rowIndex,
        productNameCn,
        packageDir,
        message: error instanceof Error ? error.message : String(error)
      });
      results.push({
        rowIndex,
        productNameCn,
        ok: false,
        status: 'error',
        packageDir,
        wrote: false,
        fieldCount: 0,
        issues
      });
    }
  }

  const issues = results.flatMap((result) => result.issues);
  const errorCount = results.filter((result) => !result.ok && result.status !== 'missing').length;
  const missingPackageCount = results.filter((result) => result.status === 'missing').length;
  const preparedCount = results.filter((result) => result.wrote || result.status === 'dryRun').length;

  return {
    ok: !issues.some((issue) => issue.severity === 'error'),
    summary: {
      totalRows: input.rows.length,
      preparedCount,
      missingPackageCount,
      errorCount,
      dryRun: input.dryRun
    },
    results,
    issues
  };
}

export async function prepareBatchMaterialPackage(
  row: object,
  materialsRoot: string,
  options: {
    templatePath?: string;
    markdownFileName?: string;
    dryRun?: boolean;
  } = {}
): Promise<PreparedBatchMaterialPackageResult> {
  const result = await prepareBatchMaterialPackages({
    materialsRoot,
    rows: [row as UnknownRow],
    templatePath: options.templatePath,
    markdownFileName: options.markdownFileName,
    dryRun: options.dryRun ?? false
  });
  const first = result.results[0];
  if (!first) {
    return {
      ok: false,
      status: 'error',
      wrote: false,
      issues: [
        {
          severity: 'error',
          code: 'MATERIAL_PACKAGE_PREPARE_EMPTY_RESULT',
          message: '资料包整理未返回行结果。'
        }
      ]
    };
  }

  return {
    ok: first.ok,
    packageDir: first.packageDir,
    markdownPath: first.markdownPath,
    status: first.status,
    wrote: first.wrote,
    issues: first.issues,
    result: first
  };
}

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import * as z from 'zod/v4';
import {
  getLocalFileInfo,
  getSuggestedMapping,
  getUploadPolicy,
  validateLocalFile,
  type ProductUploadFileInput
} from './upload/policies.js';
import { prepareImageForUpload } from './upload/imagePreparer.js';

export const productPrecheckPackageInputSchema = {
  packagePath: z
    .string()
    .min(1)
    .describe('Local product package directory, or a direct path to 商品资料.md on the Codex user machine.'),
  markdownFileName: z.string().trim().default('商品资料.md').describe('Markdown file name when packagePath is a directory.'),
  includeDraft: z.boolean().default(true).describe('When true, include a draft payload skeleton parsed from 商品资料.md.'),
  categoryConfig: z
    .object({
      baseConfigs: z.array(z.record(z.string(), z.any())).optional(),
      technicalParams: z.array(z.record(z.string(), z.any())).optional(),
      optionalConfigs: z.array(z.record(z.string(), z.any())).optional()
    })
    .optional()
    .describe('Optional result from product_get_category_config. When provided, validate config names and option values.')
};

const productPrecheckPackageObjectSchema = z.object(productPrecheckPackageInputSchema);
export type ProductPrecheckPackageInput = z.infer<typeof productPrecheckPackageObjectSchema>;

type UploadUsage = ProductUploadFileInput['usage'];
type Severity = 'error' | 'warning' | 'info';

interface PrecheckIssue {
  severity: Severity;
  code: string;
  message: string;
  section?: string;
  row?: number;
  path?: string;
}

interface MarkdownTable {
  heading: string;
  headers: string[];
  rows: Array<Record<string, string>>;
  startLine: number;
}

interface FileReference {
  section: string;
  row: number;
  usage: UploadUsage;
  usageLabel: string;
  relativePath: string;
  absolutePath: string;
  title?: string;
  description?: string;
  languageList?: Array<'zh' | 'en'>;
  required?: boolean;
}

interface CheckedFileReference extends FileReference {
  ok: boolean;
  prepared?: boolean;
  ext?: string;
  size?: number;
  uploadedLocalPath?: string;
  imageSize?: {
    width?: number;
    height?: number;
  };
  imagePreparation?: {
    mode?: string;
    sourcePath?: string;
    outputPath?: string;
    sourceSize?: {
      width: number;
      height: number;
    };
    outputSize?: {
      width: number;
      height: number;
    };
    targetRatio?: number;
    targetRatioText?: string;
  };
  limits?: {
    allowedExtensions: string[];
    maxSizeMb: number;
    maxCount?: number;
    aspectRatioText?: string;
    requireMp4Codec: boolean;
  };
  suggestedMapping?: ReturnType<typeof getSuggestedMapping>;
  errors: string[];
}

const yesNoMap: Record<string, 0 | 1> = {
  是: 1,
  否: 0
};

const productTypeMap: Record<string, number> = {
  整机: 1,
  配件: 2,
  服务: 3
};

const statusMap: Record<string, number> = {
  上架: 1,
  下架: 2,
  作废: 3
};

const proofreadStatusMap: Record<string, number> = {
  未校对: 0,
  校对完成: 1
};

const warrantyPeriodUnitMap: Record<string, number> = {
  月: 1,
  年: 2
};

const cycleUnitMap: Record<string, number> = {
  天: 1,
  小时: 2
};

const optionalConfigStatusMap: Record<string, number> = {
  是: 0,
  否: 1
};

const partTypeMap: Record<string, number> = {
  配件: 1,
  备件: 2,
  易损件: 3
};

const salesSupportTypeMap: Record<string, number> = {
  一句话卖点: 1,
  核心优势: 2,
  应用场景: 3,
  常见问题与标准回答: 4,
  '常见问题&标准回答': 4,
  异议处理: 5,
  合规红线: 6,
  售后承诺: 7,
  售后服务与支持: 8,
  质保政策: 9,
  技术支持与联系方式: 10
};

const fileUsageByLabel: Record<string, UploadUsage> = {
  商品主图: 'productMainImage',
  'Banner 图': 'bannerImage',
  Banner图: 'bannerImage',
  细节图: 'detailImage',
  尺寸图: 'sizeImage',
  尺寸示意图: 'sizeImage',
  场景图: 'sceneImage',
  包装图: 'packageImage',
  多角度实拍图: 'multiAngleImage',
  配件图: 'accessoriesImage',
  实拍视频: 'realVideo',
  装柜视频: 'loadingVideo',
  作业视频: 'workVideo',
  安装视频: 'installVideo',
  包装视频: 'packingVideo',
  链界实测视频: 'linkActualTestingVideo',
  三方实测视频: 'thirdActualTestingVideo',
  '3D 展示': 'model3d',
  '3D展示': 'model3d',
  商品附件: 'productAttachment',
  图文详情图片: 'graphicDetailImage',
  富文本图片: 'richTextImage',
  富文本视频: 'richTextVideo',
  富文本附件: 'richTextAttachment'
};

const salesSupportFileUsageByType: Record<string, UploadUsage> = {
  核心优势: 'advantageImage',
  应用场景: 'scenarioImage',
  售后服务与支持: 'serviceSupportFile',
  质保政策: 'serviceSupportFile'
};

function cleanCell(value: unknown): string {
  return String(value ?? '')
    .replace(/^`|`$/g, '')
    .trim();
}

function isBlankRow(row: Record<string, string>): boolean {
  return Object.values(row).every((value) => !cleanCell(value));
}

function parseTableLine(line: string): string[] {
  const trimmed = line.trim();
  const withoutEdges = trimmed.replace(/^\|/, '').replace(/\|$/, '');
  return withoutEdges.split('|').map((cell) => cleanCell(cell));
}

function isTableSeparator(line: string): boolean {
  const cells = parseTableLine(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function parseMarkdownTables(markdown: string): MarkdownTable[] {
  const lines = markdown.split(/\r?\n/);
  const tables: MarkdownTable[] = [];
  let heading = '';
  let index = 0;

  while (index < lines.length) {
    const headingMatch = lines[index].match(/^(#{1,6})\s+(.+?)\s*$/);
    if (headingMatch) {
      heading = headingMatch[2];
      index += 1;
      continue;
    }

    if (lines[index].trim().startsWith('|') && lines[index + 1]?.trim().startsWith('|') && isTableSeparator(lines[index + 1])) {
      const headers = parseTableLine(lines[index]);
      const rows: Array<Record<string, string>> = [];
      const startLine = index + 1;
      index += 2;

      while (index < lines.length && lines[index].trim().startsWith('|')) {
        const cells = parseTableLine(lines[index]);
        const row: Record<string, string> = {};
        headers.forEach((header, cellIndex) => {
          row[header] = cells[cellIndex] ?? '';
        });
        if (!isBlankRow(row)) rows.push(row);
        index += 1;
      }

      tables.push({
        heading,
        headers,
        rows,
        startLine
      });
      continue;
    }

    index += 1;
  }

  return tables;
}

function tablesFor(tables: MarkdownTable[], headingIncludes: string): MarkdownTable[] {
  return tables.filter((table) => table.heading.includes(headingIncludes));
}

function fieldMap(tables: MarkdownTable[], headingIncludes: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const table of tablesFor(tables, headingIncludes)) {
    if (!table.headers.includes('字段') || !table.headers.includes('填写值')) continue;
    for (const row of table.rows) {
      const key = cleanCell(row['字段']);
      if (key) result[key] = cleanCell(row['填写值']);
    }
  }
  return result;
}

function tableRows(tables: MarkdownTable[], headingIncludes: string, requiredHeader: string): Array<Record<string, string>> {
  return tablesFor(tables, headingIncludes)
    .filter((table) => table.headers.includes(requiredHeader))
    .flatMap((table) => table.rows);
}

function addIssue(issues: PrecheckIssue[], issue: PrecheckIssue): void {
  issues.push(issue);
}

function requiredText(
  issues: PrecheckIssue[],
  value: string | undefined,
  field: string,
  section: string
): string | undefined {
  const cleaned = cleanCell(value);
  if (cleaned) return cleaned;
  addIssue(issues, {
    severity: 'error',
    code: 'REQUIRED_FIELD_MISSING',
    section,
    message: `${field} 不能为空。`
  });
  return undefined;
}

function optionalText(value: string | undefined): string | undefined {
  const cleaned = cleanCell(value);
  return cleaned || undefined;
}

function numberValue(
  issues: PrecheckIssue[],
  value: string | undefined,
  field: string,
  section: string
): number | undefined {
  const cleaned = cleanCell(value).replace(/,/g, '');
  if (!cleaned) return undefined;
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) {
    addIssue(issues, {
      severity: 'error',
      code: 'NUMBER_INVALID',
      section,
      message: `${field} 必须是数字，当前值为 ${cleaned}。`
    });
    return undefined;
  }
  return parsed;
}

function mappedValue<T>(
  issues: PrecheckIssue[],
  value: string | undefined,
  map: Record<string, T>,
  field: string,
  section: string,
  required = false
): T | undefined {
  const cleaned = cleanCell(value);
  if (!cleaned) {
    if (required) {
      addIssue(issues, {
        severity: 'error',
        code: 'REQUIRED_FIELD_MISSING',
        section,
        message: `${field} 不能为空。`
      });
    }
    return undefined;
  }
  if (Object.prototype.hasOwnProperty.call(map, cleaned)) return map[cleaned];

  addIssue(issues, {
    severity: 'error',
    code: 'ENUM_INVALID',
    section,
    message: `${field} 的值不支持：${cleaned}。`
  });
  return undefined;
}

function languageList(value: string | undefined): Array<'zh' | 'en'> | undefined {
  const items = cleanCell(value)
    .split(/[,，]/)
    .map((item) => item.trim())
    .filter((item): item is 'zh' | 'en' => item === 'zh' || item === 'en');
  return items.length ? items : undefined;
}

function firstValue(row: Record<string, string>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = cleanCell(row[key]);
    if (value) return value;
  }
  return undefined;
}

function isPathLike(value: string | undefined): value is string {
  const cleaned = cleanCell(value);
  if (!cleaned) return false;
  if (/^https?:\/\//i.test(cleaned)) return false;
  return /^\.{1,2}[\\/]/.test(cleaned) || /[\\/]/.test(cleaned) || /\.[a-z0-9]{2,6}$/i.test(cleaned);
}

function resolveLocalPath(packageDir: string, relativePath: string): string {
  return path.isAbsolute(relativePath) ? path.resolve(relativePath) : path.resolve(packageDir, relativePath);
}

async function resolveMarkdownPath(input: ProductPrecheckPackageInput) {
  const packagePath = path.resolve(input.packagePath);
  const stats = await stat(packagePath);
  const markdownPath = stats.isDirectory() ? path.join(packagePath, input.markdownFileName || '商品资料.md') : packagePath;
  const markdownStats = await stat(markdownPath);
  if (!markdownStats.isFile()) {
    throw new Error(`Markdown path is not a file: ${markdownPath}`);
  }
  return {
    packageDir: path.dirname(markdownPath),
    markdownPath
  };
}

function extractCodeBlockAfterHeading(markdown: string, headingIncludes: string): string[] {
  const lines = markdown.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => /^#{1,6}\s+/.test(line) && line.includes(headingIncludes));
  if (headingIndex < 0) return [];

  const collected: string[] = [];
  let inBlock = false;

  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!inBlock && /^#{1,6}\s+/.test(line)) break;
    if (line.trim().startsWith('```')) {
      if (inBlock) break;
      inBlock = true;
      continue;
    }
    if (inBlock) collected.push(line);
  }

  return collected.map((line) => line.trim()).filter(Boolean);
}

function addFileReference(
  references: FileReference[],
  packageDir: string,
  section: string,
  row: number,
  usage: UploadUsage,
  usageLabel: string,
  relativePath: string,
  title?: string,
  description?: string,
  languages?: string,
  required?: boolean
): void {
  references.push({
    section,
    row,
    usage,
    usageLabel,
    relativePath,
    absolutePath: resolveLocalPath(packageDir, relativePath),
    title: optionalText(title),
    description: optionalText(description),
    languageList: languageList(languages),
    required
  });
}

function collectFileReferences(
  tables: MarkdownTable[],
  packageDir: string,
  issues: PrecheckIssue[]
): FileReference[] {
  const references: FileReference[] = [];

  for (const row of tableRows(tables, '商品图片', '图片用途')) {
    const label = cleanCell(row['图片用途']);
    const relativePath = cleanCell(row['文件路径']);
    if (!relativePath) continue;
    const usage = fileUsageByLabel[label];
    if (!usage) {
      addIssue(issues, {
        severity: 'warning',
        code: 'UNKNOWN_FILE_USAGE',
        section: '商品图片',
        message: `未识别的图片用途：${label}。`
      });
      continue;
    }
    addFileReference(references, packageDir, '商品图片', references.length + 1, usage, label, relativePath, row['标题'], row['描述'], row['语言'], label === '商品主图');
  }

  for (const row of tableRows(tables, '商品视频、3D 与附件', '资料用途')) {
    const label = cleanCell(row['资料用途']);
    const relativePath = cleanCell(row['文件路径']);
    if (!relativePath) continue;
    const usage = fileUsageByLabel[label];
    if (!usage) {
      addIssue(issues, {
        severity: 'warning',
        code: 'UNKNOWN_FILE_USAGE',
        section: '商品视频、3D 与附件',
        message: `未识别的资料用途：${label}。`
      });
      continue;
    }
    addFileReference(references, packageDir, '商品视频、3D 与附件', references.length + 1, usage, label, relativePath, row['标题'], row['描述'], row['语言']);
  }

  for (const row of tableRows(tables, '图文详情', '资料用途')) {
    const label = cleanCell(row['资料用途']);
    const relativePath = cleanCell(row['文件路径或内容']);
    if (!isPathLike(relativePath)) continue;
    const usage = fileUsageByLabel[label];
    if (!usage) {
      addIssue(issues, {
        severity: 'warning',
        code: 'UNKNOWN_FILE_USAGE',
        section: '图文详情',
        message: `未识别的图文详情资料用途：${label}。`
      });
      continue;
    }
    addFileReference(references, packageDir, '图文详情', references.length + 1, usage, label, relativePath, row['标题'], row['描述']);
  }

  for (const row of tableRows(tables, '认证资料', '证书名称')) {
    const filePath = cleanCell(row['文件路径']);
    if (filePath) {
      addFileReference(references, packageDir, '认证资料', references.length + 1, 'certificateFile', '认证资料文件', filePath, row['证书名称'], row['备注']);
    }
    const mainImagePath = cleanCell(row['主图路径']);
    if (mainImagePath) {
      addFileReference(references, packageDir, '认证资料', references.length + 1, 'certificateMainImage', '认证资料主图', mainImagePath, row['证书名称'], row['备注']);
    }
  }

  for (const row of tableRows(tables, '销售支持', '类型')) {
    const relativePath = cleanCell(row['文件路径']);
    if (!relativePath) continue;
    const type = cleanCell(row['类型']);
    const usage = salesSupportFileUsageByType[type] || 'serviceSupportFile';
    addFileReference(references, packageDir, '销售支持', references.length + 1, usage, `${type}文件`, relativePath, row['标题/问题/异议'], row['文件描述']);
  }

  for (const row of tableRows(tables, '客户案例媒体', '所属客户名称')) {
    const relativePath = cleanCell(row['文件路径']);
    if (!relativePath) continue;
    const mediaType = cleanCell(row['媒体类型']);
    const usage: UploadUsage = mediaType === '视频' ? 'caseVideo' : 'caseImage';
    addFileReference(references, packageDir, '客户案例媒体', references.length + 1, usage, `客户案例${mediaType || '图片'}`, relativePath, row['媒体名称'], row['备注']);
  }

  for (const row of tableRows(tables, '配件、备件、易损件', '类型')) {
    const imagePath = cleanCell(row['图片路径']);
    if (imagePath) {
      addFileReference(references, packageDir, '配件、备件、易损件', references.length + 1, 'partsImage', '配件图片', imagePath, row['名称'], row['备注']);
    }
    const attachmentPath = cleanCell(row['附件路径']);
    if (attachmentPath) {
      addFileReference(references, packageDir, '配件、备件、易损件', references.length + 1, 'partsAttachment', '配件附件', attachmentPath, row['名称'], row['备注']);
    }
  }

  for (const row of tableRows(tables, '配件文件明细', '文件类型')) {
    const relativePath = cleanCell(row['文件路径']);
    if (!relativePath) continue;
    const usage: UploadUsage = cleanCell(row['文件类型']) === '图片' ? 'partsImage' : 'partsAttachment';
    addFileReference(references, packageDir, '配件文件明细', references.length + 1, usage, cleanCell(row['文件类型']) || '配件文件', relativePath, row['名称'], row['备注']);
  }

  return references;
}

async function checkFiles(references: FileReference[], issues: PrecheckIssue[]): Promise<CheckedFileReference[]> {
  const checked: CheckedFileReference[] = [];
  const usageCounts = new Map<UploadUsage, number>();

  for (const reference of references) {
    usageCounts.set(reference.usage, (usageCounts.get(reference.usage) || 0) + 1);
  }

  for (const reference of references) {
    const policy = getUploadPolicy(reference.usage);
    const errors: string[] = [];
    let ext: string | undefined;
    let size: number | undefined;
    let imageSize: CheckedFileReference['imageSize'];

    const count = usageCounts.get(reference.usage) || 0;
    if (policy.maxCount && count > policy.maxCount) {
      errors.push(`${policy.label}最多 ${policy.maxCount} 个，当前 ${count} 个。`);
    }

    try {
      const sourceFile = await getLocalFileInfo(reference.absolutePath);
      const prepared = await prepareImageForUpload(sourceFile, policy);
      const file = prepared.file;
      ext = file.ext;
      size = file.size;
      imageSize = await validateLocalFile(file, policy);

      if (prepared.prepared) {
        addIssue(issues, {
          severity: 'info',
          code: 'IMAGE_FORCE_CROPPED',
          section: reference.section,
          row: reference.row,
          path: reference.relativePath,
          message: `${policy.label}${sourceFile.fileName}比例不符，已强制裁剪为 ${prepared.outputSize?.width}x${prepared.outputSize?.height}。`
        });
      }

      checked.push({
        ...reference,
        ok: true,
        prepared: prepared.prepared,
        ext,
        size,
        uploadedLocalPath: file.absolutePath,
        imageSize,
        imagePreparation: {
          mode: prepared.prepared ? prepared.mode : 'none',
          sourcePath: sourceFile.absolutePath,
          outputPath: prepared.outputPath,
          sourceSize: prepared.sourceSize,
          outputSize: prepared.outputSize,
          targetRatio: prepared.targetRatio,
          targetRatioText: prepared.targetRatioText
        },
        limits: {
          allowedExtensions: policy.allowedExtensions,
          maxSizeMb: policy.maxSizeMb,
          maxCount: policy.maxCount,
          aspectRatioText: policy.aspectRatioText,
          requireMp4Codec: Boolean(policy.requireMp4Codec)
        },
        suggestedMapping: getSuggestedMapping(policy),
        errors
      });
      continue;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }

    if (errors.length) {
      for (const message of errors) {
        addIssue(issues, {
          severity: reference.required ? 'error' : 'warning',
          code: reference.required ? 'REQUIRED_FILE_INVALID' : 'OPTIONAL_FILE_INVALID',
          section: reference.section,
          row: reference.row,
          path: reference.relativePath,
          message
        });
      }
    }

    checked.push({
      ...reference,
      ok: errors.length === 0,
      prepared: false,
      ext,
      size,
      uploadedLocalPath: reference.absolutePath,
      imageSize,
      limits: {
        allowedExtensions: policy.allowedExtensions,
        maxSizeMb: policy.maxSizeMb,
        maxCount: policy.maxCount,
        aspectRatioText: policy.aspectRatioText,
        requireMp4Codec: Boolean(policy.requireMp4Codec)
      },
      suggestedMapping: getSuggestedMapping(policy),
      errors
    });
  }

  return checked;
}

function compactRows(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> | undefined {
  const filtered = rows.filter((row) => Object.values(row).some((value) => value !== undefined && value !== null && value !== ''));
  return filtered.length ? filtered : undefined;
}

type CategoryConfigForPrecheck = NonNullable<ProductPrecheckPackageInput['categoryConfig']>;

function normalizeLookupText(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

function configLabel(item: Record<string, unknown> | undefined): string | undefined {
  if (!item) return undefined;
  const value = item.name ?? item.configValue ?? item.unitName;
  const text = String(value ?? '').trim();
  return text || undefined;
}

function findByLabel(items: Array<Record<string, unknown>> | undefined, label: unknown): Record<string, unknown> | undefined {
  const normalized = normalizeLookupText(label);
  if (!normalized) return undefined;
  return (items || []).find((item) => normalizeLookupText(configLabel(item)) === normalized);
}

function optionItems(config: Record<string, unknown> | undefined): Array<Record<string, unknown>> {
  return Array.isArray(config?.items) ? (config.items as Array<Record<string, unknown>>) : [];
}

function validateDraftAgainstCategoryConfig(
  draft: Record<string, unknown> | undefined,
  categoryConfig: CategoryConfigForPrecheck | undefined,
  issues: PrecheckIssue[]
): void {
  if (!draft || !categoryConfig) return;

  const baseConfigs = Array.isArray(draft.baseConfigs) ? (draft.baseConfigs as Array<Record<string, unknown>>) : [];
  baseConfigs.forEach((row, index) => {
    const name = row.name;
    if (!name) return;
    if (!findByLabel(categoryConfig.baseConfigs, name)) {
      addIssue(issues, {
        severity: 'error',
        code: 'CATEGORY_BASE_CONFIG_NOT_FOUND',
        section: '基础配置',
        row: index + 1,
        message: `基础配置不存在或不可用：${String(name)}。`
      });
    }
  });

  const technicalParams = Array.isArray(draft.technicalParams) ? (draft.technicalParams as Array<Record<string, unknown>>) : [];
  technicalParams.forEach((row, index) => {
    const name = row.name;
    if (!name) return;
    if (!findByLabel(categoryConfig.technicalParams, name)) {
      addIssue(issues, {
        severity: 'error',
        code: 'CATEGORY_TECHNICAL_PARAM_NOT_FOUND',
        section: '技术参数',
        row: index + 1,
        message: `技术参数不存在或不可用：${String(name)}。`
      });
    }
  });

  const optionalConfigs = Array.isArray(draft.optionalConfigs) ? (draft.optionalConfigs as Array<Record<string, unknown>>) : [];
  optionalConfigs.forEach((row, index) => {
    const name = row.name;
    const configValue = row.configValue;
    if (!name) return;
    const config = findByLabel(categoryConfig.optionalConfigs, name);
    if (!config) {
      addIssue(issues, {
        severity: 'error',
        code: 'CATEGORY_OPTIONAL_CONFIG_NOT_FOUND',
        section: '可选配置',
        row: index + 1,
        message: `可选配置不存在或不可用：${String(name)}。`
      });
      return;
    }

    if (!configValue) return;
    const options = optionItems(config);
    if (!findByLabel(options, configValue)) {
      const allowed = options.map((item) => configLabel(item)).filter(Boolean).join('、');
      addIssue(issues, {
        severity: 'error',
        code: 'CATEGORY_OPTIONAL_CONFIG_VALUE_NOT_FOUND',
        section: '可选配置',
        row: index + 1,
        message: `可选配置 ${String(name)} 不存在选项值：${String(configValue)}。可选值：${allowed || '无'}。`
      });
    }
  });
}

function parseDraft(markdown: string, tables: MarkdownTable[], issues: PrecheckIssue[]): Record<string, unknown> {
  const basic = fieldMap(tables, '基础信息');
  const refs = fieldMap(tables, '分类、单位、供应商');
  const region = fieldMap(tables, '适用区域');
  const sales = fieldMap(tables, '销售、交付、售后');
  const price = fieldMap(tables, '价格信息');
  const packageInfo = fieldMap(tables, '包装与物流');
  const related = fieldMap(tables, '关联商品');

  const draft: Record<string, unknown> = {
    productNameCn: requiredText(issues, basic['商品中文名称'], '商品中文名称', '基础信息'),
    productNameEn: requiredText(issues, basic['商品英文名称'], '商品英文名称', '基础信息'),
    productType: mappedValue(issues, basic['产品类型'], productTypeMap, '产品类型', '基础信息', true),
    status: mappedValue(issues, basic['上架状态'], statusMap, '上架状态', '基础信息', true),
    id: optionalText(basic['商品主键ID']),
    commodityId: numberValue(issues, basic['原商品ID'], '原商品ID', '基础信息'),
    productCode: optionalText(basic['产品编码']),
    language: optionalText(basic['语言标识']),
    tenantId: optionalText(basic['租户编号']),
    createBy: numberValue(issues, basic['创建者'], '创建者', '基础信息'),
    createDept: numberValue(issues, basic['创建部门'], '创建部门', '基础信息'),
    level: optionalText(basic['产品等级']),
    brand: optionalText(basic['品牌']),
    productModel: optionalText(basic['产品型号']),
    hsCode: optionalText(basic['HS 编码']),
    usagePurpose: optionalText(basic['产品用途']),
    relatedCommodityId: optionalText(related['关联商品ID']),
    remark: optionalText(basic['商品备注']),
    skipTranslation: mappedValue(issues, basic['是否跳过翻译'], yesNoMap, '是否跳过翻译', '基础信息'),
    proofreadStatus: mappedValue(issues, basic['校对状态'], proofreadStatusMap, '校对状态', '基础信息'),
    isInnerTreasury: mappedValue(issues, basic['是否内库商品'], yesNoMap, '是否内库商品', '基础信息'),
    externalAddress: optionalText(basic['外库上架位置']),
    externalStatus: mappedValue(issues, basic['外库状态'], statusMap, '外库状态', '基础信息'),
    categoryFirstName: requiredText(issues, refs['一级分类'], '一级分类', '分类、单位、供应商'),
    categorySecondName: optionalText(refs['二级分类']),
    categoryThirdName: optionalText(refs['三级分类']),
    unitName: requiredText(issues, refs['计量单位'], '计量单位', '分类、单位、供应商'),
    supplierName: requiredText(issues, refs['供应商'], '供应商', '分类、单位、供应商'),
    supplierProductionCycle: numberValue(issues, refs['供应商预计生产周期'], '供应商预计生产周期', '分类、单位、供应商'),
    supplierCycleUnit: mappedValue(issues, refs['生产周期单位'], cycleUnitMap, '生产周期单位', '分类、单位、供应商'),
    useAllRegions: cleanCell(region['适用范围']) === '全球',
    supportConsolidation: mappedValue(issues, sales['是否支持拼柜'], yesNoMap, '是否支持拼柜', '销售、交付、售后'),
    canExhibit: mappedValue(issues, sales['是否可做展品'], yesNoMap, '是否可做展品', '销售、交付、售后'),
    needInstallation: mappedValue(issues, sales['是否需要安装'], yesNoMap, '是否需要安装', '销售、交付、售后'),
    hasAfterSalesThreshold: mappedValue(issues, sales['是否有售后门槛'], yesNoMap, '是否有售后门槛', '销售、交付、售后'),
    supportSample: mappedValue(issues, sales['是否支持样品'], yesNoMap, '是否支持样品', '销售、交付、售后'),
    samplePrice: numberValue(issues, sales['样品价'], '样品价', '销售、交付、售后'),
    supportPartsAlone: mappedValue(issues, sales['是否支持配件单买'], yesNoMap, '是否支持配件单买', '销售、交付、售后'),
    supportOem: mappedValue(issues, sales['是否支持 OEM'], yesNoMap, '是否支持 OEM', '销售、交付、售后'),
    supportOdm: mappedValue(issues, sales['是否支持 ODM'], yesNoMap, '是否支持 ODM', '销售、交付、售后'),
    moq: numberValue(issues, sales['最小起订量 MOQ'], '最小起订量 MOQ', '销售、交付、售后'),
    warrantyPeriod: numberValue(issues, sales['质保期限'], '质保期限', '销售、交付、售后'),
    warrantyPeriodUnit: mappedValue(issues, sales['质保期限单位'], warrantyPeriodUnitMap, '质保期限单位', '销售、交付、售后'),
    supportSmallTrial: mappedValue(issues, sales['是否支持小批量试单'], yesNoMap, '是否支持小批量试单', '销售、交付、售后'),
    minTrialQuantity: numberValue(issues, sales['最小试单量'], '最小试单量', '销售、交付、售后'),
    hasSpotStock: mappedValue(issues, sales['是否现货备货'], yesNoMap, '是否现货备货', '销售、交付、售后'),
    hasOverseasWarehouseStock: mappedValue(issues, sales['是否海外仓备货'], yesNoMap, '是否海外仓备货', '销售、交付、售后'),
    standardDeliveryDays: numberValue(issues, sales['标准交期 天'], '标准交期 天', '销售、交付、售后'),
    shortestDeliveryDays: numberValue(issues, sales['最短交期 天'], '最短交期 天', '销售、交付、售后'),
    urgentOrderDays: numberValue(issues, sales['紧急单交期 天'], '紧急单交期 天', '销售、交付、售后'),
    suggestedPrice: numberValue(issues, price['建议售价'], '建议售价', '价格信息'),
    minPrice: numberValue(issues, price['最低售价'], '最低售价', '价格信息'),
    referenceCostCny: numberValue(issues, price['参考成本价 人民币'], '参考成本价 人民币', '价格信息'),
    referenceCostUsd: numberValue(issues, price['参考成本价 美元'], '参考成本价 美元', '价格信息'),
    profitMargin: numberValue(issues, price['利润率 %'], '利润率 %', '价格信息'),
    exFactoryPrice: numberValue(issues, price['含税出厂价'], '含税出厂价', '价格信息'),
    specialCustomFee: numberValue(issues, price['特殊定制费用'], '特殊定制费用', '价格信息'),
    taxRefundRate: optionalText(price['退税率']),
    clashSupport: optionalText(price['撞期支持情况']),
    rebateSupport: optionalText(price['返利支持情况']),
    rebateCondition: optionalText(price['返利条件']),
    rebateRate: numberValue(issues, price['返利比例 %'], '返利比例 %', '价格信息'),
    packageInfo: {
      packLength: numberValue(issues, packageInfo['包装长 mm'], '包装长 mm', '包装与物流'),
      packWidth: numberValue(issues, packageInfo['包装宽 mm'], '包装宽 mm', '包装与物流'),
      packHeight: numberValue(issues, packageInfo['包装高 mm'], '包装高 mm', '包装与物流'),
      packCubic: numberValue(issues, packageInfo['包装方数'], '包装方数', '包装与物流'),
      packingFee: numberValue(issues, packageInfo['包装费'], '包装费', '包装与物流'),
      packWeight: numberValue(issues, packageInfo['包装重量 kg'], '包装重量 kg', '包装与物流'),
      netWeight: numberValue(issues, packageInfo['净重 kg'], '净重 kg', '包装与物流'),
      containerFt20: numberValue(issues, packageInfo['20尺柜装柜数'], '20尺柜装柜数', '包装与物流'),
      containerFt40: numberValue(issues, packageInfo['40尺柜装柜数'], '40尺柜装柜数', '包装与物流'),
      containerHc40: numberValue(issues, packageInfo['40高柜装柜数'], '40高柜装柜数', '包装与物流'),
      containerFrame: numberValue(issues, packageInfo['框架柜装柜数'], '框架柜装柜数', '包装与物流'),
      bulkCarrier: numberValue(issues, packageInfo['散货船装柜数'], '散货船装柜数', '包装与物流'),
      palletInfo: optionalText(packageInfo['托盘信息']),
      cartonMark: optionalText(packageInfo['外箱唛头']),
      stackingReq: optionalText(packageInfo['堆码要求']),
      moistureProofReq: optionalText(packageInfo['防潮要求']),
      waterproofReq: optionalText(packageInfo['防水要求']),
      packingListTemplate: optionalText(packageInfo['装箱清单模板'])
    }
  };

  draft.tags = extractCodeBlockAfterHeading(markdown, '商品标签').map((tagName) => ({ tagName }));
  draft.suppliers = compactRows(
    tableRows(tables, '分类、单位、供应商', '供应商名称').map((row) => ({
      supplierName: optionalText(row['供应商名称']),
      supplierId: optionalText(row['供应商ID']),
      productionCycle: numberValue(issues, row['预计生产周期'], '供应商明细.预计生产周期', '供应商明细'),
      cycleUnit: mappedValue(issues, row['周期单位'], cycleUnitMap, '供应商明细.周期单位', '供应商明细'),
      remark: optionalText(row['备注'])
    }))
  );
  draft.regions = compactRows(
    tableRows(tables, '适用区域', '区域名称').map((row) => ({
      regionName: optionalText(row['区域名称']),
      regionId: optionalText(row['区域ID']),
      customerType: optionalText(row['客户类型']),
      originPlace: optionalText(row['产品产地']),
      sortNo: numberValue(issues, row['排序'], '适用区域.排序', '适用区域'),
      remark: optionalText(row['备注'])
    }))
  );
  draft.priceTiers = compactRows(
    tableRows(tables, '价格信息', '最小数量').map((row) => ({
      minPriceQuantity: numberValue(issues, row['最小数量'], '价格阶梯.最小数量', '价格信息'),
      maxPriceQuantity: numberValue(issues, row['最大数量'], '价格阶梯.最大数量', '价格信息'),
      unitPrice: numberValue(issues, row['单价'], '价格阶梯.单价', '价格信息'),
      profitRate: numberValue(issues, row['利润率 %'], '价格阶梯.利润率 %', '价格信息'),
      minDeliveryDays: numberValue(issues, row['最短交货天数'], '价格阶梯.最短交货天数', '价格信息'),
      maxDeliveryDays: numberValue(issues, row['最长交货天数'], '价格阶梯.最长交货天数', '价格信息')
    }))
  );
  draft.baseConfigs = compactRows(
    tableRows(tables, '基础配置', '配置项名称').map((row) => ({
      name: optionalText(row['配置项名称']),
      configValue: optionalText(row['配置值']),
      remark: optionalText(row['备注'])
    }))
  );
  draft.technicalParams = compactRows(
    tableRows(tables, '技术参数', '参数名称').map((row) => ({
      name: optionalText(row['参数名称']),
      paramValue: optionalText(row['参数值']),
      remark: optionalText(row['备注'])
    }))
  );
  draft.optionalConfigs = compactRows(
    tableRows(tables, '可选配置', '配置名称').map((row) => ({
      name: optionalText(row['配置名称']),
      configValue: optionalText(row['选项值']),
      priceDiffCny: numberValue(issues, row['人民币差价'], '可选配置.人民币差价', '可选配置'),
      priceDiffUsd: numberValue(issues, row['美元差价'], '可选配置.美元差价', '可选配置'),
      status: mappedValue(issues, row['是否展示'], optionalConfigStatusMap, '可选配置.是否展示', '可选配置'),
      remark: optionalText(row['备注'])
    }))
  );
  draft.partLists = compactRows(
    tableRows(tables, '配件、备件、易损件', '类型').map((row) => ({
      partType: mappedValue(issues, row['类型'], partTypeMap, '配件类型', '配件、备件、易损件'),
      partName: optionalText(row['名称']),
      specAttr: optionalText(row['规格属性']),
      costPrice: numberValue(issues, row['成本价'], '配件成本价', '配件、备件、易损件'),
      suggestedPrice: numberValue(issues, row['建议售价'], '配件建议售价', '配件、备件、易损件'),
      suggestedStock: numberValue(issues, row['建议库存'], '建议库存', '配件、备件、易损件'),
      unitName: optionalText(row['单位']),
      remark: optionalText(row['备注'])
    }))
  );
  draft.salesSupports = compactRows(
    tableRows(tables, '销售支持', '类型').map((row) => ({
      type: mappedValue(issues, row['类型'], salesSupportTypeMap, '销售支持类型', '销售支持'),
      title: optionalText(row['标题/问题/异议']),
      content: optionalText(row['内容/回答/处理方式']),
      fileContent: optionalText(row['文件描述']),
      remark: optionalText(row['备注'])
    }))
  );
  draft.competitors = compactRows(
    tableRows(tables, '竞品对比', '对比维度').map((row) => ({
      dimensionName: optionalText(row['对比维度']),
      ourProductValue: optionalText(row['我方产品值']),
      competitorValue: optionalText(row['竞品值']),
      remark: optionalText(row['备注'])
    }))
  );

  return draft;
}

function unresolvedReferences(draft: Record<string, unknown>) {
  return {
    categoryFirstName: draft.categoryFirstName,
    categorySecondName: draft.categorySecondName,
    categoryThirdName: draft.categoryThirdName,
    unitName: draft.unitName,
    supplierName: draft.supplierName,
    note: 'product_create 需要真实 categoryFirstId/categorySecondId/categoryThirdId/unitId/supplierId。下一步应通过只读 MCP 工具解析这些名称。'
  };
}

export async function precheckProductPackage(rawInput: unknown) {
  const input = productPrecheckPackageObjectSchema.parse(rawInput);
  const issues: PrecheckIssue[] = [];
  const { packageDir, markdownPath } = await resolveMarkdownPath(input);
  const markdown = await readFile(markdownPath, 'utf8');
  const tables = parseMarkdownTables(markdown);
  const draft = input.includeDraft ? parseDraft(markdown, tables, issues) : undefined;
  validateDraftAgainstCategoryConfig(draft, input.categoryConfig, issues);
  const fileReferences = collectFileReferences(tables, packageDir, issues);
  const checkedFiles = await checkFiles(fileReferences, issues);
  const requiredFileOk = checkedFiles.some((file) => file.usage === 'productMainImage' && file.ok);
  if (!requiredFileOk) {
    addIssue(issues, {
      severity: 'error',
      code: 'PRODUCT_MAIN_IMAGE_MISSING',
      section: '商品图片',
      message: '未找到可用的商品主图。'
    });
  }

  const errorCount = issues.filter((issue) => issue.severity === 'error').length;
  const warningCount = issues.filter((issue) => issue.severity === 'warning').length;
  const invalidOptionalFileCount = checkedFiles.filter((file) => !file.ok && !file.required).length;
  const uploadQueue = checkedFiles
    .filter((file) => file.ok)
    .map((file) => ({
      localPath: file.uploadedLocalPath || file.absolutePath,
      usage: file.usage,
      title: file.title,
      description: file.description,
      languageList: file.languageList,
      imagePreparation: file.imagePreparation,
      source: {
        section: file.section,
        row: file.row,
        relativePath: file.relativePath,
        usageLabel: file.usageLabel
      },
      suggestedMapping: file.suggestedMapping
    }));

  return {
    ok: errorCount === 0,
    packageDir,
    markdownPath,
    summary: {
      productNameCn: draft?.productNameCn,
      productNameEn: draft?.productNameEn,
      productType: draft?.productType,
      status: draft?.status,
      categoryFirstName: draft?.categoryFirstName,
      categorySecondName: draft?.categorySecondName,
      categoryThirdName: draft?.categoryThirdName,
      unitName: draft?.unitName,
      supplierName: draft?.supplierName,
      useAllRegions: draft?.useAllRegions
    },
    readiness: {
      canUploadAllReferencedFiles: checkedFiles.every((file) => file.ok),
      canCreateAfterSkippingInvalidOptionalFiles: errorCount === 0,
      requiresUserDecision: invalidOptionalFileCount > 0,
      errorCount,
      warningCount,
      validUploadCount: uploadQueue.length,
      invalidFileCount: checkedFiles.filter((file) => !file.ok).length
    },
    unresolvedReferences: draft ? unresolvedReferences(draft) : undefined,
    uploadQueue,
    files: checkedFiles,
    draftCreateInput: draft,
    issues
  };
}

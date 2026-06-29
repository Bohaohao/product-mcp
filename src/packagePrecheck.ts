import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import * as z from 'zod/v4';
import {
  getLocalFileInfo,
  getSuggestedMapping,
  getUploadPolicy,
  validateLocalFile,
  type ProductUploadFileInput,
  type UploadTarget
} from './upload/policies.js';
import { prepareImageForUpload } from './upload/imagePreparer.js';
import { buildFieldCoverage, buildProtocolTrace, buildSubmissionPreview, toActionableIssues } from './protocol.js';
import { validateFrontendAlignedSubmission, type SubmissionValidationIssue } from './submissionValidation.js';

export const productPrecheckPackageInputSchema = {
  packagePath: z
    .string()
    .min(1)
    .describe('Local product package directory, or a direct path to 商品资料.md on the Codex user machine.'),
  markdownFileName: z.string().trim().default('商品资料.md').describe('Markdown file name when packagePath is a directory.'),
  includeDraft: z.boolean().default(true).describe('When true, include a draft payload skeleton parsed from 商品资料.md.'),
  responseMode: z
    .enum(['standard', 'summary', 'debug'])
    .default('standard')
    .describe('standard keeps the existing full response, summary returns only business summaries/coverage/issues, debug keeps all diagnostics.'),
  categoryConfig: z
    .object({
      units: z.array(z.record(z.string(), z.any())).optional(),
      unitList: z.array(z.record(z.string(), z.any())).optional(),
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
  field?: string;
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
  rowKey?: string;
  mediaSubtitle?: string;
  mediaLanguage?: string;
  mediaId?: string;
  mediaRemark?: string;
  partTypeLabel?: string;
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

/**
 * Unresolved upload-binding placeholder carried inside draft URL fields
 * (mediaUrl / fileUrl / mainImageUrl). product_create detects and rejects
 * these via validateResolvedUploads unless an orchestrator has replaced them
 * with real OSS URLs. Local filesystem paths are never placed in URL fields.
 */
const OSS_BINDING_OPEN = '{{OSS_BINDING:';
const OSS_BINDING_CLOSE = '}}';

function bindingPlaceholder(rowKey: string): string {
  return `${OSS_BINDING_OPEN}${rowKey}${OSS_BINDING_CLOSE}`;
}

type DraftBindingField = 'mediaUrl' | 'fileUrl' | 'mainImageUrl' | 'richTextHtml';

export interface DraftBinding {
  target: UploadTarget;
  rowKey: string;
  field: DraftBindingField;
  path: string;
  placeholder: string;
}

function draftBindingField(target: UploadTarget): DraftBindingField {
  switch (target) {
    case 'medias':
    case 'customerCases.medias':
      return 'mediaUrl';
    case 'certifications.fileUrl':
    case 'salesSupports.fileUrl':
      return 'fileUrl';
    case 'certifications.mainImageUrl':
      return 'mainImageUrl';
    case 'richTextHtml':
      return 'richTextHtml';
  }
}

function buildDraftBinding(target: UploadTarget, rowKey: string): DraftBinding {
  const field = draftBindingField(target);
  let path: string;
  switch (target) {
    case 'medias':
      path = `medias[${rowKey}].mediaUrl`;
      break;
    case 'certifications.fileUrl':
      path = `certifications[${rowKey}].fileUrl`;
      break;
    case 'certifications.mainImageUrl':
      path = `certifications[${rowKey}].mainImageUrl`;
      break;
    case 'customerCases.medias':
      path = `customerCases[${rowKey}].mediaUrl`;
      break;
    case 'salesSupports.fileUrl':
      path = `salesSupports[${rowKey}].fileUrl`;
      break;
    case 'richTextHtml':
      path = `richTextHtml[${rowKey}]`;
      break;
  }
  return { target, rowKey, field, path, placeholder: bindingPlaceholder(rowKey) };
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
  故障处理与质保: 'serviceSupportFile',
  质保政策: 'serviceSupportFile'
};

const certApplyScopeMap: Record<string, number> = {
  整商品通用: 1,
  整商品: 1,
  所有单品通用: 1,
  '整商品/所有单品通用': 1,
  特定型号: 2,
  特定型号单品: 2,
  '特定型号/单品': 2
};

const certStatusMap: Record<string, number> = {
  有效: 1,
  无效: 2,
  过期: 3
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

function fieldMapAny(tables: MarkdownTable[], headingIncludesList: string[]): Record<string, string> {
  return Object.assign({}, ...headingIncludesList.map((heading) => fieldMap(tables, heading)));
}

function tableRows(tables: MarkdownTable[], headingIncludes: string, requiredHeader: string): Array<Record<string, string>> {
  return tablesFor(tables, headingIncludes)
    .filter((table) => table.headers.includes(requiredHeader))
    .flatMap((table) => table.rows);
}

function tableRowsAny(tables: MarkdownTable[], headingIncludesList: string[], requiredHeader: string): Array<Record<string, string>> {
  return headingIncludesList.flatMap((heading) => tableRows(tables, heading, requiredHeader));
}

/**
 * Header-based table lookup, independent of the preceding markdown heading.
 * Used for tables whose section label (e.g. 客户案例媒体) is written as plain
 * text rather than a `#` heading, so row indices stay stable across the file
 * reference collector and the draft builder.
 */
function rowsByHeader(tables: MarkdownTable[], requiredHeader: string): Array<Record<string, string>> {
  return tables
    .filter((table) => table.headers.includes(requiredHeader))
    .flatMap((table) => table.rows);
}

function numberText(value: string | undefined): number | undefined {
  const cleaned = cleanCell(value).replace(/,/g, '');
  if (!cleaned) return undefined;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function firstFilled(row: Record<string, string>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = optionalText(row[key]);
    if (value) return value;
  }
  return undefined;
}

interface SalesSupportEntry {
  draft: Record<string, unknown>;
  filePath?: string;
  fileTitle?: string;
  fileDescription?: string;
  usage?: UploadUsage;
}

function salesSupportEntryHasDraftContent(entry: SalesSupportEntry): boolean {
  return Object.values(entry.draft).some((value) => value !== undefined && value !== null && value !== '');
}

function addSalesEntry(entries: SalesSupportEntry[], entry: SalesSupportEntry): void {
  if (!salesSupportEntryHasDraftContent(entry) && !entry.filePath) return;
  entries.push(entry);
}

function collectSalesSupportEntries(tables: MarkdownTable[]): SalesSupportEntry[] {
  const entries: SalesSupportEntry[] = [];

  // Backward-compatible generic table: 类型 / 标题/问题/异议 / 内容/回答/处理方式.
  tableRows(tables, '销售支持', '类型').forEach((row) => {
    const typeText = cleanCell(row['类型']);
    const type = salesSupportTypeMap[typeText];
    if (!type) return;
    addSalesEntry(entries, {
      draft: {
        type,
        title: optionalText(row['标题/问题/异议']),
        content: optionalText(row['内容/回答/处理方式']),
        fileContent: optionalText(row['文件描述']),
        remark: optionalText(row['备注'])
      },
      filePath: optionalText(row['文件路径']),
      fileTitle: optionalText(row['标题/问题/异议']),
      fileDescription: optionalText(row['文件描述']),
      usage: salesSupportFileUsageByType[typeText] || 'serviceSupportFile'
    });
  });

  const oneLine = fieldMap(tables, '一句话卖点');
  addSalesEntry(entries, {
    draft: {
      type: 1,
      title: optionalText(oneLine['标题']),
      content: optionalText(oneLine['一句话卖点'] || oneLine['内容'])
    }
  });

  tableRows(tables, '核心优势', '标题').forEach((row) => {
    addSalesEntry(entries, {
      draft: {
        type: 2,
        title: optionalText(row['标题']),
        content: optionalText(row['内容'] || row['描述']),
        sortNo: numberText(row['排序']),
        remark: optionalText(row['备注'])
      },
      filePath: optionalText(row['图片路径'] || row['文件路径']),
      fileTitle: optionalText(row['标题']),
      fileDescription: optionalText(row['内容'] || row['描述']),
      usage: 'advantageImage'
    });
  });

  tableRows(tables, '应用场景', '标题').forEach((row) => {
    addSalesEntry(entries, {
      draft: {
        type: 3,
        title: optionalText(row['标题']),
        content: optionalText(row['内容'] || row['描述']),
        sortNo: numberText(row['排序']),
        remark: optionalText(row['备注'])
      },
      filePath: optionalText(row['图片路径'] || row['文件路径']),
      fileTitle: optionalText(row['标题']),
      fileDescription: optionalText(row['内容'] || row['描述']),
      usage: 'scenarioImage'
    });
  });

  tableRows(tables, '常见问题', '问题').forEach((row) => {
    addSalesEntry(entries, {
      draft: {
        type: 4,
        title: optionalText(row['问题']),
        content: optionalText(row['回答']),
        sortNo: numberText(row['排序']),
        remark: optionalText(row['备注'])
      }
    });
  });

  tableRows(tables, '异议处理', '异议').forEach((row) => {
    addSalesEntry(entries, {
      draft: {
        type: 5,
        title: optionalText(row['异议']),
        content: optionalText(row['处理方式']),
        sortNo: numberText(row['排序']),
        remark: optionalText(row['备注'])
      }
    });
  });

  tableRows(tables, '合规红线', '不可承诺事项').forEach((row) => {
    addSalesEntry(entries, {
      draft: {
        type: 6,
        title: optionalText(row['不可承诺事项']),
        content: optionalText(row['说明']),
        sortNo: numberText(row['排序']),
        remark: optionalText(row['备注'])
      }
    });
  });

  tableRows(tables, '售后服务承诺', '承诺事项').forEach((row) => {
    addSalesEntry(entries, {
      draft: {
        type: 7,
        title: optionalText(row['承诺事项']),
        content: optionalText(row['说明']),
        sortNo: numberText(row['排序']),
        remark: optionalText(row['备注'])
      }
    });
  });

  const serviceSupport = fieldMap(tables, '故障处理与质保');
  const serviceContent = optionalText(serviceSupport['服务支持说明']);
  const serviceFilePath = optionalText(serviceSupport['故障处理与质保附件']);
  const serviceFileDescription = optionalText(serviceSupport['附件说明'] || serviceSupport['服务支持说明']);
  if (serviceContent || serviceFilePath || serviceFileDescription) {
    addSalesEntry(entries, {
      draft: {
        type: 8,
        title: '故障处理与质保',
        content: serviceContent,
        fileContent: optionalText(serviceSupport['附件说明'])
      },
      filePath: serviceFilePath,
      fileTitle: '故障处理与质保',
      fileDescription: serviceFileDescription,
      usage: 'serviceSupportFile'
    });
  }

  tableRows(tables, '质保政策', '政策标题').forEach((row) => {
    addSalesEntry(entries, {
      draft: {
        type: 9,
        title: optionalText(row['政策标题']),
        content: optionalText(row['政策内容']),
        sortNo: numberText(row['排序']),
        remark: optionalText(row['备注'])
      }
    });
  });

  const techSupport = fieldMap(tables, '技术支持联系方式');
  const techSupportRow: Record<string, unknown> = {
    type: 10,
    title: '技术支持与联系方式',
    techSupportContact: optionalText(techSupport['技术支持联系人']),
    techSupportPhone: optionalText(techSupport['联系电话']),
    techSupportEmail: optionalText(techSupport['电子邮箱']),
    techSupportHours: optionalText(techSupport['服务时间']),
    techSupportAlternative: optionalText(techSupport['备用联系方式'])
  };
  const hasTechSupportContent = ['techSupportContact', 'techSupportPhone', 'techSupportEmail', 'techSupportHours', 'techSupportAlternative'].some(
    (field) => Boolean(techSupportRow[field])
  );
  if (hasTechSupportContent) addSalesEntry(entries, { draft: techSupportRow });

  return entries;
}

const splitPartSections: Array<{ heading: string; typeLabel: string; typeValue: number }> = [
  { heading: '配件清单', typeLabel: '配件', typeValue: 1 },
  { heading: '备件清单', typeLabel: '备件', typeValue: 2 },
  { heading: '易损件清单', typeLabel: '易损件', typeValue: 3 }
];

function collectPartListRows(tables: MarkdownTable[], issues: PrecheckIssue[]): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];

  tableRows(tables, '配件、备件、易损件', '类型').forEach((row) => {
    rows.push({
      partType: mappedValue(issues, row['类型'], partTypeMap, '配件类型', '配件、备件、易损件'),
      partName: optionalText(row['名称']),
      specAttr: optionalText(row['规格属性']),
      costPrice: numberValue(issues, row['成本价'], '配件成本价', '配件、备件、易损件'),
      suggestedPrice: numberValue(issues, row['建议售价'], '配件建议售价', '配件、备件、易损件'),
      suggestedStock: numberValue(issues, row['建议库存'], '建议库存', '配件、备件、易损件'),
      unitName: optionalText(row['单位']),
      remark: optionalText(row['备注'])
    });
  });

  for (const section of splitPartSections) {
    tableRows(tables, section.heading, '名称').forEach((row) => {
      rows.push({
        partType: section.typeValue,
        partName: optionalText(row['名称']),
        specAttr: optionalText(row['规格型号'] || row['规格属性']),
        costPrice: numberValue(issues, row['成本价'], `${section.heading}.成本价`, section.heading),
        suggestedPrice: numberValue(issues, row['建议售价'], `${section.heading}.建议售价`, section.heading),
        suggestedStock: numberValue(issues, row['建议库存'], `${section.heading}.建议库存`, section.heading),
        unitName: optionalText(row['单位']),
        remark: optionalText(row['备注'])
      });
    });
  }

  return rows;
}

function addIssue(issues: PrecheckIssue[], issue: PrecheckIssue): void {
  issues.push(issue);
}

function appendFrontendValidationIssues(issues: PrecheckIssue[], frontendIssues: SubmissionValidationIssue[]): void {
  for (const issue of frontendIssues) {
    addIssue(issues, {
      severity: 'error',
      code: issue.code,
      message: issue.message,
      section: issue.section,
      row: issue.row,
      field: issue.field
    });
  }
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

function normalizeRelativePathForDedupe(relativePath: string): string {
  return relativePath.replace(/\\/g, '/').replace(/^\.\/+/, '').toLowerCase();
}

function getUploadArtifactVariant(file: CheckedFileReference): string {
  const ratio = file.imagePreparation?.targetRatioText || file.imagePreparation?.targetRatio;
  if (ratio) return `image-ratio:${ratio}`;
  return `original-ext:${file.ext || path.extname(file.absolutePath).replace(/^\./, '').toLowerCase()}`;
}

function buildUploadDedupeKey(file: CheckedFileReference): string {
  return [
    'product-package-file',
    path.resolve(file.absolutePath).toLowerCase(),
    normalizeRelativePathForDedupe(file.relativePath),
    getUploadArtifactVariant(file)
  ].join('|');
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
  required?: boolean,
  extra?: {
    rowKey?: string;
    mediaSubtitle?: string;
    mediaLanguage?: string;
    mediaId?: string;
    mediaRemark?: string;
    partTypeLabel?: string;
  }
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
    required,
    rowKey: extra?.rowKey,
    mediaSubtitle: optionalText(extra?.mediaSubtitle),
    mediaLanguage: optionalText(extra?.mediaLanguage),
    mediaId: optionalText(extra?.mediaId),
    mediaRemark: optionalText(extra?.mediaRemark),
    partTypeLabel: optionalText(extra?.partTypeLabel)
  });
}

function collectFileReferences(
  tables: MarkdownTable[],
  packageDir: string,
  issues: PrecheckIssue[]
): FileReference[] {
  const references: FileReference[] = [];

  tableRows(tables, '商品图片', '图片用途').forEach((row, index) => {
    const label = cleanCell(row['图片用途']);
    const relativePath = cleanCell(row['文件路径']);
    if (!relativePath) return;
    const usage = fileUsageByLabel[label];
    if (!usage) {
      addIssue(issues, {
        severity: 'warning',
        code: 'UNKNOWN_FILE_USAGE',
        section: '商品图片',
        message: `未识别的图片用途：${label}。`
      });
      return;
    }
    addFileReference(
      references,
      packageDir,
      '商品图片',
      references.length + 1,
      usage,
      label,
      relativePath,
      row['标题'],
      row['描述'],
      row['语言'],
      label === '商品主图',
      {
        rowKey: `media-img-${index + 1}`,
        mediaSubtitle: row['副标题'],
        mediaLanguage: row['语言代码'],
        mediaId: row['原图文ID'],
        mediaRemark: row['备注']
      }
    );
  });

  tableRows(tables, '商品视频、3D 与附件', '资料用途').forEach((row, index) => {
    const label = cleanCell(row['资料用途']);
    const relativePath = cleanCell(row['文件路径']);
    if (!relativePath) return;
    const usage = fileUsageByLabel[label];
    if (!usage) {
      addIssue(issues, {
        severity: 'warning',
        code: 'UNKNOWN_FILE_USAGE',
        section: '商品视频、3D 与附件',
        message: `未识别的资料用途：${label}。`
      });
      return;
    }
    addFileReference(
      references,
      packageDir,
      '商品视频、3D 与附件',
      references.length + 1,
      usage,
      label,
      relativePath,
      row['标题'],
      row['描述'],
      row['语言'],
      undefined,
      {
        rowKey: `media-vid-${index + 1}`,
        mediaSubtitle: row['副标题'],
        mediaLanguage: row['语言代码'],
        mediaId: row['原图文ID'],
        mediaRemark: row['备注']
      }
    );
  });

  tableRows(tables, '图文详情', '资料用途').forEach((row, index) => {
    const label = cleanCell(row['资料用途']);
    const relativePath = cleanCell(row['文件路径或内容']);
    if (!isPathLike(relativePath)) return;
    const usage = fileUsageByLabel[label];
    if (!usage) {
      addIssue(issues, {
        severity: 'warning',
        code: 'UNKNOWN_FILE_USAGE',
        section: '图文详情',
        message: `未识别的图文详情资料用途：${label}。`
      });
      return;
    }
    addFileReference(
      references,
      packageDir,
      '图文详情',
      references.length + 1,
      usage,
      label,
      relativePath,
      row['标题'],
      row['描述'],
      undefined,
      undefined,
      { rowKey: `media-detail-${index + 1}` }
    );
  });

  tableRows(tables, '图文详情卡片', '标题').forEach((row, index) => {
    const relativePath = cleanCell(row['图片路径'] || row['文件路径']);
    if (!relativePath) return;
    addFileReference(
      references,
      packageDir,
      '图文详情',
      references.length + 1,
      'graphicDetailImage',
      '图文详情图片',
      relativePath,
      row['标题'],
      firstFilled(row, ['正文', '描述']),
      undefined,
      undefined,
      {
        rowKey: `media-detail-card-${index + 1}`,
        mediaSubtitle: row['副标题'],
        mediaRemark: row['备注']
      }
    );
  });

  tableRows(tables, '认证资料', '证书名称').forEach((row, index) => {
    const certRowKey = `cert-${index + 1}`;
    const filePath = cleanCell(row['文件路径']);
    if (filePath) {
      addFileReference(
        references,
        packageDir,
        '认证资料',
        references.length + 1,
        'certificateFile',
        '认证资料文件',
        filePath,
        row['证书名称'],
        row['备注'],
        undefined,
        undefined,
        { rowKey: `${certRowKey}-fileUrl` }
      );
    }
    const mainImagePath = cleanCell(row['主图路径']);
    if (mainImagePath) {
      addFileReference(
        references,
        packageDir,
        '认证资料',
        references.length + 1,
        'certificateMainImage',
        '认证资料主图',
        mainImagePath,
        row['证书名称'],
        row['备注'],
        undefined,
        undefined,
        { rowKey: `${certRowKey}-mainImageUrl` }
      );
    }
  });

  collectSalesSupportEntries(tables).forEach((entry, index) => {
    const relativePath = cleanCell(entry.filePath);
    if (!relativePath) return;
    addFileReference(
      references,
      packageDir,
      '销售支持',
      references.length + 1,
      entry.usage || 'serviceSupportFile',
      `${String(entry.draft.title || '销售支持')}文件`,
      relativePath,
      String(entry.fileTitle || entry.draft.title || ''),
      entry.fileDescription,
      undefined,
      undefined,
      { rowKey: `sales-${index + 1}` }
    );
  });

  rowsByHeader(tables, '所属客户名称').forEach((row, index) => {
    const relativePath = cleanCell(row['文件路径']);
    if (!relativePath) return;
    const mediaType = cleanCell(row['媒体类型']);
    const usage: UploadUsage = mediaType === '视频' ? 'caseVideo' : 'caseImage';
    addFileReference(
      references,
      packageDir,
      '客户案例媒体',
      references.length + 1,
      usage,
      `客户案例${mediaType || '图片'}`,
      relativePath,
      row['媒体名称'],
      row['备注'],
      undefined,
      undefined,
      { rowKey: `case-media-${index + 1}` }
    );
  });

  tableRows(tables, '配件、备件、易损件', '类型').forEach((row, index) => {
    const partsRowKey = `parts-${index + 1}`;
    const partTypeLabel = cleanCell(row['类型']);
    const imagePath = cleanCell(row['图片路径']);
    if (imagePath) {
      addFileReference(
        references,
        packageDir,
        '配件、备件、易损件',
        references.length + 1,
        'partsImage',
        '配件图片',
        imagePath,
        row['名称'],
        row['备注'],
        undefined,
        undefined,
        { rowKey: `${partsRowKey}-img`, partTypeLabel }
      );
    }
    const attachmentPath = cleanCell(row['附件路径']);
    if (attachmentPath) {
      addFileReference(
        references,
        packageDir,
        '配件、备件、易损件',
        references.length + 1,
        'partsAttachment',
        '配件附件',
        attachmentPath,
        row['名称'],
        row['备注'],
        undefined,
        undefined,
        { rowKey: `${partsRowKey}-att`, partTypeLabel }
      );
    }
  });

  let splitPartFileIndex = 0;
  for (const section of splitPartSections) {
    tableRows(tables, section.heading, '名称').forEach((row) => {
      splitPartFileIndex += 1;
      const partsRowKey = `parts-split-${splitPartFileIndex}`;
      const imagePath = cleanCell(row['图片路径']);
      if (imagePath) {
        addFileReference(
          references,
          packageDir,
          section.heading,
          references.length + 1,
          'partsImage',
          `${section.typeLabel}图片`,
          imagePath,
          row['名称'],
          row['备注'],
          undefined,
          undefined,
          { rowKey: `${partsRowKey}-img`, partTypeLabel: section.typeLabel }
        );
      }
      const attachmentPath = cleanCell(row['附件路径']);
      if (attachmentPath) {
        addFileReference(
          references,
          packageDir,
          section.heading,
          references.length + 1,
          'partsAttachment',
          `${section.typeLabel}附件`,
          attachmentPath,
          row['名称'],
          row['备注'],
          undefined,
          undefined,
          { rowKey: `${partsRowKey}-att`, partTypeLabel: section.typeLabel }
        );
      }
    });
  }

  tableRows(tables, '配件文件明细', '文件类型').forEach((row, index) => {
    const relativePath = cleanCell(row['文件路径']);
    if (!relativePath) return;
    const usage: UploadUsage = cleanCell(row['文件类型']) === '图片' ? 'partsImage' : 'partsAttachment';
    addFileReference(
      references,
      packageDir,
      '配件文件明细',
      references.length + 1,
      usage,
      cleanCell(row['文件类型']) || '配件文件',
      relativePath,
      row['名称'],
      row['备注'],
      undefined,
      undefined,
      { rowKey: `parts-file-${index + 1}`, partTypeLabel: row['类型'] }
    );
  });

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

function validateCertificationTables(tables: MarkdownTable[], issues: PrecheckIssue[]): void {
  const rows = tableRows(tables, '认证资料', '证书名称');
  rows.forEach((row, index) => {
    const rowNumber = index + 1;
    const hasContent = [
      '证书名称',
      '证书类型',
      '证书编号',
      '覆盖区域',
      '覆盖区域ID',
      '生效日期',
      '到期日期',
      '是否永久有效',
      '文件路径',
      '主图路径',
      '文件分类'
    ].some((field) => cleanCell(row[field]));
    if (!hasContent) return;

    if (!cleanCell(row['文件分类'])) {
      addIssue(issues, { severity: 'error', code: 'CERT_FILE_CATEGORY_REQUIRED', section: '认证资料', row: rowNumber, message: `认证资料第 ${rowNumber} 行必须填写文件分类。` });
    }
    if (!cleanCell(row['文件路径'])) {
      addIssue(issues, { severity: 'error', code: 'CERT_FILE_REQUIRED', section: '认证资料', row: rowNumber, message: `认证资料第 ${rowNumber} 行必须填写文件路径。` });
    }
    if (!cleanCell(row['主图路径'])) {
      addIssue(issues, { severity: 'error', code: 'CERT_MAIN_IMAGE_REQUIRED', section: '认证资料', row: rowNumber, message: `认证资料第 ${rowNumber} 行必须填写主图路径。` });
    }
    if (!cleanCell(row['证书名称'])) {
      addIssue(issues, { severity: 'error', code: 'CERT_NAME_REQUIRED', section: '认证资料', row: rowNumber, message: `认证资料第 ${rowNumber} 行必须填写证书名称。` });
    }
    if (!cleanCell(row['证书类型'])) {
      addIssue(issues, { severity: 'error', code: 'CERT_TYPE_REQUIRED', section: '认证资料', row: rowNumber, message: `认证资料第 ${rowNumber} 行必须填写证书类型。` });
    }
    if (!cleanCell(row['覆盖区域']) && !cleanCell(row['覆盖区域ID'])) {
      addIssue(issues, { severity: 'error', code: 'CERT_REGION_REQUIRED', section: '认证资料', row: rowNumber, message: `认证资料第 ${rowNumber} 行必须填写覆盖区域。` });
    }
    if (!cleanCell(row['证书编号'])) {
      addIssue(issues, { severity: 'error', code: 'CERT_NO_REQUIRED', section: '认证资料', row: rowNumber, message: `认证资料第 ${rowNumber} 行必须填写证书编号。` });
    }

    const isPermanent = cleanCell(row['是否永久有效']) === '是';
    const effectiveDate = cleanCell(row['生效日期']);
    const expiryDate = cleanCell(row['到期日期']);
    if (!isPermanent) {
      if (!effectiveDate) {
        addIssue(issues, { severity: 'error', code: 'CERT_EFFECTIVE_DATE_REQUIRED', section: '认证资料', row: rowNumber, message: `认证资料第 ${rowNumber} 行必须填写生效日期。` });
      }
      if (!expiryDate) {
        addIssue(issues, { severity: 'error', code: 'CERT_EXPIRY_DATE_REQUIRED', section: '认证资料', row: rowNumber, message: `认证资料第 ${rowNumber} 行必须填写到期日期。` });
      }
      if (effectiveDate && expiryDate) {
        const effectiveTime = Date.parse(effectiveDate);
        const expiryTime = Date.parse(expiryDate);
        if (Number.isFinite(effectiveTime) && Number.isFinite(expiryTime) && expiryTime <= effectiveTime) {
          addIssue(issues, { severity: 'error', code: 'CERT_DATE_ORDER_INVALID', section: '认证资料', row: rowNumber, message: `认证资料第 ${rowNumber} 行到期日期必须晚于生效日期。` });
        }
      }
    }
  });

}

function validateSalesSupportTables(tables: MarkdownTable[], issues: PrecheckIssue[]): void {
  const rows = tableRows(tables, '销售支持', '类型');
  rows.forEach((row, index) => {
    const rowNumber = index + 1;
    const type = cleanCell(row['类型']);
    const title = cleanCell(row['标题/问题/异议']);
    const content = cleanCell(row['内容/回答/处理方式']);
    const filePath = cleanCell(row['文件路径']);

    if (type === '核心优势' || type === '应用场景') {
      const hasContent = Boolean(title || content || filePath);
      if (hasContent && !(title && content && filePath)) {
        addIssue(issues, {
          severity: 'error',
          code: 'SALES_IMAGE_TEXT_ROW_INCOMPLETE',
          section: '销售支持',
          row: rowNumber,
          message: `销售支持第 ${rowNumber} 行（${type}）必须同时填写标题、内容、文件路径。`
        });
      }
    }

    if (type === '常见问题与标准回答' || type === '常见问题&标准回答' || type === '异议处理') {
      const hasContent = Boolean(title || content);
      if (hasContent && !(title && content)) {
        addIssue(issues, {
          severity: 'error',
          code: 'SALES_QA_ROW_INCOMPLETE',
          section: '销售支持',
          row: rowNumber,
          message: `销售支持第 ${rowNumber} 行（${type}）必须同时填写标题和内容。`
        });
      }
    }
  });

  const validateTitleContentRows = (
    heading: string,
    firstHeader: string,
    titleField: string,
    contentField: string,
    imageField?: string
  ) => {
    tableRows(tables, heading, firstHeader).forEach((row, index) => {
      const rowNumber = index + 1;
      const title = cleanCell(row[titleField]);
      const content = cleanCell(row[contentField]);
      const imagePath = imageField ? cleanCell(row[imageField]) : '';
      const hasContent = Boolean(title || content || imagePath || cleanCell(row['排序']) || cleanCell(row['备注']));
      if (!hasContent) return;
      if (!(title && content)) {
        addIssue(issues, {
          severity: 'error',
          code: 'SALES_STRUCTURED_ROW_INCOMPLETE',
          section: heading,
          row: rowNumber,
          message: `${heading}第 ${rowNumber} 行必须同时填写${titleField}和${contentField}。`
        });
      }
    });
  };

  validateTitleContentRows('核心优势', '标题', '标题', '内容', '图片路径');
  validateTitleContentRows('应用场景', '标题', '标题', '内容', '图片路径');
  validateTitleContentRows('常见问题', '问题', '问题', '回答');
  validateTitleContentRows('异议处理', '异议', '异议', '处理方式');
  validateTitleContentRows('合规红线', '不可承诺事项', '不可承诺事项', '说明');
  validateTitleContentRows('售后服务承诺', '承诺事项', '承诺事项', '说明');
  validateTitleContentRows('质保政策', '政策标题', '政策标题', '政策内容');
}

function validateCustomerCaseTables(tables: MarkdownTable[], issues: PrecheckIssue[]): void {
  const caseRows = tableRows(tables, '客户案例', '客户名称');
  const mediaRows = rowsByHeader(tables, '所属客户名称');
  caseRows.forEach((row, index) => {
    const rowNumber = index + 1;
    const customerName = cleanCell(row['客户名称']);
    const productName = cleanCell(row['产品名称']);
    const purchaseQuantity = cleanCell(row['采购数量']);
    const applicationScene = cleanCell(row['应用场景']);
    const caseHighlight = cleanCell(row['案例亮点']);
    const hasContent = Boolean(customerName || productName || purchaseQuantity || applicationScene || caseHighlight);
    if (!hasContent) return;

    const linkedMediaRows = mediaRows.filter((mediaRow) => cleanCell(mediaRow['所属客户名称']) === customerName);
    const imageCount = linkedMediaRows.filter((mediaRow) => cleanCell(mediaRow['媒体类型']) !== '视频' && cleanCell(mediaRow['文件路径'])).length;
    if (imageCount === 0) {
      addIssue(issues, {
        severity: 'error',
        code: 'CUSTOMER_CASE_IMAGE_REQUIRED',
        section: '客户案例',
        row: rowNumber,
        message: `客户案例第 ${rowNumber} 行至少需要 1 张图片。`
      });
    }
    if (!productName) {
      addIssue(issues, { severity: 'error', code: 'CUSTOMER_CASE_PRODUCT_REQUIRED', section: '客户案例', row: rowNumber, message: `客户案例第 ${rowNumber} 行必须填写产品名称。` });
    }
    if (!customerName) {
      addIssue(issues, { severity: 'error', code: 'CUSTOMER_CASE_CUSTOMER_REQUIRED', section: '客户案例', row: rowNumber, message: `客户案例第 ${rowNumber} 行必须填写客户名称。` });
    }
    const quantity = purchaseQuantity ? Number(purchaseQuantity) : undefined;
    if (!purchaseQuantity || quantity === undefined || !Number.isFinite(quantity) || quantity <= 0 || !Number.isInteger(quantity)) {
      addIssue(issues, {
        severity: 'error',
        code: 'CUSTOMER_CASE_QUANTITY_INVALID',
        section: '客户案例',
        row: rowNumber,
        message: `客户案例第 ${rowNumber} 行采购数量必须为正整数。`
      });
    }
    if (!applicationScene) {
      addIssue(issues, { severity: 'error', code: 'CUSTOMER_CASE_SCENE_REQUIRED', section: '客户案例', row: rowNumber, message: `客户案例第 ${rowNumber} 行必须填写应用场景。` });
    }
    if (!caseHighlight) {
      addIssue(issues, { severity: 'error', code: 'CUSTOMER_CASE_HIGHLIGHT_REQUIRED', section: '客户案例', row: rowNumber, message: `客户案例第 ${rowNumber} 行必须填写案例亮点。` });
    }
  });
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

function configId(item: Record<string, unknown> | undefined): string | undefined {
  if (!item) return undefined;
  const value = item.id;
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text || undefined;
}

function findById(items: Array<Record<string, unknown>> | undefined, id: unknown): Record<string, unknown> | undefined {
  const normalized = String(id ?? '').trim();
  if (!normalized) return undefined;
  return (items || []).find((item) => configId(item) === normalized);
}

function findByLabel(items: Array<Record<string, unknown>> | undefined, label: unknown): Record<string, unknown> | undefined {
  const normalized = normalizeLookupText(label);
  if (!normalized) return undefined;
  return (items || []).find((item) => normalizeLookupText(configLabel(item)) === normalized);
}

function optionItems(config: Record<string, unknown> | undefined): Array<Record<string, unknown>> {
  return Array.isArray(config?.items) ? (config.items as Array<Record<string, unknown>>) : [];
}

function assignConfigReference(
  row: Record<string, unknown>,
  item: Record<string, unknown> | undefined,
  idField: string,
  nameField: string
): void {
  const id = configId(item);
  if (id) row[idField] = id;
  const label = configLabel(item);
  if (label && !row[nameField]) row[nameField] = label;
}

function normalizedUnitList(categoryConfig: CategoryConfigForPrecheck): Array<Record<string, unknown>> | undefined {
  return categoryConfig.units || categoryConfig.unitList;
}

function validateDraftAgainstCategoryConfig(
  draft: Record<string, unknown> | undefined,
  categoryConfig: CategoryConfigForPrecheck | undefined,
  issues: PrecheckIssue[]
): void {
  if (!draft || !categoryConfig) return;

  if (!draft.unitId && draft.unitName) {
    const unit = findByLabel(normalizedUnitList(categoryConfig), draft.unitName);
    if (unit) {
      draft.unitId = configId(unit);
      draft.unitName = configLabel(unit) || draft.unitName;
    } else {
      addIssue(issues, {
        severity: 'error',
        code: 'CATEGORY_UNIT_NOT_FOUND',
        section: '分类、单位、供应商',
        message: `计量单位不存在或不适用于当前分类：${String(draft.unitName)}。`
      });
    }
  }

  const baseConfigs = Array.isArray(draft.baseConfigs) ? (draft.baseConfigs as Array<Record<string, unknown>>) : [];
  baseConfigs.forEach((row, index) => {
    const config = findById(categoryConfig.baseConfigs, row.categoryBaseId) || findByLabel(categoryConfig.baseConfigs, row.name);
    if (config) {
      assignConfigReference(row, config, 'categoryBaseId', 'name');
      const source = config.source;
      if (source !== undefined && source !== null && row.source === undefined) row.source = source;
      return;
    }
    if (row.name || row.categoryBaseId) {
      addIssue(issues, {
        severity: 'error',
        code: 'CATEGORY_BASE_CONFIG_NOT_FOUND',
        section: '基础配置',
        row: index + 1,
        message: `基础配置不存在或不可用：${String(row.name || row.categoryBaseId)}。`
      });
    }
  });

  const technicalParams = Array.isArray(draft.technicalParams) ? (draft.technicalParams as Array<Record<string, unknown>>) : [];
  technicalParams.forEach((row, index) => {
    const config = findById(categoryConfig.technicalParams, row.categoryBaseId) || findByLabel(categoryConfig.technicalParams, row.name);
    if (config) {
      assignConfigReference(row, config, 'categoryBaseId', 'name');
      return;
    }
    if (row.name || row.categoryBaseId) {
      addIssue(issues, {
        severity: 'error',
        code: 'CATEGORY_TECHNICAL_PARAM_NOT_FOUND',
        section: '技术参数',
        row: index + 1,
        message: `技术参数不存在或不可用：${String(row.name || row.categoryBaseId)}。`
      });
    }
  });

  const optionalConfigs = Array.isArray(draft.optionalConfigs) ? (draft.optionalConfigs as Array<Record<string, unknown>>) : [];
  optionalConfigs.forEach((row, index) => {
    const configValue = row.configValue;
    const config =
      findById(categoryConfig.optionalConfigs, row.categoryOptionalId) || findByLabel(categoryConfig.optionalConfigs, row.name);
    if (!config) {
      if (row.name || row.categoryOptionalId) {
        addIssue(issues, {
          severity: 'error',
          code: 'CATEGORY_OPTIONAL_CONFIG_NOT_FOUND',
          section: '可选配置',
          row: index + 1,
          message: `可选配置不存在或不可用：${String(row.name || row.categoryOptionalId)}。`
        });
      }
      return;
    }
    assignConfigReference(row, config, 'categoryOptionalId', 'name');

    if (!configValue) return;
    const options = optionItems(config);
    const option = findById(options, row.categoryOptionalConfigId) || findByLabel(options, configValue);
    if (!option) {
      const allowed = options.map((item) => configLabel(item)).filter(Boolean).join('、');
      addIssue(issues, {
        severity: 'error',
        code: 'CATEGORY_OPTIONAL_CONFIG_VALUE_NOT_FOUND',
        section: '可选配置',
        row: index + 1,
        message: `可选配置 ${String(row.name)} 不存在选项值：${String(configValue)}。可选值：${allowed || '无'}。`
      });
      return;
    }
    const optionId = configId(option);
    if (optionId) row.categoryOptionalConfigId = optionId;
    const optionLabel = configLabel(option);
    if (optionLabel) row.configValue = optionLabel;
    if (row.priceDiffCny === undefined && option.priceDiffCny !== undefined) row.priceDiffCny = option.priceDiffCny;
    if (row.priceDiffUsd === undefined && option.priceDiffUsd !== undefined) row.priceDiffUsd = option.priceDiffUsd;
  });
}

function parseDraft(markdown: string, tables: MarkdownTable[], issues: PrecheckIssue[]): Record<string, unknown> {
  const basic = fieldMapAny(tables, ['基础信息', '商品身份']);
  const refs = fieldMap(tables, '分类、单位、供应商');
  const region = fieldMapAny(tables, ['适用区域', '地域信息']);
  const sales = fieldMapAny(tables, ['销售、交付、售后', '服务属性与样品设置', '交付、库存、售后']);
  const price = fieldMapAny(tables, ['价格信息', '价格字段']);
  const packageInfo = fieldMapAny(tables, ['包装与物流', '包装配置']);
  const related = fieldMap(tables, '关联商品');

  const draft: Record<string, unknown> = {
    productNameCn: requiredText(issues, basic['商品中文名称'], '商品中文名称', '基础信息'),
    productNameEn: optionalText(basic['商品英文名称']),
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
    hsCode: optionalText(basic['建议HS编码'] || basic['HS 编码']),
    usagePurpose: optionalText(basic['产品用途']),
    relatedCommodityId: optionalText(related['关联商品ID']),
    remark: optionalText(basic['商品备注']),
    skipTranslation: mappedValue(issues, basic['是否跳过翻译'], yesNoMap, '是否跳过翻译', '基础信息'),
    proofreadStatus: mappedValue(issues, basic['校对状态'], proofreadStatusMap, '校对状态', '基础信息'),
    isInnerTreasury: mappedValue(issues, basic['是否内库商品'], yesNoMap, '是否内库商品', '基础信息'),
    externalAddress: optionalText(basic['外库上架位置']),
    externalStatus: mappedValue(issues, basic['外库状态'], statusMap, '外库状态', '基础信息'),
    categoryFirstName: optionalText(refs['一级分类']),
    categorySecondName: optionalText(refs['二级分类']),
    categoryThirdName: optionalText(refs['三级分类']),
    unitName: requiredText(issues, refs['计量单位'], '计量单位', '分类、单位、供应商'),
    supplierName: requiredText(issues, refs['供应商'], '供应商', '分类、单位、供应商'),
    supplierProductionCycle: numberValue(issues, refs['供应商预计生产周期'], '供应商预计生产周期', '分类、单位、供应商'),
    supplierCycleUnit: mappedValue(issues, refs['生产周期单位'], cycleUnitMap, '生产周期单位', '分类、单位、供应商'),
    useAllRegions: cleanCell(region['适用范围']) === '全球',
    supportConsolidation: mappedValue(issues, sales['是否支持拼柜'], yesNoMap, '是否支持拼柜', '销售、交付、售后', true),
    canExhibit: mappedValue(issues, sales['是否可做展品'], yesNoMap, '是否可做展品', '销售、交付、售后', true),
    needInstallation: mappedValue(issues, sales['是否需要安装'], yesNoMap, '是否需要安装', '销售、交付、售后', true),
    hasAfterSalesThreshold: mappedValue(issues, sales['是否有售后门槛'], yesNoMap, '是否有售后门槛', '销售、交付、售后', true),
    supportSample: mappedValue(issues, sales['是否支持样品'], yesNoMap, '是否支持样品', '销售、交付、售后', true),
    samplePrice: numberValue(issues, sales['样品价'], '样品价', '销售、交付、售后'),
    supportPartsAlone: mappedValue(issues, sales['是否支持配件单买'], yesNoMap, '是否支持配件单买', '销售、交付、售后', true),
    supportOem: mappedValue(issues, sales['是否支持 OEM'], yesNoMap, '是否支持 OEM', '销售、交付、售后', true),
    supportOdm: mappedValue(issues, sales['是否支持 ODM'], yesNoMap, '是否支持 ODM', '销售、交付、售后', true),
    moq: numberValue(issues, sales['最小起订量 MOQ'], '最小起订量 MOQ', '销售、交付、售后'),
    warrantyPeriod: numberValue(issues, sales['质保期限'], '质保期限', '销售、交付、售后'),
    warrantyPeriodUnit: mappedValue(issues, sales['质保期限单位'], warrantyPeriodUnitMap, '质保期限单位', '销售、交付、售后'),
    supportSmallTrial: mappedValue(issues, sales['是否支持小批量试单'], yesNoMap, '是否支持小批量试单', '销售、交付、售后', true),
    minTrialQuantity: numberValue(issues, sales['最小试单量'], '最小试单量', '销售、交付、售后'),
    hasSpotStock: mappedValue(issues, sales['是否现货备货'], yesNoMap, '是否现货备货', '销售、交付、售后', true),
    hasOverseasWarehouseStock: mappedValue(issues, sales['是否海外仓备货'], yesNoMap, '是否海外仓备货', '销售、交付、售后', true),
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
    tableRowsAny(tables, ['适用区域', '地域信息'], '区域名称').map((row) => ({
      regionName: optionalText(row['区域名称']),
      regionId: optionalText(row['区域ID']),
      isAll: mappedValue(issues, row['是否全球'], yesNoMap, '适用区域.是否全球', '适用区域'),
      customerType: optionalText(row['客户类型']),
      originPlace: optionalText(row['产品产地']),
      sortNo: numberValue(issues, row['排序'], '适用区域.排序', '适用区域'),
      remark: optionalText(row['备注'])
    }))
  );
  draft.priceTiers = compactRows(
    tableRowsAny(tables, ['价格信息', '价格阶梯'], '最小数量').map((row) => ({
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
      categoryBaseId: optionalText(row['配置项ID'] || row['ID']),
      name: optionalText(row['配置项名称']),
      configValue: optionalText(row['配置值']),
      source: numberValue(issues, row['来源'], '基础配置.来源', '基础配置'),
      remark: optionalText(row['备注'])
    }))
  );
  draft.technicalParams = compactRows(
    tableRows(tables, '技术参数', '参数名称').map((row) => ({
      categoryBaseId: optionalText(row['参数ID'] || row['ID']),
      name: optionalText(row['参数名称']),
      paramValue: optionalText(row['参数值']),
      remark: optionalText(row['备注'])
    }))
  );
  draft.optionalConfigs = compactRows(
    tableRows(tables, '可选配置', '配置名称').map((row) => ({
      categoryOptionalId: optionalText(row['配置ID'] || row['配置项ID']),
      name: optionalText(row['配置名称']),
      categoryOptionalConfigId: optionalText(row['选项ID']),
      configValue: optionalText(row['选项值']),
      priceDiffCny: numberValue(issues, row['人民币差价'], '可选配置.人民币差价', '可选配置'),
      priceDiffUsd: numberValue(issues, row['美元差价'], '可选配置.美元差价', '可选配置'),
      status: mappedValue(issues, row['是否展示'], optionalConfigStatusMap, '可选配置.是否展示', '可选配置'),
      remark: optionalText(row['备注'])
    }))
  );
  draft.partLists = compactRows(collectPartListRows(tables, issues));
  draft.salesSupports = compactRows(collectSalesSupportEntries(tables).map((entry) => entry.draft));
  draft.competitors = compactRows(
    tableRows(tables, '竞品对比', '对比维度').map((row) => ({
      dimensionName: optionalText(row['对比维度']),
      ourProductValue: optionalText(row['我方产品值']),
      competitorValue: optionalText(
        row['竞品名称'] && row['竞品值'] ? `${cleanCell(row['竞品名称'])}：${cleanCell(row['竞品值'])}` : row['竞品值']
      ),
      remark: optionalText(row['备注'])
    }))
  );

  return draft;
}

function unresolvedReferences(draft: Record<string, unknown>) {
  const categoryPath = [draft.categoryFirstName, draft.categorySecondName, draft.categoryThirdName]
    .map((value) => String(value ?? '').trim())
    .filter(Boolean);
  return {
    categoryFirstName: draft.categoryFirstName,
    categorySecondName: draft.categorySecondName,
    categoryThirdName: draft.categoryThirdName,
    unitName: draft.unitName,
    supplierName: draft.supplierName,
    lookupPlan: [
      {
        tool: 'product_list_categories',
        match: '按用户填写的分类路径做完全匹配；如果有可用子级，继续匹配到最末级分类。',
        categoryPath,
        fill: ['categoryFirstId', 'categorySecondId', 'categoryThirdId']
      },
      {
        tool: 'product_get_category_config',
        when: '分类末级 ID 已解析后调用。',
        fill: ['unitId', 'baseConfigs[].categoryBaseId', 'technicalParams[].categoryBaseId', 'optionalConfigs[].categoryOptionalId', 'optionalConfigs[].categoryOptionalConfigId']
      },
      {
        tool: 'product_list_suppliers',
        match: '供应商名称完全匹配。',
        fill: ['suppliers[].supplierId']
      },
      {
        tool: 'product_list_regions',
        when: '适用范围为指定区域时调用。',
        match: '区域名称完全匹配。',
        fill: ['regions[].regionId']
      }
    ],
    note: 'product_create 需要真实 categoryFirstId/categorySecondId/categoryThirdId/unitId/supplierId。用户不需要填写这些 ID；下一步应通过只读 MCP 工具解析名称并回填。'
  };
}

const MEDIA_SECTIONS = new Set(['商品图片', '商品视频、3D 与附件', '图文详情']);
const PART_MEDIA_SECTIONS = new Set(['配件、备件、易损件', '配件清单', '备件清单', '易损件清单', '配件文件明细']);
const partImageCategoryMap: Record<string, number> = {
  配件: 9,
  备件: 10,
  易损件: 11
};
const partOtherCategoryMap: Record<string, number> = {
  配件: 3,
  备件: 4,
  易损件: 5
};

function partMediaCategory(file: CheckedFileReference): { imageCategory?: number; otherCategory?: number } {
  const label = file.partTypeLabel || '配件';
  if (file.usage === 'partsImage') {
    return { imageCategory: partImageCategoryMap[label] || partImageCategoryMap.配件 };
  }
  if (file.usage === 'partsAttachment') {
    return { otherCategory: partOtherCategoryMap[label] || partOtherCategoryMap.配件 };
  }
  return {};
}

function mediaEntryFromFile(file: CheckedFileReference, sort: number): Record<string, unknown> | undefined {
  const policy = getUploadPolicy(file.usage);
  if (policy.target !== 'medias') return undefined;
  const entry: Record<string, unknown> = {
    mediaType: policy.mediaType,
    mediaUrl: bindingPlaceholder(file.rowKey || ''),
    mediaName: path.basename(file.relativePath),
    sort
  };
  if (file.usage === 'partsImage') {
    entry.mediaType = 1;
  }
  if (file.usage === 'partsAttachment') {
    entry.mediaType = 3;
  }
  if (!entry.mediaType) return undefined;
  if (file.title) entry.mediaTitle = file.title;
  if (file.mediaSubtitle) entry.mediaSubtitle = file.mediaSubtitle;
  if (file.description) entry.mediaDesc = file.description;
  if (file.mediaLanguage) entry.language = file.mediaLanguage;
  if (file.languageList) entry.languageList = file.languageList;
  if (file.mediaId) entry.mediaId = file.mediaId;
  if (policy.imageCategory) entry.imageCategory = policy.imageCategory;
  if (policy.videoCategory) entry.videoCategory = policy.videoCategory;
  if (policy.otherCategory) entry.otherCategory = policy.otherCategory;
  const partCategory = partMediaCategory(file);
  if (partCategory.imageCategory) entry.imageCategory = partCategory.imageCategory;
  if (partCategory.otherCategory) entry.otherCategory = partCategory.otherCategory;
  if (file.mediaRemark) entry.remark = file.mediaRemark;
  return entry;
}

/**
 * Populate draftCreateInput.medias / certifications / customerCases from the
 * checked file references and the markdown tables. URL fields carry unresolved
 * `{{OSS_BINDING:<rowKey>}}` placeholders that match the `draftBinding.rowKey`
 * on the corresponding uploadQueue item, so an orchestrator can apply uploaded
 * OSS URLs deterministically. Only valid (ok) files receive a placeholder;
 * product_create rejects any placeholder that survives into submission.
 */
function attachDraftMediaAndBindings(
  draft: Record<string, unknown> | undefined,
  tables: MarkdownTable[],
  checkedFiles: CheckedFileReference[]
): void {
  if (!draft) return;

  const okRowKeys = new Set<string>();
  const fileByRowKey = new Map<string, CheckedFileReference>();
  for (const file of checkedFiles) {
    if (file.ok && file.rowKey) {
      okRowKeys.add(file.rowKey);
      fileByRowKey.set(file.rowKey, file);
    }
  }

  const medias: Array<Record<string, unknown>> = [];
  for (const file of checkedFiles) {
    if (!file.ok || !file.rowKey || (!MEDIA_SECTIONS.has(file.section) && !PART_MEDIA_SECTIONS.has(file.section))) continue;
    const entry = mediaEntryFromFile(file, medias.length + 1);
    if (!entry) continue;
    medias.push(entry);
  }
  if (medias.length) draft.medias = medias;

  const salesSupports = Array.isArray(draft.salesSupports) ? (draft.salesSupports as Array<Record<string, unknown>>) : [];
  salesSupports.forEach((row, index) => {
    const rowKey = `sales-${index + 1}`;
    if (okRowKeys.has(rowKey)) row.fileUrl = bindingPlaceholder(rowKey);
  });

  const certifications: Array<Record<string, unknown>> = [];
  tableRows(tables, '认证资料', '证书名称').forEach((row, index) => {
    // Skip the 认证覆盖区域明细 sub-table, which only carries 证书名称/覆盖区域.
    const isCertRow = [
      '证书类型',
      '证书编号',
      '文件路径',
      '主图路径',
      '文件分类',
      '生效日期',
      '到期日期',
      '是否永久有效',
      '适用范围',
      '适用特定型号',
      '状态',
      '排序',
      '备注'
    ].some((field) => cleanCell(row[field]));
    if (!isCertRow) return;

    const ci = index + 1;
    const entry: Record<string, unknown> = {};
    const name = optionalText(row['证书名称']);
    if (name) entry.name = name;
    const certificateType = optionalText(row['证书类型']);
    if (certificateType) entry.certificateType = certificateType;
    const certificateNo = optionalText(row['证书编号']);
    if (certificateNo) entry.certificateNo = certificateNo;
    const coverRegions = optionalText(row['覆盖区域']);
    if (coverRegions) entry.coverRegions = coverRegions;
    const coverRegionIds = optionalText(row['覆盖区域ID']);
    if (coverRegionIds) entry.coverRegionIds = coverRegionIds;
    const applyScopeText = cleanCell(row['适用范围']);
    if (applyScopeText) entry.applyScope = certApplyScopeMap[applyScopeText] ?? applyScopeText;
    const applyModelNames = optionalText(row['适用特定型号']);
    if (applyModelNames) entry.applyModelNames = applyModelNames;
    const applyModelIds = optionalText(row['适用特定型号ID']);
    if (applyModelIds) entry.applyModelIds = applyModelIds;
    const effectiveDate = optionalText(row['生效日期']);
    if (effectiveDate) entry.effectiveDate = effectiveDate;
    const expiryDate = optionalText(row['到期日期']);
    if (expiryDate) entry.expiryDate = expiryDate;
    entry.isPermanent = cleanCell(row['是否永久有效']) === '是' ? 1 : 0;
    const fileCategory = optionalText(row['文件分类']);
    if (fileCategory) entry.fileCategory = fileCategory;
    const statusText = cleanCell(row['状态']);
    if (statusText) entry.status = certStatusMap[statusText] ?? statusText;
    const sortValue = cleanCell(row['排序']);
    if (sortValue) {
      const parsed = Number(sortValue);
      if (Number.isFinite(parsed)) entry.sort = parsed;
    }
    const remark = optionalText(row['备注']);
    if (remark) entry.remark = remark;

    const fileRowKey = `cert-${ci}-fileUrl`;
    const mainRowKey = `cert-${ci}-mainImageUrl`;
    if (okRowKeys.has(fileRowKey)) entry.fileUrl = bindingPlaceholder(fileRowKey);
    if (okRowKeys.has(mainRowKey)) entry.mainImageUrl = bindingPlaceholder(mainRowKey);

    certifications.push(entry);
  });
  if (certifications.length) draft.certifications = certifications;

  const caseRows = tableRows(tables, '客户案例', '客户名称');
  const caseMediaRows = rowsByHeader(tables, '所属客户名称');
  const caseMediaByCustomer = new Map<string, Array<string>>();
  caseMediaRows.forEach((mrow, index) => {
    const owner = cleanCell(mrow['所属客户名称']);
    if (!owner) return;
    if (!cleanCell(mrow['文件路径'])) return;
    const rowKey = `case-media-${index + 1}`;
    const list = caseMediaByCustomer.get(owner) || [];
    list.push(rowKey);
    caseMediaByCustomer.set(owner, list);
  });

  const customerCases: Array<Record<string, unknown>> = [];
  for (const row of caseRows) {
    const customerName = cleanCell(row['客户名称']);
    const hasContent = ['客户名称', '产品名称', '采购数量', '应用场景', '案例亮点'].some((field) => cleanCell(row[field]));
    if (!hasContent) continue;

    const entry: Record<string, unknown> = {};
    if (customerName) entry.customerName = customerName;
    const productName = optionalText(row['产品名称']);
    if (productName) entry.productName = productName;
    const quantityText = cleanCell(row['采购数量']);
    if (quantityText) {
      const quantity = Number(quantityText);
      if (Number.isFinite(quantity)) entry.purchaseQuantity = quantity;
    }
    const applicationScene = optionalText(row['应用场景']);
    if (applicationScene) entry.applicationScene = applicationScene;
    const caseHighlight = optionalText(row['案例亮点']);
    if (caseHighlight) entry.caseHighlight = caseHighlight;
    const sortNo = numberText(row['排序']);
    if (sortNo !== undefined) entry.sortNo = sortNo;
    const remark = optionalText(row['备注']);
    if (remark) entry.remark = remark;

    const mediaRowKeys = caseMediaByCustomer.get(customerName) || [];
    const caseMedias: Array<Record<string, unknown>> = [];
    for (const rowKey of mediaRowKeys) {
      const file = fileByRowKey.get(rowKey);
      if (!file) continue;
      const policy = getUploadPolicy(file.usage);
      const mediaEntry: Record<string, unknown> = {
        mediaType: policy.mediaType,
        mediaUrl: bindingPlaceholder(rowKey),
        mediaName: path.basename(file.relativePath),
        sort: caseMedias.length + 1
      };
      if (file.title) mediaEntry.mediaTitle = file.title;
      if (file.description) mediaEntry.mediaDesc = file.description;
      if (policy.imageCategory) mediaEntry.imageCategory = policy.imageCategory;
      if (policy.videoCategory) mediaEntry.videoCategory = policy.videoCategory;
      caseMedias.push(mediaEntry);
    }
    if (caseMedias.length) entry.medias = caseMedias;

    customerCases.push(entry);
  }
  if (customerCases.length) draft.customerCases = customerCases;
}

export async function precheckProductPackage(rawInput: unknown) {
  const input = productPrecheckPackageObjectSchema.parse(rawInput);
  const issues: PrecheckIssue[] = [];
  const { packageDir, markdownPath } = await resolveMarkdownPath(input);
  const markdown = await readFile(markdownPath, 'utf8');
  const tables = parseMarkdownTables(markdown);
  const draft = input.includeDraft ? parseDraft(markdown, tables, issues) : undefined;
  if (draft) {
    appendFrontendValidationIssues(
      issues,
      validateFrontendAlignedSubmission(draft, {
        allowReferenceNames: true,
        skipCertificationValidation: true,
        skipMediaValidation: true,
        skipSalesValidation: true
      })
    );
  }
  validateDraftAgainstCategoryConfig(draft, input.categoryConfig, issues);
  validateCertificationTables(tables, issues);
  validateSalesSupportTables(tables, issues);
  validateCustomerCaseTables(tables, issues);
  const fileReferences = collectFileReferences(tables, packageDir, issues);
  const checkedFiles = await checkFiles(fileReferences, issues);
  attachDraftMediaAndBindings(draft, tables, checkedFiles);
  const requiredFileOk = checkedFiles.some((file) => file.usage === 'productMainImage' && file.ok);
  if (!requiredFileOk) {
    addIssue(issues, {
      severity: 'error',
      code: 'PRODUCT_MAIN_IMAGE_REQUIRED',
      section: '商品图片',
      message: '未找到可用的商品主图，商品主图是创建前硬拦截字段。'
    });
  }

  const bannerFileOk = checkedFiles.some((file) => file.usage === 'bannerImage' && file.ok);
  if (!bannerFileOk) {
    addIssue(issues, {
      severity: 'warning',
      code: 'BANNER_IMAGE_OPTIONAL',
      section: '商品图片',
      message: '未找到可用的 Banner 图，建议补充以提升前台展示效果。'
    });
  }

  const errorCount = issues.filter((issue) => issue.severity === 'error').length;
  const warningCount = issues.filter((issue) => issue.severity === 'warning').length;
  const invalidOptionalFileCount = checkedFiles.filter((file) => !file.ok && !file.required).length;
  const uploadQueue = checkedFiles
    .filter((file) => file.ok)
    .map((file) => {
      const policy = getUploadPolicy(file.usage);
      return {
        localPath: file.uploadedLocalPath || file.absolutePath,
        usage: file.usage,
        title: file.title,
        description: file.description,
        languageList: file.languageList,
        dedupeKey: buildUploadDedupeKey(file),
        sourceRelativePath: file.relativePath,
        sourceLocalPath: file.absolutePath,
        imagePreparation: file.imagePreparation,
        source: {
          section: file.section,
          row: file.row,
          relativePath: file.relativePath,
          usageLabel: file.usageLabel
        },
        suggestedMapping: file.suggestedMapping,
        draftBinding: file.rowKey ? buildDraftBinding(policy.target, file.rowKey) : undefined
      };
    });

  const summary = {
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
  };
  const readiness = {
    canUploadAllReferencedFiles: checkedFiles.every((file) => file.ok),
    canCreateAfterSkippingInvalidOptionalFiles: errorCount === 0,
    requiresUserDecision: invalidOptionalFileCount > 0,
    errorCount,
    warningCount,
    validUploadCount: uploadQueue.length,
    invalidFileCount: checkedFiles.filter((file) => !file.ok).length
  };
  const fieldCoverage = draft ? buildFieldCoverage(draft) : undefined;
  const submissionPreview = draft ? buildSubmissionPreview(draft) : undefined;
  const actionableIssues = toActionableIssues(issues);
  const trace = buildProtocolTrace('product_precheck_package', undefined, [
    {
      name: 'parse_markdown',
      ok: Boolean(draft),
      counts: {
        markdownTables: tables.length
      }
    },
    {
      name: 'validate_fields',
      ok: errorCount === 0,
      counts: {
        errors: errorCount,
        warnings: warningCount
      }
    },
    {
      name: 'validate_files',
      ok: checkedFiles.every((file) => file.ok),
      counts: {
        referencedFiles: checkedFiles.length,
        validUploadCount: uploadQueue.length,
        invalidFileCount: checkedFiles.filter((file) => !file.ok).length
      }
    },
    {
      name: 'build_draft',
      ok: Boolean(draft),
      counts: submissionPreview?.counts
    }
  ]);

  const result = {
    ok: errorCount === 0,
    packageDir,
    markdownPath,
    protocol: {
      version: 'product-mcp-protocol-2026-06-29.1',
      contract: 'CommoditySaveDTO + frontend hard blockers',
      responseMode: input.responseMode
    },
    trace,
    summary,
    readiness,
    fieldCoverage,
    submissionPreview,
    actionableIssues,
    unresolvedReferences: draft ? unresolvedReferences(draft) : undefined,
    uploadQueue,
    files: checkedFiles,
    draftCreateInput: draft,
    issues
  };

  if (input.responseMode === 'summary') {
    return {
      ok: result.ok,
      packageDir,
      markdownPath,
      protocol: result.protocol,
      trace,
      summary,
      readiness,
      fieldCoverage,
      submissionPreview,
      actionableIssues,
      issues
    };
  }

  return result;
}

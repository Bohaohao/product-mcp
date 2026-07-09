import type { MarkdownTable } from './materialTemplate.js';
import { parseMarkdownTables } from './materialTemplate.js';
import type { SourceInventoryItem } from './sourceInventory.js';
import { businessTypeLabel, sectionByBusinessType, structuredBusinessTypes, type BusinessType } from './templateSectionRegistry.js';

export type SourceCoverageStatus = 'mapped' | 'ignored' | 'ambiguous' | 'blocked';

export type SourceCoverageIssueCode =
  | 'SOURCE_NOT_MAPPED'
  | 'SECTION_MATERIAL_NOT_FILLED'
  | 'TEXT_SOURCE_NOT_PARSED'
  | 'MEDIA_ONLY_MAPPING_SUSPECT'
  | 'STRUCTURED_SECTION_MEDIA_MISSING'
  | 'AMBIGUOUS_SOURCE_TARGET'
  | 'SOURCE_COVERAGE_AUDIT_FAILED';

export interface SourceCoverageReportItem {
  sourcePath: string;
  detectedBusinessType: string;
  targetSections: string[];
  targetRows: string[];
  uploadUsage?: string[];
  status: SourceCoverageStatus;
  reason: string;
  code?: SourceCoverageIssueCode;
}

export interface SourceCoverageIssue {
  severity: 'error';
  code: SourceCoverageIssueCode;
  message: string;
  sourcePath: string;
  section?: string;
  field?: string;
}

export interface SourceCoverageAuditResult {
  ok: boolean;
  summary: {
    totalSources: number;
    mappedCount: number;
    ignoredCount: number;
    ambiguousCount: number;
    blockedCount: number;
    businessSourceCount: number;
  };
  report: SourceCoverageReportItem[];
  issues: SourceCoverageIssue[];
}

interface UploadQueueLike {
  sourceRelativePath?: unknown;
  usage?: unknown;
}

function clean(value: unknown): string {
  return String(value ?? '').trim();
}

function rowHasContent(row: Record<string, string>): boolean {
  return Object.values(row).some((value) => clean(value));
}

function rowContainsSource(row: Record<string, string>, sourcePath: string): boolean {
  const normalized = sourcePath.replace(/\\/g, '/');
  return Object.values(row).some((value) => clean(value).replace(/\\/g, '/').includes(normalized));
}

function tableBusinessSection(table: MarkdownTable): string {
  if (table.headers.includes('图片用途') && table.headers.includes('文件路径')) return '商品图片';
  if (table.headers.includes('资料用途') && table.headers.includes('文件路径')) return '商品视频、3D 与附件';
  if (table.headers.includes('资料用途') && table.headers.includes('文件路径或内容')) return '图文详情富文本素材';
  if (table.headers.includes('所属客户名称') && table.headers.includes('文件路径')) return '客户案例媒体';
  if (table.headers.includes('证书名称') && table.headers.includes('文件路径')) return '认证资料';
  if (table.headers.includes('名称') && (table.heading.includes('配件') || table.heading.includes('备件') || table.heading.includes('易损件'))) return table.heading;
  return table.heading;
}

function sourceReferences(tables: MarkdownTable[], sourcePath: string): { targetSections: string[]; targetRows: string[] } {
  const sections = new Set<string>();
  const rows: string[] = [];
  for (const table of tables) {
    const section = tableBusinessSection(table);
    table.rows.forEach((row, index) => {
      if (!rowContainsSource(row, sourcePath)) return;
      sections.add(section);
      rows.push(`${section}第 ${index + 1} 行`);
    });
  }
  return {
    targetSections: [...sections],
    targetRows: rows
  };
}

function sectionHasContent(tables: MarkdownTable[], sectionName: string): boolean {
  return tables.some((table) => tableBusinessSection(table).includes(sectionName) && table.rows.some(rowHasContent));
}

function expectedSections(types: BusinessType[]): string[] {
  return structuredBusinessTypes(types)
    .map((type) => sectionByBusinessType(type)?.sectionName)
    .filter((value): value is string => Boolean(value));
}

function isTextLike(source: SourceInventoryItem): boolean {
  return source.sourceKind === 'text' || source.sourceKind === 'spreadsheet' || source.sourceKind === 'document' || source.sourceKind === 'pdf';
}

function isMediaOnlyMapped(targetSections: string[]): boolean {
  return targetSections.length > 0 && targetSections.every((section) => ['商品图片', '商品视频、3D 与附件', '图文详情富文本素材'].includes(section));
}

function isUnreferencedCertificationAuxiliaryImage(source: SourceInventoryItem, businessTypes: BusinessType[], targetSections: string[]): boolean {
  if (source.sourceKind !== 'image') return false;
  if (!businessTypes.includes('certification')) return false;
  if (targetSections.length > 0) return false;
  return /(^|[-_\s])(main|cover|front|preview|thumb|thumbnail|page[-_\s]*\d+|p\d+|render(?:ed)?|screenshot|scan)([-_\s]|$)/i.test(source.baseName)
    || /(主图|封面图?|首页|第一页|渲染图|截图)/.test(source.baseName);
}

function uploadUsageFor(source: SourceInventoryItem, uploadQueue: UploadQueueLike[]): string[] {
  const usages = new Set<string>();
  for (const item of uploadQueue) {
    if (clean(item.sourceRelativePath).replace(/\\/g, '/') !== source.sourcePath) continue;
    const usage = clean(item.usage);
    if (usage) usages.add(usage);
  }
  return [...usages];
}

function issueMessage(code: SourceCoverageIssueCode, source: SourceInventoryItem, expected: string[]): string {
  const label = source.possibleBusinessTypes.map(businessTypeLabel).join('、') || '业务资料';
  switch (code) {
    case 'TEXT_SOURCE_NOT_PARSED':
      return `${source.sourcePath} 命中${label}，但未解析并写入结构化章节：${expected.join('、')}。`;
    case 'MEDIA_ONLY_MAPPING_SUSPECT':
      return `${source.sourcePath} 命中${label}，目前只进入媒体/富文本章节，未进入应填写的结构化章节：${expected.join('、')}。`;
    case 'SECTION_MATERIAL_NOT_FILLED':
      return `${source.sourcePath} 命中${label}，但对应结构化章节为空：${expected.join('、')}。`;
    case 'AMBIGUOUS_SOURCE_TARGET':
      return `${source.sourcePath} 同时命中多个业务章节，请人工确认目标章节。`;
    case 'STRUCTURED_SECTION_MEDIA_MISSING':
      return `${source.sourcePath} 命中${label}，结构化章节存在但未引用该媒体路径。`;
    case 'SOURCE_COVERAGE_AUDIT_FAILED':
      return `${source.sourcePath} 的资料覆盖审计失败。`;
    case 'SOURCE_NOT_MAPPED':
    default:
      return `${source.sourcePath} 命中${label}，但没有映射到任何 ERP 目标章节。`;
  }
}

export function buildSourceCoverageAudit(params: {
  sources: SourceInventoryItem[];
  markdown: string;
  uploadQueue?: UploadQueueLike[];
}): SourceCoverageAuditResult {
  const tables = parseMarkdownTables(params.markdown);
  const uploadQueue = params.uploadQueue || [];
  const report: SourceCoverageReportItem[] = [];
  const issues: SourceCoverageIssue[] = [];

  for (const source of params.sources.filter((item) => item.sourceKind !== 'folder')) {
    const businessTypes = structuredBusinessTypes(source.possibleBusinessTypes);
    const detectedBusinessType = businessTypes.map(businessTypeLabel).join('、') || '';
    const expected = expectedSections(businessTypes);
    const refs = sourceReferences(tables, source.sourcePath);
    const uploadUsage = uploadUsageFor(source, uploadQueue);
    const expectedMapped = expected.some((section) => refs.targetSections.some((target) => target.includes(section)));
    let status: SourceCoverageStatus = 'ignored';
    let reason = '未命中结构化业务章节，作为普通素材处理或未引用。';
    let code: SourceCoverageIssueCode | undefined;

    if (businessTypes.length === 0) {
      if (refs.targetSections.length > 0) {
        status = 'mapped';
        reason = '普通素材已映射到媒体/附件章节。';
      }
    } else if (isUnreferencedCertificationAuxiliaryImage(source, businessTypes, refs.targetSections)) {
      status = 'ignored';
      reason = '未被认证资料字段引用的辅助图片，交由可选额外文件校验报告，不作为结构化章节缺口。';
    } else if (businessTypes.length > 1 && refs.targetSections.length === 0) {
      status = 'ambiguous';
      code = 'AMBIGUOUS_SOURCE_TARGET';
      reason = '同时命中多个业务章节且未被映射，需要人工确认。';
    } else if (refs.targetSections.length === 0) {
      status = 'blocked';
      code = isTextLike(source) ? 'TEXT_SOURCE_NOT_PARSED' : 'SOURCE_NOT_MAPPED';
      reason = '业务资料没有进入任何目标章节。';
    } else if (!expectedMapped) {
      status = 'blocked';
      code = isTextLike(source) ? 'TEXT_SOURCE_NOT_PARSED' : isMediaOnlyMapped(refs.targetSections) ? 'MEDIA_ONLY_MAPPING_SUSPECT' : 'SECTION_MATERIAL_NOT_FILLED';
      reason = '业务资料已有引用，但未进入对应结构化章节。';
    } else if (source.sourceKind === 'image' && expected.some((section) => sectionHasContent(tables, section)) && !expectedMapped) {
      status = 'blocked';
      code = 'STRUCTURED_SECTION_MEDIA_MISSING';
      reason = '结构化章节存在但未引用该媒体。';
    } else {
      status = 'mapped';
      reason = '业务资料已映射到对应结构化章节。';
    }

    const item: SourceCoverageReportItem = {
      sourcePath: source.sourcePath,
      detectedBusinessType,
      targetSections: refs.targetSections,
      targetRows: refs.targetRows,
      uploadUsage,
      status,
      reason,
      code
    };
    report.push(item);

    if (status === 'blocked' || status === 'ambiguous') {
      const issueCode = code || 'SOURCE_COVERAGE_AUDIT_FAILED';
      issues.push({
        severity: 'error',
        code: issueCode,
        message: issueMessage(issueCode, source, expected),
        sourcePath: source.sourcePath,
        section: expected.join('、') || undefined,
        field: source.sourcePath
      });
    }
  }

  const summary = {
    totalSources: report.length,
    mappedCount: report.filter((item) => item.status === 'mapped').length,
    ignoredCount: report.filter((item) => item.status === 'ignored').length,
    ambiguousCount: report.filter((item) => item.status === 'ambiguous').length,
    blockedCount: report.filter((item) => item.status === 'blocked').length,
    businessSourceCount: report.filter((item) => item.detectedBusinessType).length
  };

  return {
    ok: issues.length === 0,
    summary,
    report,
    issues
  };
}

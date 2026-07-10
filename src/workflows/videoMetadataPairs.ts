import path from 'node:path';
import type { SourceInventoryItem } from './sourceInventory.js';
import { readTextFileWithDetectedEncoding } from './textExtractors.js';

export type TestingVideoCategoryLabel = '链界实测视频' | '三方实测视频';
export type VideoMetadataMatchType = 'exact' | 'normalizedSuffix' | 'missing' | 'ambiguous' | 'orphan';
export type VideoMetadataStatus = 'mapped' | 'warning' | 'blocked';
export type VideoMetadataIssueCode =
  | 'VIDEO_METADATA_TEXT_MISSING'
  | 'VIDEO_METADATA_TEXT_UNREADABLE'
  | 'VIDEO_METADATA_FIELDS_INCOMPLETE'
  | 'VIDEO_METADATA_PAIR_AMBIGUOUS'
  | 'VIDEO_METADATA_VIDEO_NOT_FOUND'
  | 'VIDEO_METADATA_CONFLICT';

export interface TestingVideoCandidate {
  videoPath: string;
  categoryLabel: TestingVideoCategoryLabel;
  title?: string;
  description?: string;
  remark?: string;
  row?: number;
}

export interface VideoMetadataIssue {
  severity: 'error' | 'warning';
  code: VideoMetadataIssueCode;
  message: string;
  section: '商品视频、3D 与附件';
  row?: number;
  field?: string;
  path?: string;
  videoPath?: string;
  metadataPath?: string;
}

export interface VideoMetadataReportItem {
  videoPath?: string;
  metadataPath?: string;
  candidateMetadataPaths?: string[];
  categoryLabel?: TestingVideoCategoryLabel;
  videoCategory?: 4 | 6;
  matchType: VideoMetadataMatchType;
  normalizedStem: string;
  encoding?: string;
  title?: string;
  description?: string;
  effectiveRemark?: string;
  titleStatus: 'existing' | 'fromText' | 'fallbackFileName' | 'conflict' | 'missing';
  descriptionStatus: 'existing' | 'fromText' | 'conflict' | 'missing';
  status: VideoMetadataStatus;
  issues: VideoMetadataIssue[];
}

export interface VideoMetadataResolution {
  reports: VideoMetadataReportItem[];
  issues: VideoMetadataIssue[];
  byVideoPath: Map<string, VideoMetadataReportItem>;
  sidecarTextPaths: Set<string>;
  summary: {
    videoCount: number;
    mappedCount: number;
    warningCount: number;
    blockedCount: number;
    sidecarTextCount: number;
  };
}

interface PairSelection {
  candidate: TestingVideoCandidate;
  videoSource?: SourceInventoryItem;
  textSource?: SourceInventoryItem;
  matchType?: 'exact' | 'normalizedSuffix';
  blockedCandidates?: SourceInventoryItem[];
}

const CATEGORY_BY_NORMALIZED_LABEL = new Map<string, TestingVideoCategoryLabel>([
  ['链界实测视频', '链界实测视频'],
  ['链界实测', '链界实测视频'],
  ['链界', '链界实测视频'],
  ['三方实测视频', '三方实测视频'],
  ['三方实测', '三方实测视频'],
  ['第三方实测', '三方实测视频'],
  ['三方', '三方实测视频']
]);

function normalizeLabel(value: string): string {
  return value.normalize('NFC').trim().replace(/[\s_\-/.（）()]+/g, '').toLowerCase();
}

function normalizePath(value: string): string {
  return value
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .normalize('NFC')
    .trim()
    .toLowerCase();
}

function markdownPath(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '');
  return normalized ? `./${normalized}` : '';
}

function normalizeStem(value: string): string {
  return value.normalize('NFC').trim().toLowerCase();
}

function normalizedConvertedStem(value: string): string {
  return normalizeStem(value).replace(/(?:_converted|-converted| converted)$/i, '').trim();
}

function categoryNumber(label: TestingVideoCategoryLabel): 4 | 6 {
  return label === '链界实测视频' ? 4 : 6;
}

export function testingVideoCategoryFromValue(value: string): TestingVideoCategoryLabel | undefined {
  const normalized = normalizeLabel(value);
  for (const [label, category] of CATEGORY_BY_NORMALIZED_LABEL.entries()) {
    if (normalizeLabel(label) === normalized) return category;
  }
  return undefined;
}

function categoryFromSource(source: SourceInventoryItem): TestingVideoCategoryLabel | undefined {
  return testingVideoCategoryFromValue(source.parentFolder);
}

function sameFolder(left: SourceInventoryItem, right: SourceInventoryItem): boolean {
  return normalizePath(path.posix.dirname(left.sourcePath)) === normalizePath(path.posix.dirname(right.sourcePath));
}

function sourceForPath(sources: SourceInventoryItem[], sourcePath: string): SourceInventoryItem | undefined {
  const key = normalizePath(sourcePath);
  return sources.find((source) => normalizePath(source.sourcePath) === key);
}

function appendRelatedFile(source: SourceInventoryItem | undefined, related: SourceInventoryItem | undefined): void {
  if (!source || !related || source.relatedFiles.includes(related.sourcePath)) return;
  source.relatedFiles.push(related.sourcePath);
}

function cleanField(value: unknown): string {
  return String(value ?? '').trim();
}

function parseVideoMetadataText(text: string): { title: string; description: string } {
  const fields: Record<'title' | 'description', string[]> = { title: [], description: [] };
  let current: 'title' | 'description' | undefined;
  const titleLabels = new Set(['视频标题', '标题', 'videotitle', 'title']);
  const descriptionLabels = new Set(['视频描述', '描述', 'videodescription', 'description']);

  for (const rawLine of text.replace(/^\uFEFF/, '').replace(/\r/g, '').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const pair = line.match(/^([^：:]{1,48})[：:]\s*(.*)$/);
    if (pair) {
      const label = normalizeLabel(pair[1]);
      if (titleLabels.has(label)) current = 'title';
      else if (descriptionLabels.has(label)) current = 'description';
      else if (current) fields[current].push(line);
      if (current && (titleLabels.has(label) || descriptionLabels.has(label)) && pair[2].trim()) {
        fields[current].push(pair[2].trim());
      }
      continue;
    }
    if (current) fields[current].push(line);
  }

  return {
    title: fields.title.join(' ').trim(),
    description: fields.description.join(' ').trim()
  };
}

function combineRemark(existing: string | undefined, metadataPath: string | undefined): string | undefined {
  const sourceRemark = metadataPath ? `文案来源：${metadataPath}` : '';
  const current = cleanField(existing);
  if (!sourceRemark) return current || undefined;
  if (!current) return sourceRemark;
  if (current.includes(sourceRemark)) return current;
  return `${current}；${sourceRemark}`;
}

function messagePrefix(productNameCn?: string): string {
  return productNameCn ? `商品「${productNameCn}」` : '商品';
}

function issue(params: {
  severity: VideoMetadataIssue['severity'];
  code: VideoMetadataIssueCode;
  message: string;
  candidate?: TestingVideoCandidate;
  metadataPath?: string;
  field?: string;
}): VideoMetadataIssue {
  return {
    severity: params.severity,
    code: params.code,
    message: params.message,
    section: '商品视频、3D 与附件',
    row: params.candidate?.row,
    field: params.field,
    path: params.metadataPath || params.candidate?.videoPath,
    videoPath: params.candidate?.videoPath,
    metadataPath: params.metadataPath
  };
}

function candidateKey(candidate: TestingVideoCandidate): string {
  return normalizePath(candidate.videoPath);
}

function dedupeCandidates(candidates: TestingVideoCandidate[]): TestingVideoCandidate[] {
  const byPath = new Map<string, TestingVideoCandidate>();
  for (const candidate of candidates) {
    const key = candidateKey(candidate);
    if (!key || byPath.has(key)) continue;
    byPath.set(key, candidate);
  }
  return [...byPath.values()];
}

export async function resolveTestingVideoMetadata(params: {
  sources: SourceInventoryItem[];
  candidates: TestingVideoCandidate[];
  productNameCn?: string;
}): Promise<VideoMetadataResolution> {
  const candidates = dedupeCandidates(params.candidates);
  const videos = candidates.map((candidate) => ({ candidate, videoSource: sourceForPath(params.sources, candidate.videoPath) }));
  const candidateFolderKeys = new Set(
    videos
      .map(({ videoSource }) => (videoSource ? normalizePath(path.posix.dirname(videoSource.sourcePath)) : ''))
      .filter(Boolean)
  );
  const texts = params.sources.filter(
    (source) =>
      source.sourceKind === 'text' &&
      source.extension.toLowerCase() === 'txt' &&
      (candidateFolderKeys.has(normalizePath(path.posix.dirname(source.sourcePath))) || Boolean(categoryFromSource(source)))
  );
  const sidecarTextPaths = new Set(texts.map((source) => normalizePath(source.sourcePath)));
  const selections: PairSelection[] = videos.map(({ candidate, videoSource }) => ({ candidate, videoSource }));
  const reservedTexts = new Set<string>();

  const assignMatches = (matchType: 'exact' | 'normalizedSuffix'): void => {
    const claims = new Map<string, PairSelection[]>();
    for (const selection of selections) {
      if (selection.textSource || selection.blockedCandidates?.length || !selection.videoSource) continue;
      const videoStem = matchType === 'exact' ? normalizeStem(selection.videoSource.baseName) : normalizedConvertedStem(selection.videoSource.baseName);
      if (matchType === 'normalizedSuffix' && videoStem === normalizeStem(selection.videoSource.baseName)) continue;
      const matching = texts.filter((text) => {
        if (!sameFolder(selection.videoSource as SourceInventoryItem, text)) return false;
        if (reservedTexts.has(normalizePath(text.sourcePath))) return false;
        return normalizeStem(text.baseName) === videoStem;
      });
      if (matching.length > 1) {
        selection.blockedCandidates = matching;
        continue;
      }
      if (matching.length === 1) {
        const key = normalizePath(matching[0].sourcePath);
        const list = claims.get(key) || [];
        list.push(selection);
        claims.set(key, list);
        selection.textSource = matching[0];
        selection.matchType = matchType;
      }
    }

    for (const [textKey, claimedBy] of claims.entries()) {
      if (claimedBy.length === 1) {
        reservedTexts.add(textKey);
        continue;
      }
      for (const selection of claimedBy) {
        if (selection.textSource) selection.blockedCandidates = [selection.textSource];
        selection.textSource = undefined;
        selection.matchType = undefined;
      }
    }
  };

  assignMatches('exact');
  assignMatches('normalizedSuffix');

  const reports: VideoMetadataReportItem[] = [];
  const issues: VideoMetadataIssue[] = [];
  const byVideoPath = new Map<string, VideoMetadataReportItem>();

  for (const selection of selections) {
    const { candidate, videoSource } = selection;
    const videoPath = markdownPath(candidate.videoPath);
    const fallbackTitle = path.posix.basename(candidate.videoPath.replace(/\\/g, '/'), path.posix.extname(candidate.videoPath));
    const reportIssues: VideoMetadataIssue[] = [];
    const report: VideoMetadataReportItem = {
      videoPath,
      categoryLabel: candidate.categoryLabel,
      videoCategory: categoryNumber(candidate.categoryLabel),
      matchType: selection.blockedCandidates?.length ? 'ambiguous' : selection.matchType || 'missing',
      normalizedStem: videoSource ? normalizedConvertedStem(videoSource.baseName) : normalizedConvertedStem(fallbackTitle),
      title: cleanField(candidate.title) || fallbackTitle,
      description: cleanField(candidate.description) || undefined,
      effectiveRemark: cleanField(candidate.remark) || undefined,
      titleStatus: cleanField(candidate.title) ? 'existing' : 'fallbackFileName',
      descriptionStatus: cleanField(candidate.description) ? 'existing' : 'missing',
      status: 'warning',
      issues: reportIssues
    };

    if (selection.blockedCandidates?.length) {
      const candidatePaths = selection.blockedCandidates.map((source) => markdownPath(source.sourcePath));
      report.candidateMetadataPaths = candidatePaths;
      report.status = 'blocked';
      report.titleStatus = cleanField(candidate.title) ? 'existing' : 'missing';
      const pairIssue = issue({
        severity: 'error',
        code: 'VIDEO_METADATA_PAIR_AMBIGUOUS',
        candidate,
        field: '标题/描述',
        message: `${messagePrefix(params.productNameCn)}的${candidate.categoryLabel}视频 ${videoPath} 匹配到多个同优先级文案文件：${candidatePaths.join('、')}。请保留唯一对应文件或调整文件名。`
      });
      reportIssues.push(pairIssue);
    } else if (!selection.textSource) {
      const missingIssue = issue({
        severity: 'warning',
        code: 'VIDEO_METADATA_TEXT_MISSING',
        candidate,
        field: '标题/描述',
        message: `${messagePrefix(params.productNameCn)}的${candidate.categoryLabel}视频 ${videoPath} 没有对应 txt 文案，标题将使用文件名，描述保持空白。`
      });
      reportIssues.push(missingIssue);
    } else {
      const metadataPath = markdownPath(selection.textSource.sourcePath);
      report.metadataPath = metadataPath;
      report.matchType = selection.matchType || 'exact';
      report.effectiveRemark = combineRemark(candidate.remark, metadataPath);
      appendRelatedFile(videoSource, selection.textSource);
      appendRelatedFile(selection.textSource, videoSource);
      try {
        const decoded = await readTextFileWithDetectedEncoding(selection.textSource.absolutePath, selection.textSource.size);
        const parsed = parseVideoMetadataText(decoded.text);
        selection.textSource.extractedTextSummary = [parsed.title, parsed.description].filter(Boolean).join('；').slice(0, 180) || undefined;
        report.encoding = decoded.encoding;
        report.title = cleanField(candidate.title) || parsed.title || fallbackTitle;
        report.description = cleanField(candidate.description) || parsed.description || undefined;
        const missingFields = [!parsed.title ? '视频标题' : '', !parsed.description ? '视频描述' : ''].filter(Boolean);
        if (missingFields.length) {
          report.status = 'blocked';
          report.titleStatus = parsed.title ? (cleanField(candidate.title) ? 'existing' : 'fromText') : cleanField(candidate.title) ? 'existing' : 'missing';
          report.descriptionStatus = parsed.description
            ? cleanField(candidate.description)
              ? 'existing'
              : 'fromText'
            : cleanField(candidate.description)
              ? 'existing'
              : 'missing';
          const incompleteIssue = issue({
            severity: 'error',
            code: 'VIDEO_METADATA_FIELDS_INCOMPLETE',
            candidate,
            metadataPath,
            field: missingFields.join('、'),
            message: `${messagePrefix(params.productNameCn)}的${candidate.categoryLabel}文案 ${metadataPath} 缺少${missingFields.join('、')}，对应视频为 ${videoPath}。`
          });
          reportIssues.push(incompleteIssue);
        } else {
          report.status = 'mapped';
          const existingTitle = cleanField(candidate.title);
          const existingDescription = cleanField(candidate.description);
          report.title = existingTitle || parsed.title;
          report.description = existingDescription || parsed.description;
          report.titleStatus = existingTitle ? 'existing' : 'fromText';
          report.descriptionStatus = existingDescription ? 'existing' : 'fromText';

          if (existingTitle && existingTitle !== parsed.title) {
            report.titleStatus = 'conflict';
            report.status = 'warning';
            reportIssues.push(
              issue({
                severity: 'warning',
                code: 'VIDEO_METADATA_CONFLICT',
                candidate,
                metadataPath,
                field: '标题',
                message: `${messagePrefix(params.productNameCn)}的${candidate.categoryLabel}视频 ${videoPath} 已有标题「${existingTitle}」，与 ${metadataPath} 中的「${parsed.title}」不一致；已保留商品资料.md 中的值。`
              })
            );
          }
          if (existingDescription && existingDescription !== parsed.description) {
            report.descriptionStatus = 'conflict';
            report.status = 'warning';
            reportIssues.push(
              issue({
                severity: 'warning',
                code: 'VIDEO_METADATA_CONFLICT',
                candidate,
                metadataPath,
                field: '描述',
                message: `${messagePrefix(params.productNameCn)}的${candidate.categoryLabel}视频 ${videoPath} 已有描述与 ${metadataPath} 不一致；已保留商品资料.md 中的值。`
              })
            );
          }
        }
      } catch (error) {
        report.status = 'blocked';
        report.titleStatus = cleanField(candidate.title) ? 'existing' : 'missing';
        report.descriptionStatus = cleanField(candidate.description) ? 'existing' : 'missing';
        reportIssues.push(
          issue({
            severity: 'error',
            code: 'VIDEO_METADATA_TEXT_UNREADABLE',
            candidate,
            metadataPath,
            field: '标题/描述',
            message: `${messagePrefix(params.productNameCn)}的${candidate.categoryLabel}文案 ${metadataPath} 无法读取，对应视频为 ${videoPath}：${error instanceof Error ? error.message : String(error)}`
          })
        );
      }
    }

    reports.push(report);
    issues.push(...reportIssues);
    byVideoPath.set(normalizePath(candidate.videoPath), report);
  }

  const assignedTextPaths = new Set(
    reports.flatMap((report) => [report.metadataPath, ...(report.candidateMetadataPaths || [])]).filter((value): value is string => Boolean(value)).map(normalizePath)
  );
  for (const textSource of texts) {
    const key = normalizePath(textSource.sourcePath);
    if (assignedTextPaths.has(key)) continue;
    const metadataPath = markdownPath(textSource.sourcePath);
    const orphanIssue = issue({
      severity: 'error',
      code: 'VIDEO_METADATA_VIDEO_NOT_FOUND',
      metadataPath,
      field: '视频文件',
      message: `${messagePrefix(params.productNameCn)}的实测视频文案 ${metadataPath} 未找到同目录、同主名或 converted 后缀可匹配的视频文件。`
    });
    const report: VideoMetadataReportItem = {
      metadataPath,
      categoryLabel: categoryFromSource(textSource),
      videoCategory: categoryFromSource(textSource) ? categoryNumber(categoryFromSource(textSource) as TestingVideoCategoryLabel) : undefined,
      matchType: 'orphan',
      normalizedStem: normalizeStem(textSource.baseName),
      titleStatus: 'missing',
      descriptionStatus: 'missing',
      status: 'blocked',
      issues: [orphanIssue]
    };
    reports.push(report);
    issues.push(orphanIssue);
  }

  return {
    reports,
    issues,
    byVideoPath,
    sidecarTextPaths,
    summary: {
      videoCount: candidates.length,
      mappedCount: reports.filter((report) => report.status === 'mapped').length,
      warningCount: reports.filter((report) => report.status === 'warning').length,
      blockedCount: reports.filter((report) => report.status === 'blocked').length,
      sidecarTextCount: texts.length
    }
  };
}

export function videoMetadataForPath(resolution: VideoMetadataResolution | undefined, sourcePath: string): VideoMetadataReportItem | undefined {
  return resolution?.byVideoPath.get(normalizePath(sourcePath));
}

export function isTestingVideoMetadataSidecar(resolution: VideoMetadataResolution | undefined, sourcePath: string): boolean {
  return resolution?.sidecarTextPaths.has(normalizePath(sourcePath)) === true;
}

import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as z from 'zod/v4';
import { parseMarkdownTables, type MarkdownTable } from '../workflows/materialTemplate.js';

type UnknownRecord = Record<string, unknown>;
type OcrMode = 'suggest' | 'apply';
type OcrField =
  | 'certificateType'
  | 'certificateNo'
  | 'coverRegions'
  | 'issuingAuthority'
  | 'effectiveDate'
  | 'expiryDate'
  | 'mainImagePath';
type OcrAction = 'filled' | 'suggested' | 'keptExisting' | 'conflict' | 'needsManual' | 'skippedByDatePolicy';

const CERTIFICATION_HEADERS = [
  '证书名称',
  '证书类型',
  '证书编号',
  '覆盖区域',
  '覆盖区域ID',
  '适用范围',
  '适用特定型号',
  '适用特定型号ID',
  '发证机构',
  '生效日期',
  '到期日期',
  '是否永久有效',
  '文件路径',
  '主图路径',
  '文件分类',
  '状态',
  '排序',
  '备注'
];

const FIELD_TO_HEADER: Record<OcrField, string> = {
  certificateType: '证书类型',
  certificateNo: '证书编号',
  coverRegions: '覆盖区域',
  issuingAuthority: '发证机构',
  effectiveDate: '生效日期',
  expiryDate: '到期日期',
  mainImagePath: '主图路径'
};

export const productOcrOptionsSchema = z
  .object({
    autoFillThreshold: z.number().min(0).max(1).default(0.75),
    suggestThreshold: z.number().min(0).max(1).default(0.5),
    maxPdfPages: z.number().int().min(1).max(3).default(3),
    datePolicy: z.enum(['allowFill', 'keepBlank']).default('allowFill'),
    keepBlankFields: z.array(z.enum(['生效日期', '到期日期', 'effectiveDate', 'expiryDate'])).default([]),
    rowDatePolicies: z
      .array(
        z.object({
          row: z.number().int().positive().optional(),
          certificateName: z.string().trim().optional(),
          fields: z.array(z.enum(['生效日期', '到期日期', 'effectiveDate', 'expiryDate'])).default(['生效日期', '到期日期'])
        })
      )
      .default([])
  })
  .partial()
  .optional();

export const productOcrCertificationsInputSchema = {
  packagePath: z.string().trim().min(1).describe('Local product package directory or 商品资料.md path.'),
  markdownFileName: z.string().trim().default('商品资料.md'),
  mode: z.enum(['suggest', 'apply']).default('suggest'),
  ocrOptions: productOcrOptionsSchema
};

const productOcrCertificationsObjectSchema = z.object(productOcrCertificationsInputSchema);
export type ProductOcrCertificationsInput = z.infer<typeof productOcrCertificationsObjectSchema>;

interface CertificationRowRef {
  rowNumber: number;
  row: Record<string, string>;
}

interface CertificationSource {
  absolutePath: string;
  relativePath: string;
  ext: string;
  sourceType: 'pdf' | 'image';
  rowNumber?: number;
  field?: '文件路径' | '主图路径' | 'extraDiscovered';
  certificateName?: string;
}

interface OcrSourceRef {
  fileName: string;
  relativePath: string;
  page?: number;
  textSnippet?: string;
}

interface OcrCandidate {
  field: OcrField;
  value: string;
  confidence: number;
  source: OcrSourceRef;
  rawText: string;
}

interface OcrDiffEntry {
  row: number;
  certificateName?: string;
  field: string;
  before: string;
  after: string;
  candidate?: string;
  confidence?: number;
  source?: string;
  action: OcrAction;
  reason?: string;
}

function cleanCell(value: unknown): string {
  return String(value ?? '')
    .replace(/^`|`$/g, '')
    .trim();
}

function escapeCell(value: string): string {
  return cleanCell(value).replace(/\r?\n/g, '<br>').replace(/\|/g, '\\|');
}

function renderTable(headers: string[], rows: Array<Record<string, string>>): string[] {
  const outputRows = rows.length ? rows : [Object.fromEntries(headers.map((header) => [header, '']))];
  return [
    `| ${headers.map(escapeCell).join(' | ')} |`,
    `|${headers.map(() => '---').join('|')}|`,
    ...outputRows.map((row) => `| ${headers.map((header) => escapeCell(row[header] ?? '')).join(' | ')} |`)
  ];
}

function replaceTable(markdown: string, table: MarkdownTable, headers: string[], rows: Array<Record<string, string>>): string {
  const lines = markdown.split(/\r?\n/);
  lines.splice(table.startLine, table.endLine - table.startLine, ...renderTable(headers, rows));
  return `${lines.join('\n').replace(/\s+$/g, '')}\n`;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveMarkdownPath(input: ProductOcrCertificationsInput): Promise<{ packageDir: string; markdownPath: string }> {
  const resolved = path.resolve(input.packagePath);
  const stats = await stat(resolved);
  if (stats.isDirectory()) {
    return {
      packageDir: resolved,
      markdownPath: path.join(resolved, input.markdownFileName)
    };
  }
  return {
    packageDir: path.dirname(resolved),
    markdownPath: resolved
  };
}

function isCertificationTable(table: MarkdownTable): boolean {
  return table.heading.includes('认证资料') && table.headers.includes('证书名称');
}

function isPathLike(value: string): boolean {
  if (!value || /^https?:\/\//i.test(value) || value.startsWith('{{')) return false;
  return /^\.{1,2}[\\/]/.test(value) || /[\\/]/.test(value) || /\.[a-z0-9]{2,6}$/i.test(value);
}

function toMarkdownRelativePath(packageDir: string, absolutePath: string): string {
  const relative = path.relative(packageDir, absolutePath).replace(/\\/g, '/');
  return relative.startsWith('.') ? relative : `./${relative}`;
}

function resolveLocalPath(packageDir: string, relativePath: string): string {
  return path.isAbsolute(relativePath) ? path.resolve(relativePath) : path.resolve(packageDir, relativePath);
}

function normalizeRelativePath(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

function pathSuggestsCertification(relativePath: string): boolean {
  const text = relativePath.toLowerCase();
  return ['认证', '证书', '检测', '报告', 'certificate', 'certification', 'cert', 'ce', 'fcc', 'iso', 'rohs'].some((part) =>
    text.includes(part)
  );
}

function sourceLabel(source: OcrSourceRef): string {
  return `来自 ${source.fileName}${source.page ? ` 第 ${source.page} 页` : ''}`;
}

function normalizeDateField(field: string): 'effectiveDate' | 'expiryDate' | undefined {
  if (field === '生效日期' || field === 'effectiveDate') return 'effectiveDate';
  if (field === '到期日期' || field === 'expiryDate') return 'expiryDate';
  return undefined;
}

function isDateKeepBlank(
  field: OcrField,
  rowNumber: number,
  certificateName: string | undefined,
  options: Required<NonNullable<ProductOcrCertificationsInput['ocrOptions']>>
): boolean {
  if (field !== 'effectiveDate' && field !== 'expiryDate') return false;
  if (options.datePolicy === 'keepBlank') return true;
  if (options.keepBlankFields.map(normalizeDateField).includes(field)) return true;
  return options.rowDatePolicies.some((policy) => {
    const rowMatches = policy.row === undefined || policy.row === rowNumber;
    const nameMatches = !policy.certificateName || policy.certificateName === certificateName;
    const fields = policy.fields.map(normalizeDateField);
    return rowMatches && nameMatches && fields.includes(field);
  });
}

function splitCommandLine(commandLine: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < commandLine.length; index += 1) {
    const char = commandLine[index];
    if ((char === '"' || char === "'") && !quote) {
      quote = char;
      continue;
    }
    if (char === quote) {
      quote = undefined;
      continue;
    }
    if (/\s/.test(char) && !quote) {
      if (current) parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current) parts.push(current);
  return parts;
}

async function runCommandJson(commandLine: string, payload: UnknownRecord, timeoutMs = 30_000): Promise<string> {
  const [command, ...args] = splitCommandLine(commandLine);
  if (!command) throw new Error('OCR command is empty.');

  return await new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Command timed out after ${timeoutMs}ms: ${command}`));
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `Command exited with code ${code}: ${command}`));
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

async function tesseractAvailable(): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const child = spawn('tesseract', ['--version'], { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

async function ocrImage(filePath: string, source: CertificationSource, page?: number): Promise<{ text: string; confidence: number; provider: string }> {
  const command = process.env.PRODUCT_OCR_COMMAND?.trim();
  if (command) {
    const stdout = await runCommandJson(command, {
      filePath,
      sourcePath: source.absolutePath,
      relativePath: source.relativePath,
      page,
      kind: page ? 'pdfPage' : 'image'
    });
    try {
      const parsed = JSON.parse(stdout) as UnknownRecord;
      return {
        text: cleanCell(parsed.text),
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.85,
        provider: 'PRODUCT_OCR_COMMAND'
      };
    } catch {
      return { text: stdout.trim(), confidence: 0.6, provider: 'PRODUCT_OCR_COMMAND_TEXT' };
    }
  }

  if (await tesseractAvailable()) {
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn('tesseract', [filePath, 'stdout', '-l', process.env.PRODUCT_OCR_LANG || 'eng+chi_sim', 'tsv'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      });
      let out = '';
      let err = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        out += chunk;
      });
      child.stderr.on('data', (chunk) => {
        err += chunk;
      });
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err || `tesseract exited with ${code}`))));
    });
    const lines = stdout.split(/\r?\n/).slice(1);
    const words: string[] = [];
    const confidences: number[] = [];
    for (const line of lines) {
      const cells = line.split('\t');
      const conf = Number(cells[10]);
      const text = cleanCell(cells[11]);
      if (text) words.push(text);
      if (Number.isFinite(conf) && conf >= 0) confidences.push(conf / 100);
    }
    return {
      text: words.join(' '),
      confidence: confidences.length ? confidences.reduce((sum, item) => sum + item, 0) / confidences.length : 0.55,
      provider: 'tesseract'
    };
  }

  throw new Error('No local OCR provider available. Set PRODUCT_OCR_COMMAND or install tesseract.');
}

async function renderPdfPage(source: CertificationSource, packageDir: string, page: number): Promise<string> {
  const generatedDir = path.join(packageDir, '.generated', 'ocr', 'certifications');
  await mkdir(generatedDir, { recursive: true });
  const outputPath = path.join(generatedDir, `${path.basename(source.relativePath, path.extname(source.relativePath))}-page-${page}.png`);
  const command = process.env.PRODUCT_PDF_RENDER_COMMAND?.trim();
  if (command) {
    await runCommandJson(command, {
      pdfPath: source.absolutePath,
      sourcePath: source.absolutePath,
      relativePath: source.relativePath,
      outputPath,
      page
    });
    if (!(await fileExists(outputPath))) throw new Error(`PDF render command did not create ${outputPath}`);
    return outputPath;
  }

  const sharp = (await import('sharp')).default;
  await sharp(source.absolutePath, { page: page - 1, density: 180 }).png().toFile(outputPath);
  return outputPath;
}

function candidate(field: OcrField, value: string, confidence: number, source: OcrSourceRef, rawText: string): OcrCandidate | undefined {
  const cleaned = cleanCell(value).replace(/^[：:\-\s]+/, '').replace(/[。；;,\s]+$/g, '');
  if (!cleaned) return undefined;
  return { field, value: cleaned, confidence: Math.max(0, Math.min(1, confidence)), source, rawText };
}

function firstRegex(text: string, patterns: RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function normalizeDate(value: string): string | undefined {
  const text = value.trim();
  let match = text.match(/(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
  if (match) return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
  match = text.match(/(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
  if (match) return `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
  return undefined;
}

function extractCandidatesFromText(text: string, source: OcrSourceRef, providerConfidence: number): OcrCandidate[] {
  const candidates: OcrCandidate[] = [];
  const rawText = text.replace(/\s+/g, ' ').trim();
  const type = firstRegex(rawText, [
    /\b(CE)\b/i,
    /\b(FCC)\b/i,
    /\b(RoHS)\b/i,
    /\b(ISO\s*9001|ISO\s*14001|ISO\s*45001)\b/i,
    /\b(EAC|UL|CSA)\b/i
  ]);
  if (type) candidates.push(candidate('certificateType', type.toUpperCase().replace(/\s+/g, ' '), providerConfidence * 0.95, source, rawText)!);

  const number = firstRegex(rawText, [
    /(?:Certificate|Cert\.?)\s*(?:No\.?|Number|#)\s*[:：]?\s*([A-Z0-9][A-Z0-9\-/.]{3,})/i,
    /(?:证书编号|证书号|编号)\s*[:：]?\s*([A-Z0-9][A-Z0-9\-/.]{3,})/i
  ]);
  if (number && !normalizeDate(number)) candidates.push(candidate('certificateNo', number, providerConfidence * 0.92, source, rawText)!);

  const region = firstRegex(rawText, [
    /(?:覆盖区域|适用地区|适用区域|Region|Territory|Valid\s+in)\s*[:：]?\s*(全球|中国|欧盟|欧洲联盟|欧洲|美国|北美|European Union|Europe|EU|Global|Worldwide)/i,
    /\b(European Union|Europe|Global|Worldwide)\b/i
  ]);
  if (region) candidates.push(candidate('coverRegions', region, providerConfidence * 0.82, source, rawText)!);

  const issuer = firstRegex(rawText, [
    /(?:发证机构|签发机构|Issued\s+by|Certification\s+Body|Issuer)\s*[:：]?\s*([A-Za-z0-9\u4e00-\u9fa5 .,&()（）-]{3,80})/i,
    /\b(SGS|TUV|TÜV|Intertek|Bureau Veritas|UL LLC|DEKRA)[A-Za-z0-9 .,&()（）-]{0,60}/i
  ]);
  if (issuer) candidates.push(candidate('issuingAuthority', issuer, providerConfidence * 0.84, source, rawText)!);

  const effective = firstRegex(rawText, [
    /(?:生效日期|签发日期|发证日期|Date\s+of\s+Issue|Issue(?:d)?\s+Date|Issued\s+on|Valid\s+from)\s*[:：]?\s*([0-9]{1,4}[-/.年][0-9]{1,2}[-/.月][0-9]{1,4})/i
  ]);
  const effectiveDate = effective ? normalizeDate(effective) : undefined;
  if (effectiveDate) candidates.push(candidate('effectiveDate', effectiveDate, providerConfidence * 0.88, source, rawText)!);

  const expiry = firstRegex(rawText, [
    /(?:到期日期|有效期至|Expiry\s+Date|Expiration\s+Date|Valid\s+Until|Valid\s+To)\s*[:：]?\s*([0-9]{1,4}[-/.年][0-9]{1,2}[-/.月][0-9]{1,4})/i
  ]);
  const expiryDate = expiry ? normalizeDate(expiry) : undefined;
  if (expiryDate) candidates.push(candidate('expiryDate', expiryDate, providerConfidence * 0.88, source, rawText)!);

  return candidates.filter(Boolean);
}

function bestCandidates(candidates: OcrCandidate[]): Map<OcrField, OcrCandidate> {
  const best = new Map<OcrField, OcrCandidate>();
  for (const item of candidates) {
    const current = best.get(item.field);
    if (!current || item.confidence > current.confidence) best.set(item.field, item);
  }
  return best;
}

function rowSourceKey(row: Record<string, string>, packageDir: string): string[] {
  return ['文件路径', '主图路径']
    .map((field) => cleanCell(row[field]))
    .filter(isPathLike)
    .map((item) => normalizeRelativePath(toMarkdownRelativePath(packageDir, resolveLocalPath(packageDir, item))));
}

async function collectCertificationSources(
  packageDir: string,
  markdownFileName: string,
  table: MarkdownTable | undefined
): Promise<CertificationSource[]> {
  const sources: CertificationSource[] = [];
  const seen = new Set<string>();
  const addSource = (relativePath: string, row?: CertificationRowRef, field?: '文件路径' | '主图路径' | 'extraDiscovered') => {
    if (!isPathLike(relativePath)) return;
    const absolutePath = resolveLocalPath(packageDir, relativePath);
    const ext = path.extname(absolutePath).replace(/^\./, '').toLowerCase();
    if (!['pdf', 'jpg', 'jpeg', 'png'].includes(ext)) return;
    const normalized = normalizeRelativePath(toMarkdownRelativePath(packageDir, absolutePath));
    if (seen.has(normalized)) return;
    seen.add(normalized);
    sources.push({
      absolutePath,
      relativePath: toMarkdownRelativePath(packageDir, absolutePath),
      ext,
      sourceType: ext === 'pdf' ? 'pdf' : 'image',
      rowNumber: row?.rowNumber,
      field,
      certificateName: row?.row['证书名称']
    });
  };

  const rows = (table?.rows || []).map((row, index) => ({ rowNumber: index + 1, row }));
  for (const row of rows) {
    addSource(cleanCell(row.row['文件路径']), row, '文件路径');
    addSource(cleanCell(row.row['主图路径']), row, '主图路径');
  }

  const ignoredDirs = new Set(['.git', '.generated', 'node_modules']);
  async function walk(currentDir: string): Promise<void> {
    const entries = await readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (ignoredDirs.has(entry.name)) continue;
        await walk(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).replace(/^\./, '').toLowerCase();
      if (!['pdf', 'jpg', 'jpeg', 'png'].includes(ext)) continue;
      const relativePath = toMarkdownRelativePath(packageDir, absolutePath);
      if (!pathSuggestsCertification(relativePath)) continue;
      addSource(relativePath, undefined, 'extraDiscovered');
    }
  }
  if (await fileExists(packageDir)) await walk(packageDir);

  return sources;
}

function certificationNameFromSource(source: CertificationSource, candidates: Map<OcrField, OcrCandidate>): string {
  const type = candidates.get('certificateType')?.value;
  const base = path.basename(source.relativePath, path.extname(source.relativePath)).replace(/[-_\s]*(main|cover|page-\d+)$/i, '');
  return type ? `${type} 认证` : base || '认证资料';
}

function ensureCertificationHeaders(headers: string[]): string[] {
  const result = [...headers];
  for (const header of CERTIFICATION_HEADERS) {
    if (!result.includes(header)) {
      const insertBefore = header === '发证机构' ? result.indexOf('生效日期') : -1;
      if (insertBefore >= 0) result.splice(insertBefore, 0, header);
      else result.push(header);
    }
  }
  return result;
}

function matchRowForSource(
  rows: CertificationRowRef[],
  source: CertificationSource,
  packageDir: string
): CertificationRowRef | undefined {
  if (source.rowNumber) return rows.find((row) => row.rowNumber === source.rowNumber);
  const normalized = normalizeRelativePath(source.relativePath);
  return rows.find((row) => rowSourceKey(row.row, packageDir).includes(normalized));
}

async function ocrSource(source: CertificationSource, packageDir: string, options: Required<NonNullable<ProductOcrCertificationsInput['ocrOptions']>>) {
  const sourceResults: Array<{ source: OcrSourceRef; text: string; confidence: number; provider?: string; error?: string; renderedPath?: string }> = [];
  if (source.sourceType === 'image') {
    try {
      const result = await ocrImage(source.absolutePath, source);
      sourceResults.push({
        source: { fileName: path.basename(source.relativePath), relativePath: source.relativePath, textSnippet: result.text.slice(0, 180) },
        text: result.text,
        confidence: result.confidence,
        provider: result.provider
      });
    } catch (error) {
      sourceResults.push({
        source: { fileName: path.basename(source.relativePath), relativePath: source.relativePath },
        text: '',
        confidence: 0,
        error: error instanceof Error ? error.message : String(error)
      });
    }
    return sourceResults;
  }

  for (let page = 1; page <= options.maxPdfPages; page += 1) {
    try {
      const renderedPath = await renderPdfPage(source, packageDir, page);
      const result = await ocrImage(renderedPath, source, page);
      sourceResults.push({
        source: {
          fileName: path.basename(source.relativePath),
          relativePath: source.relativePath,
          page,
          textSnippet: result.text.slice(0, 180)
        },
        text: result.text,
        confidence: result.confidence,
        provider: result.provider,
        renderedPath
      });
    } catch (error) {
      sourceResults.push({
        source: { fileName: path.basename(source.relativePath), relativePath: source.relativePath, page },
        text: '',
        confidence: 0,
        error: error instanceof Error ? error.message : String(error)
      });
      break;
    }
  }
  return sourceResults;
}

function applyCandidateToRow(
  row: CertificationRowRef,
  field: OcrField,
  selected: OcrCandidate | undefined,
  options: Required<NonNullable<ProductOcrCertificationsInput['ocrOptions']>>,
  mode: OcrMode
): OcrDiffEntry {
  const header = FIELD_TO_HEADER[field];
  const before = cleanCell(row.row[header]);
  const certificateName = cleanCell(row.row['证书名称']) || undefined;

  if (isDateKeepBlank(field, row.rowNumber, certificateName, options)) {
    return {
      row: row.rowNumber,
      certificateName,
      field: header,
      before,
      after: before,
      action: 'skippedByDatePolicy',
      reason: '用户策略要求日期保持空白，不使用 OCR 日期回填。'
    };
  }

  if (!selected || selected.confidence < options.suggestThreshold) {
    return {
      row: row.rowNumber,
      certificateName,
      field: header,
      before,
      after: before,
      action: 'needsManual',
      reason: 'OCR 未识别到足够可信的候选值，需人工确认。'
    };
  }

  if (before) {
    const same = before.toLowerCase() === selected.value.toLowerCase();
    return {
      row: row.rowNumber,
      certificateName,
      field: header,
      before,
      after: before,
      candidate: selected.value,
      confidence: selected.confidence,
      source: sourceLabel(selected.source),
      action: same ? 'keptExisting' : 'conflict',
      reason: same ? '已有值与 OCR 一致，保持不变。' : '已有值与 OCR 候选不一致，未覆盖用户填写值。'
    };
  }

  if (selected.confidence >= options.autoFillThreshold) {
    if (mode === 'apply') row.row[header] = selected.value;
    return {
      row: row.rowNumber,
      certificateName,
      field: header,
      before,
      after: mode === 'apply' ? selected.value : before,
      candidate: selected.value,
      confidence: selected.confidence,
      source: sourceLabel(selected.source),
      action: mode === 'apply' ? 'filled' : 'suggested',
      reason: mode === 'apply' ? '空白字段已按高置信度 OCR 自动回填。' : '高置信度 OCR 候选，可自动回填。'
    };
  }

  return {
    row: row.rowNumber,
    certificateName,
    field: header,
    before,
    after: before,
    candidate: selected.value,
    confidence: selected.confidence,
    source: sourceLabel(selected.source),
    action: 'suggested',
    reason: 'OCR 候选低于自动回填阈值，仅作为建议。'
  };
}

export async function productOcrCertifications(rawInput: unknown) {
  const input = productOcrCertificationsObjectSchema.parse(rawInput);
  const options = {
    autoFillThreshold: 0.75,
    suggestThreshold: 0.5,
    maxPdfPages: 3,
    datePolicy: 'allowFill' as const,
    keepBlankFields: [],
    rowDatePolicies: [],
    ...(input.ocrOptions || {})
  };
  const { packageDir, markdownPath } = await resolveMarkdownPath(input);
  const markdown = await readFile(markdownPath, 'utf8');
  const tables = parseMarkdownTables(markdown);
  const table = tables.find(isCertificationTable);
  const rows: CertificationRowRef[] = (table?.rows || []).map((row, index) => ({ rowNumber: index + 1, row: { ...row } }));
  const sources = await collectCertificationSources(packageDir, input.markdownFileName, table);
  const ocrResults = [];
  const ocrDiff: OcrDiffEntry[] = [];
  const issues: Array<{ severity: 'warning' | 'info'; code: string; message: string; field?: string }> = [];

  let workingRows = rows;
  const sourcesByRow = new Map<number, CertificationSource[]>();
  const sourceCandidateMaps = new Map<string, Map<OcrField, OcrCandidate>>();
  const sourceRenderedMainImage = new Map<string, OcrCandidate>();

  for (const source of sources) {
    const rawResults = await ocrSource(source, packageDir, options);
    const candidates = rawResults.flatMap((result) =>
      result.text ? extractCandidatesFromText(result.text, result.source, result.confidence) : []
    );
    const best = bestCandidates(candidates);
    const bestPage = rawResults
      .filter((result) => result.renderedPath)
      .sort((a, b) => {
        const aCount = extractCandidatesFromText(a.text, a.source, a.confidence).length;
        const bCount = extractCandidatesFromText(b.text, b.source, b.confidence).length;
        return bCount - aCount;
      })[0];
    if (bestPage?.renderedPath) {
      best.set(
        'mainImagePath',
        candidate(
          'mainImagePath',
          toMarkdownRelativePath(packageDir, bestPage.renderedPath),
          0.95,
          bestPage.source,
          bestPage.text || 'PDF rendered page'
        )!
      );
      sourceRenderedMainImage.set(source.relativePath, best.get('mainImagePath')!);
    } else if (source.sourceType === 'image') {
      best.set(
        'mainImagePath',
        candidate('mainImagePath', source.relativePath, 0.92, { fileName: path.basename(source.relativePath), relativePath: source.relativePath }, 'image source')!
      );
    }
    sourceCandidateMaps.set(source.relativePath, best);
    ocrResults.push({
      source,
      providerResults: rawResults.map((result) => ({
        source: result.source,
        confidence: result.confidence,
        provider: result.provider,
        error: result.error,
        textSnippet: result.text.slice(0, 180)
      })),
      candidates: [...best.values()]
    });

    const matchedRow = matchRowForSource(workingRows, source, packageDir);
    if (matchedRow) {
      const items = sourcesByRow.get(matchedRow.rowNumber) || [];
      items.push(source);
      sourcesByRow.set(matchedRow.rowNumber, items);
    } else if (source.sourceType === 'pdf') {
      const rowNumber = workingRows.length + 1;
      const row: Record<string, string> = Object.fromEntries((table?.headers || CERTIFICATION_HEADERS).map((header) => [header, '']));
      row['证书名称'] = certificationNameFromSource(source, best);
      row['文件路径'] = source.relativePath;
      row['文件分类'] = '认证资料';
      row['适用范围'] = '全部型号';
      row['状态'] = '有效';
      row['排序'] = String(rowNumber);
      const ref = { rowNumber, row };
      workingRows = [...workingRows, ref];
      sourcesByRow.set(rowNumber, [source]);
    }
  }

  for (const row of workingRows) {
    const sourceList = sourcesByRow.get(row.rowNumber) || [];
    const merged = new Map<OcrField, OcrCandidate>();
    for (const source of sourceList) {
      const sourceCandidates = sourceCandidateMaps.get(source.relativePath);
      if (!sourceCandidates) continue;
      for (const [field, item] of sourceCandidates.entries()) {
        const current = merged.get(field);
        if (!current || item.confidence > current.confidence) merged.set(field, item);
      }
    }
    for (const field of Object.keys(FIELD_TO_HEADER) as OcrField[]) {
      ocrDiff.push(applyCandidateToRow(row, field, merged.get(field), options, input.mode));
    }
  }

  let wrote = false;
  let outputMarkdownPath: string | undefined;
  if (input.mode === 'apply') {
    if (!table) {
      issues.push({
        severity: 'warning',
        code: 'CERTIFICATION_TABLE_NOT_FOUND',
        message: '未找到认证资料表，OCR 只能返回建议，未写入商品资料.md。'
      });
    } else {
      const headers = ensureCertificationHeaders(table.headers);
      const nextMarkdown = replaceTable(markdown, table, headers, workingRows.map((row) => row.row));
      if (nextMarkdown !== markdown) {
        await writeFile(markdownPath, nextMarkdown, 'utf8');
        wrote = true;
        outputMarkdownPath = markdownPath;
      }
    }
  }

  const summary = {
    scannedFileCount: sources.length,
    ocrSuccessCount: ocrResults.filter((result) => result.providerResults.some((item) => !item.error && item.textSnippet)).length,
    ocrFailureCount: ocrResults.filter((result) => result.providerResults.every((item) => item.error || !item.textSnippet)).length,
    autoFilledCount: ocrDiff.filter((item) => item.action === 'filled').length,
    suggestedCount: ocrDiff.filter((item) => item.action === 'suggested').length,
    needsManualCount: ocrDiff.filter((item) => item.action === 'needsManual').length,
    conflictCount: ocrDiff.filter((item) => item.action === 'conflict').length,
    skippedByDatePolicyCount: ocrDiff.filter((item) => item.action === 'skippedByDatePolicy').length,
    wrote
  };

  return {
    ok: true,
    packageDir,
    markdownPath,
    mode: input.mode,
    provider: process.env.PRODUCT_OCR_COMMAND ? 'PRODUCT_OCR_COMMAND' : 'auto-local',
    ocrSummary: summary,
    ocrDiff,
    ocrResults,
    issues,
    outputMarkdownPath
  };
}

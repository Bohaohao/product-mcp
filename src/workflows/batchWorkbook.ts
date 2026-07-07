import { createHash } from 'node:crypto';
import { copyFile, stat } from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
import type {
  Cell,
  CellErrorValue,
  CellHyperlinkValue,
  CellRichTextValue,
  CellValue,
  Workbook,
  Worksheet
} from 'exceljs';

export const BATCH_TEMPLATE_SHEET_NAME = '导入模板';

export const STANDARD_BATCH_HEADERS = [
  '产品类型',
  '所属一级分类',
  '所属二级分类',
  '所属三级分类',
  '产品中文名称',
  '产品型号',
  '单位',
  '状态',
  '所属供应商',
  '供货商代码',
  '适用区域（下拉选择）',
  '产品等级（下拉选择）',
  '参考成本价含税（￥）',
  '参考成本价（＄）',
  '利润率（%）',
  '包装尺寸-长（毫米）',
  '包装尺寸-宽（毫米）',
  '包装尺寸-高（毫米）',
  '重量-毛重（千克）',
  '包装费（元）'
] as const;

export const BATCH_PROGRESS_HEADERS = [
  '创建进度',
  '创建结果说明',
  '商品ID',
  '资料包路径',
  '商品资料路径',
  '最后更新时间',
  'workflowId'
] as const;

export type StandardBatchHeader = (typeof STANDARD_BATCH_HEADERS)[number];
export type BatchProgressHeader = (typeof BATCH_PROGRESS_HEADERS)[number];
export type BatchCellPrimitive = string | number | boolean | Date | null;

export type BatchRowSelection =
  | 'all'
  | readonly (number | string)[]
  | {
      mode?: 'all';
      rowNumbers?: readonly number[];
      productNames?: readonly string[];
    };

export interface BatchRowIssue {
  code: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  blocking?: boolean;
  scope?: 'workbook' | 'sheet' | 'row' | 'cell';
  sheetName?: string;
  rowNumber?: number;
  columnNumber?: number;
  header?: string;
  field?: string;
  cellAddress?: string;
  details?: Record<string, unknown>;
}

export interface BatchWorkbookIssue extends BatchRowIssue {
  severity: 'error' | 'warning';
  blocking: boolean;
  scope: 'workbook' | 'sheet' | 'row' | 'cell';
}

export interface BatchWorkbookRow {
  [key: string]: unknown;
  rowNumber: number;
  productName: string;
  productNameCn: string;
  productType: BatchCellPrimitive;
  categoryFirstName: BatchCellPrimitive;
  categorySecondName: BatchCellPrimitive;
  categoryThirdName: BatchCellPrimitive;
  productModel: BatchCellPrimitive;
  unitName: BatchCellPrimitive;
  status: BatchCellPrimitive;
  supplierName: BatchCellPrimitive;
  supplierCode: BatchCellPrimitive;
  regionName: BatchCellPrimitive;
  level: BatchCellPrimitive;
  referenceCostCny: BatchCellPrimitive;
  referenceCostUsd: BatchCellPrimitive;
  profitMargin: BatchCellPrimitive;
  packLength: BatchCellPrimitive;
  packWidth: BatchCellPrimitive;
  packHeight: BatchCellPrimitive;
  packWeight: BatchCellPrimitive;
  packingFee: BatchCellPrimitive;
  values: Record<StandardBatchHeader, BatchCellPrimitive>;
  progress: Partial<Record<BatchProgressHeader, string>>;
  issues: BatchWorkbookIssue[];
  blocked: boolean;
}

export type BatchProductRow = BatchWorkbookRow;

export interface BatchWorkbookLoadOptions {
  workbookPath: string;
  sheetName?: string;
  rowSelection?: BatchRowSelection;
}

export interface BatchWorkbookParseResult {
  workbookPath: string;
  sheetName: string;
  worksheetName: string;
  headerRowNumber: number;
  headerColumns: Record<StandardBatchHeader, number>;
  progressColumns: Partial<Record<BatchProgressHeader, number>>;
  rows: BatchWorkbookRow[];
  issues: BatchWorkbookIssue[];
}

export interface BatchRowProgressUpdate {
  rowNumber?: number;
  productName?: string;
  progress?: string;
  resultMessage?: string;
  productId?: string | number | null;
  packagePath?: string | null;
  productMarkdownPath?: string | null;
  workflowId?: string | null;
  updatedAt?: string | Date;
  values?: Partial<Record<BatchProgressHeader, BatchCellPrimitive | undefined>>;
}

export interface BatchWorkbookWriteResult {
  ok: true;
  workbookPath: string;
  backupPath: string;
  sheetName: string;
  rowNumber: number;
  updatedAt: string;
  updatedColumns: Record<BatchProgressHeader, number>;
}

export interface BatchWorkbookProgressPatch {
  status?: string;
  message?: string;
  productId?: string | number | null;
  packagePath?: string | null;
  markdownPath?: string | null;
  workflowId?: string | null;
}

export interface BatchWorkbookProgressSession {
  readonly backupFilePath?: string;
  writeRowProgress(rowNumber: number, update: BatchWorkbookProgressPatch): Promise<BatchWorkbookWriteResult>;
}

export interface BatchWorkbookHandle extends BatchWorkbookParseResult {
  session: BatchWorkbookProgressSession;
  writeRowProgress(update: BatchRowProgressUpdate): Promise<BatchWorkbookWriteResult>;
}

interface HeaderInspection {
  worksheet: Worksheet;
  sheetName: string;
  headerRowNumber: number;
  headerColumns: Map<StandardBatchHeader, number>;
  progressColumns: Map<BatchProgressHeader, number>;
  missingHeaders: StandardBatchHeader[];
  matchedStandardCount: number;
  lastHeaderColumn: number;
}

interface SelectedRowsResult {
  rows: BatchWorkbookRow[];
  issues: BatchWorkbookIssue[];
}

type FormulaCellValue = {
  formula?: string;
  sharedFormula?: string;
  result?: unknown;
};

const STANDARD_HEADER_BY_NORMALIZED = new Map(
  STANDARD_BATCH_HEADERS.map((header) => [normalizeHeader(header), header] as const)
);
const PROGRESS_HEADER_BY_NORMALIZED = new Map(
  BATCH_PROGRESS_HEADERS.map((header) => [normalizeHeader(header), header] as const)
);

const FORMULA_ERROR_VALUES = new Set([
  '#NULL!',
  '#DIV/0!',
  '#VALUE!',
  '#REF!',
  '#NAME?',
  '#NUM!',
  '#N/A',
  '#GETTING_DATA',
  '#SPILL!',
  '#CALC!',
  '#FIELD!',
  '#BLOCKED!',
  '#UNKNOWN!'
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);
}

function normalizeHeader(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .replace(/\(/g, '（')
    .replace(/\)/g, '）')
    .replace(/\$/g, '＄')
    .replace(/¥/g, '￥')
    .trim();
}

function normalizeProductName(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase();
}

function isCellErrorValue(value: unknown): value is CellErrorValue {
  return isRecord(value) && typeof value.error === 'string' && value.error.trim().startsWith('#');
}

function isRichTextValue(value: unknown): value is CellRichTextValue {
  return isRecord(value) && Array.isArray(value.richText);
}

function isHyperlinkValue(value: unknown): value is CellHyperlinkValue {
  return isRecord(value) && typeof value.text === 'string' && typeof value.hyperlink === 'string';
}

function isFormulaValue(value: unknown): value is FormulaCellValue {
  return isRecord(value) && (typeof value.formula === 'string' || typeof value.sharedFormula === 'string');
}

function isArraySelection(value: BatchRowSelection): value is readonly (number | string)[] {
  return Array.isArray(value);
}

function isBlankPrimitive(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  return false;
}

function isFormulaErrorText(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const text = value.trim().toUpperCase();
  return text.startsWith('#') || FORMULA_ERROR_VALUES.has(text);
}

function primitiveToText(value: BatchCellPrimitive): string {
  if (value === null) return '';
  if (value instanceof Date) return value.toISOString();
  return String(value).trim();
}

function normalizeCellPrimitive(value: unknown): BatchCellPrimitive {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (isCellErrorValue(value)) return value.error;
  if (isRichTextValue(value)) return value.richText.map((item) => item.text || '').join('');
  if (isHyperlinkValue(value)) return value.text || value.hyperlink;
  return String(value);
}

function issue(input: Omit<BatchWorkbookIssue, 'severity' | 'blocking'> & Partial<Pick<BatchWorkbookIssue, 'severity' | 'blocking'>>): BatchWorkbookIssue {
  return {
    severity: input.severity || 'error',
    blocking: input.blocking ?? input.severity !== 'warning',
    ...input
  };
}

function cellToHeaderText(cell: Cell): string {
  const value = cell.value;
  if (isFormulaValue(value)) {
    const result = normalizeCellPrimitive(value.result);
    return primitiveToText(result) || cell.text.trim();
  }
  return primitiveToText(normalizeCellPrimitive(value)) || cell.text.trim();
}

function inspectHeaderRow(worksheet: Worksheet, rowNumber: number): HeaderInspection {
  const row = worksheet.getRow(rowNumber);
  const labels = new Map<string, number>();
  let lastHeaderColumn = 0;

  row.eachCell({ includeEmpty: false }, (cell, columnNumber) => {
    const text = cellToHeaderText(cell);
    if (!text) return;

    lastHeaderColumn = Math.max(lastHeaderColumn, columnNumber);
    const normalized = normalizeHeader(text);
    if (!labels.has(normalized)) labels.set(normalized, columnNumber);
  });

  const headerColumns = new Map<StandardBatchHeader, number>();
  for (const [normalized, header] of STANDARD_HEADER_BY_NORMALIZED) {
    const columnNumber = labels.get(normalized);
    if (columnNumber !== undefined) headerColumns.set(header, columnNumber);
  }

  const progressColumns = new Map<BatchProgressHeader, number>();
  for (const [normalized, header] of PROGRESS_HEADER_BY_NORMALIZED) {
    const columnNumber = labels.get(normalized);
    if (columnNumber !== undefined) progressColumns.set(header, columnNumber);
  }

  const missingHeaders = STANDARD_BATCH_HEADERS.filter((header) => !headerColumns.has(header));

  return {
    worksheet,
    sheetName: worksheet.name,
    headerRowNumber: rowNumber,
    headerColumns,
    progressColumns,
    missingHeaders,
    matchedStandardCount: headerColumns.size,
    lastHeaderColumn
  };
}

function bestHeaderInspection(worksheet: Worksheet): HeaderInspection {
  let best = inspectHeaderRow(worksheet, 1);
  for (let rowNumber = 2; rowNumber <= Math.max(worksheet.rowCount, 1); rowNumber += 1) {
    const candidate = inspectHeaderRow(worksheet, rowNumber);
    if (candidate.matchedStandardCount > best.matchedStandardCount) {
      best = candidate;
      if (candidate.missingHeaders.length === 0) return candidate;
    }
  }
  return best;
}

function findStandardHeaderSheet(workbook: Workbook, skipSheetName?: string): HeaderInspection | undefined {
  for (const worksheet of workbook.worksheets) {
    if (skipSheetName && worksheet.name === skipSheetName) continue;
    const inspection = bestHeaderInspection(worksheet);
    if (inspection.missingHeaders.length === 0) return inspection;
  }
  return undefined;
}

function selectWorksheetHeaders(workbook: Workbook, requestedSheetName?: string): { inspection: HeaderInspection; issues: BatchWorkbookIssue[] } {
  const issues: BatchWorkbookIssue[] = [];

  if (requestedSheetName) {
    const worksheet = workbook.getWorksheet(requestedSheetName);
    if (!worksheet) {
      const fallback = workbook.worksheets[0];
      if (!fallback) throw new Error(`Workbook has no worksheets: ${requestedSheetName}`);
      const inspection = bestHeaderInspection(fallback);
      issues.push(
        issue({
          code: 'REQUESTED_SHEET_NOT_FOUND',
          scope: 'workbook',
          message: `指定 sheet 不存在：${requestedSheetName}`,
          details: { requestedSheetName }
        })
      );
      return { inspection, issues };
    }

    const inspection = bestHeaderInspection(worksheet);
    if (inspection.missingHeaders.length > 0) {
      issues.push(missingHeadersIssue(inspection));
    }
    return { inspection, issues };
  }

  const template = workbook.getWorksheet(BATCH_TEMPLATE_SHEET_NAME);
  if (template) {
    const inspection = bestHeaderInspection(template);
    if (inspection.missingHeaders.length === 0) return { inspection, issues };

    const fallback = findStandardHeaderSheet(workbook, template.name);
    if (fallback) {
      issues.push(
        issue({
          code: 'TEMPLATE_SHEET_HEADERS_MISSING',
          severity: 'warning',
          blocking: false,
          scope: 'sheet',
          sheetName: template.name,
          rowNumber: inspection.headerRowNumber,
          message: `sheet "${BATCH_TEMPLATE_SHEET_NAME}" 未包含完整标准表头，已改用 sheet "${fallback.sheetName}"。`,
          details: { missingHeaders: inspection.missingHeaders }
        })
      );
      return { inspection: fallback, issues };
    }

    issues.push(missingHeadersIssue(inspection));
    return { inspection, issues };
  }

  const fallback = findStandardHeaderSheet(workbook);
  if (fallback) return { inspection: fallback, issues };

  const firstWorksheet = workbook.worksheets[0];
  if (!firstWorksheet) throw new Error('Workbook has no worksheets.');

  const inspection = bestHeaderInspection(firstWorksheet);
  issues.push(missingHeadersIssue(inspection));
  return { inspection, issues };
}

function missingHeadersIssue(inspection: HeaderInspection): BatchWorkbookIssue {
  return issue({
    code: 'STANDARD_HEADERS_NOT_FOUND',
    scope: 'sheet',
    sheetName: inspection.sheetName,
    rowNumber: inspection.headerRowNumber,
    message: `未找到完整的标准 20 表头，缺少：${inspection.missingHeaders.join('、')}`,
    details: {
      expectedHeaders: STANDARD_BATCH_HEADERS,
      missingHeaders: inspection.missingHeaders,
      matchedStandardCount: inspection.matchedStandardCount
    }
  });
}

function formulaIssue(
  code: string,
  message: string,
  worksheet: Worksheet,
  rowNumber: number,
  columnNumber: number,
  header: StandardBatchHeader,
  cell: Cell,
  details?: Record<string, unknown>
): BatchWorkbookIssue {
  return issue({
    code,
    scope: 'cell',
    sheetName: worksheet.name,
    rowNumber,
    columnNumber,
    header,
    cellAddress: cell.address,
    message,
    details
  });
}

function parseCellValue(
  worksheet: Worksheet,
  rowNumber: number,
  columnNumber: number,
  header: StandardBatchHeader,
  cell: Cell
): { value: BatchCellPrimitive; issues: BatchWorkbookIssue[] } {
  const value = cell.value;
  const issues: BatchWorkbookIssue[] = [];

  if (isFormulaValue(value)) {
    const formulaText = value.formula || value.sharedFormula || cell.formula || '';
    const result = value.result;
    if (isBlankPrimitive(result)) {
      issues.push(
        formulaIssue(
          'FORMULA_RESULT_EMPTY',
          `${header} 的公式单元格 ${cell.address} 没有可用缓存结果。`,
          worksheet,
          rowNumber,
          columnNumber,
          header,
          cell,
          { formula: formulaText }
        )
      );
      return { value: null, issues };
    }

    if (isCellErrorValue(result) || isFormulaErrorText(result)) {
      const errorText = isCellErrorValue(result) ? result.error : String(result);
      issues.push(
        formulaIssue(
          'FORMULA_RESULT_ERROR',
          `${header} 的公式单元格 ${cell.address} 缓存结果为公式错误：${errorText}`,
          worksheet,
          rowNumber,
          columnNumber,
          header,
          cell,
          { formula: formulaText, error: errorText }
        )
      );
      return { value: errorText, issues };
    }

    return { value: normalizeCellPrimitive(result), issues };
  }

  if (isCellErrorValue(value)) {
    issues.push(
      formulaIssue(
        'CELL_ERROR_VALUE',
        `${header} 的单元格 ${cell.address} 为错误值：${value.error}`,
        worksheet,
        rowNumber,
        columnNumber,
        header,
        cell,
        { error: value.error }
      )
    );
    return { value: value.error, issues };
  }

  return { value: normalizeCellPrimitive(value), issues };
}

function isCellEmptyForDataRow(cell: Cell): boolean {
  const value = cell.value;
  if (isFormulaValue(value)) return false;
  if (isRichTextValue(value)) return value.richText.every((item) => !item.text?.trim());
  if (isHyperlinkValue(value)) return !value.text.trim() && !value.hyperlink.trim();
  return isBlankPrimitive(value);
}

function parseWorkbookRows(inspection: HeaderInspection): BatchWorkbookRow[] {
  const rows: BatchWorkbookRow[] = [];
  if (inspection.missingHeaders.length > 0) return rows;

  const worksheet = inspection.worksheet;
  for (let rowNumber = inspection.headerRowNumber + 1; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const standardCells = STANDARD_BATCH_HEADERS.map((header) => row.getCell(inspection.headerColumns.get(header) as number));
    if (standardCells.every(isCellEmptyForDataRow)) continue;

    const values = {} as Record<StandardBatchHeader, BatchCellPrimitive>;
    const rowIssues: BatchWorkbookIssue[] = [];

    for (const header of STANDARD_BATCH_HEADERS) {
      const columnNumber = inspection.headerColumns.get(header) as number;
      const cell = row.getCell(columnNumber);
      const parsed = parseCellValue(worksheet, rowNumber, columnNumber, header, cell);
      values[header] = parsed.value;
      rowIssues.push(...parsed.issues);
    }

    const progress: Partial<Record<BatchProgressHeader, string>> = {};
    for (const header of BATCH_PROGRESS_HEADERS) {
      const columnNumber = inspection.progressColumns.get(header);
      if (columnNumber === undefined) continue;
      progress[header] = primitiveToText(normalizeCellPrimitive(row.getCell(columnNumber).value));
    }

    const productName = primitiveToText(values['产品中文名称']);
    rows.push({
      rowNumber,
      productName,
      productNameCn: productName,
      productType: values['产品类型'],
      categoryFirstName: values['所属一级分类'],
      categorySecondName: values['所属二级分类'],
      categoryThirdName: values['所属三级分类'],
      productModel: values['产品型号'],
      unitName: values['单位'],
      status: values['状态'],
      supplierName: values['所属供应商'],
      supplierCode: values['供货商代码'],
      regionName: values['适用区域（下拉选择）'],
      level: values['产品等级（下拉选择）'],
      referenceCostCny: values['参考成本价含税（￥）'],
      referenceCostUsd: values['参考成本价（＄）'],
      profitMargin: values['利润率（%）'],
      packLength: values['包装尺寸-长（毫米）'],
      packWidth: values['包装尺寸-宽（毫米）'],
      packHeight: values['包装尺寸-高（毫米）'],
      packWeight: values['重量-毛重（千克）'],
      packingFee: values['包装费（元）'],
      values,
      progress,
      issues: rowIssues,
      blocked: rowIssues.some((rowIssue) => rowIssue.blocking)
    });
  }

  return rows;
}

function rowSelectionTargets(rowSelection: BatchRowSelection | undefined): {
  all: boolean;
  rowNumbers: Set<number>;
  productNames: Set<string>;
  rawProductNames: string[];
} {
  if (!rowSelection || rowSelection === 'all') {
    return { all: true, rowNumbers: new Set(), productNames: new Set(), rawProductNames: [] };
  }

  if (isArraySelection(rowSelection)) {
    const rowNumbers = new Set<number>();
    const rawProductNames: string[] = [];
    for (const item of rowSelection) {
      if (typeof item === 'number' && Number.isInteger(item)) rowNumbers.add(item);
      else if (typeof item === 'string' && item.trim()) rawProductNames.push(item);
    }
    return {
      all: false,
      rowNumbers,
      productNames: new Set(rawProductNames.map(normalizeProductName)),
      rawProductNames
    };
  }

  if (rowSelection.mode === 'all') {
    return { all: true, rowNumbers: new Set(), productNames: new Set(), rawProductNames: [] };
  }

  const rowNumbers = new Set<number>((rowSelection.rowNumbers || []).filter((rowNumber: number) => Number.isInteger(rowNumber)));
  const rawProductNames = (rowSelection.productNames || []).map((name: string) => name.trim()).filter(Boolean);
  return {
    all: false,
    rowNumbers,
    productNames: new Set(rawProductNames.map(normalizeProductName)),
    rawProductNames
  };
}

function selectRows(rows: BatchWorkbookRow[], rowSelection: BatchRowSelection | undefined, sheetName: string): SelectedRowsResult {
  const targets = rowSelectionTargets(rowSelection);
  if (targets.all) return { rows, issues: [] };

  const selected = rows.filter((row) => {
    if (targets.rowNumbers.has(row.rowNumber)) return true;
    if (row.productName && targets.productNames.has(normalizeProductName(row.productName))) return true;
    return false;
  });

  const issues: BatchWorkbookIssue[] = [];
  const availableRowNumbers = new Set(rows.map((row) => row.rowNumber));
  for (const rowNumber of targets.rowNumbers) {
    if (!availableRowNumbers.has(rowNumber)) {
      issues.push(
        issue({
          code: 'ROW_SELECTION_NOT_FOUND',
          scope: 'row',
          sheetName,
          rowNumber,
          message: `rowSelection 指定的行号不存在或为空行：${rowNumber}`
        })
      );
    }
  }

  const availableProductNames = new Set(rows.map((row) => normalizeProductName(row.productName)).filter(Boolean));
  for (const rawName of targets.rawProductNames) {
    if (!availableProductNames.has(normalizeProductName(rawName))) {
      issues.push(
        issue({
          code: 'PRODUCT_NAME_SELECTION_NOT_FOUND',
          scope: 'workbook',
          sheetName,
          message: `rowSelection 指定的商品名不存在：${rawName}`,
          details: { productName: rawName }
        })
      );
    }
  }

  return { rows: selected, issues };
}

function mapToObject<K extends string>(map: Map<K, number>, keys: readonly K[]): Record<K, number> {
  const result = {} as Record<K, number>;
  for (const key of keys) {
    const value = map.get(key);
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function partialMapToObject<K extends string>(map: Map<K, number>, keys: readonly K[]): Partial<Record<K, number>> {
  const result: Partial<Record<K, number>> = {};
  for (const key of keys) {
    const value = map.get(key);
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function buildProgressValues(update: BatchRowProgressUpdate): Partial<Record<BatchProgressHeader, BatchCellPrimitive>> {
  const updatedAt = update.updatedAt instanceof Date ? update.updatedAt.toISOString() : update.updatedAt || new Date().toISOString();
  const values: Partial<Record<BatchProgressHeader, BatchCellPrimitive>> = {
    ...(update.values || {}),
    '最后更新时间': updatedAt
  };

  if (update.progress !== undefined) values['创建进度'] = update.progress;
  if (update.resultMessage !== undefined) values['创建结果说明'] = update.resultMessage;
  if (update.productId !== undefined) values['商品ID'] = update.productId;
  if (update.packagePath !== undefined) values['资料包路径'] = update.packagePath;
  if (update.productMarkdownPath !== undefined) values['商品资料路径'] = update.productMarkdownPath;
  if (update.workflowId !== undefined) values.workflowId = update.workflowId;

  return values;
}

function cloneCellStyle(source: Cell, target: Cell): void {
  if (source.style && Object.keys(source.style).length > 0) {
    target.style = JSON.parse(JSON.stringify(source.style)) as Cell['style'];
  }
}

function ensureProgressColumns(inspection: HeaderInspection): Map<BatchProgressHeader, number> {
  const worksheet = inspection.worksheet;
  const headerRow = worksheet.getRow(inspection.headerRowNumber);
  const columns = new Map(inspection.progressColumns);
  const standardLastColumn = Math.max(...[...inspection.headerColumns.values()]);
  let lastHeaderColumn = Math.max(inspection.lastHeaderColumn, standardLastColumn, ...[...columns.values(), 0]);
  const styleSource = headerRow.getCell(lastHeaderColumn || standardLastColumn);

  for (const header of BATCH_PROGRESS_HEADERS) {
    let columnNumber = columns.get(header);
    if (columnNumber === undefined) {
      columnNumber = lastHeaderColumn + 1;
      lastHeaderColumn = columnNumber;
      columns.set(header, columnNumber);
      inspection.progressColumns.set(header, columnNumber);
    }

    const cell = headerRow.getCell(columnNumber);
    if (cell.value !== header) cell.value = header;
    if (cell !== styleSource) cloneCellStyle(styleSource, cell);
    const column = worksheet.getColumn(columnNumber);
    if (!column.width || column.width < Math.min(Math.max(header.length + 4, 12), 24)) {
      column.width = Math.min(Math.max(header.length + 4, 12), 24);
    }
  }

  headerRow.commit();
  inspection.lastHeaderColumn = lastHeaderColumn;
  return columns;
}

function findUpdateRow(rows: BatchWorkbookRow[], update: BatchRowProgressUpdate): BatchWorkbookRow {
  if (update.rowNumber !== undefined) {
    const row = rows.find((candidate) => candidate.rowNumber === update.rowNumber);
    if (row) return row;
    throw new Error(`Batch workbook row not found: ${update.rowNumber}`);
  }

  if (update.productName) {
    const normalized = normalizeProductName(update.productName);
    const matches = rows.filter((row) => normalizeProductName(row.productName) === normalized);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new Error(`Batch workbook product name is ambiguous: ${update.productName}`);
    }
    throw new Error(`Batch workbook product name not found: ${update.productName}`);
  }

  throw new Error('writeRowProgress requires rowNumber or productName.');
}

function timestampForFileName(date = new Date()): string {
  return date.toISOString().replace(/[-:.]/g, '').replace('T', '-').replace('Z', 'Z');
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function createWorkbookBackup(workbookPath: string): Promise<string> {
  const parsed = path.parse(workbookPath);
  const extension = parsed.ext || '.xlsx';
  const basePath = path.join(parsed.dir, `${parsed.name}.backup-${timestampForFileName()}${extension}`);
  if (!(await exists(basePath))) {
    await copyFile(workbookPath, basePath);
    return basePath;
  }

  for (let index = 2; index < 1000; index += 1) {
    const candidate = path.join(parsed.dir, `${parsed.name}.backup-${timestampForFileName()}-${index}${extension}`);
    if (!(await exists(candidate))) {
      await copyFile(workbookPath, candidate);
      return candidate;
    }
  }

  throw new Error(`Unable to allocate workbook backup path for ${workbookPath}`);
}

function normalizeLoadOptions(
  workbookPathOrOptions: string | BatchWorkbookLoadOptions,
  options?: Omit<BatchWorkbookLoadOptions, 'workbookPath'>
): BatchWorkbookLoadOptions {
  if (typeof workbookPathOrOptions === 'string') {
    return {
      ...(options || {}),
      workbookPath: workbookPathOrOptions
    };
  }
  return workbookPathOrOptions;
}

export function batchWorkbookHash(workbookPath: string): string {
  return createHash('sha256').update(path.resolve(workbookPath)).digest('hex').slice(0, 16);
}

class BatchWorkbookSession implements BatchWorkbookHandle {
  workbookPath: string;
  sheetName: string;
  worksheetName: string;
  headerRowNumber: number;
  headerColumns: Record<StandardBatchHeader, number>;
  progressColumns: Partial<Record<BatchProgressHeader, number>>;
  rows: BatchWorkbookRow[];
  issues: BatchWorkbookIssue[];
  session: BatchWorkbookProgressSession;
  private workbook: Workbook;
  private inspection: HeaderInspection;
  private backupPath?: string;
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(workbook: Workbook, workbookPath: string, inspection: HeaderInspection, parseResult: Omit<BatchWorkbookParseResult, 'workbookPath'>) {
    this.workbook = workbook;
    this.workbookPath = workbookPath;
    this.inspection = inspection;
    this.sheetName = parseResult.sheetName;
    this.worksheetName = parseResult.worksheetName;
    this.headerRowNumber = parseResult.headerRowNumber;
    this.headerColumns = parseResult.headerColumns;
    this.progressColumns = parseResult.progressColumns;
    this.rows = parseResult.rows;
    this.issues = parseResult.issues;
    const self = this;
    this.session = {
      get backupFilePath() {
        return self.backupPath;
      },
      writeRowProgress(rowNumber, update) {
        return self.writeRowProgress({
          rowNumber,
          progress: update.status,
          resultMessage: update.message,
          productId: update.productId,
          packagePath: update.packagePath,
          productMarkdownPath: update.markdownPath,
          workflowId: update.workflowId
        });
      }
    };
  }

  async writeRowProgress(update: BatchRowProgressUpdate): Promise<BatchWorkbookWriteResult> {
    const task = this.writeQueue.then(() => this.flushRowProgress(update));
    this.writeQueue = task.catch(() => undefined);
    return task;
  }

  private async ensureBackup(): Promise<string> {
    if (!this.backupPath) {
      this.backupPath = await createWorkbookBackup(this.workbookPath);
    }
    return this.backupPath;
  }

  private async flushRowProgress(update: BatchRowProgressUpdate): Promise<BatchWorkbookWriteResult> {
    const target = findUpdateRow(this.rows, update);
    const backupPath = await this.ensureBackup();
    const columns = ensureProgressColumns(this.inspection);
    const row = this.inspection.worksheet.getRow(target.rowNumber);
    const values = buildProgressValues(update);

    for (const header of BATCH_PROGRESS_HEADERS) {
      if (!Object.prototype.hasOwnProperty.call(values, header)) continue;
      const columnNumber = columns.get(header) as number;
      row.getCell(columnNumber).value = values[header] as CellValue;
      target.progress[header] = primitiveToText(values[header] ?? null);
    }
    row.commit();

    await this.workbook.xlsx.writeFile(this.workbookPath);

    this.progressColumns = partialMapToObject(columns, BATCH_PROGRESS_HEADERS);
    const updatedAt = primitiveToText(values['最后更新时间'] ?? null);
    return {
      ok: true,
      workbookPath: this.workbookPath,
      backupPath,
      sheetName: this.sheetName,
      rowNumber: target.rowNumber,
      updatedAt,
      updatedColumns: mapToObject(columns, BATCH_PROGRESS_HEADERS)
    };
  }
}

export async function readBatchWorkbookRows(options: BatchWorkbookLoadOptions): Promise<BatchWorkbookParseResult>;
export async function readBatchWorkbookRows(
  workbookPath: string,
  options?: Omit<BatchWorkbookLoadOptions, 'workbookPath'>
): Promise<BatchWorkbookParseResult>;
export async function readBatchWorkbookRows(
  workbookPathOrOptions: string | BatchWorkbookLoadOptions,
  maybeOptions?: Omit<BatchWorkbookLoadOptions, 'workbookPath'>
): Promise<BatchWorkbookParseResult> {
  const options = normalizeLoadOptions(workbookPathOrOptions, maybeOptions);
  const workbookPath = path.resolve(options.workbookPath);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(workbookPath);
  const { inspection, issues: workbookIssues } = selectWorksheetHeaders(workbook, options.sheetName);
  const allRows = parseWorkbookRows(inspection);
  const selected = selectRows(allRows, options.rowSelection, inspection.sheetName);
  const rowIssues = selected.rows.flatMap((row) => row.issues);
  const issues = [...workbookIssues, ...selected.issues, ...rowIssues];

  return {
    workbookPath,
    sheetName: inspection.sheetName,
    worksheetName: inspection.sheetName,
    headerRowNumber: inspection.headerRowNumber,
    headerColumns: mapToObject(inspection.headerColumns, STANDARD_BATCH_HEADERS),
    progressColumns: partialMapToObject(inspection.progressColumns, BATCH_PROGRESS_HEADERS),
    rows: selected.rows,
    issues
  };
}

export async function loadBatchWorkbook(options: BatchWorkbookLoadOptions): Promise<BatchWorkbookHandle>;
export async function loadBatchWorkbook(
  workbookPath: string,
  options?: Omit<BatchWorkbookLoadOptions, 'workbookPath'>
): Promise<BatchWorkbookHandle>;
export async function loadBatchWorkbook(
  workbookPathOrOptions: string | BatchWorkbookLoadOptions,
  maybeOptions?: Omit<BatchWorkbookLoadOptions, 'workbookPath'>
): Promise<BatchWorkbookHandle> {
  const options = normalizeLoadOptions(workbookPathOrOptions, maybeOptions);
  const workbookPath = path.resolve(options.workbookPath);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(workbookPath);
  const { inspection, issues: workbookIssues } = selectWorksheetHeaders(workbook, options.sheetName);
  const allRows = parseWorkbookRows(inspection);
  const selected = selectRows(allRows, options.rowSelection, inspection.sheetName);
  const rowIssues = selected.rows.flatMap((row) => row.issues);
  const issues = [...workbookIssues, ...selected.issues, ...rowIssues];

  return new BatchWorkbookSession(workbook, workbookPath, inspection, {
    sheetName: inspection.sheetName,
    worksheetName: inspection.sheetName,
    headerRowNumber: inspection.headerRowNumber,
    headerColumns: mapToObject(inspection.headerColumns, STANDARD_BATCH_HEADERS),
    progressColumns: partialMapToObject(inspection.progressColumns, BATCH_PROGRESS_HEADERS),
    rows: selected.rows,
    issues
  });
}

export async function writeBatchWorkbookRowProgress(
  options: BatchWorkbookLoadOptions & { update: BatchRowProgressUpdate }
): Promise<BatchWorkbookWriteResult> {
  const workbook = await loadBatchWorkbook(options);
  return await workbook.writeRowProgress(options.update);
}

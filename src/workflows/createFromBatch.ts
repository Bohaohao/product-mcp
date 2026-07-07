import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import * as z from 'zod/v4';
import type { BackendClient } from '../backendClient.js';
import { buildProtocolTrace, type ProtocolStage } from '../protocol.js';
import { productCreateFromPackage, type UploadLocalFile } from './createFromPackage.js';
import { batchWorkbookHash, loadBatchWorkbook, type BatchProductRow, type BatchRowIssue, type BatchRowSelection } from './batchWorkbook.js';
import { prepareBatchMaterialPackage } from './batchMaterialPackage.js';

type UnknownRecord = Record<string, unknown>;

export const productCreateFromBatchInputSchema = {
  workbookPath: z.string().trim().min(1).describe('Local Excel workbook. Each row in the standard import sheet represents one product.'),
  materialsRoot: z.string().trim().min(1).describe('Directory containing one product material folder per productNameCn.'),
  runMode: z.enum(['prepare', 'preview', 'create']).default('preview'),
  confirm: z.boolean().optional().describe('Required true when runMode=create. One confirmation covers the full selected batch.'),
  clientRequestId: z.string().trim().min(1).optional().describe('Optional workflow idempotency key. Reuse the same value from preview to create.'),
  sheetName: z.string().trim().optional(),
  rowSelection: z
    .union([
      z.literal('all'),
      z.array(z.union([z.number().int().positive(), z.string().trim().min(1)])),
      z.object({
        rowNumbers: z.array(z.number().int().positive()).optional(),
        productNames: z.array(z.string().trim().min(1)).optional()
      })
    ])
    .optional()
    .describe('Defaults to all non-empty product rows. Values may be Excel row numbers or product names.'),
  concurrency: z.number().int().min(1).max(6).default(2),
  responseMode: z.enum(['summary', 'standard', 'debug']).default('summary')
};

const productCreateFromBatchObjectSchema = z.object(productCreateFromBatchInputSchema);
export type ProductCreateFromBatchInput = z.infer<typeof productCreateFromBatchObjectSchema>;

interface CreateFromBatchRuntime {
  uploadLocalFile: UploadLocalFile;
}

interface BatchRowResult {
  rowNumber: number;
  productNameCn?: string;
  status: string;
  ok: boolean;
  skipped?: boolean;
  code?: string;
  message?: string;
  productId?: string;
  packagePath?: string;
  markdownPath?: string;
  workflowId?: string;
  clientRequestId?: string;
  issues?: BatchRowIssue[];
}

interface BatchJournal {
  batchId: string;
  clientRequestId?: string;
  workbookPath: string;
  materialsRoot: string;
  runMode: string;
  createdAt: string;
  updatedAt: string;
  rows: BatchRowResult[];
  stages: ProtocolStage[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text || undefined;
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120) || 'batch';
}

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function batchDir(): string {
  return path.join(homedir(), '.erp-product', 'batch-workflows');
}

function batchJournalPath(batchId: string): string {
  return path.join(batchDir(), `${safeName(batchId)}.json`);
}

function defaultBatchId(input: ProductCreateFromBatchInput): string {
  if (input.clientRequestId) {
    return `batch_${safeName(input.clientRequestId)}_${sha(input.clientRequestId).slice(0, 8)}`;
  }
  return `batch_${sha(`${path.resolve(input.workbookPath)}:${path.resolve(input.materialsRoot)}`).slice(0, 20)}`;
}

function rowClientRequestId(input: ProductCreateFromBatchInput, row: BatchProductRow): string {
  return `${defaultBatchId(input)}_${batchWorkbookHash(input.workbookPath)}_${row.rowNumber}_${sha(row.productNameCn || String(row.rowNumber)).slice(0, 12)}`;
}

async function readJournal(batchId: string): Promise<BatchJournal | undefined> {
  try {
    return JSON.parse(await readFile(batchJournalPath(batchId), 'utf8')) as BatchJournal;
  } catch {
    return undefined;
  }
}

async function writeJournal(journal: BatchJournal): Promise<void> {
  journal.updatedAt = nowIso();
  await mkdir(batchDir(), { recursive: true });
  await writeFile(batchJournalPath(journal.batchId), JSON.stringify(journal, null, 2), 'utf8');
}

function summarizeIssues(issues: BatchRowIssue[] | undefined): string {
  const rows = (issues || []).filter((issue) => issue.severity === 'error');
  if (!rows.length) return '';
  return rows.map((issue) => issue.message).join('；').slice(0, 900);
}

function rowResultFromPackageResult(row: BatchProductRow, result: UnknownRecord, fallbackStatus: string): BatchRowResult {
  const ok = result.ok === true;
  const createResult = isRecord(result.createResult) ? result.createResult : undefined;
  const productId = stringValue(result.productId) || stringValue(result.id) || stringValue(createResult?.productId) || stringValue(createResult?.id);
  return {
    rowNumber: row.rowNumber,
    productNameCn: row.productNameCn,
    ok,
    status: ok ? fallbackStatus : fallbackStatus.replace('成功', '失败'),
    code: stringValue(result.code),
    message: stringValue(result.summary) || stringValue(result.message),
    productId,
    workflowId: stringValue(result.workflowId),
    clientRequestId: stringValue(result.clientRequestId)
  };
}

async function runWithConcurrency<T>(items: T[], concurrency: number, run: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index];
      index += 1;
      await run(item);
    }
  });
  await Promise.all(workers);
}

function packageResult(result: UnknownRecord, responseMode: ProductCreateFromBatchInput['responseMode']): UnknownRecord {
  if (responseMode === 'debug') return result;
  const rows = Array.isArray(result.rows) ? (result.rows as BatchRowResult[]) : [];
  const compactRows = rows.map((row) => ({
    rowNumber: row.rowNumber,
    productNameCn: row.productNameCn,
    status: row.status,
    ok: row.ok,
    skipped: row.skipped,
    code: row.code,
    message: row.message,
    productId: row.productId,
    packagePath: row.packagePath,
    markdownPath: row.markdownPath,
    workflowId: row.workflowId,
    clientRequestId: row.clientRequestId
  }));
  if (responseMode === 'summary') {
    return {
      ok: result.ok,
      batchId: result.batchId,
      clientRequestId: result.clientRequestId,
      runMode: result.runMode,
      workbookPath: result.workbookPath,
      materialsRoot: result.materialsRoot,
      worksheetName: result.worksheetName,
      summary: result.summary,
      counts: result.counts,
      rows: compactRows.slice(0, 50),
      omittedRowCount: Math.max(0, compactRows.length - 50),
      workbookBackupPath: result.workbookBackupPath,
      journalPath: result.journalPath,
      tracePath: result.tracePath
    };
  }
  return {
    ...result,
    rows: compactRows,
    journal: undefined
  };
}

export async function productCreateFromBatch(
  backend: BackendClient,
  rawInput: unknown,
  requestId: string,
  runtime: CreateFromBatchRuntime
) {
  const input = productCreateFromBatchObjectSchema.parse(rawInput);
  if (input.runMode === 'create' && input.confirm !== true) {
    return {
      ok: false,
      blocked: true,
      code: 'CONFIRM_REQUIRED',
      summary: 'runMode=create 必须传入 confirm=true；该确认将覆盖本次选中的整批商品。'
    };
  }

  const batchId = defaultBatchId(input);
  const loaded = await loadBatchWorkbook({
    workbookPath: input.workbookPath,
    sheetName: input.sheetName,
    rowSelection: input.rowSelection as BatchRowSelection | undefined
  });
  const journal =
    (await readJournal(batchId)) || {
      batchId,
      clientRequestId: input.clientRequestId,
      workbookPath: path.resolve(input.workbookPath),
      materialsRoot: path.resolve(input.materialsRoot),
      runMode: input.runMode,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      rows: [],
      stages: []
    };
  journal.runMode = input.runMode;
  journal.clientRequestId = input.clientRequestId;
  journal.rows = [];
  journal.stages.push({
    name: 'load_batch_workbook',
    ok: !loaded.issues.some((issue) => issue.blocking && issue.scope !== 'row' && issue.scope !== 'cell'),
    counts: {
      rowCount: loaded.rows.length
    },
    summary: `Loaded ${loaded.rows.length} selected product row(s) from ${loaded.worksheetName}.`
  });
  await writeJournal(journal);

  const workbookBlockingIssues = loaded.issues.filter((issue) => issue.blocking && issue.scope !== 'row' && issue.scope !== 'cell');
  if (workbookBlockingIssues.length > 0) {
    const result = {
      ok: false,
      blocked: true,
      code: 'BATCH_WORKBOOK_BLOCKED',
      batchId,
      clientRequestId: input.clientRequestId,
      runMode: input.runMode,
      workbookPath: path.resolve(input.workbookPath),
      materialsRoot: path.resolve(input.materialsRoot),
      worksheetName: loaded.worksheetName,
      summary: summarizeIssues(workbookBlockingIssues) || '批量工作簿存在阻塞问题。',
      counts: { total: loaded.rows.length, success: 0, failure: loaded.rows.length, skipped: 0 },
      rows: [],
      issues: workbookBlockingIssues,
      workbookBackupPath: loaded.session.backupFilePath,
      journalPath: batchJournalPath(batchId),
      tracePath: batchJournalPath(batchId),
      trace: buildProtocolTrace('product_create_from_batch', batchId, journal.stages)
    };
    return packageResult(result, input.responseMode);
  }

  const results = new Map<number, BatchRowResult>();

  await runWithConcurrency(loaded.rows, input.concurrency, async (row) => {
    const clientRequestId = rowClientRequestId(input, row);
    let failureStatus = '预检失败';
    try {
    if (row.blocked) {
      const result: BatchRowResult = {
        rowNumber: row.rowNumber,
        productNameCn: row.productNameCn,
        status: '预检失败',
        ok: false,
        code: 'BATCH_ROW_BLOCKED',
        message: summarizeIssues(row.issues) || '该行存在阻塞问题。',
        clientRequestId,
        issues: row.issues
      };
      await loaded.session.writeRowProgress(row.rowNumber, {
        status: result.status,
        message: result.message,
        workflowId: clientRequestId
      });
      results.set(row.rowNumber, result);
      return;
    }

    const existingProductId = row.progress?.商品ID;
    if (input.runMode === 'create' && row.progress?.创建进度 === '创建成功' && existingProductId) {
      const skipped: BatchRowResult = {
        rowNumber: row.rowNumber,
        productNameCn: row.productNameCn,
        status: '创建成功',
        ok: true,
        skipped: true,
        productId: existingProductId,
        clientRequestId,
        message: '该行已有创建成功记录，本次跳过重复创建。'
      };
      results.set(row.rowNumber, skipped);
      return;
    }

    await loaded.session.writeRowProgress(row.rowNumber, { status: '等待整理', message: '等待生成或更新商品资料.md。' });
    await loaded.session.writeRowProgress(row.rowNumber, { status: '整理中', message: '正在根据表格和资料包生成商品资料.md。' });
    const prepared = await prepareBatchMaterialPackage(row, input.materialsRoot);
    if (!prepared.ok || !prepared.packageDir || !prepared.markdownPath) {
      const result: BatchRowResult = {
        rowNumber: row.rowNumber,
        productNameCn: row.productNameCn,
        status: '预检失败',
        ok: false,
        code: 'MATERIAL_PREPARE_FAILED',
        message: summarizeIssues(prepared.issues) || '资料包整理失败。',
        packagePath: prepared.packageDir,
        markdownPath: prepared.markdownPath,
        clientRequestId,
        issues: prepared.issues
      };
      await loaded.session.writeRowProgress(row.rowNumber, {
        status: result.status,
        message: result.message,
        packagePath: result.packagePath,
        markdownPath: result.markdownPath
      });
      results.set(row.rowNumber, result);
      return;
    }

    await loaded.session.writeRowProgress(row.rowNumber, {
      status: '等待预检',
      message: '商品资料.md 已生成，等待预检。',
      packagePath: prepared.packageDir,
      markdownPath: prepared.markdownPath
    });

    if (input.runMode === 'prepare') {
      const result: BatchRowResult = {
        rowNumber: row.rowNumber,
        productNameCn: row.productNameCn,
        status: '等待预检',
        ok: true,
        packagePath: prepared.packageDir,
        markdownPath: prepared.markdownPath,
        clientRequestId,
        message: '商品资料.md 已生成，未执行 Product MCP 预检。'
      };
      results.set(row.rowNumber, result);
      return;
    }

    await loaded.session.writeRowProgress(row.rowNumber, {
      status: '预检中',
      message: '正在执行 Product MCP 预检/预览。',
      packagePath: prepared.packageDir,
      markdownPath: prepared.markdownPath
    });

    const preview = (await productCreateFromPackage(
      backend,
      {
        packagePath: prepared.packageDir,
        runMode: 'preview',
        responseMode: input.responseMode === 'debug' ? 'debug' : 'summary',
        clientRequestId
      },
      requestId,
      runtime
    )) as UnknownRecord;

    if (preview.ok !== true) {
      const result = rowResultFromPackageResult(row, preview, '预检失败');
      result.packagePath = prepared.packageDir;
      result.markdownPath = prepared.markdownPath;
      await loaded.session.writeRowProgress(row.rowNumber, {
        status: result.status,
        message: result.message || result.code || '预检失败。',
        packagePath: prepared.packageDir,
        markdownPath: prepared.markdownPath,
        workflowId: result.workflowId
      });
      results.set(row.rowNumber, result);
      return;
    }

    if (input.runMode === 'preview') {
      const result = rowResultFromPackageResult(row, preview, '预检通过');
      result.packagePath = prepared.packageDir;
      result.markdownPath = prepared.markdownPath;
      await loaded.session.writeRowProgress(row.rowNumber, {
        status: '预检通过',
        message: result.message || '预检通过，未创建。',
        packagePath: prepared.packageDir,
        markdownPath: prepared.markdownPath,
        workflowId: result.workflowId
      });
      results.set(row.rowNumber, result);
      return;
    }

    failureStatus = '创建失败';
    await loaded.session.writeRowProgress(row.rowNumber, {
      status: '创建中',
      message: '预检通过，正在上传并创建商品。',
      workflowId: stringValue(preview.workflowId)
    });

    const created = (await productCreateFromPackage(
      backend,
      {
        packagePath: prepared.packageDir,
        runMode: 'create',
        confirm: true,
        responseMode: input.responseMode === 'debug' ? 'debug' : 'summary',
        clientRequestId
      },
      requestId,
      runtime
    )) as UnknownRecord;
    const result = rowResultFromPackageResult(row, created, created.ok === true ? '创建成功' : '创建失败');
    result.packagePath = prepared.packageDir;
    result.markdownPath = prepared.markdownPath;
    await loaded.session.writeRowProgress(row.rowNumber, {
      status: result.status,
      message: result.message || result.code || result.status,
      productId: result.productId,
      packagePath: prepared.packageDir,
      markdownPath: prepared.markdownPath,
      workflowId: result.workflowId
    });
    results.set(row.rowNumber, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const result: BatchRowResult = {
        rowNumber: row.rowNumber,
        productNameCn: row.productNameCn,
        status: failureStatus,
        ok: false,
        code: 'ROW_WORKFLOW_FAILED',
        message,
        clientRequestId
      };
      await loaded.session
        .writeRowProgress(row.rowNumber, {
          status: failureStatus,
          message,
          workflowId: clientRequestId
        })
        .catch(() => undefined);
      results.set(row.rowNumber, result);
    }
  });

  const rows = loaded.rows.map((row) => results.get(row.rowNumber)).filter((row): row is BatchRowResult => Boolean(row));
  const counts = {
    total: rows.length,
    success: rows.filter((row) => row.ok && !row.skipped).length,
    failure: rows.filter((row) => !row.ok).length,
    skipped: rows.filter((row) => row.skipped).length
  };
  journal.rows = rows;
  journal.stages.push({
    name: 'process_batch_rows',
    ok: rows.every((row) => row.ok),
    counts
  });
  await writeJournal(journal);

  const result = {
    ok: rows.every((row) => row.ok),
    batchId,
    clientRequestId: input.clientRequestId,
    runMode: input.runMode,
    workbookPath: path.resolve(input.workbookPath),
    materialsRoot: path.resolve(input.materialsRoot),
    worksheetName: loaded.worksheetName,
    summary: `批量${input.runMode}完成：共 ${counts.total} 行，成功 ${counts.success} 行，失败 ${counts.failure} 行，跳过 ${counts.skipped} 行。`,
    counts,
    rows,
    workbookBackupPath: loaded.session.backupFilePath,
    journalPath: batchJournalPath(batchId),
    tracePath: batchJournalPath(batchId),
    trace: buildProtocolTrace('product_create_from_batch', batchId, journal.stages),
    journal: input.responseMode === 'debug' ? journal : undefined
  };
  return packageResult(result, input.responseMode);
}

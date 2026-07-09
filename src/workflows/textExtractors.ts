import { readFile } from 'node:fs/promises';
import ExcelJS from 'exceljs';
import type { SourceInventoryItem } from './sourceInventory.js';

export interface TextFactItem {
  title: string;
  content: string;
}

export interface TextExtractionResult {
  ok: boolean;
  text: string;
  summary?: string;
  reason?: string;
}

const MAX_TEXT_BYTES = 512 * 1024;

function compactWhitespace(value: string): string {
  return value.replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function summarize(value: string): string {
  const compact = compactWhitespace(value).replace(/\n+/g, ' ');
  return compact.length > 180 ? `${compact.slice(0, 180)}...` : compact;
}

async function readPlainText(source: SourceInventoryItem): Promise<TextExtractionResult> {
  if (source.size > MAX_TEXT_BYTES) {
    return {
      ok: false,
      text: '',
      reason: `文本文件过大，超过 ${Math.round(MAX_TEXT_BYTES / 1024)}KB 自动解析上限。`
    };
  }
  const text = compactWhitespace(await readFile(source.absolutePath, 'utf8'));
  return {
    ok: Boolean(text),
    text,
    summary: text ? summarize(text) : undefined,
    reason: text ? undefined : '文本为空。'
  };
}

async function readSpreadsheet(source: SourceInventoryItem): Promise<TextExtractionResult> {
  if (source.extension === 'csv') return readPlainText(source);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(source.absolutePath);
  const lines: string[] = [];
  workbook.worksheets.slice(0, 3).forEach((sheet) => {
    lines.push(`# ${sheet.name}`);
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const values = row.values;
      if (!Array.isArray(values)) return;
      const cells = values
        .slice(1)
        .map((cell) => {
          if (cell === null || cell === undefined) return '';
          if (typeof cell === 'object' && 'text' in cell) return String((cell as { text?: unknown }).text || '');
          return String(cell).trim();
        })
        .filter(Boolean);
      if (cells.length) lines.push(cells.join(' | '));
    });
  });
  const text = compactWhitespace(lines.join('\n'));
  return {
    ok: Boolean(text),
    text,
    summary: text ? summarize(text) : undefined,
    reason: text ? undefined : '表格未解析出文本。'
  };
}

export async function extractTextFromSource(source: SourceInventoryItem): Promise<TextExtractionResult> {
  if (source.sourceKind === 'text') return readPlainText(source);
  if (source.sourceKind === 'spreadsheet') return readSpreadsheet(source);
  if (source.sourceKind === 'pdf') {
    return {
      ok: false,
      text: '',
      reason: 'PDF 业务文案暂不做通用文本解析；认证 PDF 会由认证 OCR 流程处理。'
    };
  }
  if (source.sourceKind === 'document') {
    return {
      ok: false,
      text: '',
      reason: 'Word/PPT 业务文案暂不做通用文本解析，请转为 txt/xlsx 或在商品资料.md 中填写结构化章节。'
    };
  }
  return {
    ok: false,
    text: '',
    reason: `${source.sourceKind} 不需要文本解析。`
  };
}

function stripBullet(value: string): string {
  return value.replace(/^\s*(?:[-*•]|\d+[.、)]|[（(]?\d+[）)])\s*/, '').trim();
}

export function parseTitleContentItems(text: string, fallbackTitle: string): TextFactItem[] {
  const lines = compactWhitespace(text)
    .split(/\n+/)
    .map((line) => stripBullet(line))
    .filter(Boolean);
  const items: TextFactItem[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const pair = line.match(/^(.{2,48}?)[：:]\s*(.{2,})$/);
    if (pair) {
      items.push({
        title: pair[1].trim(),
        content: pair[2].trim()
      });
      continue;
    }
    const next = lines[index + 1];
    if (next && line.length <= 40 && !next.includes('：') && !next.includes(':')) {
      items.push({
        title: line,
        content: next
      });
      index += 1;
    }
  }

  if (!items.length && lines.length) {
    items.push({
      title: fallbackTitle,
      content: lines.join('；')
    });
  }

  return items;
}

export function parseFaqItems(text: string): TextFactItem[] {
  const lines = compactWhitespace(text)
    .split(/\n+/)
    .map((line) => stripBullet(line))
    .filter(Boolean);
  const items: TextFactItem[] = [];
  let pendingQuestion = '';

  for (const line of lines) {
    const qMatch = line.match(/^(?:Q|问|问题)[：:]\s*(.+)$/i);
    if (qMatch) {
      pendingQuestion = qMatch[1].trim();
      continue;
    }
    const aMatch = line.match(/^(?:A|答|回答)[：:]\s*(.+)$/i);
    if (aMatch && pendingQuestion) {
      items.push({ title: pendingQuestion, content: aMatch[1].trim() });
      pendingQuestion = '';
      continue;
    }
    const pair = line.match(/^(.+?[？?])\s*(.+)$/);
    if (pair) {
      items.push({ title: pair[1].trim(), content: pair[2].trim() });
    }
  }

  if (!items.length) return parseTitleContentItems(text, '常见问题');
  return items;
}

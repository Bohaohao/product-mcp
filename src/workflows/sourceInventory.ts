import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { detectBusinessTypesFromText, type BusinessType } from './templateSectionRegistry.js';

export type SourceKind = 'folder' | 'image' | 'video' | 'text' | 'pdf' | 'spreadsheet' | 'document' | 'other';

export interface SourceInventoryItem {
  sourcePath: string;
  absolutePath: string;
  sourceKind: SourceKind;
  parentFolder: string;
  fileName: string;
  baseName: string;
  extension: string;
  size: number;
  detectedLabels: string[];
  possibleBusinessTypes: BusinessType[];
  extractedTextSummary?: string;
  relatedFiles: string[];
  pathParts: string[];
}

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'avi', 'mkv']);
const TEXT_EXTENSIONS = new Set(['txt', 'md', 'csv', 'json']);
const SPREADSHEET_EXTENSIONS = new Set(['xlsx', 'xls', 'csv']);
const DOCUMENT_EXTENSIONS = new Set(['doc', 'docx', 'ppt', 'pptx']);
const SKIPPED_DIRS = new Set(['.git', '.generated', 'node_modules']);

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, '/');
}

function sourceKindFromExtension(ext: string): SourceKind {
  const normalized = ext.toLowerCase().replace(/^\./, '');
  if (IMAGE_EXTENSIONS.has(normalized)) return 'image';
  if (VIDEO_EXTENSIONS.has(normalized)) return 'video';
  if (normalized === 'pdf') return 'pdf';
  if (SPREADSHEET_EXTENSIONS.has(normalized)) return 'spreadsheet';
  if (TEXT_EXTENSIONS.has(normalized)) return 'text';
  if (DOCUMENT_EXTENSIONS.has(normalized)) return 'document';
  return 'other';
}

function labelsForPath(parts: string[], fileName: string): string[] {
  return [...parts.slice(0, -1), path.basename(fileName, path.extname(fileName))]
    .map((part) => part.trim())
    .filter(Boolean);
}

function businessTypesFor(parts: string[], fileName: string): BusinessType[] {
  const joined = [...parts, fileName].join(' ');
  return detectBusinessTypesFromText(joined);
}

export async function collectSourceInventory(
  packageDir: string,
  options: {
    markdownFileName?: string;
    includeFolders?: boolean;
  } = {}
): Promise<SourceInventoryItem[]> {
  const markdownFileName = options.markdownFileName || '商品资料.md';
  const includeFolders = options.includeFolders ?? false;
  const items: SourceInventoryItem[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === markdownFileName) continue;
      if (entry.isDirectory() && SKIPPED_DIRS.has(entry.name)) continue;

      const absolutePath = path.join(dir, entry.name);
      const relativePath = normalizeRelativePath(path.relative(packageDir, absolutePath));
      const pathParts = relativePath.split('/').filter(Boolean);
      const parentFolder = pathParts.length > 1 ? pathParts[pathParts.length - 2] : '';

      if (entry.isDirectory()) {
        if (includeFolders) {
          items.push({
            sourcePath: relativePath,
            absolutePath,
            sourceKind: 'folder',
            parentFolder,
            fileName: entry.name,
            baseName: entry.name,
            extension: '',
            size: 0,
            detectedLabels: labelsForPath(pathParts, entry.name),
            possibleBusinessTypes: businessTypesFor(pathParts, entry.name),
            relatedFiles: [],
            pathParts
          });
        }
        await walk(absolutePath);
        continue;
      }

      if (!entry.isFile()) continue;
      const fileStat = await stat(absolutePath);
      const extension = path.extname(entry.name).replace(/^\./, '').toLowerCase();
      items.push({
        sourcePath: relativePath,
        absolutePath,
        sourceKind: sourceKindFromExtension(extension),
        parentFolder,
        fileName: entry.name,
        baseName: path.basename(entry.name, path.extname(entry.name)),
        extension,
        size: fileStat.size,
        detectedLabels: labelsForPath(pathParts, entry.name),
        possibleBusinessTypes: businessTypesFor(pathParts, entry.name),
        relatedFiles: [],
        pathParts
      });
    }
  }

  await walk(packageDir);
  return items.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath, 'zh-Hans-CN'));
}

export function sourceInventorySummary(items: SourceInventoryItem[]) {
  const byKind: Record<string, number> = {};
  const byBusinessType: Record<string, number> = {};
  for (const item of items) {
    byKind[item.sourceKind] = (byKind[item.sourceKind] || 0) + 1;
    for (const type of item.possibleBusinessTypes) {
      byBusinessType[type] = (byBusinessType[type] || 0) + 1;
    }
  }
  return {
    total: items.length,
    byKind,
    byBusinessType
  };
}

import path from 'node:path';
import type { SourceInventoryItem } from './sourceInventory.js';
import { detectBusinessTypesFromText, type BusinessType } from './templateSectionRegistry.js';
import { extractTextFromSource, parseFaqItems, parseTitleContentItems, type TextFactItem } from './textExtractors.js';

export interface SourceMappingRecord {
  sourcePath: string;
  detectedBusinessTypes: BusinessType[];
  targetSections: string[];
  targetRows: string[];
  status: 'mapped' | 'ignored' | 'ambiguous' | 'blocked';
  reason: string;
}

export interface StructuredSourceRows {
  advantageRows: Array<Record<string, string>>;
  scenarioRows: Array<Record<string, string>>;
  faqRows: Array<Record<string, string>>;
  afterSalesRows: Array<Record<string, string>>;
  warrantyRows: Array<Record<string, string>>;
  caseRows: Array<Record<string, string>>;
  caseMediaRows: Array<Record<string, string>>;
  mappings: SourceMappingRecord[];
  counts: Record<string, number>;
}

const IMAGE_KINDS = new Set(['image']);
const TEXT_KINDS = new Set(['text', 'spreadsheet']);

function includesType(source: SourceInventoryItem, type: BusinessType): boolean {
  return source.possibleBusinessTypes.includes(type);
}

function sameFolder(a: SourceInventoryItem, b: SourceInventoryItem): boolean {
  return a.parentFolder === b.parentFolder && a.pathParts.slice(0, -1).join('/') === b.pathParts.slice(0, -1).join('/');
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_\-/.（）()]+/g, '');
}

function imageScore(item: TextFactItem, image: SourceInventoryItem): number {
  const title = normalize(item.title);
  const base = normalize(image.baseName);
  if (!title || !base) return 0;
  if (title.includes(base) || base.includes(title)) return 3;
  let score = 0;
  for (const char of [...new Set([...title])]) {
    if (base.includes(char)) score += 1;
  }
  return score;
}

function pickImageForItem(item: TextFactItem, images: SourceInventoryItem[], used: Set<string>, index: number): SourceInventoryItem | undefined {
  const available = images.filter((image) => !used.has(image.sourcePath));
  if (!available.length) return undefined;
  const ranked = available
    .map((image) => ({ image, score: imageScore(item, image) }))
    .sort((a, b) => b.score - a.score || a.image.sourcePath.localeCompare(b.image.sourcePath, 'zh-Hans-CN'));
  const exact = ranked.find((entry) => entry.score >= 3);
  return exact?.image || available[index] || available[0];
}

function sourceRemark(source: SourceInventoryItem): string {
  return `来源：${source.sourcePath}`;
}

function increment(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] || 0) + 1;
}

async function extractItems(source: SourceInventoryItem, businessType: BusinessType): Promise<TextFactItem[]> {
  const extracted = await extractTextFromSource(source);
  source.extractedTextSummary = extracted.summary;
  if (!extracted.ok) return [];
  if (businessType === 'faq') return parseFaqItems(extracted.text);
  return parseTitleContentItems(extracted.text, source.baseName);
}

function textSourcesFor(sources: SourceInventoryItem[], type: BusinessType): SourceInventoryItem[] {
  return sources.filter((source) => TEXT_KINDS.has(source.sourceKind) && includesType(source, type));
}

function imagesFor(sources: SourceInventoryItem[], type: BusinessType, textSource?: SourceInventoryItem): SourceInventoryItem[] {
  return sources.filter((source) => {
    if (!IMAGE_KINDS.has(source.sourceKind)) return false;
    if (!includesType(source, type)) return false;
    return textSource ? sameFolder(source, textSource) : true;
  });
}

async function buildTitleContentImageRows(params: {
  sources: SourceInventoryItem[];
  type: 'coreAdvantage' | 'applicationScenario';
  rowLabel: 'advantageRows' | 'scenarioRows';
  titleHeader: '标题';
  contentHeader: '内容';
  imageHeader: '图片路径';
  sectionName: string;
  counts: Record<string, number>;
  mappings: SourceMappingRecord[];
}): Promise<Array<Record<string, string>>> {
  const rows: Array<Record<string, string>> = [];
  const usedImages = new Set<string>();
  const texts = textSourcesFor(params.sources, params.type);

  for (const text of texts) {
    const items = await extractItems(text, params.type);
    if (!items.length) {
      params.mappings.push({
        sourcePath: text.sourcePath,
        detectedBusinessTypes: [params.type],
        targetSections: [],
        targetRows: [],
        status: 'blocked',
        reason: '命中业务章节但未能解析出标题/内容。'
      });
      continue;
    }

    const localImages = imagesFor(params.sources, params.type, text);
    items.forEach((item, index) => {
      const image = pickImageForItem(item, localImages, usedImages, index);
      if (image) usedImages.add(image.sourcePath);
      const rowNumber = rows.length + 1;
      rows.push({
        [params.titleHeader]: item.title,
        [params.contentHeader]: item.content,
        [params.imageHeader]: image?.sourcePath || '',
        排序: String(rowNumber),
        备注: sourceRemark(text)
      });
      params.mappings.push({
        sourcePath: text.sourcePath,
        detectedBusinessTypes: [params.type],
        targetSections: [params.sectionName],
        targetRows: [`${params.sectionName}第 ${rowNumber} 行`],
        status: 'mapped',
        reason: '文本已解析为结构化销售支持行。'
      });
      if (image) {
        params.mappings.push({
          sourcePath: image.sourcePath,
          detectedBusinessTypes: [params.type],
          targetSections: ['商品图片', params.sectionName],
          targetRows: [`${params.sectionName}第 ${rowNumber} 行`],
          status: 'mapped',
          reason: '图片同时用于商品图片分类和结构化销售支持行。'
        });
      }
      increment(params.counts, params.rowLabel);
    });
  }

  return rows;
}

async function buildFaqRows(sources: SourceInventoryItem[], counts: Record<string, number>, mappings: SourceMappingRecord[]): Promise<Array<Record<string, string>>> {
  const rows: Array<Record<string, string>> = [];
  for (const text of textSourcesFor(sources, 'faq')) {
    const items = await extractItems(text, 'faq');
    items.forEach((item) => {
      const rowNumber = rows.length + 1;
      rows.push({
        问题: item.title,
        回答: item.content,
        排序: String(rowNumber),
        备注: sourceRemark(text)
      });
      mappings.push({
        sourcePath: text.sourcePath,
        detectedBusinessTypes: ['faq'],
        targetSections: ['常见问题'],
        targetRows: [`常见问题第 ${rowNumber} 行`],
        status: 'mapped',
        reason: 'FAQ 文案已解析为结构化问答。'
      });
      increment(counts, 'faqRows');
    });
  }
  return rows;
}

async function buildSimpleSalesRows(params: {
  sources: SourceInventoryItem[];
  type: 'afterSales' | 'warranty';
  sectionName: string;
  titleHeader: string;
  contentHeader: string;
  countKey: string;
  counts: Record<string, number>;
  mappings: SourceMappingRecord[];
}): Promise<Array<Record<string, string>>> {
  const rows: Array<Record<string, string>> = [];
  for (const text of textSourcesFor(params.sources, params.type)) {
    const items = await extractItems(text, params.type);
    items.forEach((item) => {
      const rowNumber = rows.length + 1;
      rows.push({
        [params.titleHeader]: item.title,
        [params.contentHeader]: item.content,
        排序: String(rowNumber),
        备注: sourceRemark(text)
      });
      params.mappings.push({
        sourcePath: text.sourcePath,
        detectedBusinessTypes: [params.type],
        targetSections: [params.sectionName],
        targetRows: [`${params.sectionName}第 ${rowNumber} 行`],
        status: 'mapped',
        reason: '售后/质保文案已解析为结构化销售支持行。'
      });
      increment(params.counts, params.countKey);
    });
  }
  return rows;
}

async function buildCustomerCaseRows(
  sources: SourceInventoryItem[],
  productNameCn: string,
  counts: Record<string, number>,
  mappings: SourceMappingRecord[]
): Promise<{
  caseRows: Array<Record<string, string>>;
  caseMediaRows: Array<Record<string, string>>;
}> {
  const caseRows: Array<Record<string, string>> = [];
  const caseMediaRows: Array<Record<string, string>> = [];
  const caseTexts = textSourcesFor(sources, 'customerCase');
  const customerNameFor = (source: SourceInventoryItem) => {
    const index = source.pathParts.findIndex((part) => detectBusinessTypesFromText(part).includes('customerCase'));
    const next = index >= 0 ? source.pathParts[index + 1] : undefined;
    if (next && next !== source.fileName) return path.basename(next, path.extname(next));
    return source.parentFolder || source.baseName;
  };

  for (const text of caseTexts) {
    const items = await extractItems(text, 'customerCase');
    const customerName = customerNameFor(text);
    const first = items[0];
    const rowNumber = caseRows.length + 1;
    caseRows.push({
      客户名称: customerName,
      产品名称: productNameCn,
      采购数量: '',
      应用场景: first?.title || customerName,
      案例亮点: first?.content || '',
      排序: String(rowNumber),
      备注: sourceRemark(text)
    });
    mappings.push({
      sourcePath: text.sourcePath,
      detectedBusinessTypes: ['customerCase'],
      targetSections: ['客户案例'],
      targetRows: [`客户案例第 ${rowNumber} 行`],
      status: 'mapped',
      reason: '客户案例文案已解析为客户案例行。'
    });
    increment(counts, 'caseRows');
  }

  for (const image of sources.filter((source) => includesType(source, 'customerCase') && (source.sourceKind === 'image' || source.sourceKind === 'video'))) {
    const customerName = customerNameFor(image);
    caseMediaRows.push({
      所属客户名称: customerName,
      媒体类型: image.sourceKind === 'video' ? '视频' : '图片',
      文件路径: image.sourcePath,
      媒体名称: image.baseName,
      备注: sourceRemark(image)
    });
    mappings.push({
      sourcePath: image.sourcePath,
      detectedBusinessTypes: ['customerCase'],
      targetSections: ['客户案例媒体'],
      targetRows: [`客户案例媒体第 ${caseMediaRows.length} 行`],
      status: 'mapped',
      reason: '客户案例媒体已绑定到客户案例。'
    });
    increment(counts, 'caseMediaRows');
  }

  return { caseRows, caseMediaRows };
}

export async function mapSourcesToStructuredRows(sources: SourceInventoryItem[], productNameCn: string): Promise<StructuredSourceRows> {
  const counts: Record<string, number> = {};
  const mappings: SourceMappingRecord[] = [];
  const advantageRows = await buildTitleContentImageRows({
    sources,
    type: 'coreAdvantage',
    rowLabel: 'advantageRows',
    titleHeader: '标题',
    contentHeader: '内容',
    imageHeader: '图片路径',
    sectionName: '核心优势',
    counts,
    mappings
  });
  const scenarioRows = await buildTitleContentImageRows({
    sources,
    type: 'applicationScenario',
    rowLabel: 'scenarioRows',
    titleHeader: '标题',
    contentHeader: '内容',
    imageHeader: '图片路径',
    sectionName: '应用场景',
    counts,
    mappings
  });
  const faqRows = await buildFaqRows(sources, counts, mappings);
  const afterSalesRows = await buildSimpleSalesRows({
    sources,
    type: 'afterSales',
    sectionName: '售后服务承诺',
    titleHeader: '承诺事项',
    contentHeader: '说明',
    countKey: 'afterSalesRows',
    counts,
    mappings
  });
  const warrantyRows = await buildSimpleSalesRows({
    sources,
    type: 'warranty',
    sectionName: '质保政策',
    titleHeader: '政策标题',
    contentHeader: '政策内容',
    countKey: 'warrantyRows',
    counts,
    mappings
  });
  const customerCases = await buildCustomerCaseRows(sources, productNameCn, counts, mappings);

  return {
    advantageRows,
    scenarioRows,
    faqRows,
    afterSalesRows,
    warrantyRows,
    caseRows: customerCases.caseRows,
    caseMediaRows: customerCases.caseMediaRows,
    mappings,
    counts
  };
}

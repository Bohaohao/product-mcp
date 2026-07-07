export type MediaClassificationKind = 'image' | 'media' | 'richText';

export interface ClassificationDecision {
  label: string;
  remark?: string;
  source: 'sourceTable' | 'exactCategory' | 'explicitMapping' | 'preservedOriginal' | 'subjectiveFallback';
  original: string;
}

export interface ClassificationValidationIssue {
  code: string;
  message: string;
  fieldPath: string;
  blocking: true;
  suggestion: string;
}

const SOURCE_CLASSIFICATION_REMARK_PREFIX = '原始表格分类：';
const PRESERVE_ORIGINAL_REMARK = '目标模板无同名分类，保留原始分类';
const SUBJECTIVE_FALLBACK_REASON = '目标模板无同名分类且无法保留原分类，按内容语义降级映射。';

const SOURCE_CLASSIFICATION_FIELDS = [
  '资料分类',
  '资料用途',
  '资料类型',
  '媒体分类',
  '媒体类型',
  '文件分类',
  '附件分类',
  '图片用途',
  '图片分类',
  '视频分类',
  '视频类型',
  'mediaCategory',
  'materialCategory',
];

const IMAGE_TARGET_CATEGORIES = new Set([
  '商品主图',
  'Banner 图',
  '细节图',
  '尺寸图',
  '场景图',
  '包装图',
  '多角度实拍图',
  '配件图',
]);

const MEDIA_TARGET_CATEGORIES = new Set([
  '实拍视频',
  '装柜视频',
  '作业视频',
  '安装视频',
  '包装视频',
  '链界实测视频',
  '三方实测视频',
  '3D 展示',
  '商品附件',
]);

const RICH_TEXT_TARGET_CATEGORIES = new Set([
  '富文本图片',
  '富文本视频',
  '富文本附件',
  '图文详情图片',
]);

const IMAGE_EXPLICIT_MAPPINGS = new Map([
  ['主图', '商品主图'],
  ['封面', '商品主图'],
  ['商品封面', '商品主图'],
  ['main', '商品主图'],
  ['cover', '商品主图'],
  ['banner', 'Banner 图'],
  ['横幅', 'Banner 图'],
  ['头图', 'Banner 图'],
  ['海报', 'Banner 图'],
  ['详情', '细节图'],
  ['详情图', '细节图'],
  ['细节', '细节图'],
  ['detail', '细节图'],
  ['尺寸', '尺寸图'],
  ['尺码', '尺寸图'],
  ['size', '尺寸图'],
  ['场景', '场景图'],
  ['应用场景', '场景图'],
  ['scene', '场景图'],
  ['包装', '包装图'],
  ['包装图片', '包装图'],
  ['package', '包装图'],
  ['packing', '包装图'],
  ['多角度', '多角度实拍图'],
  ['多角度图', '多角度实拍图'],
  ['实拍图', '多角度实拍图'],
  ['配件', '配件图'],
  ['配件图片', '配件图'],
  ['accessories', '配件图'],
]);

const MEDIA_EXPLICIT_MAPPINGS = new Map([
  ['实拍', '实拍视频'],
  ['产品视频', '实拍视频'],
  ['视频', '实拍视频'],
  ['video', '实拍视频'],
  ['装柜', '装柜视频'],
  ['装柜实拍', '装柜视频'],
  ['loading', '装柜视频'],
  ['作业', '作业视频'],
  ['施工', '作业视频'],
  ['work', '作业视频'],
  ['安装', '安装视频'],
  ['install', '安装视频'],
  ['包装', '包装视频'],
  ['包装实拍', '包装视频'],
  ['package', '包装视频'],
  ['packing', '包装视频'],
  ['链界实测', '链界实测视频'],
  ['链界', '链界实测视频'],
  ['三方实测', '三方实测视频'],
  ['三方', '三方实测视频'],
  ['第三方实测', '三方实测视频'],
  ['3d', '3D 展示'],
  ['3D', '3D 展示'],
  ['3D模型', '3D 展示'],
  ['3D 模型', '3D 展示'],
  ['附件', '商品附件'],
  ['商品资料', '商品附件'],
  ['文档', '商品附件'],
  ['资料', '商品附件'],
]);

const RICH_TEXT_EXPLICIT_MAPPINGS = new Map([
  ['图片', '富文本图片'],
  ['图文图片', '富文本图片'],
  ['详情图片', '图文详情图片'],
  ['视频', '富文本视频'],
  ['附件', '富文本附件'],
  ['文档', '富文本附件'],
]);

function cleanCategory(value: unknown): string {
  return String(value ?? '').trim();
}

function normalizedKey(value: string): string {
  return value.trim().replace(/\s+/g, '').toLowerCase();
}

function targetCategories(kind: MediaClassificationKind): Set<string> {
  if (kind === 'image') return IMAGE_TARGET_CATEGORIES;
  if (kind === 'richText') return RICH_TEXT_TARGET_CATEGORIES;
  return MEDIA_TARGET_CATEGORIES;
}

function explicitMappings(kind: MediaClassificationKind): Map<string, string> {
  if (kind === 'image') return IMAGE_EXPLICIT_MAPPINGS;
  if (kind === 'richText') return RICH_TEXT_EXPLICIT_MAPPINGS;
  return MEDIA_EXPLICIT_MAPPINGS;
}

function findExplicitMapping(kind: MediaClassificationKind, category: string): string | undefined {
  const mappings = explicitMappings(kind);
  const exact = mappings.get(category);
  if (exact) return exact;
  const normalized = normalizedKey(category);
  for (const [from, to] of mappings.entries()) {
    if (normalizedKey(from) === normalized) return to;
  }
  return undefined;
}

export function sourceClassificationFromRecord(record: Record<string, unknown>): string {
  for (const field of SOURCE_CLASSIFICATION_FIELDS) {
    const value = cleanCategory(record[field]);
    if (value) return value;
  }
  return '';
}

export function directParentCategoryFromPath(pathValue: string): string {
  const normalized = pathValue.replace(/\\/g, '/');
  const parts = normalized.split('/').filter((part) => part && part !== '.');
  if (parts.length < 2) return '';
  return cleanCategory(parts[parts.length - 2]);
}

export function resolveMediaClassification(params: {
  kind: MediaClassificationKind;
  directParentCategory?: string;
  fallbackLabel?: string;
  sourceClassification?: string;
}): ClassificationDecision {
  const sourceClassification = cleanCategory(params.sourceClassification);
  if (sourceClassification) {
    return {
      label: sourceClassification,
      remark: `${SOURCE_CLASSIFICATION_REMARK_PREFIX}${sourceClassification}`,
      source: 'sourceTable',
      original: sourceClassification,
    };
  }

  const original = cleanCategory(params.directParentCategory) || cleanCategory(params.fallbackLabel);
  const categories = targetCategories(params.kind);
  if (original && categories.has(original)) {
    return {
      label: original,
      source: 'exactCategory',
      original,
    };
  }

  if (original) {
    const mapped = findExplicitMapping(params.kind, original);
    if (mapped) {
      return {
        label: mapped,
        remark: `原目录/原分类：${original}；目标分类：${mapped}；原因：明确等价映射。`,
        source: 'explicitMapping',
        original,
      };
    }
    return {
      label: original,
      remark: `${PRESERVE_ORIGINAL_REMARK}；原目录/原分类：${original}`,
      source: 'preservedOriginal',
      original,
    };
  }

  const fallback = cleanCategory(params.fallbackLabel) || '未分类资料';
  return {
    label: fallback,
    remark: `原目录/原分类：空；目标分类：${fallback}；原因：${SUBJECTIVE_FALLBACK_REASON}`,
    source: 'subjectiveFallback',
    original: '',
  };
}

function matchRemarkValue(remark: string, pattern: RegExp): string {
  const match = remark.match(pattern);
  return cleanCategory(match?.[1]);
}

function isAllowedByExplicitMapping(kind: MediaClassificationKind, original: string, label: string): boolean {
  const mapped = findExplicitMapping(kind, original);
  return !!mapped && mapped === label;
}

export function validateMediaClassificationRow(params: {
  kind: MediaClassificationKind;
  label: string;
  pathValue: string;
  remark?: string;
  fieldPath: string;
}): ClassificationValidationIssue | undefined {
  const label = cleanCategory(params.label);
  const pathValue = cleanCategory(params.pathValue);
  const remark = cleanCategory(params.remark);
  if (!label || !pathValue) return undefined;

  const sourceClassification = matchRemarkValue(remark, /原始表格分类：([^；;]+)/);
  if (sourceClassification && label !== sourceClassification) {
    return {
      code: 'MEDIA_CLASSIFICATION_SOURCE_MISMATCH',
      message: `${params.fieldPath} 的分类被改写：原始表格分类为「${sourceClassification}」，当前为「${label}」。`,
      fieldPath: params.fieldPath,
      blocking: true,
      suggestion: `将第一列改回「${sourceClassification}」，或修正原始表格分类来源。`,
    };
  }

  const originalFromRemark = matchRemarkValue(remark, /原目录\/原分类：([^；;]+)/);
  const directParent = directParentCategoryFromPath(pathValue);
  const original = originalFromRemark && originalFromRemark !== '空' ? originalFromRemark : directParent;

  if (remark.includes(SUBJECTIVE_FALLBACK_REASON)) {
    const target = matchRemarkValue(remark, /目标分类：([^；;]+)/);
    if (!originalFromRemark || !target || target !== label) {
      return {
        code: 'MEDIA_CLASSIFICATION_FALLBACK_TRACE_MISSING',
        message: `${params.fieldPath} 使用了主观降级分类，但备注没有完整记录原分类、目标分类和原因。`,
        fieldPath: params.fieldPath,
        blocking: true,
        suggestion: '按格式填写备注：原目录/原分类：X；目标分类：Y；原因：目标模板无同名分类且无法保留原分类，按内容语义降级映射。',
      };
    }
    return undefined;
  }

  if (!original) return undefined;
  if (label === original) return undefined;
  if (isAllowedByExplicitMapping(params.kind, original, label)) return undefined;
  if (remark.includes(PRESERVE_ORIGINAL_REMARK) && label === original) return undefined;

  return {
    code: 'MEDIA_CLASSIFICATION_DIRECTORY_MISMATCH',
    message: `${params.fieldPath} 的分类「${label}」与直接父目录/原分类「${original}」不一致，且没有明确等价映射。`,
    fieldPath: params.fieldPath,
    blocking: true,
    suggestion: `优先把第一列改为「${original}」；如确有标准映射，请在 MCP 映射规则中显式维护后再使用目标分类。`,
  };
}

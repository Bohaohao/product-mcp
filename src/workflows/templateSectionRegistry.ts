export type BusinessType =
  | 'baseInfo'
  | 'productConfig'
  | 'priceInfo'
  | 'inventoryLogistics'
  | 'parts'
  | 'spareParts'
  | 'wearParts'
  | 'graphicInfo'
  | 'testingVideoMetadata'
  | 'certification'
  | 'coreAdvantage'
  | 'applicationScenario'
  | 'faq'
  | 'customerCase'
  | 'afterSales'
  | 'warranty';

export interface TemplateSectionDefinition {
  sectionId: string;
  sectionName: string;
  aliases: string[];
  businessTypes: BusinessType[];
  rowSchema: string[];
  supportedSourceTypes: string[];
  targetDtoPath: string;
  relatedUploadUsage?: string[];
  textExtractionUseful: boolean;
  mediaReferenceExpected: boolean;
}

export const TEMPLATE_SECTION_REGISTRY: TemplateSectionDefinition[] = [
  {
    sectionId: '1',
    sectionName: '基础信息',
    aliases: ['基础信息', '商品信息', '基本信息', 'base info', 'basic info'],
    businessTypes: ['baseInfo'],
    rowSchema: ['字段', '填写值'],
    supportedSourceTypes: ['row', 'cell', 'spreadsheet'],
    targetDtoPath: 'root',
    textExtractionUseful: true,
    mediaReferenceExpected: false
  },
  {
    sectionId: '2',
    sectionName: '产品配置',
    aliases: ['产品配置', '基础配置', '技术参数', '可选配置', '参数', '配置', 'spec', 'configuration'],
    businessTypes: ['productConfig'],
    rowSchema: ['配置名称', '配置值'],
    supportedSourceTypes: ['text', 'spreadsheet', 'document', 'pdf'],
    targetDtoPath: 'baseConfigs/technicalParams/optionalConfigs',
    textExtractionUseful: true,
    mediaReferenceExpected: false
  },
  {
    sectionId: '3',
    sectionName: '价格信息',
    aliases: ['价格信息', '价格阶梯', '报价', 'price', 'pricing'],
    businessTypes: ['priceInfo'],
    rowSchema: ['客户类型', '起订量', '价格'],
    supportedSourceTypes: ['row', 'cell', 'spreadsheet'],
    targetDtoPath: 'priceTiers',
    textExtractionUseful: true,
    mediaReferenceExpected: false
  },
  {
    sectionId: '4',
    sectionName: '库存与物流',
    aliases: ['库存与物流', '包装', '物流', '库存', '交付', 'package', 'logistics'],
    businessTypes: ['inventoryLogistics'],
    rowSchema: ['字段', '填写值'],
    supportedSourceTypes: ['row', 'cell', 'spreadsheet', 'text'],
    targetDtoPath: 'packageInfo/root',
    textExtractionUseful: true,
    mediaReferenceExpected: false
  },
  {
    sectionId: '5.1',
    sectionName: '配件清单',
    aliases: ['配件', '配件清单', '属具', 'accessory', 'accessories', 'parts'],
    businessTypes: ['parts'],
    rowSchema: ['名称', '规格属性', '图片路径', '附件路径'],
    supportedSourceTypes: ['image', 'pdf', 'text', 'spreadsheet'],
    targetDtoPath: 'partLists',
    relatedUploadUsage: ['partsImage', 'partsAttachment'],
    textExtractionUseful: true,
    mediaReferenceExpected: true
  },
  {
    sectionId: '5.2',
    sectionName: '备件清单',
    aliases: ['备件', '备件清单', 'spare', 'spare parts'],
    businessTypes: ['spareParts'],
    rowSchema: ['名称', '规格属性', '图片路径', '附件路径'],
    supportedSourceTypes: ['image', 'pdf', 'text', 'spreadsheet'],
    targetDtoPath: 'partLists',
    relatedUploadUsage: ['partsImage', 'partsAttachment'],
    textExtractionUseful: true,
    mediaReferenceExpected: true
  },
  {
    sectionId: '5.3',
    sectionName: '易损件清单',
    aliases: ['易损件', '易损件清单', 'wear parts', 'wearing parts'],
    businessTypes: ['wearParts'],
    rowSchema: ['名称', '规格属性', '图片路径', '附件路径'],
    supportedSourceTypes: ['image', 'pdf', 'text', 'spreadsheet'],
    targetDtoPath: 'partLists',
    relatedUploadUsage: ['partsImage', 'partsAttachment'],
    textExtractionUseful: true,
    mediaReferenceExpected: true
  },
  {
    sectionId: '6',
    sectionName: '图文信息',
    aliases: ['图文信息', '商品图片', '商品视频', '富文本', '详情', 'media', 'gallery'],
    businessTypes: ['graphicInfo'],
    rowSchema: ['资料用途', '文件路径'],
    supportedSourceTypes: ['image', 'video', 'pdf', 'document', 'text'],
    targetDtoPath: 'medias/richTextHtml',
    relatedUploadUsage: ['productMainImage', 'sceneImage', 'richTextAttachment'],
    textExtractionUseful: true,
    mediaReferenceExpected: true
  },
  {
    sectionId: '6.2',
    sectionName: '商品视频、3D 与附件',
    aliases: ['链界实测视频', '链界实测', '三方实测视频', '三方实测', '第三方实测'],
    businessTypes: ['testingVideoMetadata'],
    rowSchema: ['资料用途', '文件路径', '标题', '描述', '备注'],
    supportedSourceTypes: ['video', 'text'],
    targetDtoPath: 'medias[videoCategory=4|6].mediaTitle/mediaDesc',
    relatedUploadUsage: ['linkActualTestingVideo', 'thirdActualTestingVideo'],
    textExtractionUseful: true,
    mediaReferenceExpected: true
  },
  {
    sectionId: '7',
    sectionName: '认证资料',
    aliases: ['认证', '认证资料', '证书', '检测报告', 'certificate', 'certification', 'cert'],
    businessTypes: ['certification'],
    rowSchema: ['证书名称', '证书类型', '证书编号', '文件路径', '主图路径'],
    supportedSourceTypes: ['pdf', 'image', 'text'],
    targetDtoPath: 'certifications',
    relatedUploadUsage: ['certificateFile', 'certificateMainImage'],
    textExtractionUseful: true,
    mediaReferenceExpected: true
  },
  {
    sectionId: '8.2',
    sectionName: '核心优势',
    aliases: ['核心优势', '卖点', '优势', '亮点', 'advantage', 'selling point', 'benefit'],
    businessTypes: ['coreAdvantage'],
    rowSchema: ['标题', '内容', '图片路径', '排序', '备注'],
    supportedSourceTypes: ['text', 'image', 'document', 'spreadsheet'],
    targetDtoPath: 'salesSupports[type=2]',
    relatedUploadUsage: ['advantageImage'],
    textExtractionUseful: true,
    mediaReferenceExpected: true
  },
  {
    sectionId: '8.3',
    sectionName: '应用场景',
    aliases: ['应用场景', '使用场景', '场景应用', '施工场景', 'scenario', 'application'],
    businessTypes: ['applicationScenario'],
    rowSchema: ['标题', '内容', '图片路径', '排序', '备注'],
    supportedSourceTypes: ['text', 'image', 'document', 'spreadsheet'],
    targetDtoPath: 'salesSupports[type=3]',
    relatedUploadUsage: ['scenarioImage'],
    textExtractionUseful: true,
    mediaReferenceExpected: true
  },
  {
    sectionId: '8.4',
    sectionName: '常见问题',
    aliases: ['常见问题', 'FAQ', '问答', '标准回答', 'qa'],
    businessTypes: ['faq'],
    rowSchema: ['问题', '回答', '排序', '备注'],
    supportedSourceTypes: ['text', 'document', 'spreadsheet'],
    targetDtoPath: 'salesSupports[type=4]',
    textExtractionUseful: true,
    mediaReferenceExpected: false
  },
  {
    sectionId: '8.8',
    sectionName: '客户案例',
    aliases: ['客户案例', '案例', '客户', 'case', 'customer case'],
    businessTypes: ['customerCase'],
    rowSchema: ['客户名称', '产品名称', '采购数量', '应用场景', '案例亮点'],
    supportedSourceTypes: ['text', 'image', 'video', 'document', 'spreadsheet'],
    targetDtoPath: 'customerCases',
    relatedUploadUsage: ['caseImage', 'caseVideo'],
    textExtractionUseful: true,
    mediaReferenceExpected: true
  },
  {
    sectionId: '8.10',
    sectionName: '售后服务承诺',
    aliases: ['售后', '售后服务', '服务承诺', 'after sales', 'after-sales', 'service promise'],
    businessTypes: ['afterSales'],
    rowSchema: ['承诺事项', '说明', '排序', '备注'],
    supportedSourceTypes: ['text', 'document', 'pdf', 'spreadsheet'],
    targetDtoPath: 'salesSupports[type=7]',
    textExtractionUseful: true,
    mediaReferenceExpected: false
  },
  {
    sectionId: '8.11',
    sectionName: '故障处理与质保',
    aliases: ['质保', '保修', '故障处理', '保修政策', 'warranty', 'guarantee'],
    businessTypes: ['warranty'],
    rowSchema: ['政策标题', '政策内容', '排序', '备注'],
    supportedSourceTypes: ['text', 'document', 'pdf', 'spreadsheet'],
    targetDtoPath: 'salesSupports[type=8/9]',
    relatedUploadUsage: ['serviceSupportFile'],
    textExtractionUseful: true,
    mediaReferenceExpected: false
  },
  {
    sectionId: '9',
    sectionName: '提交前确认',
    aliases: ['提交前确认', '确认', 'confirm'],
    businessTypes: [],
    rowSchema: ['字段', '填写值'],
    supportedSourceTypes: ['row', 'cell'],
    targetDtoPath: 'confirm',
    textExtractionUseful: false,
    mediaReferenceExpected: false
  }
];

const BUSINESS_TYPE_BY_PRIORITY: BusinessType[] = [
  'certification',
  'customerCase',
  'applicationScenario',
  'coreAdvantage',
  'faq',
  'afterSales',
  'warranty',
  'spareParts',
  'wearParts',
  'parts',
  'testingVideoMetadata',
  'productConfig',
  'priceInfo',
  'inventoryLogistics',
  'baseInfo',
  'graphicInfo'
];

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_\-/.（）()【】\[\]{}]+/g, '');
}

export function sectionByBusinessType(type: BusinessType): TemplateSectionDefinition | undefined {
  return TEMPLATE_SECTION_REGISTRY.find((section) => section.businessTypes.includes(type));
}

export function detectBusinessTypesFromText(value: string): BusinessType[] {
  const normalized = normalize(value);
  if (!normalized) return [];
  const matched = new Set<BusinessType>();
  for (const section of TEMPLATE_SECTION_REGISTRY) {
    for (const alias of section.aliases) {
      const aliasKey = normalize(alias);
      if (aliasKey && normalized.includes(aliasKey)) {
        section.businessTypes.forEach((type) => matched.add(type));
      }
    }
  }
  return BUSINESS_TYPE_BY_PRIORITY.filter((type) => matched.has(type));
}

export function businessTypeLabel(type: BusinessType): string {
  return sectionByBusinessType(type)?.sectionName || type;
}

export function structuredBusinessTypes(types: BusinessType[]): BusinessType[] {
  return types.filter((type) => type !== 'graphicInfo' && type !== 'baseInfo' && type !== 'inventoryLogistics' && type !== 'priceInfo');
}

export function isTextExtractionUseful(type: BusinessType): boolean {
  return sectionByBusinessType(type)?.textExtractionUseful === true;
}

export function expectsMediaReference(type: BusinessType): boolean {
  return sectionByBusinessType(type)?.mediaReferenceExpected === true;
}

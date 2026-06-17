import { stat } from 'node:fs/promises';
import path from 'node:path';
import { imageSizeFromFile } from 'image-size/fromFile';
import * as z from 'zod/v4';

export const productUploadFileInputSchema = {
  localPath: z.string().min(1).describe('Absolute local file path on the Codex user machine.'),
  usage: z.enum([
    'productMainImage',
    'bannerImage',
    'detailImage',
    'sizeImage',
    'sceneImage',
    'packageImage',
    'multiAngleImage',
    'accessoriesImage',
    'realVideo',
    'loadingVideo',
    'workVideo',
    'installVideo',
    'packingVideo',
    'linkActualTestingVideo',
    'thirdActualTestingVideo',
    'model3d',
    'productAttachment',
    'certificateFile',
    'certificateMainImage',
    'graphicDetailImage',
    'advantageImage',
    'scenarioImage',
    'caseImage',
    'caseVideo',
    'serviceSupportFile',
    'partsImage',
    'partsAttachment',
    'richTextImage',
    'richTextVideo',
    'richTextAttachment'
  ]),
  title: z.string().optional(),
  description: z.string().optional(),
  languageList: z.array(z.enum(['zh', 'en'])).optional()
};

export const productUploadFileObjectSchema = z.object(productUploadFileInputSchema);
export type ProductUploadFileInput = z.infer<typeof productUploadFileObjectSchema>;

export type UploadTarget =
  | 'medias'
  | 'certifications.fileUrl'
  | 'certifications.mainImageUrl'
  | 'salesSupports.fileUrl'
  | 'customerCases.medias'
  | 'richTextHtml';

export interface UploadPolicy {
  usage: ProductUploadFileInput['usage'];
  label: string;
  allowedExtensions: string[];
  maxSizeMb: number;
  maxCount?: number;
  mediaType?: 1 | 2 | 3 | 4;
  imageCategory?: number;
  videoCategory?: number;
  otherCategory?: number;
  aspectRatio?: number;
  aspectRatioText?: string;
  requireMp4Codec?: boolean;
  target: UploadTarget;
}

export interface LocalFileInfo {
  absolutePath: string;
  fileName: string;
  ext: string;
  size: number;
}

const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png'];

const imagePolicy = (
  usage: ProductUploadFileInput['usage'],
  label: string,
  maxCount: number,
  target: UploadTarget,
  extra: Partial<UploadPolicy> = {}
): UploadPolicy => ({
  usage,
  label,
  allowedExtensions: IMAGE_EXTENSIONS,
  maxSizeMb: 20,
  maxCount,
  target,
  ...extra
});

const videoPolicy = (
  usage: ProductUploadFileInput['usage'],
  label: string,
  maxSizeMb: number,
  maxCount: number,
  target: UploadTarget,
  extra: Partial<UploadPolicy> = {}
): UploadPolicy => ({
  usage,
  label,
  allowedExtensions: ['mp4'],
  maxSizeMb,
  maxCount,
  requireMp4Codec: true,
  target,
  ...extra
});

export const UPLOAD_POLICIES: Record<ProductUploadFileInput['usage'], UploadPolicy> = {
  productMainImage: imagePolicy('productMainImage', '商品主图', 1, 'medias', {
    mediaType: 1,
    imageCategory: 1,
    aspectRatio: 1,
    aspectRatioText: '1:1'
  }),
  bannerImage: imagePolicy('bannerImage', 'banner图', 1, 'medias', {
    mediaType: 1,
    imageCategory: 8,
    aspectRatio: 3,
    aspectRatioText: '3:1'
  }),
  detailImage: imagePolicy('detailImage', '细节图', 10, 'medias', {
    mediaType: 1,
    imageCategory: 2,
    aspectRatio: 1,
    aspectRatioText: '1:1'
  }),
  sizeImage: imagePolicy('sizeImage', '尺寸示意图', 10, 'medias', {
    mediaType: 1,
    imageCategory: 3,
    aspectRatio: 1,
    aspectRatioText: '1:1'
  }),
  sceneImage: imagePolicy('sceneImage', '场景图', 10, 'medias', {
    mediaType: 1,
    imageCategory: 4,
    aspectRatio: 1,
    aspectRatioText: '1:1'
  }),
  packageImage: imagePolicy('packageImage', '包装图', 10, 'medias', {
    mediaType: 1,
    imageCategory: 5,
    aspectRatio: 1,
    aspectRatioText: '1:1'
  }),
  multiAngleImage: imagePolicy('multiAngleImage', '多角度实拍图', 10, 'medias', {
    mediaType: 1,
    imageCategory: 6,
    aspectRatio: 1,
    aspectRatioText: '1:1'
  }),
  accessoriesImage: imagePolicy('accessoriesImage', '配件图', 10, 'medias', {
    mediaType: 1,
    imageCategory: 7,
    aspectRatio: 1,
    aspectRatioText: '1:1'
  }),
  realVideo: videoPolicy('realVideo', '实拍视频', 200, 5, 'medias', { mediaType: 2, videoCategory: 1 }),
  loadingVideo: videoPolicy('loadingVideo', '装柜视频', 200, 5, 'medias', { mediaType: 2, videoCategory: 2 }),
  workVideo: videoPolicy('workVideo', '作业视频', 200, 5, 'medias', { mediaType: 2, videoCategory: 3 }),
  installVideo: videoPolicy('installVideo', '安装视频', 200, 5, 'medias', { mediaType: 2, videoCategory: 5 }),
  packingVideo: videoPolicy('packingVideo', '包装视频', 200, 5, 'medias', { mediaType: 2, videoCategory: 7 }),
  linkActualTestingVideo: videoPolicy('linkActualTestingVideo', '链接实测视频', 500, 5, 'medias', { mediaType: 2, videoCategory: 4 }),
  thirdActualTestingVideo: videoPolicy('thirdActualTestingVideo', '三方实测视频', 500, 5, 'medias', { mediaType: 2, videoCategory: 6 }),
  model3d: {
    usage: 'model3d',
    label: '3D展示',
    allowedExtensions: ['glb'],
    maxSizeMb: 500,
    maxCount: 5,
    mediaType: 3,
    otherCategory: 1,
    target: 'medias'
  },
  productAttachment: {
    usage: 'productAttachment',
    label: '商品附件',
    allowedExtensions: ['pdf'],
    maxSizeMb: 50,
    maxCount: 10,
    mediaType: 3,
    otherCategory: 2,
    target: 'medias'
  },
  certificateFile: {
    usage: 'certificateFile',
    label: '认证资料文件',
    allowedExtensions: ['pdf'],
    maxSizeMb: 50,
    maxCount: 1,
    target: 'certifications.fileUrl'
  },
  certificateMainImage: imagePolicy('certificateMainImage', '认证资料主图', 1, 'certifications.mainImageUrl', {
    aspectRatio: 3 / 4,
    aspectRatioText: '3:4'
  }),
  graphicDetailImage: imagePolicy('graphicDetailImage', '图文详情图片', 1, 'medias', {
    mediaType: 4,
    aspectRatio: 16 / 9,
    aspectRatioText: '16:9'
  }),
  advantageImage: imagePolicy('advantageImage', '核心优势图片', 1, 'salesSupports.fileUrl', {
    aspectRatio: 16 / 9,
    aspectRatioText: '16:9'
  }),
  scenarioImage: imagePolicy('scenarioImage', '应用场景图片', 1, 'salesSupports.fileUrl', {
    aspectRatio: 3 / 4,
    aspectRatioText: '3:4'
  }),
  caseImage: imagePolicy('caseImage', '客户案例图片', 10, 'customerCases.medias', {
    aspectRatio: 16 / 9,
    aspectRatioText: '16:9'
  }),
  caseVideo: videoPolicy('caseVideo', '客户案例视频', 500, 5, 'customerCases.medias'),
  serviceSupportFile: {
    usage: 'serviceSupportFile',
    label: '故障处理与质保附件',
    allowedExtensions: ['pdf'],
    maxSizeMb: 50,
    maxCount: 1,
    target: 'salesSupports.fileUrl'
  },
  partsImage: imagePolicy('partsImage', '配件/备件/易损件图片', 5, 'medias', {
    aspectRatio: 1,
    aspectRatioText: '1:1'
  }),
  partsAttachment: {
    usage: 'partsAttachment',
    label: '配件/备件/易损件附件',
    allowedExtensions: ['pdf'],
    maxSizeMb: 50,
    maxCount: 5,
    target: 'medias'
  },
  richTextImage: imagePolicy('richTextImage', '富文本图片', 0, 'richTextHtml'),
  richTextVideo: videoPolicy('richTextVideo', '富文本视频', 100, 0, 'richTextHtml'),
  richTextAttachment: {
    usage: 'richTextAttachment',
    label: '富文本附件',
    allowedExtensions: ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'pdf', 'txt', 'rar', '7z', 'csv'],
    maxSizeMb: 20,
    target: 'richTextHtml'
  }
};

export function getUploadPolicy(usage: ProductUploadFileInput['usage']): UploadPolicy {
  return UPLOAD_POLICIES[usage];
}

export async function getLocalFileInfo(localPath: string): Promise<LocalFileInfo> {
  const absolutePath = path.resolve(localPath);
  const stats = await stat(absolutePath);

  if (!stats.isFile()) {
    throw new Error('本地路径不是文件');
  }

  const fileName = path.basename(absolutePath);
  return {
    absolutePath,
    fileName,
    ext: path.extname(fileName).replace(/^\./, '').toLowerCase(),
    size: stats.size
  };
}

export async function validateLocalFile(file: LocalFileInfo, policy: UploadPolicy): Promise<{ width?: number; height?: number }> {
  if (!policy.allowedExtensions.includes(file.ext)) {
    throw new Error(`${policy.label}${file.fileName}格式不支持，仅支持：${policy.allowedExtensions.join(', ')}`);
  }

  const maxBytes = policy.maxSizeMb * 1024 * 1024;
  if (file.size > maxBytes) {
    throw new Error(`${policy.label}${file.fileName}大小不能超过${policy.maxSizeMb}MB`);
  }

  if (!policy.aspectRatio || !IMAGE_EXTENSIONS.includes(file.ext)) {
    return {};
  }

  const size = await imageSizeFromFile(file.absolutePath);
  if (!size.width || !size.height) {
    throw new Error(`${policy.label}${file.fileName}图片尺寸读取失败`);
  }

  const actualRatio = size.width / size.height;
  const tolerance = 0.03;
  if (Math.abs(actualRatio - policy.aspectRatio) > tolerance) {
    throw new Error(`${policy.label}要求比例${policy.aspectRatioText || policy.aspectRatio}，当前图片为${size.width}x${size.height}`);
  }

  return {
    width: size.width,
    height: size.height
  };
}

export function getSuggestedMapping(policy: UploadPolicy) {
  return {
    target: policy.target,
    mediaType: policy.mediaType,
    imageCategory: policy.imageCategory,
    videoCategory: policy.videoCategory,
    otherCategory: policy.otherCategory
  };
}

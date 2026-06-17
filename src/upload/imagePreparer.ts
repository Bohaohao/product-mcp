import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { getLocalFileInfo, type LocalFileInfo, type UploadPolicy } from './policies.js';

export interface PreparedImageResult {
  prepared: boolean;
  file: LocalFileInfo;
  sourceFile: LocalFileInfo;
  outputPath?: string;
  mode?: 'forceCrop';
  sourceSize?: {
    width: number;
    height: number;
  };
  outputSize?: {
    width: number;
    height: number;
  };
  targetRatio?: number;
  targetRatioText?: string;
}

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png']);
const DEFAULT_RATIO_TOLERANCE = 0.03;

function isImage(file: LocalFileInfo): boolean {
  return IMAGE_EXTENSIONS.has(file.ext);
}

function outputExt(file: LocalFileInfo): string {
  return file.ext === 'png' ? 'png' : 'jpg';
}

function outputFileName(file: LocalFileInfo, policy: UploadPolicy, width: number, height: number): string {
  const parsed = path.parse(file.fileName);
  const ext = outputExt(file);
  const safeName = parsed.name.replace(/[\\/:*?"<>|\s]+/g, '_') || 'image';
  return `${safeName}__${policy.usage}__crop_${width}x${height}.${ext}`;
}

function preparedDirFor(file: LocalFileInfo): string {
  const hash = createHash('sha1').update(file.absolutePath).digest('hex').slice(0, 12);
  return path.join(process.cwd(), '.generated', 'prepared', hash);
}

function computeCropSize(width: number, height: number, targetRatio: number): { width: number; height: number } {
  const currentRatio = width / height;
  if (currentRatio > targetRatio) {
    return {
      width: Math.max(1, Math.round(height * targetRatio)),
      height
    };
  }

  return {
    width,
    height: Math.max(1, Math.round(width / targetRatio))
  };
}

async function fileInfoIfExists(filePath: string): Promise<LocalFileInfo | undefined> {
  try {
    const stats = await stat(filePath);
    if (!stats.isFile()) return undefined;
    return await getLocalFileInfo(filePath);
  } catch {
    return undefined;
  }
}

export async function prepareImageForUpload(file: LocalFileInfo, policy: UploadPolicy): Promise<PreparedImageResult> {
  if (!policy.aspectRatio || !isImage(file)) {
    return {
      prepared: false,
      file,
      sourceFile: file
    };
  }

  const metadata = await sharp(file.absolutePath).metadata();
  const width = metadata.width;
  const height = metadata.height;
  if (!width || !height) {
    throw new Error(`${policy.label}${file.fileName}图片尺寸读取失败`);
  }

  const currentRatio = width / height;
  if (Math.abs(currentRatio - policy.aspectRatio) <= DEFAULT_RATIO_TOLERANCE) {
    return {
      prepared: false,
      file,
      sourceFile: file,
      sourceSize: { width, height },
      targetRatio: policy.aspectRatio,
      targetRatioText: policy.aspectRatioText
    };
  }

  const cropSize = computeCropSize(width, height, policy.aspectRatio);
  const outputDir = preparedDirFor(file);
  await mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, outputFileName(file, policy, cropSize.width, cropSize.height));
  const existing = await fileInfoIfExists(outputPath);
  if (!existing) {
    const pipeline = sharp(file.absolutePath)
      .rotate()
      .resize({
        width: cropSize.width,
        height: cropSize.height,
        fit: 'cover',
        position: 'centre'
      });

    if (outputExt(file) === 'png') {
      await pipeline.png().toFile(outputPath);
    } else {
      await pipeline.jpeg({ quality: 92 }).toFile(outputPath);
    }
  }

  const preparedFile = await getLocalFileInfo(outputPath);

  return {
    prepared: true,
    file: preparedFile,
    sourceFile: file,
    outputPath,
    mode: 'forceCrop',
    sourceSize: {
      width,
      height
    },
    outputSize: cropSize,
    targetRatio: policy.aspectRatio,
    targetRatioText: policy.aspectRatioText
  };
}

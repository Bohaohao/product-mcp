import OSS from 'ali-oss';
import type { LocalFileInfo, UploadPolicy } from './policies.js';

export interface OssStsToken {
  region: string;
  accessKeyId: string;
  accessKeySecret: string;
  securityToken: string;
  bucketName: string;
}

export interface UploadBackendConfig {
  backendBaseUrl: string;
  clientId: string;
  language: string;
}

export interface OssUploadResult {
  url: string;
  objectKey: string;
}

type OssStsError = Error & { status?: number; code?: string | number };

const DEFAULT_CLIENT_ID = 'e5cd7e4891bf95d1d19206ce24a7b32e';

function createOssStsError(message: string, status?: number, code?: string | number): OssStsError {
  const error = new Error(message) as OssStsError;
  error.status = status;
  error.code = code;
  return error;
}

export function defaultUploadBackendConfig(partial: Partial<UploadBackendConfig> = {}): UploadBackendConfig {
  return {
    backendBaseUrl: partial.backendBaseUrl || 'https://test.eysscm.com/api',
    clientId: partial.clientId || DEFAULT_CLIENT_ID,
    language: partial.language || 'zh_CN'
  };
}

export async function getOssStsToken(config: UploadBackendConfig, authorization: string): Promise<OssStsToken> {
  const response = await fetch(`${config.backendBaseUrl.replace(/\/+$/, '')}/user/oss/sts/token`, {
    method: 'GET',
    headers: {
      Authorization: authorization,
      clientid: config.clientId,
      'Content-Language': config.language,
      locale: config.language,
      Accept: 'application/json'
    }
  });
  const text = await response.text();
  const body = text ? (JSON.parse(text) as { code?: number | string; msg?: string; message?: string; data?: unknown }) : {};

  if (!response.ok) {
    throw createOssStsError(body.msg || body.message || `Failed to get OSS STS token: HTTP ${response.status}`, response.status, body.code);
  }

  if (body.code !== undefined && String(body.code) !== '200') {
    throw createOssStsError(body.msg || body.message || 'Failed to get OSS STS token.', undefined, body.code);
  }

  const data = body.data as Partial<OssStsToken> | undefined;
  if (!data?.region || !data.accessKeyId || !data.accessKeySecret || !data.securityToken || !data.bucketName) {
    throw new Error('OSS STS token response is missing required fields.');
  }

  return {
    region: String(data.region),
    accessKeyId: String(data.accessKeyId),
    accessKeySecret: String(data.accessKeySecret),
    securityToken: String(data.securityToken),
    bucketName: String(data.bucketName)
  };
}

function getCurrentDatePath(now = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}/${month}/${day}`;
}

function getUniqueFileName(fileName: string): string {
  const normalizedName = fileName || 'file';
  const dotIndex = normalizedName.lastIndexOf('.');
  const name = dotIndex > 0 ? normalizedName.slice(0, dotIndex) : normalizedName;
  const ext = dotIndex > 0 ? normalizedName.slice(dotIndex) : '';
  const safeName = name.replace(/[\\/:*?"<>|\s]+/g, '_');
  const uniqueId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  return `${safeName}_${uniqueId}${ext}`;
}

function encodeOssObjectPath(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

export function buildOssObjectKey(fileName: string): string {
  return `${getCurrentDatePath()}/${getUniqueFileName(fileName)}`;
}

export function buildOssUrl(sts: OssStsToken, objectKey: string): string {
  return `https://${sts.bucketName}.oss-${sts.region}.aliyuncs.com/${encodeOssObjectPath(objectKey)}`;
}

export async function uploadLocalFileToOss(
  sts: OssStsToken,
  file: LocalFileInfo,
  _policy: UploadPolicy
): Promise<OssUploadResult> {
  const client = new OSS({
    region: `oss-${sts.region}`,
    accessKeyId: sts.accessKeyId,
    accessKeySecret: sts.accessKeySecret,
    stsToken: sts.securityToken,
    bucket: sts.bucketName
  });
  const objectKey = buildOssObjectKey(file.fileName);
  await client.multipartUpload(objectKey, file.absolutePath);

  return {
    objectKey,
    url: buildOssUrl(sts, objectKey)
  };
}

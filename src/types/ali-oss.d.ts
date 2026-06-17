declare module 'ali-oss' {
  export interface MultipartUploadOptions {
    progress?: (percent: number) => void;
  }

  export interface OssClientOptions {
    region: string;
    accessKeyId: string;
    accessKeySecret: string;
    stsToken: string;
    bucket: string;
  }

  export default class OSS {
    constructor(options: OssClientOptions);
    multipartUpload(objectKey: string, filePath: string, options?: MultipartUploadOptions): Promise<unknown>;
  }
}

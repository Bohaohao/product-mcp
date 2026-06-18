import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import * as z from 'zod/v4';
import { productListCategoriesInputSchema } from './tools/categories.js';
import { productCreateInputSchema } from './tools/createProduct.js';
import {
  productGetCategoryConfigInputSchema,
  productGetDictInputSchema,
  productListRegionsInputSchema,
  productListSuppliersInputSchema
} from './tools/references.js';
import { productGetDetailInputSchema } from './tools/productDetail.js';
import {
  getLocalFileInfo,
  getSuggestedMapping,
  getUploadPolicy,
  productUploadFileInputSchema,
  productUploadFileObjectSchema,
  validateLocalFile,
  type LocalFileInfo,
  type ProductUploadFileInput
} from './upload/policies.js';
import { defaultUploadBackendConfig, getOssStsToken, uploadLocalFileToOss } from './upload/ossUploader.js';
import { precheckProductPackage, productPrecheckPackageInputSchema } from './packagePrecheck.js';
import { prepareImageForUpload } from './upload/imagePreparer.js';

interface BridgeConfig {
  projectUrl: string;
  matchUrlPrefixes?: string[];
  tokenStorageKey: string;
  remoteMcpUrl: string;
  backendBaseUrl?: string;
  clientId?: string;
  language?: string;
  chromeMcp?: {
    command: string;
    args: string[];
    env?: Record<string, string>;
  };
}

interface ChromePage {
  id: number;
  url: string;
  selected: boolean;
}

interface BrowserToken {
  token: string;
  pageUrl: string;
  origin: string;
  fetchedAt: string;
  expiresAt: string;
  expiresInSeconds: number;
  fromCache: boolean;
}

interface CachedBrowserToken {
  token: string;
  pageUrl: string;
  origin: string;
  fetchedAtMs: number;
  expiresAtMs: number;
}

interface CachedOssUpload {
  url: string;
  objectKey: string;
  cachedAtMs: number;
  reuseCount: number;
}

const TOKEN_CACHE_TTL_MS = 2 * 60 * 60 * 1000;
const CHROME_DEVTOOLS_MCP_PACKAGE = 'chrome-devtools-mcp@latest';
const CHROME_DEVTOOLS_MCP_PREFLIGHT_TIMEOUT_MS = 60_000;

const DEFAULT_CHROME_MCP = {
  command: 'cmd',
  args: ['/c', 'npx', '-y', 'chrome-devtools-mcp@latest', '--autoConnect', '--channel=stable', '--no-usage-statistics'],
  env: {
    PROGRAMFILES: 'C:\\Program Files',
    SystemRoot: 'C:\\WINDOWS'
  }
};

const productAuthStatusInputSchema = {
  forceRefresh: z.boolean().default(false).describe('When true, bypass the in-memory token cache and read Admin-Token from Chrome again.')
};

class ChromeDevtoolsMcpPreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChromeDevtoolsMcpPreflightError';
  }
}

class ChromeRemoteDebuggingNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChromeRemoteDebuggingNotAllowedError';
  }
}

function parseArgs(): { configPath: string } {
  const index = process.argv.indexOf('--config');
  const configPath = index >= 0 ? process.argv[index + 1] : process.env.PRODUCT_MCP_BRIDGE_CONFIG;

  if (!configPath) {
    throw new Error('Missing --config <path> or PRODUCT_MCP_BRIDGE_CONFIG.');
  }

  return { configPath };
}

function loadConfig(path: string): BridgeConfig {
  const config = JSON.parse(readFileSync(path, 'utf8')) as BridgeConfig;

  if (!config.projectUrl) throw new Error('Bridge config missing projectUrl.');
  if (!config.tokenStorageKey) throw new Error('Bridge config missing tokenStorageKey.');
  if (!config.remoteMcpUrl) throw new Error('Bridge config missing remoteMcpUrl.');

  return config;
}

function textResult(payload: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(payload, null, 2)
      }
    ]
  };
}

function parsePages(text: string): ChromePage[] {
  const pages: ChromePage[] = [];

  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^(\d+):\s+(.+?)(\s+\[selected\])?$/);
    if (!match) continue;
    pages.push({
      id: Number(match[1]),
      url: match[2].trim(),
      selected: Boolean(match[3])
    });
  }

  return pages;
}

function extractJsonFromChromeText(text: string): unknown {
  const block = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (block) return JSON.parse(block[1]);

  const prefix = 'Script ran on page and returned:';
  const index = text.indexOf(prefix);
  const raw = index >= 0 ? text.slice(index + prefix.length).trim() : text.trim();
  return JSON.parse(raw);
}

function isMatchingProjectPage(config: BridgeConfig, pageUrl: string): boolean {
  const prefixes = config.matchUrlPrefixes?.length ? config.matchUrlPrefixes : [config.projectUrl];
  return prefixes.some((prefix) => pageUrl.startsWith(prefix));
}

function asBearer(token: string): string {
  return token.startsWith('Bearer ') ? token : `Bearer ${token}`;
}

function cleanEnv(env: NodeJS.ProcessEnv, overrides: Record<string, string> = {}): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) result[key] = value;
  }

  return {
    ...result,
    ...overrides
  };
}

function npmCommand(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function usesChromeDevtoolsMcpPackage(config: BridgeConfig['chromeMcp']): boolean {
  if (!config) return true;
  return [config.command, ...config.args].join(' ').includes('chrome-devtools-mcp');
}

function preinstallChromeDevtoolsMcp(env: Record<string, string>): void {
  const result = spawnSync(
    npmCommand(),
    ['exec', '--yes', '--package', CHROME_DEVTOOLS_MCP_PACKAGE, '--', 'node', '-e', 'process.stdout.write("ok")'],
    {
      cwd: process.cwd(),
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: CHROME_DEVTOOLS_MCP_PREFLIGHT_TIMEOUT_MS,
      windowsHide: true
    }
  );

  if (result.error) {
    throw new ChromeDevtoolsMcpPreflightError(
      `Chrome DevTools MCP preflight failed before reading ERP login token. Tried to resolve ${CHROME_DEVTOOLS_MCP_PACKAGE} through npm, but npm failed: ${result.error.message}`
    );
  }

  if (result.status !== 0) {
    throw new ChromeDevtoolsMcpPreflightError(
      [
        `Chrome DevTools MCP preflight failed before reading ERP login token. Tried to auto-install/resolve ${CHROME_DEVTOOLS_MCP_PACKAGE} through npm.`,
        result.stderr?.trim() ? `stderr: ${result.stderr.trim()}` : undefined,
        result.stdout?.trim() ? `stdout: ${result.stdout.trim()}` : undefined
      ]
        .filter(Boolean)
        .join('\n')
    );
  }
}

function isChromeDevtoolsMcpPreflightError(error: unknown): boolean {
  return error instanceof Error && error.name === 'ChromeDevtoolsMcpPreflightError';
}

function isChromeRemoteDebuggingNotAllowedError(error: unknown): boolean {
  return error instanceof Error && error.name === 'ChromeRemoteDebuggingNotAllowedError';
}

function isPotentialChromeRemoteDebuggingError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /remote debugging|devtools|chrome|browser|target|websocket|connection|connect|ECONNREFUSED|ECONNRESET/i.test(message);
}

function chromeRemoteDebuggingGuidance(config: BridgeConfig) {
  return {
    title: 'Chrome DevTools MCP 已安装，但无法连接本机 Chrome',
    reason:
      'Product MCP 需要通过 chrome-devtools-mcp 读取你已登录 ERP 页面中的 localStorage.Admin-Token。当前 chrome-devtools-mcp 无法连接 Chrome，通常是 Chrome 未允许本次远程调试，或目标 Chrome 实例未打开。',
    steps: [
      '1. 打开本机 Chrome 浏览器，确认使用的是 Chrome，不是 Edge 或其它浏览器。',
      `2. 在 Chrome 中打开或切换到 ERP 页面：${config.projectUrl}`,
      `3. 确认页面地址以这些前缀之一开头：${(config.matchUrlPrefixes?.length ? config.matchUrlPrefixes : [config.projectUrl]).join(' , ')}`,
      '4. 保持 ERP 页面已登录状态；如果登录过期，请先重新登录并刷新页面。',
      '5. 当 Chrome 顶部、右上角或页面上出现 “Allow remote debugging for this browser instance” 提示时，点击它并选择 Allow/允许。',
      '6. 如果暂时没有看到该提示，请保持 Chrome 打开，回到 Codex 再次触发登录检查；提示通常会在 chrome-devtools-mcp 尝试连接时出现。'
    ],
    afterUserAction: '用户完成上述操作后，AI 应重新调用 product_auth_status；不需要额外传入调试确认参数。',
    nextToolCall: {
      name: 'product_auth_status',
      arguments: {}
    }
  };
}

function bridgeErrorPayload(error: unknown, config: BridgeConfig, defaultCode: string): Record<string, unknown> {
  if (isChromeDevtoolsMcpPreflightError(error)) {
    return {
      ok: false,
      code: 'CHROME_DEVTOOLS_MCP_UNAVAILABLE',
      message: error instanceof Error ? error.message : String(error),
      recoverableAction: '请允许 npm/npx 访问网络；如网络需要代理，请先配置 npm proxy，然后重试 product_auth_status。',
      projectUrl: config.projectUrl,
      tokenStorageKey: config.tokenStorageKey,
      remoteMcpUrl: config.remoteMcpUrl
    };
  }

  if (isChromeRemoteDebuggingNotAllowedError(error)) {
    return {
      ok: false,
      code: 'CHROME_REMOTE_DEBUGGING_NOT_ALLOWED',
      message: error instanceof Error ? error.message : String(error),
      requiresUserAction: true,
      ...chromeRemoteDebuggingGuidance(config),
      projectUrl: config.projectUrl,
      tokenStorageKey: config.tokenStorageKey,
      remoteMcpUrl: config.remoteMcpUrl
    };
  }

  return {
    ok: false,
    code: defaultCode,
    message: error instanceof Error ? error.message : String(error)
  };
}

function normalizeCallToolResult(result: Awaited<ReturnType<Client['callTool']>>): CallToolResult {
  if ('content' in result && Array.isArray(result.content)) {
    return result as CallToolResult;
  }

  return textResult({
    ok: true,
    result
  });
}

function getTokenCacheMetadata(token: CachedBrowserToken, fromCache: boolean): BrowserToken {
  const expiresInMs = Math.max(0, token.expiresAtMs - Date.now());

  return {
    token: token.token,
    pageUrl: token.pageUrl,
    origin: token.origin,
    fetchedAt: new Date(token.fetchedAtMs).toISOString(),
    expiresAt: new Date(token.expiresAtMs).toISOString(),
    expiresInSeconds: Math.ceil(expiresInMs / 1000),
    fromCache
  };
}

function normalizeRelativePathForCache(relativePath?: string): string | undefined {
  const cleaned = relativePath?.trim();
  if (!cleaned) return undefined;
  return cleaned.replace(/\\/g, '/').replace(/^\.\/+/, '').toLowerCase();
}

function normalizeLocalPathForCache(localPath: string): string {
  return path.resolve(localPath).toLowerCase();
}

async function getLocalFileCacheSignature(localPath: string): Promise<string> {
  const file = await getLocalFileInfo(localPath);
  return `${normalizeLocalPathForCache(file.absolutePath)}|size:${file.size}|mtime:${Math.round(file.mtimeMs)}`;
}

async function buildUploadCacheKey(
  input: ProductUploadFileInput,
  sourceFile: LocalFileInfo,
  uploadedFile: LocalFileInfo
): Promise<string> {
  const relativePath = normalizeRelativePathForCache(input.sourceRelativePath);
  const sourcePath = input.sourceLocalPath || sourceFile.absolutePath;
  let sourceSignature: string;

  try {
    sourceSignature = await getLocalFileCacheSignature(sourcePath);
  } catch {
    sourceSignature = `path:${normalizeLocalPathForCache(sourcePath)}`;
  }

  if (input.dedupeKey) {
    return ['dedupe', input.dedupeKey, sourceSignature].join('|');
  }

  return [
    'fallback',
    relativePath || normalizeLocalPathForCache(sourcePath),
    sourceSignature,
    normalizeLocalPathForCache(uploadedFile.absolutePath),
    `size:${uploadedFile.size}`,
    `mtime:${Math.round(uploadedFile.mtimeMs)}`
  ].join('|');
}

function parseJsonToolResult(result: CallToolResult): Record<string, unknown> | undefined {
  const text = result.content.find((item) => item.type === 'text');
  if (!text || text.type !== 'text') return undefined;

  try {
    const parsed = JSON.parse(text.text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function isAuthFailurePayload(payload: Record<string, unknown> | undefined): boolean {
  if (!payload) return false;
  const code = String(payload.code || '').toUpperCase();
  const status = Number(payload.status);
  const message = String(payload.message || payload.error || '').toUpperCase();

  return (
    code === 'AUTH_TOKEN_INVALID' ||
    code === 'PERMISSION_DENIED' ||
    status === 401 ||
    status === 403 ||
    message.includes('AUTH_TOKEN_INVALID') ||
    message.includes('PERMISSION_DENIED') ||
    message.includes('401') ||
    message.includes('403')
  );
}

function isAuthFailureError(error: unknown): boolean {
  const record = error && typeof error === 'object' ? (error as Record<string, unknown>) : undefined;
  const code = String(record?.code || '').toUpperCase();
  const status = Number(record?.status);
  const message = error instanceof Error ? error.message.toUpperCase() : String(error).toUpperCase();

  return (
    code === 'AUTH_TOKEN_INVALID' ||
    code === 'PERMISSION_DENIED' ||
    status === 401 ||
    status === 403 ||
    message.includes('AUTH_TOKEN_INVALID') ||
    message.includes('PERMISSION_DENIED') ||
    message.includes('401') ||
    message.includes('403')
  );
}

class ProductTokenBridge {
  private chromeClient?: Client;
  private cachedToken?: CachedBrowserToken;
  private chromeDevtoolsMcpPreflight?: Promise<void>;
  private readonly uploadCache = new Map<string, CachedOssUpload>();

  constructor(private readonly config: BridgeConfig) {}

  async close(): Promise<void> {
    await this.chromeClient?.close();
  }

  invalidateTokenCache(): void {
    this.cachedToken = undefined;
  }

  async getBrowserToken(options: { forceRefresh?: boolean } = {}): Promise<BrowserToken> {
    if (!options.forceRefresh && this.cachedToken && this.cachedToken.expiresAtMs > Date.now()) {
      return getTokenCacheMetadata(this.cachedToken, true);
    }

    const chromeConfig = this.config.chromeMcp || DEFAULT_CHROME_MCP;
    await this.ensureChromeDevtoolsMcp(chromeConfig);

    let chrome: Client;
    let pagesResult: Awaited<ReturnType<Client['callTool']>>;
    try {
      chrome = await this.getChromeClient();
      pagesResult = await chrome.callTool({ name: 'list_pages', arguments: {} });
    } catch (error) {
      if (isPotentialChromeRemoteDebuggingError(error)) {
        throw new ChromeRemoteDebuggingNotAllowedError(
          `Chrome DevTools MCP is installed but could not connect to Chrome. Please make sure Chrome is open and allows remote debugging for this browser instance. Original error: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      throw error;
    }
    const pagesText = this.getSingleText(pagesResult);
    const pages = parsePages(pagesText);

    let page = pages.find((candidate) => isMatchingProjectPage(this.config, candidate.url));

    if (!page) {
      const newPage = await chrome.callTool({
        name: 'new_page',
        arguments: {
          url: this.config.projectUrl,
          timeout: 30000
        }
      });
      const newPageText = this.getSingleText(newPage);
      const refreshed = parsePages(newPageText);
      page = refreshed.find((candidate) => isMatchingProjectPage(this.config, candidate.url));
    }

    if (!page) {
      throw new Error(`No Chrome tab matched configured project URL: ${this.config.projectUrl}`);
    }

    await chrome.callTool({
      name: 'select_page',
      arguments: {
        pageId: page.id,
        bringToFront: false
      }
    });

    const tokenResult = await chrome.callTool({
      name: 'evaluate_script',
      arguments: {
        function: `() => {
          const key = ${JSON.stringify(this.config.tokenStorageKey)};
          const token = window.localStorage.getItem(key);
          return {
            href: location.href,
            origin: location.origin,
            hasToken: Boolean(token),
            token
          };
        }`
      }
    });
    const tokenPayload = extractJsonFromChromeText(this.getSingleText(tokenResult)) as {
      href?: string;
      origin?: string;
      hasToken?: boolean;
      token?: string;
    };

    if (!tokenPayload.hasToken || !tokenPayload.token) {
      throw new Error(
        `Chrome tab ${tokenPayload.href || page.url} does not contain localStorage.${this.config.tokenStorageKey}. Please login in Chrome first.`
      );
    }

    const now = Date.now();
    this.cachedToken = {
      token: tokenPayload.token,
      pageUrl: tokenPayload.href || page.url,
      origin: tokenPayload.origin || new URL(page.url).origin,
      fetchedAtMs: now,
      expiresAtMs: now + TOKEN_CACHE_TTL_MS
    };

    return getTokenCacheMetadata(this.cachedToken, false);
  }

  async callRemoteTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    let firstResult: CallToolResult;

    try {
      firstResult = await this.callRemoteToolOnce(name, args, false);
    } catch (error) {
      if (!isAuthFailureError(error)) throw error;
      this.invalidateTokenCache();
      return await this.callRemoteToolOnce(name, args, true);
    }

    const firstPayload = parseJsonToolResult(firstResult);

    if (!isAuthFailurePayload(firstPayload)) {
      return firstResult;
    }

    this.invalidateTokenCache();
    const secondResult = await this.callRemoteToolOnce(name, args, true);
    return secondResult;
  }

  private async callRemoteToolOnce(name: string, args: Record<string, unknown>, forceRefreshToken: boolean): Promise<CallToolResult> {
    const browserToken = await this.getBrowserToken({ forceRefresh: forceRefreshToken });
    const transport = new StreamableHTTPClientTransport(new URL(this.config.remoteMcpUrl), {
      requestInit: {
        headers: {
          Authorization: asBearer(browserToken.token),
          'Content-Language': this.config.language || 'zh_CN'
        }
      }
    });
    const client = new Client({ name: 'product-token-bridge-remote-client', version: '0.1.0' });

    try {
      await client.connect(transport);
      try {
        const result = await client.callTool({
          name,
          arguments: args
        });
        return normalizeCallToolResult(result);
      } catch (error) {
        if (!forceRefreshToken && isAuthFailureError(error)) {
          this.invalidateTokenCache();
          return await this.callRemoteToolOnce(name, args, true);
        }
        throw error;
      }
    } finally {
      await client.close();
    }
  }

  async uploadLocalFile(input: unknown) {
    const parsedInput = productUploadFileObjectSchema.parse(input);
    const policy = getUploadPolicy(parsedInput.usage);
    const sourceFile = await getLocalFileInfo(parsedInput.localPath);
    const prepared = await prepareImageForUpload(sourceFile, policy);
    const file = prepared.file;
    const imageSize = await validateLocalFile(file, policy);
    const cacheKey = await buildUploadCacheKey(parsedInput, sourceFile, file);
    const sourceLocalPath = parsedInput.sourceLocalPath ? path.resolve(parsedInput.sourceLocalPath) : sourceFile.absolutePath;
    let cachedUpload = this.uploadCache.get(cacheKey);
    const reusedUpload = Boolean(cachedUpload);

    if (cachedUpload) {
      cachedUpload.reuseCount += 1;
    } else {
      const backendConfig = defaultUploadBackendConfig({
        backendBaseUrl: this.config.backendBaseUrl,
        clientId: this.config.clientId,
        language: this.config.language || 'zh_CN'
      });
      const sts = await this.getOssStsTokenWithCache(backendConfig);
      const upload = await uploadLocalFileToOss(sts, file, policy);
      cachedUpload = {
        url: upload.url,
        objectKey: upload.objectKey,
        cachedAtMs: Date.now(),
        reuseCount: 0
      };
      this.uploadCache.set(cacheKey, cachedUpload);
    }

    return {
      ok: true,
      url: cachedUpload.url,
      objectKey: cachedUpload.objectKey,
      fileName: file.fileName,
      ext: file.ext,
      size: file.size,
      sourceFileName: path.basename(sourceLocalPath),
      sourceLocalPath,
      sourceRelativePath: parsedInput.sourceRelativePath,
      uploadedLocalPath: file.absolutePath,
      usage: parsedInput.usage,
      label: policy.label,
      title: parsedInput.title,
      description: parsedInput.description,
      languageList: parsedInput.languageList,
      imageSize,
      imagePreparation: prepared.prepared
        ? {
            mode: prepared.mode,
            sourcePath: sourceFile.absolutePath,
            outputPath: prepared.outputPath,
            sourceSize: prepared.sourceSize,
            outputSize: prepared.outputSize,
            targetRatio: prepared.targetRatio,
            targetRatioText: prepared.targetRatioText
          }
        : {
            mode: 'none',
            sourceSize: prepared.sourceSize,
            targetRatio: prepared.targetRatio,
            targetRatioText: prepared.targetRatioText
          },
      suggestedMapping: getSuggestedMapping(policy),
      reusedUpload,
      dedupe: {
        enabled: true,
        cacheKey,
        sourceRelativePath: parsedInput.sourceRelativePath,
        firstUploadedAt: new Date(cachedUpload.cachedAtMs).toISOString(),
        reuseCount: cachedUpload.reuseCount,
        strategy: 'same dedupeKey/source path and same upload artifact variant'
      },
      limits: {
        allowedExtensions: policy.allowedExtensions,
        maxSizeMb: policy.maxSizeMb,
        maxCount: policy.maxCount,
        aspectRatioText: policy.aspectRatioText,
        requireMp4Codec: Boolean(policy.requireMp4Codec)
      },
      videoCodecChecked: false,
      videoCodecCheckNote: policy.requireMp4Codec ? '当前最小版本只校验视频扩展名和大小；后续可插入 ffprobe 做 H.264/AAC/比例强校验。' : undefined
    };
  }

  async precheckPackage(input: unknown) {
    return await precheckProductPackage(input);
  }

  private async getOssStsTokenWithCache(backendConfig: ReturnType<typeof defaultUploadBackendConfig>) {
    try {
      const browserToken = await this.getBrowserToken();
      return await getOssStsToken(backendConfig, asBearer(browserToken.token));
    } catch (error) {
      if (!isAuthFailureError(error)) throw error;
    }

    this.invalidateTokenCache();
    const refreshedToken = await this.getBrowserToken({ forceRefresh: true });
    return await getOssStsToken(backendConfig, asBearer(refreshedToken.token));
  }

  private async getChromeClient(): Promise<Client> {
    if (this.chromeClient) return this.chromeClient;

    const chromeConfig = this.config.chromeMcp || DEFAULT_CHROME_MCP;
    await this.ensureChromeDevtoolsMcp(chromeConfig);
    const transport = new StdioClientTransport({
      command: chromeConfig.command,
      args: chromeConfig.args,
      env: cleanEnv(process.env, chromeConfig.env || {})
    });
    const client = new Client({ name: 'product-token-bridge-chrome-client', version: '0.1.0' });
    await client.connect(transport);
    this.chromeClient = client;
    return client;
  }

  private async ensureChromeDevtoolsMcp(chromeConfig: NonNullable<BridgeConfig['chromeMcp']>): Promise<void> {
    if (!usesChromeDevtoolsMcpPackage(chromeConfig)) return;

    this.chromeDevtoolsMcpPreflight ??= Promise.resolve()
      .then(() => {
        const env = cleanEnv(process.env, chromeConfig.env || {});
        preinstallChromeDevtoolsMcp(env);
      })
      .catch((error) => {
        this.chromeDevtoolsMcpPreflight = undefined;
        throw error;
      });

    await this.chromeDevtoolsMcpPreflight;
  }

  private getSingleText(result: Awaited<ReturnType<Client['callTool']>>): string {
    const content = 'content' in result && Array.isArray(result.content) ? result.content : [];
    const text = content.find((item) => item.type === 'text');
    if (!text || text.type !== 'text') throw new Error('Chrome MCP returned no text content.');
    return text.text;
  }
}

async function main(): Promise<void> {
  const { configPath } = parseArgs();
  const config = loadConfig(configPath);
  const bridge = new ProductTokenBridge(config);
  const server = new McpServer({
    name: 'product-token-bridge',
    version: '0.1.0'
  });

  server.registerTool(
    'product_auth_status',
    {
      title: 'Product MCP auth status',
      description:
        'Report whether Admin-Token is available without exposing it. Uses the in-memory token cache for up to 2 hours unless forceRefresh=true.',
      inputSchema: productAuthStatusInputSchema
    },
    async (input) => {
      try {
        const forceRefresh = Boolean((input as { forceRefresh?: boolean } | undefined)?.forceRefresh);
        const token = await bridge.getBrowserToken({ forceRefresh });
        return textResult({
          ok: true,
          projectUrl: config.projectUrl,
          matchedPageUrl: token.pageUrl,
          origin: token.origin,
          tokenStorageKey: config.tokenStorageKey,
          tokenPresent: true,
          tokenLength: token.token.length,
          tokenSource: token.fromCache ? 'cache' : 'chrome',
          tokenCache: {
            enabled: true,
            maxTtlSeconds: TOKEN_CACHE_TTL_MS / 1000,
            fromCache: token.fromCache,
            fetchedAt: token.fetchedAt,
            expiresAt: token.expiresAt,
            expiresInSeconds: token.expiresInSeconds
          },
          remoteMcpUrl: config.remoteMcpUrl
        });
      } catch (error) {
        return textResult(bridgeErrorPayload(error, config, 'PRODUCT_AUTH_STATUS_FAILED'));
      }
    }
  );

  server.registerTool(
    'product_upload_file',
    {
      title: 'Upload product file',
      description:
        'Upload a local product-related file from the Codex user machine directly to OSS using the current Chrome Admin-Token and STS, then return the OSS URL. Use this for images, videos, PDFs, 3D files, and other local files instead of sending file bytes or base64 through the remote HTTP MCP. Preserve dedupeKey/sourceRelativePath/sourceLocalPath from product_precheck_package to reuse the first OSS URL for repeated files.',
      inputSchema: productUploadFileInputSchema
    },
    async (input) => {
      try {
        return textResult(await bridge.uploadLocalFile(input));
      } catch (error) {
        return textResult(bridgeErrorPayload(error, config, 'PRODUCT_UPLOAD_FILE_FAILED'));
      }
    }
  );

  server.registerTool(
    'product_precheck_package',
    {
      title: 'Precheck product package',
      description:
        'Read a local 商品资料.md package, parse product fields, validate referenced local files against upload policies, and return a draft create payload without uploading or creating a product.',
      inputSchema: productPrecheckPackageInputSchema
    },
    async (input) => {
      try {
        return textResult(await bridge.precheckPackage(input));
      } catch (error) {
        return textResult({
          ok: false,
          code: 'PRODUCT_PRECHECK_PACKAGE_FAILED',
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
  );

  server.registerTool(
    'product_list_categories',
    {
      title: 'List product categories',
      description:
        'Read Admin-Token from the configured Chrome project tab, then query product categories through the remote Product MCP.',
      inputSchema: productListCategoriesInputSchema
    },
    async (input) => {
      try {
        return await bridge.callRemoteTool('product_list_categories', input);
      } catch (error) {
        return textResult(bridgeErrorPayload(error, config, 'PRODUCT_TOKEN_BRIDGE_FAILED'));
      }
    }
  );

  server.registerTool(
    'product_create',
    {
      title: 'Create product',
      description:
        'Read Admin-Token from the configured Chrome project tab, then create a real product through the remote Product MCP. Use product_upload_file first for local files, and pass only returned OSS URLs plus business fields here; never pass local paths, file bytes, or large base64 payloads.',
      inputSchema: productCreateInputSchema
    },
    async (input) => {
      try {
        return await bridge.callRemoteTool('product_create', input);
      } catch (error) {
        return textResult(bridgeErrorPayload(error, config, 'PRODUCT_TOKEN_BRIDGE_FAILED'));
      }
    }
  );

  server.registerTool(
    'product_get_category_config',
    {
      title: 'Get product category config',
      description:
        'Read Admin-Token from the configured Chrome project tab, then query category units/configs through the remote Product MCP.',
      inputSchema: productGetCategoryConfigInputSchema
    },
    async (input) => {
      try {
        return await bridge.callRemoteTool('product_get_category_config', input);
      } catch (error) {
        return textResult(bridgeErrorPayload(error, config, 'PRODUCT_TOKEN_BRIDGE_FAILED'));
      }
    }
  );

  server.registerTool(
    'product_list_suppliers',
    {
      title: 'List suppliers',
      description:
        'Read Admin-Token from the configured Chrome project tab, then query supplier options through the remote Product MCP.',
      inputSchema: productListSuppliersInputSchema
    },
    async (input) => {
      try {
        return await bridge.callRemoteTool('product_list_suppliers', input);
      } catch (error) {
        return textResult(bridgeErrorPayload(error, config, 'PRODUCT_TOKEN_BRIDGE_FAILED'));
      }
    }
  );

  server.registerTool(
    'product_list_regions',
    {
      title: 'List product regions',
      description:
        'Read Admin-Token from the configured Chrome project tab, then query region options through the remote Product MCP.',
      inputSchema: productListRegionsInputSchema
    },
    async (input) => {
      try {
        return await bridge.callRemoteTool('product_list_regions', input);
      } catch (error) {
        return textResult(bridgeErrorPayload(error, config, 'PRODUCT_TOKEN_BRIDGE_FAILED'));
      }
    }
  );

  server.registerTool(
    'product_get_dict',
    {
      title: 'Get system dict',
      description:
        'Read Admin-Token from the configured Chrome project tab, then query system dictionary values through the remote Product MCP.',
      inputSchema: productGetDictInputSchema
    },
    async (input) => {
      try {
        return await bridge.callRemoteTool('product_get_dict', input);
      } catch (error) {
        return textResult(bridgeErrorPayload(error, config, 'PRODUCT_TOKEN_BRIDGE_FAILED'));
      }
    }
  );

  server.registerTool(
    'product_get_detail',
    {
      title: 'Get product detail',
      description:
        'Read Admin-Token from the configured Chrome project tab, then query product edit detail sections through the remote Product MCP.',
      inputSchema: productGetDetailInputSchema
    },
    async (input) => {
      try {
        return await bridge.callRemoteTool('product_get_detail', input);
      } catch (error) {
        return textResult(bridgeErrorPayload(error, config, 'PRODUCT_TOKEN_BRIDGE_FAILED'));
      }
    }
  );

  process.on('SIGINT', () => {
    bridge.close().finally(() => process.exit(0));
  });
  process.on('SIGTERM', () => {
    bridge.close().finally(() => process.exit(0));
  });

  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});

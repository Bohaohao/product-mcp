import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
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
  validateLocalFile
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
}

const DEFAULT_CHROME_MCP = {
  command: 'cmd',
  args: ['/c', 'npx', '-y', 'chrome-devtools-mcp@latest', '--autoConnect', '--channel=stable', '--no-usage-statistics'],
  env: {
    PROGRAMFILES: 'C:\\Program Files',
    SystemRoot: 'C:\\WINDOWS'
  }
};

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

function normalizeCallToolResult(result: Awaited<ReturnType<Client['callTool']>>): CallToolResult {
  if ('content' in result && Array.isArray(result.content)) {
    return result as CallToolResult;
  }

  return textResult({
    ok: true,
    result
  });
}

class ProductTokenBridge {
  private chromeClient?: Client;

  constructor(private readonly config: BridgeConfig) {}

  async close(): Promise<void> {
    await this.chromeClient?.close();
  }

  async getBrowserToken(): Promise<BrowserToken> {
    const chrome = await this.getChromeClient();
    const pagesResult = await chrome.callTool({ name: 'list_pages', arguments: {} });
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

    return {
      token: tokenPayload.token,
      pageUrl: tokenPayload.href || page.url,
      origin: tokenPayload.origin || new URL(page.url).origin
    };
  }

  async callRemoteTool(name: string, args: Record<string, unknown>) {
    const browserToken = await this.getBrowserToken();
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
      const result = await client.callTool({
        name,
        arguments: args
      });
      return normalizeCallToolResult(result);
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
    const browserToken = await this.getBrowserToken();
    const backendConfig = defaultUploadBackendConfig({
      backendBaseUrl: this.config.backendBaseUrl,
      clientId: this.config.clientId,
      language: this.config.language || 'zh_CN'
    });
    const sts = await getOssStsToken(backendConfig, asBearer(browserToken.token));
    const upload = await uploadLocalFileToOss(sts, file, policy);

    return {
      ok: true,
      url: upload.url,
      objectKey: upload.objectKey,
      fileName: file.fileName,
      ext: file.ext,
      size: file.size,
      sourceFileName: sourceFile.fileName,
      sourceLocalPath: sourceFile.absolutePath,
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

  private async getChromeClient(): Promise<Client> {
    if (this.chromeClient) return this.chromeClient;

    const chromeConfig = this.config.chromeMcp || DEFAULT_CHROME_MCP;
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
      description: 'Read the configured project tab in Chrome and report whether Admin-Token is available without exposing it.',
      inputSchema: {}
    },
    async () => {
      try {
        const token = await bridge.getBrowserToken();
        return textResult({
          ok: true,
          projectUrl: config.projectUrl,
          matchedPageUrl: token.pageUrl,
          origin: token.origin,
          tokenStorageKey: config.tokenStorageKey,
          tokenPresent: true,
          tokenLength: token.token.length,
          remoteMcpUrl: config.remoteMcpUrl
        });
      } catch (error) {
        return textResult({
          ok: false,
          message: error instanceof Error ? error.message : String(error),
          projectUrl: config.projectUrl,
          tokenStorageKey: config.tokenStorageKey,
          remoteMcpUrl: config.remoteMcpUrl
        });
      }
    }
  );

  server.registerTool(
    'product_upload_file',
    {
      title: 'Upload product file',
      description:
        'Upload a local product-related file from the Codex user machine to OSS using the current Chrome Admin-Token, then return the OSS URL.',
      inputSchema: productUploadFileInputSchema
    },
    async (input) => {
      try {
        return textResult(await bridge.uploadLocalFile(input));
      } catch (error) {
        return textResult({
          ok: false,
          code: 'PRODUCT_UPLOAD_FILE_FAILED',
          message: error instanceof Error ? error.message : String(error)
        });
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
        return textResult({
          ok: false,
          code: 'PRODUCT_TOKEN_BRIDGE_FAILED',
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
  );

  server.registerTool(
    'product_create',
    {
      title: 'Create product',
      description:
        'Read Admin-Token from the configured Chrome project tab, then create a real product through the remote Product MCP. Use product_upload_file first for local files.',
      inputSchema: productCreateInputSchema
    },
    async (input) => {
      try {
        return await bridge.callRemoteTool('product_create', input);
      } catch (error) {
        return textResult({
          ok: false,
          code: 'PRODUCT_TOKEN_BRIDGE_FAILED',
          message: error instanceof Error ? error.message : String(error)
        });
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
        return textResult({
          ok: false,
          code: 'PRODUCT_TOKEN_BRIDGE_FAILED',
          message: error instanceof Error ? error.message : String(error)
        });
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
        return textResult({
          ok: false,
          code: 'PRODUCT_TOKEN_BRIDGE_FAILED',
          message: error instanceof Error ? error.message : String(error)
        });
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
        return textResult({
          ok: false,
          code: 'PRODUCT_TOKEN_BRIDGE_FAILED',
          message: error instanceof Error ? error.message : String(error)
        });
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
        return textResult({
          ok: false,
          code: 'PRODUCT_TOKEN_BRIDGE_FAILED',
          message: error instanceof Error ? error.message : String(error)
        });
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
        return textResult({
          ok: false,
          code: 'PRODUCT_TOKEN_BRIDGE_FAILED',
          message: error instanceof Error ? error.message : String(error)
        });
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

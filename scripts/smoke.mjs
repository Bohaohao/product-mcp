import { createServer } from 'node:http';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { parsePages } from '../dist/chromePages.js';
import { ProductTokenBridge } from '../dist/localBridge.js';
import { ProductMcpError } from '../dist/errors.js';
import { createProductMcpExpressApp } from '../dist/server.js';
import { ProductTokenDaemonClient } from '../dist/tokenDaemonClient.js';
import { productCreate } from '../dist/tools/createProduct.js';

const fakeBackendPort = Number(process.env.SMOKE_BACKEND_PORT || 18787);
const mcpPort = Number(process.env.SMOKE_MCP_PORT || 18788);
const authorization = 'Bearer smoke-token';

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
  let rawBody = '';
  for await (const chunk of req) {
    rawBody += chunk;
  }
  return rawBody ? JSON.parse(rawBody) : {};
}

function createFakeBackend() {
  return createServer((req, res) => {
    if (req.headers.authorization !== authorization) {
      sendJson(res, 401, { code: 401, msg: 'invalid token' });
      return;
    }

    if (req.method === 'GET' && req.url === '/api/user/erp/productCategory/tree') {
      sendJson(res, 200, {
        code: 200,
        data: [
          {
            id: 1,
            parentId: 0,
            categoryName: '工程机械',
            i18nName: 'Construction Machinery',
            status: '0',
            children: [
              {
                id: 11,
                parentId: 1,
                categoryName: '挖掘机配件',
                i18nName: 'Excavator Parts',
                status: '0'
              },
              {
                id: 12,
                parentId: 1,
                categoryName: '停用分类',
                status: '1'
              }
            ]
          }
        ]
      });
      return;
    }

    if (req.method === 'GET' && req.url?.startsWith('/api/user/erp/productCategory/configList')) {
      const url = new URL(req.url, 'http://127.0.0.1');
      assert(url.searchParams.get('categoryId') === '11', 'category config query was not forwarded');
      sendJson(res, 200, {
        code: 200,
        data: {
          unitList: [
            { id: '9001', unitName: 'piece', categoryId: '11', status: 0 },
            { id: '9002', unitName: 'disabled unit', categoryId: '11', status: 1 }
          ],
          baseList: [{ id: '8001', name: 'Power', defaultValue: '100W', status: 0 }],
          fieldList: [{ id: '7001', name: 'Length', defaultValue: '10cm', status: 0 }],
          optionalList: [
            {
              id: '6001',
              name: 'Color',
              status: 0,
              items: [
                { id: '600101', name: 'Red', price: '1.00', status: 0 },
                { id: '600102', configValue: 'Blue', status: 1 }
              ]
            }
          ]
        }
      });
      return;
    }

    if (req.method === 'GET' && req.url === '/api/user/erp/supplier/classification/tree') {
      sendJson(res, 200, {
        code: 200,
        data: [
          {
            id: 'class-1',
            classificationName: 'Machinery',
            status: 0,
            supplierList: [{ id: '88', name: 'Smoke Supplier', code: 'SUP-88', rating: 'A', mainItem: 'Parts' }],
            children: [
              {
                id: 'class-2',
                classificationName: 'Disabled',
                status: 1,
                supplierList: [{ id: '99', name: 'Hidden Supplier' }]
              }
            ]
          }
        ]
      });
      return;
    }

    if (req.method === 'GET' && req.url?.startsWith('/api/user/regionalOrganizations/continents')) {
      sendJson(res, 200, {
        code: 200,
        data: [
          { id: 'region-1', nameZh: 'China', nameEn: 'China', orgCode: 'CN', continentDictValue: 'ALL' },
          { id: 'region-2', nameZh: 'Europe', nameEn: 'Europe', orgCode: 'EU', continentDictValue: 'ALL' }
        ]
      });
      return;
    }

    if (req.method === 'GET' && req.url === '/api/user/system/dict/data/type/erp_customer_type') {
      sendJson(res, 200, {
        code: 200,
        data: [
          { dictCode: '1', dictLabel: 'Dealer', dictValue: '1', dictType: 'erp_customer_type', dictSort: 1 },
          { dictCode: '2', dictLabel: 'Project Customer', dictValue: '3', dictType: 'erp_customer_type', dictSort: 2 }
        ]
      });
      return;
    }

    if (req.method === 'POST' && req.url?.startsWith('/api/user/erp/commodity/list')) {
      const url = new URL(req.url, 'http://127.0.0.1');
      let rawBody = '';
      req.on('data', (chunk) => {
        rawBody += chunk;
      });
      req.on('end', () => {
        const body = JSON.parse(rawBody || '{}');
        assert(url.searchParams.get('pageNum') === '1', 'duplicate check pageNum query was not forwarded');
        assert(url.searchParams.get('pageSize') === '20', 'duplicate check pageSize query was not forwarded');
        assert(body.keyword === 'SmokeTestProduct', 'duplicate check keyword was not normalized');
        sendJson(res, 200, {
          code: 200,
          data: {
            rows: [
              {
                id: 'candidate-compact-only',
                productNameCn: 'SmokeTestProduct',
                productNameEn: 'Compact Candidate',
                productCode: 'SMOKE-COMPACT'
              },
              {
                id: 'dup-1',
                productNameCn: 'Smoke Test Product',
                productNameEn: 'Smoke Test Product EN',
                productCode: 'SMOKE-001',
                categoryFirstName: 'Machinery',
                categorySecondName: 'Parts',
                unitName: 'piece'
              }
            ],
            total: 1
          }
        });
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/user/erp/commodity') {
      let rawBody = '';
      req.on('data', (chunk) => {
        rawBody += chunk;
      });
      req.on('end', () => {
        const body = JSON.parse(rawBody || '{}');
        assert(body.productNameCn === 'Smoke Test Product', 'productNameCn was not forwarded');
        assert(body.productNameEn === 'Smoke Test Product EN', 'productNameEn was not forwarded');
        assert(body.categoryFirstId === 1, 'categoryFirstId was not normalized');
        assert(body.unitId === 9, 'unitId was not normalized');
        assert(body.suppliers?.[0]?.supplierId === 88, 'supplier was not mapped');
        assert(body.suppliers?.[0]?.productionCycle === 7, 'supplier productionCycle was not normalized');
        assert(body.suppliers?.[0]?.cycleUnit === 1, 'supplier cycleUnit was not normalized');
        assert(body.regions?.[0]?.isAll === 1, 'global region was not mapped');
        assert(body.tenantId === 'tenant-smoke', 'tenantId was not forwarded');
        assert(body.relatedCommodityId === '456,789', 'relatedCommodityId was not forwarded');
        assert(body.spuNameEn === 'Smoke Test Product EN', 'spuNameEn compatibility field was not forwarded');
        assert(body.i18nList?.[1]?.spuName === 'Smoke Test Product EN', 'product i18nList was not created');
        assert(body.baseConfigs?.[0]?.categoryBaseId === '8001', 'base config was not resolved');
        assert(body.technicalParams?.[0]?.categoryBaseId === '7001', 'technical param was not resolved');
        assert(body.optionalConfigs?.[0]?.categoryOptionalId === '6001', 'optional config was not resolved');
        assert(body.optionalConfigs?.[0]?.categoryOptionalConfigId === '600101', 'optional config option was not resolved');
        assert(body.optionalConfigs?.[0]?.configValue === 'Red', 'optional config value was not normalized');
        assert(body.medias?.[0]?.imageCategory === 1, 'main image media was not created');
        assert(body.medias?.[0]?.mediaUrl === 'https://example.test/main.png', 'main image url was not mapped');
        assert(body.medias?.[1]?.imageCategory === 8, 'banner media was not forwarded');
        assert(body.medias?.[2]?.language === 'cn', 'media language was not preserved');
        assert(body.medias?.[2]?.mediaId === 'media-zh-1', 'mediaId was not preserved');
        assert(body.palletInfo === 'Smoke pallet', 'package text field was not preserved');
        assert(body.packLength === 101, 'top-level packLength should override packageInfo');
        assert(body.bulkCarrier === 3, 'top-level bulkCarrier was not forwarded');
        assert(body.packingListTemplate === 'Smoke template', 'top-level packingListTemplate was not forwarded');

        sendJson(res, 200, {
          code: 200,
          data: {
            id: 123456
          }
        });
      });
      return;
    }

    if (req.method === 'GET' && req.url === '/api/user/erp/commodity/base/123456') {
      sendJson(res, 200, {
        code: 200,
        data: {
          id: '123456',
          productNameCn: 'Smoke Test Product',
          productNameEn: 'Smoke Test Product EN'
        }
      });
      return;
    }

    for (const path of [
      '/api/user/erp/commodity/medias/123456',
      '/api/user/erp/commodity/sales/123456',
      '/api/user/erp/commodity/parts/123456',
      '/api/user/erp/commodity/certifications/123456'
    ]) {
      if (req.method === 'GET' && req.url === path) {
        sendJson(res, 200, { code: 200, data: [] });
        return;
      }
    }

    sendJson(res, 404, { code: 404, msg: 'not found' });
  });
}

function createFakeTokenDaemon(secret) {
  const stats = {
    statusCalls: 0,
    tokenCalls: 0,
    invalidateCalls: 0,
    lastTokenForceRefresh: undefined
  };
  const now = new Date();
  const tokenPayload = {
    ok: true,
    token: 'smoke-token',
    pageUrl: 'https://test.eysscm.com/erp/commodity/commodity',
    origin: 'https://test.eysscm.com',
    fetchedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString(),
    expiresInSeconds: 7200,
    fromCache: false
  };

  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${secret}`) {
      sendJson(res, 401, {
        ok: false,
        code: 'TOKEN_DAEMON_AUTH_FAILED',
        message: 'bad secret'
      });
      return;
    }

    if (req.method === 'GET' && req.url === '/healthz') {
      sendJson(res, 200, {
        ok: true,
        name: 'fake-product-token-bridge-daemon'
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/auth/status') {
      await readJsonBody(req);
      stats.statusCalls += 1;
      sendJson(res, 200, {
        ok: true,
        tokenPresent: true,
        tokenProvider: 'token_bridge_daemon',
        matchedPageUrl: tokenPayload.pageUrl,
        origin: tokenPayload.origin,
        tokenStorageKey: 'Admin-Token',
        tokenCache: {
          enabled: true,
          fromCache: false,
          expiresInSeconds: 7200
        }
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/auth/token') {
      const body = await readJsonBody(req);
      stats.tokenCalls += 1;
      stats.lastTokenForceRefresh = Boolean(body.forceRefresh);
      sendJson(res, 200, tokenPayload);
      return;
    }

    if (req.method === 'POST' && req.url === '/auth/invalidate') {
      await readJsonBody(req);
      stats.invalidateCalls += 1;
      sendJson(res, 200, {
        ok: true,
        invalidated: true
      });
      return;
    }

    sendJson(res, 404, {
      ok: false,
      code: 'not_found'
    });
  });

  return { server, stats };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function createValidationBackendStub() {
  return {
    async get(path) {
      if (path === '/user/erp/productCategory/tree') {
        return [
          {
            id: 1,
            status: '0',
            children: [{ id: 11, status: '0', children: [] }]
          }
        ];
      }
      if (path === '/user/erp/productCategory/configList') {
        return {
          baseList: [],
          fieldList: [],
          optionalList: []
        };
      }
      throw new Error(`Unexpected GET path in validation stub: ${path}`);
    },
    async post() {
      throw new Error('Validation stub should not reach backend POST.');
    }
  };
}

async function assertCreateValidationFailure(argumentsPayload, expectedIssueCode) {
  try {
    await productCreate(createValidationBackendStub(), argumentsPayload, 'smoke-validation');
    throw new Error(`Expected productCreate to fail with ${expectedIssueCode}.`);
  } catch (error) {
    assert(error instanceof ProductMcpError, 'validation error was not mapped to ProductMcpError');
    assert(error.code === 'MCP_INPUT_INVALID', `unexpected validation error code: ${error.code}`);
    const issues = error.details?.issues || [];
    assert(Array.isArray(issues), 'validation error details did not include issues');
    assert(
      issues.some((issue) => issue.code === expectedIssueCode),
      `expected validation issue ${expectedIssueCode}, got ${JSON.stringify(issues)}`
    );
  }
}

async function assertCreateSchemaFailure(argumentsPayload, expectedPath) {
  try {
    await productCreate(createValidationBackendStub(), argumentsPayload, 'smoke-schema-validation');
    throw new Error(`Expected productCreate schema validation to fail for ${expectedPath}.`);
  } catch (error) {
    const issues = error?.issues || [];
    assert(Array.isArray(issues), 'schema validation error did not include zod issues');
    assert(
      issues.some((issue) => issue.path?.join('.') === expectedPath),
      `expected schema issue at ${expectedPath}, got ${JSON.stringify(issues)}`
    );
  }
}

const dtoRequiredFlags = {
  supportConsolidation: 0,
  canExhibit: 0,
  needInstallation: 0,
  hasAfterSalesThreshold: 0,
  supportSample: 0,
  supportPartsAlone: 0,
  supportOem: 0,
  supportOdm: 0,
  supportSmallTrial: 0,
  hasSpotStock: 0,
  hasOverseasWarehouseStock: 0
};

function createMinimalDtoInput(overrides = {}) {
  return {
    confirm: true,
    productNameCn: 'Smoke Test Product',
    productType: 3,
    status: 1,
    categoryFirstId: '1',
    categorySecondId: '11',
    unitId: '9',
    suppliers: [{ supplierId: '88', supplierName: 'Smoke Supplier' }],
    useAllRegions: true,
    productMainImageUrl: 'https://example.test/main.png',
    ...dtoRequiredFlags,
    ...overrides
  };
}

function createSuccessBackendStub(assertBody) {
  return {
    async get(path) {
      if (path === '/user/erp/productCategory/tree') {
        return [
          {
            id: 1,
            status: '0',
            children: [{ id: 11, status: '0', children: [] }]
          }
        ];
      }
      if (path === '/user/erp/productCategory/configList') {
        return {
          baseList: [],
          fieldList: [],
          optionalList: []
        };
      }
      throw new Error(`Unexpected GET path in success stub: ${path}`);
    },
    async post(path, body) {
      assert(path === '/user/erp/commodity', `unexpected POST path in success stub: ${path}`);
      assertBody(body);
      return { id: 999001 };
    }
  };
}

async function assertCreateSucceedsWithoutEnglishName() {
  const result = await productCreate(
    createSuccessBackendStub((body) => {
      assert(body.productNameCn === 'Smoke Test Product', 'productNameCn was not forwarded');
      assert(body.productNameEn === undefined, 'productNameEn should stay optional');
      assert(body.spuNameEn === undefined, 'spuNameEn compatibility field should stay optional');
      assert(Array.isArray(body.i18nList) && body.i18nList.length === 1, 'i18nList should only include zh when english name is missing');
      assert(body.i18nList?.[0]?.langCode === 'zh', 'zh i18n row was not preserved');
      assert(body.productType === 3, 'productType was not forwarded');
      assert(body.status === 1, 'status was not forwarded');
      assert(body.unitId === 9, 'unitId was not normalized');
      assert(body.suppliers?.[0]?.supplierId === 88, 'supplier was not normalized');
      assert(body.categoryFirstId === 1, 'categoryFirstId was not normalized');
      assert(body.categorySecondId === 11, 'categorySecondId was not normalized');
      assert(body.regions?.[0]?.isAll === 1, 'global region was not mapped');
      assert(body.packLength === undefined, 'service product should not require package fields');
      assert(body.medias?.[0]?.imageCategory === 1, 'main image media was not created');
      assert(body.supportConsolidation === 0, 'supportConsolidation was not forwarded');
      assert(body.hasOverseasWarehouseStock === 0, 'hasOverseasWarehouseStock was not forwarded');
    }),
    createMinimalDtoInput(),
    'smoke-success-no-en'
  );

  assert(result.ok === true, 'productCreate should succeed without english name');
  assert(result.id === '999001', 'productCreate should return stubbed id');
}

async function assertTokenDaemonClientAndBridge() {
  const secret = 'smoke-secret';
  const { server, stats } = createFakeTokenDaemon(secret);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;
  const previousUrl = process.env.PRODUCT_TOKEN_DAEMON_URL;
  const previousSecret = process.env.PRODUCT_TOKEN_DAEMON_SECRET;

  try {
    const client = new ProductTokenDaemonClient({ url, secret });
    const health = await client.healthz();
    assert(health.ok === true, 'daemon healthz failed');

    const status = await client.authStatus();
    assert(status.ok === true, 'daemon auth status failed');
    assert(!JSON.stringify(status).includes('smoke-token'), 'daemon auth status leaked token');

    const token = await client.getToken({ forceRefresh: true });
    assert(token.token === 'smoke-token', 'daemon token response was not returned to local client');
    assert(stats.lastTokenForceRefresh === true, 'daemon token forceRefresh was not forwarded');

    await client.invalidate();
    assert(stats.invalidateCalls === 1, 'daemon invalidate was not called');

    process.env.PRODUCT_TOKEN_DAEMON_URL = url;
    process.env.PRODUCT_TOKEN_DAEMON_SECRET = secret;
    const bridge = new ProductTokenBridge({
      projectUrl: 'https://test.eysscm.com/erp/commodity/commodity',
      matchUrlPrefixes: ['https://test.eysscm.com/erp/commodity'],
      tokenStorageKey: 'Admin-Token',
      backendBaseUrl: 'http://127.0.0.1:1/api',
      clientId: 'e5cd7e4891bf95d1d19206ce24a7b32e',
      language: 'zh_CN'
    });

    const bridgeStatus = await bridge.getAuthStatus();
    assert(bridgeStatus.tokenProvider === 'token_bridge_daemon', 'bridge auth status did not use daemon');
    assert(!JSON.stringify(bridgeStatus).includes('smoke-token'), 'bridge auth status leaked token');

    const bridgeToken = await bridge.getBrowserToken({ forceRefresh: true });
    assert(bridgeToken.token === 'smoke-token', 'bridge did not fetch token from daemon');
    assert(stats.statusCalls >= 2, 'bridge did not call daemon auth status');
    assert(stats.tokenCalls >= 2, 'bridge did not call daemon token endpoint');
    await bridge.close();
  } finally {
    if (previousUrl === undefined) delete process.env.PRODUCT_TOKEN_DAEMON_URL;
    else process.env.PRODUCT_TOKEN_DAEMON_URL = previousUrl;
    if (previousSecret === undefined) delete process.env.PRODUCT_TOKEN_DAEMON_SECRET;
    else process.env.PRODUCT_TOKEN_DAEMON_SECRET = previousSecret;
    await closeServer(server);
  }
}

function assertChromePageParsing() {
  const oldFormat = parsePages('0: https://test.eysscm.com/erp/commodity/commodity [selected]');
  assert(oldFormat[0]?.url === 'https://test.eysscm.com/erp/commodity/commodity', 'old Chrome page format parsing failed');
  assert(oldFormat[0]?.selected === true, 'old Chrome page selected flag parsing failed');

  const newFormat = parsePages('1: ERP 商品管理 (https://test.eysscm.com/erp/commodity/commodity)');
  assert(newFormat[0]?.url === 'https://test.eysscm.com/erp/commodity/commodity', 'title plus URL Chrome page format parsing failed');

  const newSelectedFormat = parsePages('2: ERP 商品管理 (https://test.eysscm.com/erp/commodity/commodity) [selected]');
  assert(newSelectedFormat[0]?.url === 'https://test.eysscm.com/erp/commodity/commodity', 'selected title plus URL parsing failed');
  assert(newSelectedFormat[0]?.selected === true, 'selected title plus URL flag parsing failed');

  const indentedFormat = parsePages('  - 3: 易运盈链界 (https://test.eysscm.com/erp/commodity/commodity) [selected]');
  assert(indentedFormat[0]?.url === 'https://test.eysscm.com/erp/commodity/commodity', 'indented bullet Chrome page parsing failed');
  assert(indentedFormat[0]?.selected === true, 'indented bullet selected flag parsing failed');
}

async function main() {
  assertChromePageParsing();
  await assertTokenDaemonClientAndBridge();
  await assertCreateSucceedsWithoutEnglishName();

  const modelAliasResult = await productCreate(
    createSuccessBackendStub((body) => {
      assert(body.productModel === 'ABC 123', 'spuModel alias should normalize to productModel');
    }),
    createMinimalDtoInput({ spuModel: 'ABC 123' }),
    'smoke-success-model-alias'
  );
  assert(modelAliasResult.ok === true, 'productCreate should accept valid spuModel alias');

  await assertCreateValidationFailure(
    createMinimalDtoInput({ productModel: '中文-Model' }),
    'PRODUCT_MODEL_FORMAT_INVALID'
  );

  await assertCreateSchemaFailure(
    (() => {
      const payload = createMinimalDtoInput();
      delete payload.supportOem;
      return payload;
    })(),
    'supportOem'
  );

  await assertCreateValidationFailure(
    createMinimalDtoInput({
      medias: [{ mediaType: 1, imageCategory: 1, mediaUrl: '{{OSS_BINDING:product-main-image-1}}' }]
    }),
    'UNRESOLVED_UPLOAD_BINDING'
  );
  await assertCreateValidationFailure(
    createMinimalDtoInput({
      independentPkg: 1,
      skuList: [{ skuCode: 'SKU-1', pkgLength: 100, pkgWidth: 100, pkgHeight: 100, grossWeight: 2, pkgWeight: 1 }],
      medias: [{ mediaType: 1, imageCategory: 8, mediaUrl: 'https://example.test/banner.png' }]
    }),
    'SKU_PACKAGE_FEE_REQUIRED'
  );
  await assertCreateValidationFailure(
    createMinimalDtoInput({ categoryFirstId: undefined, categorySecondId: undefined }),
    'CATEGORY_FIRST_REQUIRED'
  );
  await assertCreateValidationFailure(
    createMinimalDtoInput({ useAllRegions: false, regions: [] }),
    'REGION_REQUIRED'
  );
  await assertCreateValidationFailure(
    createMinimalDtoInput({ productMainImageUrl: undefined }),
    'PRODUCT_MAIN_IMAGE_REQUIRED'
  );
  await assertCreateValidationFailure(
    createMinimalDtoInput({ productType: 2 }),
    'PACKAGE_LENGTH_REQUIRED'
  );
  await assertCreateValidationFailure(
    createMinimalDtoInput({
      productType: 1,
      packageInfo: {
        packLength: 100,
        packWidth: 100,
        packHeight: 100,
        packingFee: 1,
        packWeight: 2,
        netWeight: 1
      }
    }),
    'PRODUCT_LEVEL_REQUIRED'
  );

  const fakeBackend = createFakeBackend();
  fakeBackend.listen(fakeBackendPort, '127.0.0.1');
  await once(fakeBackend, 'listening');

  const mcpApp = createProductMcpExpressApp({
    port: mcpPort,
    host: '127.0.0.1',
    path: '/mcp',
    backendBaseUrl: `http://127.0.0.1:${fakeBackendPort}/api`,
    clientId: 'e5cd7e4891bf95d1d19206ce24a7b32e',
    requestTimeoutMs: 5000,
    defaultLanguage: 'zh_CN'
  });
  const mcpServer = mcpApp.listen(mcpPort, '127.0.0.1');
  await once(mcpServer, 'listening');

  try {
    const health = await fetch(`http://127.0.0.1:${mcpPort}/healthz`);
    assert(health.ok, `healthz failed: ${health.status}`);

    const missingAuth = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list'
      })
    });
    assert(missingAuth.status === 401, `missing auth should be 401, got ${missingAuth.status}`);

    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcpPort}/mcp`), {
      requestInit: {
        headers: {
          Authorization: authorization,
          'Content-Language': 'zh_CN'
        }
      }
    });
    const client = new Client({ name: 'product-mcp-smoke', version: '0.1.0' });

    await client.connect(transport);
    const tools = await client.listTools();
    assert(
      tools.tools.some((tool) => tool.name === 'product_list_categories'),
      'product_list_categories was not listed'
    );
    assert(
      tools.tools.some((tool) => tool.name === 'product_create'),
      'product_create was not listed'
    );
    for (const toolName of [
      'product_check_name_duplicate',
      'product_get_category_config',
      'product_list_suppliers',
      'product_list_regions',
      'product_get_dict'
    ]) {
      assert(tools.tools.some((tool) => tool.name === toolName), `${toolName} was not listed`);
    }

    const result = await client.callTool({
      name: 'product_list_categories',
      arguments: {
        keyword: '挖掘机',
        enabledOnly: true
      }
    });

    const textContent = result.content?.find((item) => item.type === 'text');
    assert(textContent?.type === 'text', 'tool result did not contain text content');

    const payload = JSON.parse(textContent.text);
    assert(payload.ok === true, 'tool result was not ok');
    assert(payload.categories?.[0]?.children?.[0]?.id === '11', 'category filtering result was unexpected');

    const duplicateResult = await client.callTool({
      name: 'product_check_name_duplicate',
      arguments: {
        productNameCn: 'Smoke Test Product'
      }
    });
    const duplicateText = duplicateResult.content?.find((item) => item.type === 'text');
    assert(duplicateText?.type === 'text', 'duplicate check result did not contain text content');
    const duplicatePayload = JSON.parse(duplicateText.text);
    assert(duplicatePayload.ok === true, 'duplicate check result was not ok');
    assert(duplicatePayload.exists === true, 'duplicate check should find the existing product');
    assert(duplicatePayload.blocking === true, 'duplicate check should be blocking when a duplicate exists');
    assert(duplicatePayload.candidateCount === 2, 'duplicate check should keep all keyword candidates');
    assert(duplicatePayload.duplicateCount === 1, 'duplicate check should only count exact productNameCn matches');
    assert(duplicatePayload.duplicates?.[0]?.id === 'dup-1', 'duplicate check did not normalize duplicate id');

    const createResult = await client.callTool({
      name: 'product_create',
      arguments: {
        confirm: true,
        productNameCn: 'Smoke Test Product',
        productNameEn: 'Smoke Test Product EN',
        productType: 1,
        status: 1,
        level: 'A',
        tenantId: 'tenant-smoke',
        relatedCommodityId: '456,789',
        categoryFirstId: '1',
        categorySecondId: '11',
        unitId: '9',
        suppliers: [{ supplierId: '88', supplierName: 'Smoke Supplier', productionCycle: '7', cycleUnit: '1' }],
        ...dtoRequiredFlags,
        useAllRegions: true,
        productMainImageUrl: 'https://example.test/main.png',
        medias: [
          { mediaType: 1, imageCategory: 8, mediaUrl: 'https://example.test/banner.png' },
          { mediaType: 1, imageCategory: 2, mediaUrl: 'https://example.test/detail.png', language: 'cn', mediaId: 'media-zh-1' }
        ],
        baseConfigs: [{ name: 'Power', configValue: '100W' }],
        technicalParams: [{ name: 'Length', paramValue: '10cm' }],
        optionalConfigs: [{ name: 'Color', configValue: 'Red', status: 0 }],
        referenceCostCny: 100,
        profitMargin: 15,
        packLength: 101,
        bulkCarrier: '3',
        packingListTemplate: 'Smoke template',
        packageInfo: {
          packLength: 100,
          packWidth: 100,
          packHeight: 100,
          packCubic: '0.01',
          packingFee: 1,
          packWeight: 2,
          netWeight: 1,
          palletInfo: 'Smoke pallet'
        }
      }
    });
    const createTextContent = createResult.content?.find((item) => item.type === 'text');
    assert(createTextContent?.type === 'text', 'create tool result did not contain text content');
    const createPayload = JSON.parse(createTextContent.text);
    assert(createPayload.ok === true, 'create tool result was not ok');
    assert(createPayload.id === '123456', 'create tool did not extract product id');
    assert(createPayload.frontendEditPath === '/erp/commodity/editCommodity/123456', 'create edit path was unexpected');

    const categoryConfigResult = await client.callTool({
      name: 'product_get_category_config',
      arguments: { categoryId: '11' }
    });
    const categoryConfigText = categoryConfigResult.content?.find((item) => item.type === 'text');
    assert(categoryConfigText?.type === 'text', 'category config result did not contain text content');
    const categoryConfigPayload = JSON.parse(categoryConfigText.text);
    assert(categoryConfigPayload.units?.length === 1, 'category config did not filter disabled units');
    assert(categoryConfigPayload.units?.[0]?.id === '9001', 'category config unit normalization failed');
    assert(categoryConfigPayload.baseConfigs?.[0]?.name === 'Power', 'category config base normalization failed');
    assert(categoryConfigPayload.optionalConfigs?.[0]?.items?.[0]?.configValue === 'Red', 'category config option name normalization failed');

    const detailResult = await client.callTool({
      name: 'product_get_detail',
      arguments: {
        productId: '123456',
        includeSections: ['base', 'medias']
      }
    });
    const detailText = detailResult.content?.find((item) => item.type === 'text');
    assert(detailText?.type === 'text', 'detail result did not contain text content');
    const detailPayload = JSON.parse(detailText.text);
    assert(detailPayload.base?.productNameEn === 'Smoke Test Product EN', 'detail base was not returned');
    assert(Array.isArray(detailPayload.medias), 'detail medias was not returned');

    const supplierResult = await client.callTool({
      name: 'product_list_suppliers',
      arguments: { keyword: '88', includeTree: true }
    });
    const supplierText = supplierResult.content?.find((item) => item.type === 'text');
    assert(supplierText?.type === 'text', 'supplier result did not contain text content');
    const supplierPayload = JSON.parse(supplierText.text);
    assert(supplierPayload.suppliers?.[0]?.id === '88', 'supplier flattening failed');
    assert(supplierPayload.suppliers?.[0]?.classificationPath?.[0] === 'Machinery', 'supplier classification path failed');

    const regionResult = await client.callTool({
      name: 'product_list_regions',
      arguments: { keyword: 'China' }
    });
    const regionText = regionResult.content?.find((item) => item.type === 'text');
    assert(regionText?.type === 'text', 'region result did not contain text content');
    const regionPayload = JSON.parse(regionText.text);
    assert(regionPayload.regions?.[0]?.id === 'region-1', 'region filtering failed');

    const dictResult = await client.callTool({
      name: 'product_get_dict',
      arguments: { dictType: 'erp_customer_type', keyword: 'Dealer' }
    });
    const dictText = dictResult.content?.find((item) => item.type === 'text');
    assert(dictText?.type === 'text', 'dict result did not contain text content');
    const dictPayload = JSON.parse(dictText.text);
    assert(dictPayload.items?.[0]?.value === '1', 'dict filtering failed');

    await client.close();
    console.log('Product MCP smoke test passed');
  } finally {
    mcpServer.close();
    fakeBackend.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

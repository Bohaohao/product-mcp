import { createServer } from 'node:http';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { parsePages } from '../dist/chromePages.js';
import { ProductMcpError } from '../dist/errors.js';
import { createProductMcpExpressApp } from '../dist/server.js';
import { ProductTokenDaemonClient } from '../dist/tokenDaemonClient.js';
import { precheckProductPackage } from '../dist/packagePrecheck.js';
import { productOcrCertifications } from '../dist/ocr/certificationOcr.js';
import { productCreate } from '../dist/tools/createProduct.js';
import { productCreateFromPackage } from '../dist/workflows/createFromPackage.js';

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
        assert(['SmokeTestProduct', 'WorkflowUniqueProduct'].includes(body.keyword), 'duplicate check keyword was not normalized');
        if (body.keyword === 'WorkflowUniqueProduct') {
          sendJson(res, 200, {
            code: 200,
            data: {
              rows: [],
              total: 0
            }
          });
          return;
        }
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

function createPreviewBackendStub() {
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
      throw new Error(`Unexpected GET path in preview stub: ${path}`);
    },
    async post() {
      throw new Error('previewOnly=true must not call the create API');
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
  assert(result.submissionPreview?.counts?.medias === 1, 'productCreate should return a final submission media count');
  assert(result.fieldCoverage?.counts?.recognizedFields > 0, 'productCreate should return field coverage');
  assert(result.trace?.operation === 'product_create', 'productCreate should return a protocol trace');
}

async function assertPartListUnitStaysString() {
  const result = await productCreate(
    createSuccessBackendStub((body) => {
      const part = body.partLists?.[0];
      assert(part?.unitName === 'piece', 'partLists[].unitName should be forwarded as plain text');
      assert(!Object.prototype.hasOwnProperty.call(part, 'unitId'), 'partLists[].unitId must not be submitted during create');
    }),
    createMinimalDtoInput({
      partLists: [
        {
          id: 'edit-only-part-id',
          partType: 1,
          partName: 'Filter Kit',
          specAttr: 'FK 100',
          costPrice: 1,
          suggestedPrice: 2,
          suggestedStock: 3,
          unitName: 'piece',
          unitId: 'should-be-stripped'
        }
      ]
    }),
    'smoke-part-unit-string'
  );

  assert(result.ok === true, 'productCreate should accept part unit as a string-only field');
}

async function assertPreviewOnlySkipsCreate() {
  const result = await productCreate(
    createPreviewBackendStub(),
    createMinimalDtoInput({ confirm: undefined, previewOnly: true }),
    'smoke-preview-only'
  );

  assert(result.ok === true, 'previewOnly should return ok');
  assert(result.previewOnly === true, 'previewOnly flag was not returned');
  assert(result.submissionPreview?.product?.productNameCn === 'Smoke Test Product', 'preview should include business product summary');
  assert(result.submissionPreview?.counts?.medias === 1, 'preview should include normalized media counts');
  assert(result.note?.includes('no ERP create API call'), 'preview should state that no create call was made');
}

function createWorkflowBackendStub(options = {}) {
  let createPostCount = 0;
  return {
    get createPostCount() {
      return createPostCount;
    },
    async get(requestPath) {
      if (requestPath === '/user/erp/productCategory/tree') {
        return [
          {
            id: 'cat-1',
            status: '0',
            categoryName: 'Construction Machinery',
            children: [{ id: 'cat-11', status: '0', categoryName: 'Excavator Parts', children: [] }]
          }
        ];
      }
      if (requestPath === '/user/erp/productCategory/configList') {
        return {
          unitList: [{ id: 'unit-piece', unitName: 'piece', status: 0 }],
          baseList: [],
          fieldList: [],
          optionalList: []
        };
      }
      if (requestPath === '/user/erp/supplier/classification/tree') {
        return [
          {
            id: 'supplier-class',
            classificationName: 'Smoke',
            status: 0,
            supplierList: [{ id: 'supplier-88', name: 'Smoke Supplier' }]
          }
        ];
      }
      if (requestPath.startsWith('/user/regionalOrganizations/continents')) {
        return [];
      }
      if (requestPath.startsWith('/user/erp/commodity/')) {
        return [];
      }
      throw new Error(`Unexpected workflow GET path: ${requestPath}`);
    },
    async post(requestPath, body) {
      if (requestPath === '/user/erp/commodity/list') {
        assert(body.keyword === 'WorkflowUniqueProduct', 'workflow duplicate keyword was not normalized');
        return { rows: [], total: 0 };
      }
      if (requestPath === '/user/erp/commodity') {
        createPostCount += 1;
        if (options.allowCreate) {
          return { id: 'workflow-product-1', productId: 'workflow-product-1', ok: true };
        }
        throw new Error('workflow upload failure test must not call create');
      }
      throw new Error(`Unexpected workflow POST path: ${requestPath}`);
    }
  };
}

async function createWorkflowPackage() {
  const dir = await mkdtemp(path.join(tmpdir(), 'product-mcp-workflow-'));
  await mkdir(path.join(dir, '商品主图'), { recursive: true });
  await mkdir(path.join(dir, '细节图'), { recursive: true });
  const onePixelPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
    'base64'
  );
  await writeFile(path.join(dir, '商品主图', 'main.png'), onePixelPng);
  await writeFile(path.join(dir, '细节图', 'detail.png'), onePixelPng);
  await writeFile(
    path.join(dir, '商品资料.md'),
    `# 商品资料

## 1. 基础信息

### 1.1 商品身份

| 字段 | 填写值 | 填写说明 |
|---|---|---|
| 商品中文名称 | Workflow Unique Product | 必填 |
| 产品类型 | 服务 | 整机 / 配件 / 服务 |
| 上架状态 | 上架 | 上架 / 下架 / 作废 |

### 1.2 分类、单位、供应商

| 字段 | 填写值 | 填写说明 |
|---|---|---|
| 一级分类 | Construction Machinery | 必填 |
| 二级分类 | Excavator Parts | 必填 |
| 计量单位 | piece | 必填 |
| 供应商 | Smoke Supplier | 必填 |

### 1.3 地域信息

| 字段 | 填写值 | 填写说明 |
|---|---|---|
| 适用范围 | 全球 | 必填 |

### 1.4 服务属性与样品设置

| 字段 | 填写值 | 填写说明 |
|---|---|---|
| 是否支持拼柜 | 否 | 是 / 否 |
| 是否可做展品 | 否 | 是 / 否 |
| 是否需要安装 | 否 | 是 / 否 |
| 是否有售后门槛 | 否 | 是 / 否 |
| 是否支持样品 | 否 | 是 / 否 |

## 4. 库存与物流

### 4.2 交付、库存、售后

| 字段 | 填写值 | 填写说明 |
|---|---|---|
| 是否支持配件单买 | 否 | 是 / 否 |
| 是否支持 OEM | 否 | 是 / 否 |
| 是否支持 ODM | 否 | 是 / 否 |
| 是否支持小批量试单 | 否 | 是 / 否 |
| 是否现货备货 | 否 | 是 / 否 |
| 是否海外仓备货 | 否 | 是 / 否 |

## 6. 图文信息

### 6.1 商品图片

| 图片用途 | 文件路径 | 数量/比例说明 | 标题 | 副标题 | 描述 | 语言 | 语言代码 | 原图文ID | 备注 |
|---|---|---|---|---|---|---|---|---|---|
| 商品主图 | ./商品主图/main.png | 1:1 | 主图 |  |  |  |  |  |  |
| 细节图 | ./细节图/detail.png | 1:1 | 细节 |  |  |  |  |  |  |
`,
    'utf8'
  );
  return dir;
}

async function createCertificationOcrPackage(options = {}) {
  const dir = await createWorkflowPackage();
  await mkdir(path.join(dir, '认证'), { recursive: true });
  const pdfName = options.pdfName || 'Excavator CE.pdf';
  await writeFile(path.join(dir, '认证', pdfName), Buffer.from('%PDF-1.4\n% smoke OCR certificate\n'));
  const markdownPath = path.join(dir, '商品资料.md');
  const markdown = await readFile(markdownPath, 'utf8');
  await writeFile(
    markdownPath,
    `${markdown}

## 7. 认证资料

| 证书名称 | 证书类型 | 证书编号 | 覆盖区域 | 覆盖区域ID | 适用范围 | 适用特定型号 | 适用特定型号ID | 生效日期 | 到期日期 | 是否永久有效 | 文件路径 | 主图路径 | 文件分类 | 状态 | 排序 | 备注 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| CE 认证 |  |  |  |  | 全部型号 |  |  |  |  |  | ./认证/${pdfName} |  | 认证资料 | 有效 | 1 | smoke OCR |
`,
    'utf8'
  );
  return { dir, markdownPath, pdfName };
}

async function createFakeOcrCommands(root) {
  const renderPath = path.join(root, 'fake-render.mjs');
  const ocrPath = path.join(root, 'fake-ocr.mjs');
  await writeFile(
    renderPath,
    `import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const input = JSON.parse(readFileSync(0, 'utf8'));
mkdirSync(input.outputPath.replace(/[\\\\/][^\\\\/]+$/, ''), { recursive: true });
writeFileSync(input.outputPath, 'rendered page ' + input.page);
`,
    'utf8'
  );
  await writeFile(
    ocrPath,
    `import { readFileSync } from 'node:fs';
const input = JSON.parse(readFileSync(0, 'utf8'));
const source = String(input.sourcePath || input.filePath || '');
const page = Number(input.page || 1);
let text = '';
let confidence = 0.96;
if (source.includes('LOW.pdf')) {
  text = 'Certificate No: LOW-12345 CE';
  confidence = 0.55;
} else if (page === 1) {
  text = 'CE Certificate Certificate No: CE-2026-001 Region: European Union';
} else if (page === 2) {
  text = 'Issued by: SGS Date of Issue: 2026-01-02 Expiry Date: 2028-01-02';
} else {
  text = '';
  confidence = 0.4;
}
process.stdout.write(JSON.stringify({ text, confidence }));
`,
    'utf8'
  );
  return {
    ocrCommand: `"${process.execPath}" "${ocrPath}"`,
    renderCommand: `"${process.execPath}" "${renderPath}"`
  };
}

async function withFakeOcr(root, run) {
  const oldOcr = process.env.PRODUCT_OCR_COMMAND;
  const oldRender = process.env.PRODUCT_PDF_RENDER_COMMAND;
  const commands = await createFakeOcrCommands(root);
  process.env.PRODUCT_OCR_COMMAND = commands.ocrCommand;
  process.env.PRODUCT_PDF_RENDER_COMMAND = commands.renderCommand;
  try {
    return await run();
  } finally {
    if (oldOcr === undefined) delete process.env.PRODUCT_OCR_COMMAND;
    else process.env.PRODUCT_OCR_COMMAND = oldOcr;
    if (oldRender === undefined) delete process.env.PRODUCT_PDF_RENDER_COMMAND;
    else process.env.PRODUCT_PDF_RENDER_COMMAND = oldRender;
  }
}

async function assertCertificationOcrSmoke() {
  const root = await mkdtemp(path.join(tmpdir(), 'product-mcp-ocr-'));
  try {
    await withFakeOcr(root, async () => {
      const fixture = await createCertificationOcrPackage();
      const suggest = await productOcrCertifications({
        packagePath: fixture.dir,
        mode: 'suggest',
        ocrOptions: { maxPdfPages: 3 }
      });
      const suggestText = stringifyResult(suggest);
      assert(suggest.ok === true, 'certification OCR suggest should return ok');
      assert(suggestText.includes('CE-2026-001'), 'certification OCR should extract visible certificate number');
      assert(suggestText.includes('CE'), 'certification OCR should extract visible certificate type');
      assert(/Excavator CE\.pdf.*第 1 页|第 1 页.*Excavator CE\.pdf/.test(suggestText), 'OCR suggestions should include page 1 source reference');
      assert(/Expiry Date|到期日期|2028-01-02/.test(suggestText), 'OCR should inspect later PDF pages when useful');

      const applied = await productOcrCertifications({
        packagePath: fixture.dir,
        mode: 'apply',
        ocrOptions: { maxPdfPages: 3 }
      });
      assert(applied.ocrSummary.autoFilledCount >= 5, 'OCR apply should fill blank high-confidence certification fields');
      const markdown = await readFile(fixture.markdownPath, 'utf8');
      assert(markdown.includes('CE-2026-001'), 'OCR apply did not write certificate number');
      assert(markdown.includes('SGS'), 'OCR apply did not write issuing authority');
      assert(markdown.includes('2026-01-02'), 'OCR apply did not write effective date');
      assert(markdown.includes('2028-01-02'), 'OCR apply did not write expiry date');
      assert(markdown.includes('.generated/ocr/certifications/Excavator CE-page-1.png'), 'OCR apply did not write generated PDF main image path');

      const keepBlankFixture = await createCertificationOcrPackage();
      const keepBlank = await productOcrCertifications({
        packagePath: keepBlankFixture.dir,
        mode: 'apply',
        ocrOptions: { maxPdfPages: 3, datePolicy: 'keepBlank' }
      });
      const keepBlankMarkdown = await readFile(keepBlankFixture.markdownPath, 'utf8');
      assert(!keepBlankMarkdown.includes('2026-01-02'), 'datePolicy=keepBlank should not write effective date');
      assert(!keepBlankMarkdown.includes('2028-01-02'), 'datePolicy=keepBlank should not write expiry date');
      assert(stringifyResult(keepBlank).includes('skippedByDatePolicy'), 'date keep-blank policy should be traceable in OCR diff');

      const lowFixture = await createCertificationOcrPackage({ pdfName: 'LOW.pdf' });
      const low = await productOcrCertifications({
        packagePath: lowFixture.dir,
        mode: 'apply',
        ocrOptions: { maxPdfPages: 1 }
      });
      const lowMarkdown = await readFile(lowFixture.markdownPath, 'utf8');
      assert(!lowMarkdown.includes('LOW-12345'), 'low-confidence OCR should not be auto-written');
      assert(stringifyResult(low).includes('suggested'), 'low-confidence OCR should remain a suggestion');
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function assertCreateFromPackageWorkflow() {
  const packageDir = await createWorkflowPackage();
  const tracePaths = [];
  try {
    const previewBackend = createWorkflowBackendStub();
    let previewUploadCalled = false;
    const previewResult = await productCreateFromPackage(
      previewBackend,
      {
        packagePath: packageDir,
        runMode: 'preview',
        clientRequestId: `smoke-preview-${Date.now()}`,
        responseMode: 'standard'
      },
      'smoke-create-from-package-preview',
      {
        async uploadLocalFile() {
          previewUploadCalled = true;
          throw new Error('preview mode must not upload');
        }
      }
    );
    assert(previewResult.ok === true, 'create_from_package preview should pass');
    assert(previewResult.previewOnly === true, 'create_from_package preview flag missing');
    assert(previewUploadCalled === false, 'preview mode called upload');
    assert(previewBackend.createPostCount === 0, 'preview mode called create');
    assert(previewResult.referenceResolution?.ok === true, 'preview should resolve references');
    if (previewResult.tracePath) tracePaths.push(previewResult.tracePath);

    const createBackend = createWorkflowBackendStub();
    const attempts = new Map();
    const createResult = await productCreateFromPackage(
      createBackend,
      {
        packagePath: packageDir,
        runMode: 'create',
        confirm: true,
        clientRequestId: `smoke-create-${Date.now()}`,
        responseMode: 'standard'
      },
      'smoke-create-from-package-create',
      {
        async uploadLocalFile(input) {
          const key = input.sourceRelativePath || input.localPath;
          const count = (attempts.get(key) || 0) + 1;
          attempts.set(key, count);
          if (String(key).includes('detail.png')) {
            throw new Error(`forced upload failure ${count}`);
          }
          return {
            ok: true,
            url: `https://oss.example.test/${path.basename(input.localPath)}`,
            objectKey: `smoke/${path.basename(input.localPath)}`
          };
        }
      }
    );
    assert(createResult.ok === false, 'upload failure workflow should be blocked');
    assert(createResult.code === 'UPLOAD_FAILED', 'upload failure code was not returned');
    assert(createResult.uploadSummary?.total === 2, 'all valid uploadQueue items should be attempted');
    assert(createResult.uploadSummary?.successCount === 1, 'successful uploads should be counted');
    assert(createResult.uploadSummary?.errorCount === 1, 'failed uploads should be counted');
    assert([...attempts.entries()].some(([key, count]) => String(key).includes('detail.png') && count === 2), 'failed upload should retry once');
    assert([...attempts.entries()].some(([key, count]) => String(key).includes('main.png') && count === 1), 'successful upload should run once');
    assert(createBackend.createPostCount === 0, 'workflow must not create after upload errors');
    if (createResult.tracePath) tracePaths.push(createResult.tracePath);

    const successBackend = createWorkflowBackendStub({ allowCreate: true });
    const successClientRequestId = `smoke-success-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const successUploads = [];
    const successResult = await productCreateFromPackage(
      successBackend,
      {
        packagePath: packageDir,
        runMode: 'create',
        confirm: true,
        clientRequestId: successClientRequestId,
        responseMode: 'standard'
      },
      'smoke-create-from-package-success',
      {
        async uploadLocalFile(input) {
          successUploads.push(input.sourceRelativePath || input.localPath);
          return {
            ok: true,
            url: `https://oss.example.test/${path.basename(input.localPath)}`,
            objectKey: `smoke/${path.basename(input.localPath)}`
          };
        }
      }
    );
    assert(successResult.ok === true, 'successful workflow create should pass');
    assert(successResult.productId === 'workflow-product-1', 'successful workflow should return productId');
    assert(successResult.uploadSummary?.successCount === 2, 'successful workflow should upload every valid item');
    assert(successUploads.length === 2, 'successful workflow should invoke upload for every valid item');
    assert(successBackend.createPostCount === 1, 'successful workflow should call create once');
    assert(successResult.diffReport, 'successful workflow should return a detail diff report');
    if (successResult.tracePath) tracePaths.push(successResult.tracePath);

    const replayResult = await productCreateFromPackage(
      successBackend,
      {
        packagePath: packageDir,
        runMode: 'create',
        confirm: true,
        clientRequestId: successClientRequestId,
        responseMode: 'standard'
      },
      'smoke-create-from-package-replay',
      {
        async uploadLocalFile() {
          throw new Error('idempotent replay must not upload');
        }
      }
    );
    assert(replayResult.ok === true && replayResult.reused === true, 'idempotent replay should return existing product');
    assert(successBackend.createPostCount === 1, 'idempotent replay must not call create again');
    if (replayResult.tracePath) tracePaths.push(replayResult.tracePath);
  } finally {
    await rm(packageDir, { recursive: true, force: true });
    await Promise.all(tracePaths.map((tracePath) => rm(tracePath, { force: true })));
  }
}

const BATCH_HEADER = Object.freeze({
  productType: '\u4ea7\u54c1\u7c7b\u578b',
  categoryFirstName: '\u6240\u5c5e\u4e00\u7ea7\u5206\u7c7b',
  categorySecondName: '\u6240\u5c5e\u4e8c\u7ea7\u5206\u7c7b',
  categoryThirdName: '\u6240\u5c5e\u4e09\u7ea7\u5206\u7c7b',
  productNameCn: '\u4ea7\u54c1\u4e2d\u6587\u540d\u79f0',
  productModel: '\u4ea7\u54c1\u578b\u53f7',
  unitName: '\u5355\u4f4d',
  status: '\u72b6\u6001',
  supplierName: '\u6240\u5c5e\u4f9b\u5e94\u5546',
  supplierCode: '\u4f9b\u8d27\u5546\u4ee3\u7801',
  regionName: '\u9002\u7528\u533a\u57df\uff08\u4e0b\u62c9\u9009\u62e9\uff09',
  level: '\u4ea7\u54c1\u7b49\u7ea7\uff08\u4e0b\u62c9\u9009\u62e9\uff09',
  referenceCostCny: '\u53c2\u8003\u6210\u672c\u4ef7\u542b\u7a0e\uff08\uffe5\uff09',
  referenceCostUsd: '\u53c2\u8003\u6210\u672c\u4ef7\uff08\uff04\uff09',
  profitMargin: '\u5229\u6da6\u7387\uff08%\uff09',
  packLength: '\u5305\u88c5\u5c3a\u5bf8-\u957f\uff08\u6beb\u7c73\uff09',
  packWidth: '\u5305\u88c5\u5c3a\u5bf8-\u5bbd\uff08\u6beb\u7c73\uff09',
  packHeight: '\u5305\u88c5\u5c3a\u5bf8-\u9ad8\uff08\u6beb\u7c73\uff09',
  packWeight: '\u91cd\u91cf-\u6bdb\u91cd\uff08\u5343\u514b\uff09',
  packingFee: '\u5305\u88c5\u8d39\uff08\u5143\uff09',
  progress: '\u521b\u5efa\u8fdb\u5ea6',
  resultMessage: '\u521b\u5efa\u7ed3\u679c\u8bf4\u660e',
  productId: '\u5546\u54c1ID',
  packagePath: '\u8d44\u6599\u5305\u8def\u5f84',
  markdownPath: '\u5546\u54c1\u8d44\u6599\u8def\u5f84',
  updatedAt: '\u6700\u540e\u66f4\u65b0\u65f6\u95f4',
  workflowId: 'workflowId'
});

const BATCH_STANDARD_HEADERS = Object.freeze([
  BATCH_HEADER.productType,
  BATCH_HEADER.categoryFirstName,
  BATCH_HEADER.categorySecondName,
  BATCH_HEADER.categoryThirdName,
  BATCH_HEADER.productNameCn,
  BATCH_HEADER.productModel,
  BATCH_HEADER.unitName,
  BATCH_HEADER.status,
  BATCH_HEADER.supplierName,
  BATCH_HEADER.supplierCode,
  BATCH_HEADER.regionName,
  BATCH_HEADER.level,
  BATCH_HEADER.referenceCostCny,
  BATCH_HEADER.referenceCostUsd,
  BATCH_HEADER.profitMargin,
  BATCH_HEADER.packLength,
  BATCH_HEADER.packWidth,
  BATCH_HEADER.packHeight,
  BATCH_HEADER.packWeight,
  BATCH_HEADER.packingFee
]);

const BATCH_PROGRESS_HEADERS = Object.freeze([
  BATCH_HEADER.progress,
  BATCH_HEADER.resultMessage,
  BATCH_HEADER.productId,
  BATCH_HEADER.packagePath,
  BATCH_HEADER.markdownPath,
  BATCH_HEADER.updatedAt,
  BATCH_HEADER.workflowId
]);

const BATCH_WORKBOOK_HEADERS = Object.freeze([...BATCH_STANDARD_HEADERS, ...BATCH_PROGRESS_HEADERS]);

const BATCH_REQUIRED_EXPORTS = Object.freeze([
  'productCreateFromBatch',
  'readBatchWorkbookRows',
  'prepareBatchMaterialPackage'
]);

const BATCH_MODULE_PATHS = Object.freeze({
  workflow: '../dist/workflows/createFromBatch.js',
  workbook: '../dist/workflows/batchWorkbook.js',
  materialPackage: '../dist/workflows/batchMaterialPackage.js'
});

async function loadExcelJs() {
  let excelModule;
  try {
    excelModule = await import('exceljs');
  } catch (error) {
    if (error?.code !== 'MODULE_NOT_FOUND') throw error;
    excelModule = await import('exceljs/dist/exceljs.js');
  }
  return excelModule.default || excelModule;
}

async function writeBatchWorkbook(excelPath, rows) {
  const ExcelJS = await loadExcelJs();
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Batch');
  worksheet.addRow(BATCH_WORKBOOK_HEADERS);
  for (const row of rows) {
    const excelRow = worksheet.addRow([]);
    BATCH_WORKBOOK_HEADERS.forEach((header, index) => {
      excelRow.getCell(index + 1).value = row[header] ?? '';
    });
  }
  BATCH_WORKBOOK_HEADERS.forEach((header, index) => {
    worksheet.getColumn(index + 1).width = Math.max(14, header.length + 4);
  });
  await writeFile(excelPath, Buffer.from(await workbook.xlsx.writeBuffer()));
}

async function openBatchWorkbook(excelPath) {
  const ExcelJS = await loadExcelJs();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await readFile(excelPath));
  return workbook;
}

function excelValueToText(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') {
    if (Array.isArray(value.richText)) return value.richText.map((item) => item.text || '').join('');
    if (value.text !== undefined) return String(value.text);
    if (value.result !== undefined) return excelValueToText(value.result);
    if (value.error !== undefined) return String(value.error);
    if (value.formula !== undefined) return String(value.formula);
  }
  return String(value);
}

function cellText(cell) {
  return excelValueToText(cell.value).trim();
}

function worksheetHeaderMap(worksheet) {
  const headers = new Map();
  const headerRow = worksheet.getRow(1);
  for (let index = 1; index <= headerRow.cellCount; index += 1) {
    const text = cellText(headerRow.getCell(index));
    if (text) headers.set(text, index);
  }
  return headers;
}

function isFormulaErrorValue(value) {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    value.formula !== undefined &&
    Boolean(value.result) &&
    typeof value.result === 'object' &&
    typeof value.result.error === 'string'
  );
}

function createBatchWorkbookRow(productNameCn, overrides = {}) {
  return {
    [BATCH_HEADER.productType]: '\u670d\u52a1',
    [BATCH_HEADER.categoryFirstName]: 'Construction Machinery',
    [BATCH_HEADER.categorySecondName]: 'Excavator Parts',
    [BATCH_HEADER.categoryThirdName]: '',
    [BATCH_HEADER.productNameCn]: productNameCn,
    [BATCH_HEADER.productModel]: '',
    [BATCH_HEADER.unitName]: 'piece',
    [BATCH_HEADER.status]: '\u4e0a\u67b6',
    [BATCH_HEADER.supplierName]: 'Smoke Supplier',
    [BATCH_HEADER.supplierCode]: '',
    [BATCH_HEADER.regionName]: '\u5168\u7403',
    [BATCH_HEADER.level]: '',
    [BATCH_HEADER.referenceCostCny]: '',
    [BATCH_HEADER.referenceCostUsd]: '',
    [BATCH_HEADER.profitMargin]: '',
    [BATCH_HEADER.packLength]: '',
    [BATCH_HEADER.packWidth]: '',
    [BATCH_HEADER.packHeight]: '',
    [BATCH_HEADER.packWeight]: '',
    [BATCH_HEADER.packingFee]: '',
    ...overrides
  };
}

async function createBatchSmokeFixtures() {
  const root = await mkdtemp(path.join(tmpdir(), 'product-mcp-batch-'));
  const materialsRoot = path.join(root, 'materials');
  await mkdir(materialsRoot, { recursive: true });

  const validProductName = 'Workflow Unique Product';
  const missingProductName = 'Missing Package Product';
  const preparedProductName = 'Prepared Batch Product';
  const certMissingProductName = 'Cert Missing Main Image Product';
  const certInvalidImageProductName = 'Cert Invalid Main Image Product';
  const certAutoPairProductName = 'Cert Auto Pair Product';
  const certAuxOnlyProductName = 'Cert Auxiliary Images Only Product';
  const certExtraInvalidProductName = 'Cert Extra Invalid Image Product';
  const sourceMappingProductName = 'Source Mapping Product';
  const sourceCoverageGapProductName = 'Source Coverage Gap Product';
  const sourcePackageDir = await createWorkflowPackage();
  const validPackageDir = path.join(materialsRoot, validProductName);
  await cp(sourcePackageDir, validPackageDir, { recursive: true });

  const onePixelPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
    'base64'
  );
  const preparedPackageDir = path.join(materialsRoot, preparedProductName);
  await mkdir(path.join(preparedPackageDir, '商品主图'), { recursive: true });
  await mkdir(path.join(preparedPackageDir, '实测视频'), { recursive: true });
  await writeFile(path.join(preparedPackageDir, '商品主图', 'main.png'), onePixelPng);
  await writeFile(path.join(preparedPackageDir, '实测视频', 'actual.mp4'), Buffer.from('not-a-real-video'));

  const sourceMappingPackageDir = path.join(materialsRoot, sourceMappingProductName);
  await mkdir(path.join(sourceMappingPackageDir, '商品主图'), { recursive: true });
  await mkdir(path.join(sourceMappingPackageDir, '应用场景'), { recursive: true });
  await mkdir(path.join(sourceMappingPackageDir, '核心优势'), { recursive: true });
  await mkdir(path.join(sourceMappingPackageDir, 'FAQ'), { recursive: true });
  await mkdir(path.join(sourceMappingPackageDir, '客户案例', '客户A'), { recursive: true });
  await mkdir(path.join(sourceMappingPackageDir, '认证'), { recursive: true });
  await mkdir(path.join(sourceMappingPackageDir, '配件'), { recursive: true });
  await mkdir(path.join(sourceMappingPackageDir, '售后'), { recursive: true });
  await mkdir(path.join(sourceMappingPackageDir, '质保'), { recursive: true });
  await writeFile(path.join(sourceMappingPackageDir, '商品主图', 'main.png'), onePixelPng);
  await writeFile(path.join(sourceMappingPackageDir, '应用场景', '文案.txt'), '道路开挖施工：适用于道路开挖、管沟铺设与路基修整\n建筑工地施工：适用于建筑工地土方转运与基础施工\n');
  await writeFile(path.join(sourceMappingPackageDir, '应用场景', '道路工程.jpg'), onePixelPng);
  await writeFile(path.join(sourceMappingPackageDir, '应用场景', '建筑工地.jpg'), onePixelPng);
  await writeFile(path.join(sourceMappingPackageDir, '核心优势', '文案.txt'), '高效节能：动力响应快，综合油耗低\n维护便捷：常用维护点集中，保养效率高\n');
  await writeFile(path.join(sourceMappingPackageDir, '核心优势', '高效节能.jpg'), onePixelPng);
  await writeFile(path.join(sourceMappingPackageDir, 'FAQ', 'faq.txt'), 'Q：是否适合狭窄工况？\nA：适合园林、市政和小型道路施工。\n');
  await writeFile(path.join(sourceMappingPackageDir, '客户案例', '客户A', '文案.txt'), '道路养护项目：客户用于城区道路养护，设备通过性好，转场灵活。\n');
  await writeFile(path.join(sourceMappingPackageDir, '客户案例', '客户A', '现场.jpg'), onePixelPng);
  await writeFile(path.join(sourceMappingPackageDir, '认证', 'CE.pdf'), Buffer.from('%PDF-1.4\n% smoke certificate\n'));
  await writeFile(path.join(sourceMappingPackageDir, '认证', 'CE-main.jpg'), onePixelPng);
  await writeFile(path.join(sourceMappingPackageDir, '配件', '铲斗.jpg'), onePixelPng);
  await writeFile(path.join(sourceMappingPackageDir, '售后', '文案.txt'), '快速响应：收到售后请求后 24 小时内响应。\n');
  await writeFile(path.join(sourceMappingPackageDir, '质保', '文案.txt'), '整机质保：核心部件提供 12 个月质保。\n');

  const sourceCoverageGapPackageDir = path.join(materialsRoot, sourceCoverageGapProductName);
  await cp(sourcePackageDir, sourceCoverageGapPackageDir, { recursive: true });
  await mkdir(path.join(sourceCoverageGapPackageDir, '应用场景'), { recursive: true });
  await writeFile(path.join(sourceCoverageGapPackageDir, '应用场景', '道路工程.jpg'), onePixelPng);

  const certMissingPackageDir = path.join(materialsRoot, certMissingProductName);
  await cp(sourcePackageDir, certMissingPackageDir, { recursive: true });
  await mkdir(path.join(certMissingPackageDir, '认证'), { recursive: true });
  await writeFile(path.join(certMissingPackageDir, '认证', 'CE.pdf'), Buffer.from('%PDF-1.4\n% smoke certificate\n'));
  const certMarkdownPath = path.join(certMissingPackageDir, '商品资料.md');
  const certMarkdown = await readFile(certMarkdownPath, 'utf8');
  await writeFile(
    certMarkdownPath,
    `${certMarkdown}

## 7. 认证资料

| 证书名称 | 证书类型 | 证书编号 | 覆盖区域 | 覆盖区域ID | 适用范围 | 适用特定型号 | 适用特定型号ID | 生效日期 | 到期日期 | 是否永久有效 | 文件路径 | 主图路径 | 文件分类 | 状态 | 排序 | 备注 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| CE 认证 | CE | CE-001 | 全球 |  | 全部型号 |  |  |  |  | 是 | ./认证/CE.pdf |  | 认证资料 | 有效 | 1 | smoke 缺主图 |
`,
    'utf8'
  );

  const certInvalidImagePackageDir = path.join(materialsRoot, certInvalidImageProductName);
  await cp(sourcePackageDir, certInvalidImagePackageDir, { recursive: true });
  await mkdir(path.join(certInvalidImagePackageDir, '认证'), { recursive: true });
  await writeFile(path.join(certInvalidImagePackageDir, '认证', 'CE.pdf'), Buffer.from('%PDF-1.4\n% smoke certificate\n'));
  await writeFile(path.join(certInvalidImagePackageDir, '认证', 'CE-main.jpg'), Buffer.from('not-a-valid-image'));
  const certInvalidMarkdownPath = path.join(certInvalidImagePackageDir, '商品资料.md');
  const certInvalidMarkdown = await readFile(certInvalidMarkdownPath, 'utf8');
  await writeFile(
    certInvalidMarkdownPath,
    `${certInvalidMarkdown}

## 7. 认证资料

| 证书名称 | 证书类型 | 证书编号 | 覆盖区域 | 覆盖区域ID | 适用范围 | 适用特定型号 | 适用特定型号ID | 生效日期 | 到期日期 | 是否永久有效 | 文件路径 | 主图路径 | 文件分类 | 状态 | 排序 | 备注 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| CE 认证 | CE | CE-002 | 全球 |  | 全部型号 |  |  |  |  | 是 | ./认证/CE.pdf | ./认证/CE-main.jpg | 认证资料 | 有效 | 1 | smoke 坏主图 |
`,
    'utf8'
  );

  const certAutoPairPackageDir = path.join(materialsRoot, certAutoPairProductName);
  await mkdir(path.join(certAutoPairPackageDir, '认证'), { recursive: true });
  await writeFile(path.join(certAutoPairPackageDir, '认证', 'CE.pdf'), Buffer.from('%PDF-1.4\n% smoke certificate\n'));
  await writeFile(path.join(certAutoPairPackageDir, '认证', 'CE-main.jpg'), onePixelPng);

  const certAuxOnlyPackageDir = path.join(materialsRoot, certAuxOnlyProductName);
  await mkdir(path.join(certAuxOnlyPackageDir, '认证'), { recursive: true });
  await writeFile(path.join(certAuxOnlyPackageDir, '认证', 'main.jpg'), onePixelPng);
  await writeFile(path.join(certAuxOnlyPackageDir, '认证', 'cover.jpg'), onePixelPng);

  const certExtraInvalidPackageDir = path.join(materialsRoot, certExtraInvalidProductName);
  await cp(sourcePackageDir, certExtraInvalidPackageDir, { recursive: true });
  await mkdir(path.join(certExtraInvalidPackageDir, '认证'), { recursive: true });
  await writeFile(path.join(certExtraInvalidPackageDir, '认证', 'unused-main.jpg'), Buffer.from('not-a-valid-image'));

  const createExcelPath = path.join(root, 'batch-create.xlsx');
  await writeBatchWorkbook(createExcelPath, [
    createBatchWorkbookRow(validProductName),
    createBatchWorkbookRow(missingProductName)
  ]);

  const formulaExcelPath = path.join(root, 'batch-formula-error.xlsx');
  await writeBatchWorkbook(formulaExcelPath, [
    createBatchWorkbookRow('Formula Error Product', {
      [BATCH_HEADER.productNameCn]: { formula: '1/0', result: { error: '#DIV/0!' } }
    })
  ]);

  const prepareExcelPath = path.join(root, 'batch-prepare.xlsx');
  await writeBatchWorkbook(prepareExcelPath, [createBatchWorkbookRow(preparedProductName)]);

  const sourceMappingExcelPath = path.join(root, 'batch-source-mapping.xlsx');
  await writeBatchWorkbook(sourceMappingExcelPath, [createBatchWorkbookRow(sourceMappingProductName)]);

  const certMissingExcelPath = path.join(root, 'batch-cert-missing-main-image.xlsx');
  await writeBatchWorkbook(certMissingExcelPath, [createBatchWorkbookRow(certMissingProductName)]);

  const certInvalidImageExcelPath = path.join(root, 'batch-cert-invalid-main-image.xlsx');
  await writeBatchWorkbook(certInvalidImageExcelPath, [createBatchWorkbookRow(certInvalidImageProductName)]);

  const certAutoPairExcelPath = path.join(root, 'batch-cert-auto-pair.xlsx');
  await writeBatchWorkbook(certAutoPairExcelPath, [createBatchWorkbookRow(certAutoPairProductName)]);

  const certAuxOnlyExcelPath = path.join(root, 'batch-cert-aux-only.xlsx');
  await writeBatchWorkbook(certAuxOnlyExcelPath, [createBatchWorkbookRow(certAuxOnlyProductName)]);

  return {
    root,
    packageDirs: [sourcePackageDir],
    materialsRoot,
    validProductName,
    missingProductName,
    preparedProductName,
    certMissingProductName,
    certInvalidImageProductName,
    certAutoPairProductName,
    certAuxOnlyProductName,
    certExtraInvalidProductName,
    sourceMappingProductName,
    sourceCoverageGapProductName,
    createExcelPath,
    formulaExcelPath,
    prepareExcelPath,
    sourceMappingExcelPath,
    certMissingExcelPath,
    certInvalidImageExcelPath,
    certAutoPairExcelPath,
    certAuxOnlyExcelPath,
    certInvalidImagePackageDir,
    certExtraInvalidPackageDir,
    sourceCoverageGapPackageDir
  };
}

async function assertBatchDraftFixtureCoverage(fixtures) {
  const workbook = await openBatchWorkbook(fixtures.createExcelPath);
  const worksheet = workbook.getWorksheet('Batch') || workbook.worksheets[0];
  const headers = worksheetHeaderMap(worksheet);
  for (const header of BATCH_WORKBOOK_HEADERS) {
    assert(headers.has(header), `batch fixture missing standard Excel header: ${header}`);
  }
  assert(
    cellText(worksheet.getRow(2).getCell(headers.get(BATCH_HEADER.productNameCn))) === fixtures.validProductName,
    'batch fixture valid product row was not written'
  );
  assert(
    cellText(worksheet.getRow(3).getCell(headers.get(BATCH_HEADER.productNameCn))) === fixtures.missingProductName,
    'batch fixture missing-package product row was not written'
  );

  const formulaWorkbook = await openBatchWorkbook(fixtures.formulaExcelPath);
  const formulaSheet = formulaWorkbook.getWorksheet('Batch') || formulaWorkbook.worksheets[0];
  const formulaHeaders = worksheetHeaderMap(formulaSheet);
  const formulaValue = formulaSheet.getRow(2).getCell(formulaHeaders.get(BATCH_HEADER.productNameCn)).value;
  assert(isFormulaErrorValue(formulaValue), 'batch formula-error fixture did not preserve an Excel formula error cell');

  const prepareWorkbook = await openBatchWorkbook(fixtures.prepareExcelPath);
  const prepareSheet = prepareWorkbook.getWorksheet('Batch') || prepareWorkbook.worksheets[0];
  const prepareHeaders = worksheetHeaderMap(prepareSheet);
  assert(
    cellText(prepareSheet.getRow(2).getCell(prepareHeaders.get(BATCH_HEADER.productNameCn))) === fixtures.preparedProductName,
    'batch prepare fixture did not include a product row for Markdown generation'
  );
}

async function loadBatchSmokeApi() {
  const missingModules = [];
  const imported = {};
  for (const [key, modulePath] of Object.entries(BATCH_MODULE_PATHS)) {
    const moduleUrl = new URL(modulePath, import.meta.url);
    try {
      await stat(moduleUrl);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        missingModules.push(modulePath);
        continue;
      }
      throw error;
    }
    imported[key] = await import(moduleUrl.href);
  }

  if (missingModules.length) return { pending: true, missingModules };

  const missingExports = [
    ['workflow', 'productCreateFromBatch'],
    ['workbook', 'readBatchWorkbookRows'],
    ['materialPackage', 'prepareBatchMaterialPackage']
  ].filter(([moduleKey, exportName]) => typeof imported[moduleKey]?.[exportName] !== 'function');

  if (missingExports.length) {
    throw new Error(
      `Batch smoke modules are missing required exports: ${missingExports
        .map(([moduleKey, exportName]) => `${BATCH_MODULE_PATHS[moduleKey]}.${exportName}`)
        .join(', ')}`
    );
  }

  return {
    pending: false,
    api: {
      async parseProductBatchWorkbook(input) {
        return imported.workbook.readBatchWorkbookRows({
          workbookPath: input.workbookPath || input.excelPath,
          sheetName: input.sheetName,
          rowSelection: input.rowSelection
        });
      },
      async prepareProductBatchMarkdown(input) {
        const parsed = await imported.workbook.readBatchWorkbookRows({
          workbookPath: input.workbookPath || input.excelPath,
          sheetName: input.sheetName,
          rowSelection: input.rowSelection
        });
        const results = [];
        for (const row of parsed.rows) {
          results.push(
            await imported.materialPackage.prepareBatchMaterialPackage(row, input.materialsRoot, {
              markdownFileName: input.markdownFileName,
              dryRun: input.dryRun
            })
          );
        }
        return {
          ok: results.every((result) => result.ok),
          workbook: parsed,
          results
        };
      },
      async runProductBatchFromExcel(backend, input, requestId, runtime) {
        return imported.workflow.productCreateFromBatch(
          backend,
          {
            workbookPath: input.workbookPath || input.excelPath,
            materialsRoot: input.materialsRoot,
            runMode: input.runMode,
            confirm: input.confirm,
            sheetName: input.sheetName,
            rowSelection: input.rowSelection,
            concurrency: input.concurrency,
            responseMode: input.responseMode
          },
          requestId,
          runtime
        );
      }
    }
  };
}

function stringifyResult(value) {
  return JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? String(item) : item));
}

function collectStrings(value, predicate, output = []) {
  if (typeof value === 'string') {
    if (predicate(value)) output.push(value);
  } else if (Array.isArray(value)) {
    value.forEach((item) => collectStrings(item, predicate, output));
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach((item) => collectStrings(item, predicate, output));
  }
  return output;
}

async function existingPathFromResult(result, fallbackDir, predicate) {
  for (const candidate of collectStrings(result, predicate)) {
    const resolved = path.isAbsolute(candidate) ? candidate : path.resolve(fallbackDir, candidate);
    try {
      await stat(resolved);
      return resolved;
    } catch {
      // Keep scanning result paths; the final assertion will report the missing artifact.
    }
  }
  return undefined;
}

async function workbookPathAfterBatchRun(result, fallbackExcelPath) {
  return (
    (await existingPathFromResult(result, path.dirname(fallbackExcelPath), (value) => /\.xlsx$/i.test(value))) ||
    fallbackExcelPath
  );
}

async function assertBatchModeSmoke() {
  const fixtures = await createBatchSmokeFixtures();
  try {
    await assertBatchDraftFixtureCoverage(fixtures);
    const loaded = await loadBatchSmokeApi();
    if (loaded.pending) {
      console.warn(
        `[smoke:batch] pending integration; missing batch module(s): ${loaded.missingModules.join(
          ', '
        )}. Expected exports: ${BATCH_REQUIRED_EXPORTS.join(', ')}. Draft xlsx fixtures were generated and validated.`
      );
      return;
    }

    const { api } = loaded;
    const parsed = await api.parseProductBatchWorkbook({ excelPath: fixtures.createExcelPath, responseMode: 'debug' });
    const parsedText = stringifyResult(parsed);
    assert(parsedText.includes(fixtures.validProductName), 'batch parser did not recognize the valid standard-header row');
    assert(parsedText.includes(fixtures.missingProductName), 'batch parser did not keep missing-package row for row-level failure');

    const formulaResult = await api.parseProductBatchWorkbook({ excelPath: fixtures.formulaExcelPath, responseMode: 'debug' });
    assert(
      /FORMULA|formula|\u516c\u5f0f|#DIV\/0!/.test(stringifyResult(formulaResult)),
      'batch parser did not report formula-error cells'
    );

    const prepareResult = await api.prepareProductBatchMarkdown({
      excelPath: fixtures.prepareExcelPath,
      materialsRoot: fixtures.materialsRoot,
      responseMode: 'debug'
    });
    const markdownPath = await existingPathFromResult(
      prepareResult,
      fixtures.materialsRoot,
      (value) => /\.md$/i.test(value) || value.endsWith('\u5546\u54c1\u8d44\u6599.md')
    );
    assert(markdownPath, 'batch prepare did not return a generated Markdown path');
    const markdown = await readFile(markdownPath, 'utf8');
    assert(markdown.includes(fixtures.preparedProductName), 'batch prepare Markdown did not include source product data');
    assert(markdown.includes('| 实测视频 | ./实测视频/actual.mp4 |'), 'batch prepare should preserve direct-parent media category');
    assert(!markdown.includes('| 作业视频 | ./实测视频/actual.mp4 |'), 'batch prepare must not subjectively rewrite 实测视频 to 作业视频');
    assert(markdown.includes('目标模板无同名分类，保留原始分类'), 'batch prepare should trace preserved nonstandard media categories');

    const sourceMappingResult = await api.prepareProductBatchMarkdown({
      excelPath: fixtures.sourceMappingExcelPath,
      materialsRoot: fixtures.materialsRoot,
      responseMode: 'debug'
    });
    const sourceMappingMarkdownPath = await existingPathFromResult(
      sourceMappingResult,
      fixtures.materialsRoot,
      (value) => /\.md$/i.test(value) || value.endsWith('\u5546\u54c1\u8d44\u6599.md')
    );
    assert(sourceMappingMarkdownPath, 'source mapping prepare did not return a generated Markdown path');
    const sourceMappingMarkdown = await readFile(sourceMappingMarkdownPath, 'utf8');
    assert(sourceMappingMarkdown.includes('道路开挖施工'), '应用场景文案 was not mapped into 8.3 应用场景');
    assert(sourceMappingMarkdown.includes('./应用场景/道路工程.jpg'), '应用场景 image was not referenced by structured scenario row');
    assert(sourceMappingMarkdown.includes('| 场景图 | ./应用场景/道路工程.jpg |'), '应用场景 image should still be kept as 商品图片/场景图');
    assert(sourceMappingMarkdown.includes('高效节能'), '核心优势文案 was not mapped into 8.2 核心优势');
    assert(sourceMappingMarkdown.includes('是否适合狭窄工况'), 'FAQ 文案 was not mapped into 8.4 常见问题');
    assert(sourceMappingMarkdown.includes('客户A'), '客户案例文案 did not generate 8.8 客户案例');
    assert(sourceMappingMarkdown.includes('./客户案例/客户A/现场.jpg'), '客户案例图片 did not generate 客户案例媒体');
    assert(sourceMappingMarkdown.includes('./认证/CE.pdf'), '认证 PDF did not generate 7 认证资料行');
    assert(sourceMappingMarkdown.includes('./配件/铲斗.jpg'), '配件图片 did not generate 5 配件清单');
    assert(sourceMappingMarkdown.includes('快速响应'), '售后文案 was not mapped into 8.10 售后服务承诺');
    assert(sourceMappingMarkdown.includes('整机质保'), '质保文案 was not mapped into 8.11 质保政策');

    const sourceMappingPrecheck = await precheckProductPackage({
      packagePath: sourceMappingMarkdownPath,
      responseMode: 'debug',
      ocrMode: 'off'
    });
    const sourceMappingPrecheckText = stringifyResult(sourceMappingPrecheck);
    assert(sourceMappingPrecheckText.includes('sourceCoverageReport'), 'precheck should return sourceCoverageReport');
    assert(!sourceMappingPrecheckText.includes('MEDIA_ONLY_MAPPING_SUSPECT'), 'structured source mapping should not be media-only suspect');

    const sourceCoverageGapPrecheck = await precheckProductPackage({
      packagePath: fixtures.sourceCoverageGapPackageDir,
      responseMode: 'debug',
      ocrMode: 'off'
    });
    const sourceCoverageGapText = stringifyResult(sourceCoverageGapPrecheck);
    assert(sourceCoverageGapPrecheck.ok === false, 'precheck should fail when business source exists but target section is empty');
    assert(
      /SOURCE_NOT_MAPPED|MEDIA_ONLY_MAPPING_SUSPECT|SECTION_MATERIAL_NOT_FILLED|SOURCE_COVERAGE_AUDIT_FAILED/.test(sourceCoverageGapText),
      'source coverage audit should expose a concrete mapping error code'
    );
    assert(sourceCoverageGapText.includes('应用场景/道路工程.jpg'), 'source coverage audit should locate the unmapped scenario image');

    const certAutoPairResult = await api.prepareProductBatchMarkdown({
      excelPath: fixtures.certAutoPairExcelPath,
      materialsRoot: fixtures.materialsRoot,
      responseMode: 'debug'
    });
    const certAutoPairMarkdownPath = await existingPathFromResult(
      certAutoPairResult,
      fixtures.materialsRoot,
      (value) => /\.md$/i.test(value) || value.endsWith('\u5546\u54c1\u8d44\u6599.md')
    );
    assert(certAutoPairMarkdownPath, 'batch prepare did not return certification auto-pair Markdown path');
    const certAutoPairMarkdown = await readFile(certAutoPairMarkdownPath, 'utf8');
    const certAutoPairRows = certAutoPairMarkdown
      .split(/\r?\n/)
      .filter((line) => line.includes('./认证/'));
    assert(
      certAutoPairRows.some((line) => line.includes('./认证/CE.pdf') && line.includes('./认证/CE-main.jpg')),
      'CE-main.jpg should be bound to the CE.pdf certification row'
    );
    assert(
      certAutoPairRows.filter((line) => line.includes('./认证/CE-main.jpg')).length === 1,
      'CE-main.jpg must not be generated as an extra certification row'
    );

    const certAuxOnlyResult = await api.prepareProductBatchMarkdown({
      excelPath: fixtures.certAuxOnlyExcelPath,
      materialsRoot: fixtures.materialsRoot,
      responseMode: 'debug'
    });
    const certAuxOnlyMarkdownPath = await existingPathFromResult(
      certAuxOnlyResult,
      fixtures.materialsRoot,
      (value) => /\.md$/i.test(value) || value.endsWith('\u5546\u54c1\u8d44\u6599.md')
    );
    assert(certAuxOnlyMarkdownPath, 'batch prepare did not return auxiliary-only certification Markdown path');
    const certAuxOnlyMarkdown = await readFile(certAuxOnlyMarkdownPath, 'utf8');
    assert(!certAuxOnlyMarkdown.includes('./认证/main.jpg'), 'main.jpg without a certificate anchor must not create a certification row');
    assert(!certAuxOnlyMarkdown.includes('./认证/cover.jpg'), 'cover.jpg without a certificate anchor must not create a certification row');

    const certInvalidPrecheck = await precheckProductPackage({
      packagePath: fixtures.certInvalidImagePackageDir,
      responseMode: 'debug'
    });
    const certInvalidPrecheckText = stringifyResult(certInvalidPrecheck);
    assert(certInvalidPrecheck.ok === false, 'precheck should fail when certification main image is invalid');
    assert(certInvalidPrecheckText.includes('REQUIRED_FILE_INVALID'), 'invalid certification main image should be a blocking file error');
    assert(
      /认证资料第\s+\d+\s+行\s*\/\s*主图路径.*CE-main\.jpg/.test(certInvalidPrecheckText),
      'invalid certification main image should locate row, field and file name'
    );
    assert(
      certInvalidPrecheckText.includes('blockingInvalidFiles') && !certInvalidPrecheckText.includes('"ignoredInvalidExtraFiles":[{"'),
      'invalid explicit certification main image should be grouped as blocking, not ignored extra'
    );

    const certExtraInvalidPrecheck = await precheckProductPackage({
      packagePath: fixtures.certExtraInvalidPackageDir,
      responseMode: 'debug'
    });
    const certExtraInvalidText = stringifyResult(certExtraInvalidPrecheck);
    assert(certExtraInvalidPrecheck.ok === true, 'unreferenced invalid certification image should not block precheck');
    assert(certExtraInvalidText.includes('OPTIONAL_FILE_INVALID'), 'unreferenced invalid certification image should be reported as optional invalid file');
    assert(certExtraInvalidText.includes('ignoredInvalidExtraFiles'), 'unreferenced invalid certification image should be grouped as ignored extra');
    assert(!stringifyResult(certExtraInvalidPrecheck.uploadQueue || []).includes('unused-main.jpg'), 'unreferenced invalid certification image must not enter uploadQueue');

    const certMissingPreviewBackend = createWorkflowBackendStub({ allowCreate: true });
    let certMissingUploadCalled = false;
    const certMissingPreview = await api.runProductBatchFromExcel(
      certMissingPreviewBackend,
      {
        excelPath: fixtures.certMissingExcelPath,
        materialsRoot: fixtures.materialsRoot,
        runMode: 'preview',
        responseMode: 'debug'
      },
      'smoke-batch-cert-missing-main-image-preview',
      {
        async uploadLocalFile() {
          certMissingUploadCalled = true;
          throw new Error('batch preview with missing certification main image must not upload');
        }
      }
    );
    const certMissingText = stringifyResult(certMissingPreview);
    assert(certMissingPreview.ok === false, 'batch preview should fail when certification main image is missing');
    assert(certMissingText.includes('CERT_MAIN_IMAGE_REQUIRED'), 'batch preview should expose CERT_MAIN_IMAGE_REQUIRED');
    assert(/认证资料第\s+\d+\s+行.*(缺少主图|必须上传主图|主图路径)/.test(certMissingText), 'batch preview should locate the missing certification main image row');
    assert(!certMissingText.includes('[object Object]'), 'batch preview row error should not contain [object Object]');
    assert(!certMissingText.includes('ROW_WORKFLOW_FAILED'), 'batch preview validation error should not collapse to ROW_WORKFLOW_FAILED');
    assert(certMissingUploadCalled === false, 'batch preview with missing certification main image called upload');
    assert(certMissingPreviewBackend.createPostCount === 0, 'batch preview with missing certification main image called create');

    const certInvalidPreviewBackend = createWorkflowBackendStub({ allowCreate: true });
    let certInvalidUploadCalled = false;
    const certInvalidPreview = await api.runProductBatchFromExcel(
      certInvalidPreviewBackend,
      {
        excelPath: fixtures.certInvalidImageExcelPath,
        materialsRoot: fixtures.materialsRoot,
        runMode: 'preview',
        responseMode: 'debug'
      },
      'smoke-batch-cert-invalid-main-image-preview',
      {
        async uploadLocalFile() {
          certInvalidUploadCalled = true;
          throw new Error('batch preview with invalid certification main image must not upload');
        }
      }
    );
    const certInvalidText = stringifyResult(certInvalidPreview);
    assert(certInvalidPreview.ok === false, 'batch preview should fail when certification main image file is invalid');
    assert(certInvalidText.includes('REQUIRED_FILE_INVALID'), 'batch preview should expose invalid explicit certification image as blocking');
    assert(/认证资料第\s+\d+\s+行\s*\/\s*主图路径.*CE-main\.jpg/.test(certInvalidText), 'batch preview should locate invalid certification main image row and file');
    assert(!certInvalidText.includes('[object Object]'), 'batch preview invalid file error should not contain [object Object]');
    assert(!certInvalidText.includes('ROW_WORKFLOW_FAILED'), 'batch preview invalid file error should not collapse to ROW_WORKFLOW_FAILED');
    assert(certInvalidUploadCalled === false, 'batch preview with invalid certification main image called upload');
    assert(certInvalidPreviewBackend.createPostCount === 0, 'batch preview with invalid certification main image called create');

    const previewBackend = createWorkflowBackendStub({ allowCreate: true });
    let previewUploadCalled = false;
    const previewResult = await api.runProductBatchFromExcel(
      previewBackend,
      {
        excelPath: fixtures.createExcelPath,
        materialsRoot: fixtures.materialsRoot,
        runMode: 'preview',
        responseMode: 'debug'
      },
      'smoke-batch-preview',
      {
        async uploadLocalFile() {
          previewUploadCalled = true;
          throw new Error('batch preview must not upload');
        }
      }
    );
    assert(/preview/i.test(stringifyResult(previewResult)), 'batch preview did not return preview metadata');
    assert(previewUploadCalled === false, 'batch preview mode called upload');
    assert(previewBackend.createPostCount === 0, 'batch preview mode called create');

    const createBackend = createWorkflowBackendStub({ allowCreate: true });
    const createResult = await api.runProductBatchFromExcel(
      createBackend,
      {
        excelPath: fixtures.createExcelPath,
        materialsRoot: fixtures.materialsRoot,
        runMode: 'create',
        confirm: true,
        responseMode: 'debug'
      },
      'smoke-batch-create',
      {
        async uploadLocalFile(input) {
          return {
            ok: true,
            url: `https://oss.example.test/${path.basename(input.localPath)}`,
            objectKey: `smoke/${path.basename(input.localPath)}`
          };
        }
      }
    );
    assert(createBackend.createPostCount === 1, 'batch create should create the valid row once');

    const writebackPath = await workbookPathAfterBatchRun(createResult, fixtures.createExcelPath);
    const workbook = await openBatchWorkbook(writebackPath);
    const worksheet = workbook.getWorksheet('Batch') || workbook.worksheets[0];
    const headers = worksheetHeaderMap(worksheet);
    const productIdText = cellText(worksheet.getRow(2).getCell(headers.get(BATCH_HEADER.productId)));
    const successProgressText = cellText(worksheet.getRow(2).getCell(headers.get(BATCH_HEADER.progress)));
    const successMessageText = cellText(worksheet.getRow(2).getCell(headers.get(BATCH_HEADER.resultMessage)));
    const failedProgressText = cellText(worksheet.getRow(3).getCell(headers.get(BATCH_HEADER.progress)));
    const failedMessageText = cellText(worksheet.getRow(3).getCell(headers.get(BATCH_HEADER.resultMessage)));

    assert(productIdText.includes('workflow-product-1'), 'batch create did not write 商品ID back to the workbook');
    assert(successProgressText || successMessageText, 'batch create did not write progress/message for the success row');
    assert(failedProgressText || failedMessageText, 'batch create did not write progress/message for the failed row');
    assert(/fail|error|missing|\u5931\u8d25|\u7f3a/i.test(`${failedProgressText} ${failedMessageText}`), 'batch create did not record the missing-package row failure');
  } finally {
    await rm(fixtures.root, { recursive: true, force: true });
    await Promise.all(fixtures.packageDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  }
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
    const { ProductTokenBridge } = await import('../dist/localBridge.js');
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
  await assertCreateSucceedsWithoutEnglishName();
  await assertPartListUnitStaysString();
  await assertPreviewOnlySkipsCreate();
  await assertCreateFromPackageWorkflow();
  await assertCertificationOcrSmoke();
  await assertBatchModeSmoke();
  await assertTokenDaemonClientAndBridge();

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

  await assertCreateValidationFailure(
    createMinimalDtoInput({ confirm: undefined }),
    'CONFIRM_REQUIRED'
  );
  await assertCreateValidationFailure(
    createMinimalDtoInput({ id: 'old-product-id' }),
    'CREATE_MODE_ID_FORBIDDEN'
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

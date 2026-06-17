import { createServer } from 'node:http';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createProductMcpExpressApp } from '../dist/server.js';

const fakeBackendPort = Number(process.env.SMOKE_BACKEND_PORT || 18787);
const mcpPort = Number(process.env.SMOKE_MCP_PORT || 18788);
const authorization = 'Bearer smoke-token';

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
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
        assert(body.medias?.[1]?.language === 'cn', 'media language was not preserved');
        assert(body.medias?.[1]?.mediaId === 'media-zh-1', 'mediaId was not preserved');
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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
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
    for (const toolName of ['product_get_category_config', 'product_list_suppliers', 'product_list_regions', 'product_get_dict']) {
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

    const createResult = await client.callTool({
      name: 'product_create',
      arguments: {
        confirm: true,
        productNameCn: 'Smoke Test Product',
        productNameEn: 'Smoke Test Product EN',
        tenantId: 'tenant-smoke',
        relatedCommodityId: '456,789',
        categoryFirstId: '1',
        categorySecondId: '11',
        unitId: '9',
        suppliers: [{ supplierId: '88', supplierName: 'Smoke Supplier', productionCycle: '7', cycleUnit: '1' }],
        useAllRegions: true,
        productMainImageUrl: 'https://example.test/main.png',
        medias: [{ mediaType: 1, imageCategory: 2, mediaUrl: 'https://example.test/detail.png', language: 'cn', mediaId: 'media-zh-1' }],
        baseConfigs: [{ name: 'Power', configValue: '100W' }],
        technicalParams: [{ name: 'Length', paramValue: '10cm' }],
        optionalConfigs: [{ name: 'Color', configValue: 'Red', status: 0 }],
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

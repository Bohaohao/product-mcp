# Product MCP

Remote HTTP MCP server for ERP product operations.

## Scope

The first version registers only the v0 whitelist tools from `docs/step1.md`.
The remote MCP server currently registers:

- `product_list_categories`
- `product_get_category_config`
- `product_list_suppliers`
- `product_list_regions`
- `product_get_dict`
- `product_get_detail`
- `product_create`

The local Chrome token bridge also registers:

- `product_auth_status`
- `product_precheck_package`
- `product_upload_file`
- `product_list_categories`
- `product_get_category_config`
- `product_list_suppliers`
- `product_list_regions`
- `product_get_dict`
- `product_get_detail`
- `product_create`

`product_upload_file` runs locally in the bridge process. It reads a user-provided `localPath`,
gets `Admin-Token` from Chrome, calls `GET /user/oss/sts/token`, uploads the file directly
from the user's machine to OSS, and returns the OSS URL. Large files do not go through
base64 or the remote MCP server. If the upload usage has a required image aspect ratio,
non-matching images are force-cropped locally before validation and upload.

`product_precheck_package` also runs locally in the bridge process. It reads a local
`商品资料.md`, parses the currently supported product fields and file tables, validates
referenced local files against upload policies, and returns a draft create payload plus an
upload queue. If an image has a required aspect ratio and does not match it, the current
version force-crops the image with `sharp` and returns the generated file path in the
upload queue. It does not upload files and does not create a product.

`product_create` is a write operation. The local bridge reads `Admin-Token` from Chrome,
forwards the call to the remote MCP server, and the remote MCP server calls
`POST /user/erp/commodity`. Use `product_upload_file` first for local files, then pass
the returned OSS URLs into `product_create`.

The read-only reference tools are intended to run before `product_create`, so Codex can
look up real category config, unit, supplier, region, and dictionary values instead of
asking the user to manually provide backend IDs.

`product_get_detail` is a read-only acceptance tool. It queries product edit detail
sections after `product_create`, so Codex can verify the created product through MCP
instead of relying on browser network inspection.

`product_create` resolves and validates category-dependent config rows before writing:
base configs, technical params, and optional config option values must exist in the
selected category config. Large numeric IDs must be passed as strings when they are
outside JavaScript's safe integer range.

The removed tools are not registered:

- independent product payload validation
- product draft creation
- physical product deletion

## Runtime

Node.js 18.18+ is required.

```bash
npm install
npm run build
npm start
```

Local verification:

```bash
npm run smoke
```

The smoke test does not create a real product. It starts a fake backend and verifies:

- `product_list_categories` is listed and callable.
- `product_get_category_config` is listed and returns units/configs for a selected category.
- `product_list_suppliers` is listed and can search suppliers by id/name/classification.
- `product_list_regions` is listed and can search regional organization options.
- `product_get_dict` is listed and returns normalized dictionary values.
- `product_get_detail` is listed and can query product detail sections.
- `product_create` is listed and sends `POST /user/erp/commodity`.
- `product_create` can extract the returned product `id`.

The MCP endpoint is:

```text
POST /mcp
```

Health check:

```text
GET /healthz
```

## Environment

Copy `.env.example` into your deployment environment and set real values:

```bash
PRODUCT_MCP_PORT=8787
PRODUCT_MCP_HOST=0.0.0.0
PRODUCT_MCP_PATH=/mcp
PRODUCT_MCP_ALLOWED_HOSTS=
PRODUCT_MCP_BACKEND_BASE_URL=https://your-frontend-or-gateway-domain/api
PRODUCT_MCP_CLIENT_ID=e5cd7e4891bf95d1d19206ce24a7b32e
PRODUCT_MCP_REQUEST_TIMEOUT_MS=50000
PRODUCT_MCP_DEFAULT_LANGUAGE=zh_CN
```

`PRODUCT_MCP_BACKEND_BASE_URL` must be the absolute server-side base URL that reaches the same backend API exposed to the frontend under `/api` or `/dev-api`.

For remote testing, set `PRODUCT_MCP_HOST=0.0.0.0`. After the MCP domain is fixed, set `PRODUCT_MCP_ALLOWED_HOSTS` to a comma-separated host list, for example:

```bash
PRODUCT_MCP_ALLOWED_HOSTS=mcp.company.com,10.0.0.12
```

## Deploy With PM2

```bash
cd product-mcp
npm ci
npm run build
cp deploy.env.example deploy.env
# edit deploy.env and set PRODUCT_MCP_BACKEND_BASE_URL
set -a
. ./deploy.env
set +a
npx pm2 start ecosystem.config.cjs
npx pm2 save
```

Verify:

```bash
curl http://127.0.0.1:8787/healthz
```

## Deploy With Docker

```bash
cd product-mcp
docker build -t product-mcp:0.1.0 .
docker run -d --name product-mcp --env-file deploy.env -p 8787:8787 product-mcp:0.1.0
```

For HTTPS, put this service behind the company gateway or Nginx and proxy the public MCP URL to `http://127.0.0.1:8787/mcp`.

Minimal Nginx location:

```nginx
location /mcp {
  proxy_pass http://127.0.0.1:8787/mcp;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
}

location /healthz {
  proxy_pass http://127.0.0.1:8787/healthz;
}
```

## Authentication

Codex connects to this MCP server with:

```http
Authorization: Bearer <user-token>
```

The MCP server forwards the same Authorization header to backend APIs and also sends the frontend `clientid` header.

## Read-only Reference Tools

These tools are safe lookup helpers. They still forward the current user's token to the
backend, so backend permissions remain the source of truth.

### product_get_category_config

Backend endpoint:

```text
GET /user/erp/productCategory/configList?categoryId=<categoryId>
```

Input:

```json
{
  "categoryId": "2064170526602231809",
  "enabledOnly": true
}
```

Returns normalized `units`, `baseConfigs`, `technicalParams`, and `optionalConfigs`.
Use a returned unit `id` as `product_create.unitId`.

### product_list_suppliers

Backend endpoint:

```text
GET /user/erp/supplier/classification/tree
```

Input:

```json
{
  "keyword": "1001",
  "includeTree": false
}
```

Returns flattened `suppliers`. `keyword` matches supplier id, name, code, rating, main item,
and classification path. Use a returned supplier `id` and `name` as `supplierId` and
`supplierName`.

### product_list_regions

Backend endpoint:

```text
GET /user/regionalOrganizations/continents?value=<keyword>
```

Input:

```json
{
  "keyword": "China"
}
```

Returns region `id`, `nameZh`, `nameEn`, `orgCode`, and `continentDictValue`. Use the returned
`id` as `regions[].regionId` when not using `useAllRegions`.

### product_get_dict

Backend endpoint:

```text
GET /user/system/dict/data/type/<dictType>
```

Input:

```json
{
  "dictType": "erp_customer_type"
}
```

Returns normalized dictionary items with `label`, `value`, `code`, `type`, and sort metadata.

## Local Upload Tool

## Local Package Precheck Tool

When using the local token bridge, Codex can precheck a product package through:

```text
product_precheck_package
```

Input:

```json
{
  "packagePath": "D:\\path\\to\\product-package",
  "includeDraft": true
}
```

The tool returns:

- parsed product summary and draft `product_create` input without resolved backend IDs
- local file validation results
- an upload queue for files that pass validation
- errors and warnings for missing fields, bad numbers, invalid enum values, missing files,
  invalid file extensions, oversized files, or bad image ratios

In this version, bad image ratios are auto-fixed by force-cropping. The result is reported
as `IMAGE_FORCE_CROPPED`, and `uploadQueue[].localPath` points to the generated image under
`.generated/prepared/`.

It intentionally runs in the local bridge because remote MCP cannot read user-machine files.

CLI verification without starting the bridge:

```bash
npm run build
node dist/packagePrecheckCli.js "D:/path/to/product-package"
```

When using the local token bridge, Codex can upload product files through:

```text
product_upload_file
```

Input:

```json
{
  "localPath": "D:/path/to/file.png",
  "usage": "productMainImage",
  "title": "optional title",
  "description": "optional description",
  "languageList": ["zh", "en"]
}
```

The first minimal upload module supports fixed `usage` presets such as:

```text
productMainImage
bannerImage
detailImage
realVideo
loadingVideo
workVideo
installVideo
packingVideo
linkActualTestingVideo
thirdActualTestingVideo
model3d
productAttachment
certificateFile
certificateMainImage
graphicDetailImage
advantageImage
scenarioImage
caseImage
caseVideo
serviceSupportFile
partsImage
partsAttachment
richTextImage
richTextVideo
richTextAttachment
```

The bridge validates extension and size before uploading. Image usages with required ratios
are force-cropped locally when dimensions do not match. The current minimal version marks
video codec validation as not checked; a later adapter can plug in `ffprobe` to enforce
H.264/AAC and 4:3 or 16:9.

Bridge config can explicitly set the backend used for STS:

```json
{
  "backendBaseUrl": "https://test.eysscm.com/api",
  "clientId": "e5cd7e4891bf95d1d19206ce24a7b32e"
}
```

## Minimal Product Create Tool

When using the local token bridge, Codex can create a real product through:

```text
product_create
```

Required minimal input:

```json
{
  "confirm": true,
  "productNameCn": "测试商品",
  "productNameEn": "Test Product",
  "productType": 1,
  "status": 1,
  "categoryFirstId": "1",
  "unitId": "9",
  "supplierId": "88",
  "useAllRegions": true
}
```

Recommended input after uploading a main image:

```json
{
  "confirm": true,
  "productNameCn": "测试商品",
  "productNameEn": "Test Product",
  "productType": 1,
  "status": 1,
  "categoryFirstId": "1",
  "unitId": "9",
  "supplierId": "88",
  "useAllRegions": true,
  "productMainImageUrl": "https://example.oss-cn-beijing.aliyuncs.com/path/main.png",
  "productMainImageName": "main.png",
  "packageInfo": {
    "packLength": 100,
    "packWidth": 100,
    "packHeight": 100,
    "packCubic": "0.01",
    "packingFee": 1,
    "packWeight": 2,
    "netWeight": 1
  }
}
```

`confirm: true` is mandatory because the tool creates a real product. Creating with
`status=3` is intentionally blocked; status `3` is reserved for voiding an existing product.

The result includes:

```json
{
  "ok": true,
  "id": "123456",
  "productId": "123456",
  "frontendEditPath": "/erp/commodity/editCommodity/123456",
  "frontendViewPath": "/erp/commodity/viewCommodity/123456"
}
```

## Codex MCP Config Example

For the simplest direct connection, replace the URL after deployment and provide a user token manually:

```json
{
  "mcpServers": {
    "product": {
      "transport": "http",
      "url": "https://your-mcp-domain.example.com/mcp",
      "headers": {
        "Authorization": "Bearer <user-token>"
      }
    }
  }
}
```

For local automatic token forwarding from Chrome, use the token bridge instead of configuring a static
`Authorization` header. Example stdio server config:

```json
{
  "mcpServers": {
    "product": {
      "command": "node",
      "args": [
        "D:\\path\\to\\product-mcp\\dist\\localBridge.js",
        "--config",
        "D:\\path\\to\\product-mcp\\product-token-bridge.config.json"
      ]
    }
  }
}
```

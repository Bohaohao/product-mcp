# Product MCP / ERP 商品 MCP

Product MCP is a remote HTTP MCP server plus a local Chrome token bridge for ERP product operations.

Product MCP 是一个面向 ERP 商品业务的 MCP 服务，包含远程 HTTP MCP 服务和本地 Chrome 登录态桥接器。

## AI Agent Contract / AI 智能体快速契约

Use this section first when you are an AI agent.

如果你是 AI 智能体，请优先读取本节。

### What This Repo Does / 仓库职责

- Remote MCP server: exposes read-only ERP reference tools and the real product creation tool.
- Local token bridge: reads the current user's `Admin-Token` from a logged-in Chrome ERP tab, then calls the remote MCP with `Authorization`.
- Local-only file tools: precheck product packages, validate local files, crop images when required, upload files to OSS through STS.

- 远程 MCP 服务：提供 ERP 只读参考查询工具，以及真实创建商品的写入工具。
- 本地 token bridge：从用户已登录的 Chrome ERP 页面读取 `Admin-Token`，再带 `Authorization` 调用远程 MCP。
- 本地文件工具：预检商品资料包、校验本地文件、按要求裁剪图片，并通过 STS 上传到 OSS。

### Safety Rules / 安全规则

- Never ask the user to paste or reveal `Admin-Token`.
- Always call `product_auth_status` before backend lookup, upload, or create when using the local bridge.
- Always use read-only lookup tools before asking the user for backend IDs.
- Never call `product_create` unless the user clearly confirms product creation in the current conversation.
- Pass large numeric IDs as strings to avoid JavaScript precision loss.
- Remote MCP cannot read local files. Use the local bridge for local paths.

- 不要要求用户粘贴或暴露 `Admin-Token`。
- 使用本地 bridge 时，后端查询、上传、创建前先调用 `product_auth_status`。
- 优先使用只读查询工具解析真实后端 ID，不要让用户手填 ID。
- 没有用户在当前对话中的明确确认，不要调用 `product_create`。
- 大整数 ID 必须按字符串传入，避免 JavaScript 精度丢失。
- 远程 MCP 不能读取用户本地文件路径；本地路径必须走本地 bridge。

### Recommended Product Creation Flow / 推荐创建流程

1. `product_auth_status`
2. `product_precheck_package` for local product package input
3. `product_list_categories`
4. `product_get_category_config`
5. `product_list_suppliers`
6. `product_list_regions` when not using all regions
7. `product_get_dict` when dictionary values are needed
8. `product_upload_file` for every valid local file in the upload queue
9. Ask the user to confirm the final write operation
10. `product_create` with `confirm: true`
11. `product_get_detail` to verify the created product

1. 调用 `product_auth_status` 检查登录态。
2. 如果用户提供本地商品资料包，调用 `product_precheck_package`。
3. 调用 `product_list_categories` 解析分类。
4. 调用 `product_get_category_config` 解析单位、基础配置、技术参数、可选配置。
5. 调用 `product_list_suppliers` 解析供应商。
6. 非全区域商品再调用 `product_list_regions`。
7. 需要字典值时调用 `product_get_dict`。
8. 对上传队列中的有效本地文件逐个调用 `product_upload_file`。
9. 创建前向用户总结并确认写入操作。
10. 调用 `product_create`，必须传 `confirm: true`。
11. 调用 `product_get_detail` 验证创建结果。

## Architecture / 架构

```text
MCP client
  -> local token bridge, stdio, optional but recommended for Codex users
    -> Chrome DevTools MCP
      -> logged-in ERP tab localStorage.Admin-Token
    -> remote Product MCP, HTTP /mcp
      -> ERP backend APIs
      -> OSS STS API
```

```text
MCP 客户端
  -> 本地 token bridge，stdio，推荐 Codex 用户使用
    -> Chrome DevTools MCP
      -> 已登录 ERP 页面 localStorage.Admin-Token
    -> 远程 Product MCP，HTTP /mcp
      -> ERP 后端接口
      -> OSS STS 接口
```

## Tool Surface / 工具清单

### Remote HTTP MCP Tools / 远程 HTTP MCP 工具

These tools run on the remote MCP server and forward the current user's `Authorization` header to the ERP backend.

这些工具运行在远程 MCP 服务中，会把当前用户的 `Authorization` 转发给 ERP 后端。

| Tool | Read/Write | Purpose |
| --- | --- | --- |
| `product_list_categories` | Read | Query product category tree. 查询商品分类树。 |
| `product_get_category_config` | Read | Query units, base configs, technical params, optional configs. 查询分类配置。 |
| `product_list_suppliers` | Read | Query and flatten supplier options. 查询供应商。 |
| `product_list_regions` | Read | Query region options. 查询适用区域。 |
| `product_get_dict` | Read | Query system dictionary values. 查询系统字典。 |
| `product_get_detail` | Read | Query product detail sections after creation. 创建后验收查询。 |
| `product_create` | Write | Create a real ERP product through `POST /user/erp/commodity`. 创建真实商品。 |

### Local Bridge Tools / 本地 Bridge 工具

These tools are available when the local bridge is used. Local file access only works here.

这些工具仅在使用本地 bridge 时可用。本地文件读取只在这里生效。

| Tool | Read/Write | Purpose |
| --- | --- | --- |
| `product_auth_status` | Read | Check Chrome ERP login token availability without exposing token content. 检查 Chrome 登录态。 |
| `product_precheck_package` | Local read | Parse and validate a local product package. 预检本地商品资料包。 |
| `product_upload_file` | Write upload | Validate, optionally crop, and upload a local file to OSS. 上传本地文件到 OSS。 |
| remote tools listed above | Mixed | The bridge forwards these calls to remote MCP with Chrome token. 代理远程工具。 |

## Runtime / 运行环境

Node.js 18.18+ is required.

需要 Node.js 18.18 或更高版本。

```bash
npm ci
npm run build
npm start
```

Local verification:

本地验证：

```bash
npm run smoke
```

The smoke test does not create a real product. It starts a fake backend and verifies tool registration, request mapping, and response normalization.

`smoke` 测试不会创建真实商品。它会启动一个假后端，验证工具注册、请求映射和响应归一化。

## Remote MCP Server / 远程 MCP 服务

Endpoint:

端点：

```text
POST /mcp
GET /healthz
```

### Environment / 环境变量

Copy `.env.example` into the deployment environment and set real values.

复制 `.env.example`，并在部署环境中配置真实值。

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

`PRODUCT_MCP_BACKEND_BASE_URL` must be an absolute server-side base URL that reaches the same backend API exposed to the frontend under `/api` or `/dev-api`.

`PRODUCT_MCP_BACKEND_BASE_URL` 必须是服务端可访问的后端 API 基础地址，语义上应等同于前端 `/api` 或 `/dev-api` 指向的后端。

### Authentication / 鉴权

Remote MCP expects:

远程 MCP 期望请求携带：

```http
Authorization: Bearer <user-token>
```

The server forwards the same `Authorization` header to ERP backend APIs and also sends the configured `clientid` header.

服务端会把同一个 `Authorization` 转发给 ERP 后端，并附带配置的 `clientid` 请求头。

## Local Token Bridge / 本地 Token Bridge

The local bridge is the recommended entry for Codex users. It avoids manual token copying.

本地 bridge 是 Codex 用户的推荐入口，可以避免手动复制 token。

### Bridge Config / Bridge 配置

Default config file:

默认配置文件：

```text
product-token-bridge.config.json
```

Important fields:

关键字段：

```json
{
  "projectUrl": "https://test.eysscm.com/erp/purchase",
  "matchUrlPrefixes": ["https://test.eysscm.com/erp/"],
  "tokenStorageKey": "Admin-Token",
  "remoteMcpUrl": "http://47.95.237.95:8787/mcp",
  "backendBaseUrl": "https://test.eysscm.com/api",
  "clientId": "e5cd7e4891bf95d1d19206ce24a7b32e",
  "language": "zh_CN"
}
```

### MCP Client Config / MCP 客户端配置

Use this stdio server config when a client should get the token from Chrome automatically.

如果希望 MCP 客户端自动从 Chrome 获取登录态，使用下面的 stdio 配置：

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

Before using the bridge, the user must log in to the ERP system in Chrome.

使用 bridge 前，用户必须先在 Chrome 中登录 ERP 系统。

## Deployment / 部署

### PM2

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

验证：

```bash
curl http://127.0.0.1:8787/healthz
```

### Docker

```bash
cd product-mcp
docker build -t product-mcp:0.1.0 .
docker run -d --name product-mcp --env-file deploy.env -p 8787:8787 product-mcp:0.1.0
```

For HTTPS, put this service behind a company gateway or Nginx.

如需 HTTPS，请放到公司网关或 Nginx 后面。

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

## Tool Details / 工具细节

### `product_auth_status`

Checks whether the configured Chrome ERP page contains `localStorage.Admin-Token`.

检查配置的 Chrome ERP 页面中是否存在 `localStorage.Admin-Token`。

Example success shape:

成功结果示例：

```json
{
  "ok": true,
  "projectUrl": "https://test.eysscm.com/erp/purchase",
  "matchedPageUrl": "https://test.eysscm.com/erp/commodity/commodity",
  "tokenStorageKey": "Admin-Token",
  "tokenPresent": true,
  "tokenLength": 245,
  "remoteMcpUrl": "http://47.95.237.95:8787/mcp"
}
```

### `product_precheck_package`

Runs locally. Reads a product package directory or product markdown file, parses supported fields and file tables, validates local files, and returns a draft create payload plus an upload queue.

本地运行。读取商品资料包目录或商品资料 Markdown 文件，解析已支持字段和文件表格，校验本地文件，并返回创建草稿和上传队列。

Input:

输入：

```json
{
  "packagePath": "D:\\path\\to\\product-package",
  "includeDraft": true
}
```

Notes:

说明：

- It does not upload files.
- It does not create a product.
- Images with required aspect ratios are force-cropped by `sharp` when needed.
- Cropped files are written under `.generated/prepared/`.

- 不上传文件。
- 不创建商品。
- 必要时会用 `sharp` 强制裁剪有比例要求的图片。
- 裁剪产物写入 `.generated/prepared/`。

CLI verification:

命令行验证：

```bash
npm run build
node dist/packagePrecheckCli.js "D:/path/to/product-package"
```

### `product_upload_file`

Runs locally. Validates a local file, optionally prepares the image, gets OSS STS token from ERP backend, uploads directly to OSS, and returns an OSS URL.

本地运行。校验本地文件，必要时处理图片，通过 ERP 后端获取 OSS STS token，直传 OSS，并返回 OSS URL。

Input:

输入：

```json
{
  "localPath": "D:/path/to/file.png",
  "usage": "productMainImage",
  "title": "optional title",
  "description": "optional description",
  "languageList": ["zh", "en"]
}
```

Supported `usage` values:

支持的 `usage` 值：

```text
productMainImage
bannerImage
detailImage
sizeImage
sceneImage
packageImage
multiAngleImage
accessoriesImage
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

### `product_create`

Write operation. Creates a real ERP product through:

写操作。通过以下后端接口创建真实 ERP 商品：

```text
POST /user/erp/commodity
```

Minimal input:

最小输入：

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

上传主图后的推荐输入：

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

`confirm: true` is mandatory. Creating with `status=3` is intentionally blocked because status `3` is reserved for voiding an existing product.

`confirm: true` 是必填项。创建时禁止传 `status=3`，因为 `3` 保留给作废已有商品。

Successful result shape:

成功结果结构：

```json
{
  "ok": true,
  "id": "123456",
  "productId": "123456",
  "frontendEditPath": "/erp/commodity/editCommodity/123456",
  "frontendViewPath": "/erp/commodity/viewCommodity/123456"
}
```

### Read-only Lookup Tools / 只读查询工具

Use these before `product_create`.

创建前优先使用这些工具。

#### `product_list_categories`

Queries:

查询：

```text
GET /user/erp/productCategory/tree
```

#### `product_get_category_config`

Queries:

查询：

```text
GET /user/erp/productCategory/configList?categoryId=<categoryId>
```

Input:

输入：

```json
{
  "categoryId": "2064170526602231809",
  "enabledOnly": true
}
```

Returns normalized `units`, `baseConfigs`, `technicalParams`, and `optionalConfigs`.

返回归一化的 `units`、`baseConfigs`、`technicalParams` 和 `optionalConfigs`。

#### `product_list_suppliers`

Queries:

查询：

```text
GET /user/erp/supplier/classification/tree
```

Input:

输入：

```json
{
  "keyword": "1001",
  "includeTree": false
}
```

#### `product_list_regions`

Queries:

查询：

```text
GET /user/regionalOrganizations/continents?value=<keyword>
```

Input:

输入：

```json
{
  "keyword": "China"
}
```

#### `product_get_dict`

Queries:

查询：

```text
GET /user/system/dict/data/type/<dictType>
```

Input:

输入：

```json
{
  "dictType": "erp_customer_type"
}
```

#### `product_get_detail`

Queries product edit detail sections after creation.

创建后查询商品编辑详情分区，用于验收。

Input:

输入：

```json
{
  "productId": "123456",
  "includeSections": ["base", "medias", "sales", "parts", "certifications"]
}
```

## Troubleshooting / 故障处理

### Missing Chrome token / 未获取到 Chrome token

Likely causes:

可能原因：

- Chrome is not open.
- ERP page is not logged in.
- Current page URL does not match `matchUrlPrefixes`.
- `tokenStorageKey` is not `Admin-Token` in the target environment.

- Chrome 未打开。
- ERP 页面未登录。
- 当前页面 URL 不匹配 `matchUrlPrefixes`。
- 目标环境的 token key 不是 `Admin-Token`。

Recommended user-facing prompt:

推荐给用户的提示：

```text
Please open Chrome, log in to the ERP system, keep an ERP page under the configured URL prefix, refresh the page, then retry product_auth_status.

请打开 Chrome 并登录 ERP 系统，保持一个匹配配置 URL 前缀的 ERP 页面，刷新页面后重新调用 product_auth_status。
```

### Remote MCP returns 401 / 远程 MCP 返回 401

- Direct HTTP clients must provide `Authorization: Bearer <user-token>`.
- Local bridge users should check `product_auth_status`.

- 直接 HTTP 连接必须提供 `Authorization: Bearer <user-token>`。
- 本地 bridge 用户应先检查 `product_auth_status`。

### Local file path fails / 本地路径失败

- Remote MCP cannot read local paths.
- Use `product_precheck_package` or `product_upload_file` through the local bridge.
- Verify the path is absolute or relative to the bridge process working directory.

- 远程 MCP 不能读取本地路径。
- 本地路径应通过本地 bridge 的 `product_precheck_package` 或 `product_upload_file` 处理。
- 确认路径为绝对路径，或相对于 bridge 进程工作目录。

## Repository Split / 仓库拆分建议

This repo should stay focused on Product MCP runtime code.

本仓库只负责 Product MCP 运行时代码。

Recommended sibling repositories:

推荐使用两个兄弟仓库：

```text
product-mcp          # this repo, MCP server and bridge
erp-product-plugin   # Codex plugin marketplace wrapper
```

The Codex plugin marketplace can start this repo's local bridge through `PRODUCT_MCP_HOME` or a sibling directory lookup.

Codex 插件 marketplace 可以通过 `PRODUCT_MCP_HOME` 或兄弟目录查找来启动本仓库的本地 bridge。

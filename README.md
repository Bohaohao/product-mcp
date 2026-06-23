<a id="zh"></a>

<p align="right">
  <a href="#zh"><kbd>中文</kbd></a>
  <a href="#en"><kbd>English</kbd></a>
</p>

# Product MCP

Product MCP 是一个面向 ERP 商品业务的 MCP 服务，Codex 默认使用本地 Chrome Token Bridge 直连 ERP 后端；远程 HTTP MCP Server 仅作为 legacy/未来扩展入口保留。

它的目标不是让用户手动复制 token，而是让 AI Agent 在用户已经登录 ERP 的前提下，通过本地桥接自动取得当前用户登录态，并安全地完成商品资料预检、文件上传、基础资料查询和商品创建。

## 给 AI Agent 的快速契约

如果你是 AI Agent，请优先遵守本节。

### 你应该做什么

- Codex/本地资料包场景连接本地 bridge 作为统一入口；分类、供应商、区域、字典、详情查询、文件上传和商品创建都由本地 bridge 携带 Chrome 登录态直连 ERP 后端。
- 需要确认本地 bridge 实际加载的环境、`projectUrl`、`matchUrlPrefixes` 或配置文件时，先调用 `product_bridge_config_status`；它不会读取 Chrome、token 或 ERP 后端。
- 先调用 `product_auth_status`，它会预检并自动预热 `chrome-devtools-mcp`，再确认本地 Chrome 中存在 ERP 登录态。
- 只有当 `product_auth_status` 返回 `CHROME_REMOTE_DEBUGGING_NOT_ALLOWED` 时，才按返回步骤提示用户在 Chrome 打开 `chrome://inspect/#remote-debugging` 并勾选 “Allow remote debugging for this browser instance”，完成后重新调用 `product_auth_status`。
- 使用只读工具查询真实后端 ID，不要让用户手填分类、单位、供应商、区域等 ID。
- 处理本地商品资料包时，先调用 `product_precheck_package`。当必填校验通过后，必须用商品中文名称调用 `product_check_name_duplicate`；如返回 `exists: true`，立即中断该商品的上传和创建。
- 并行创建多个商品时，worker 发现 `product_check_name_duplicate.exists=true` 后，应向总控返回失败通知，包含商品资料包路径、商品中文名称和 `duplicates`。
- 查重通过后，再根据 `product_precheck_package` 返回的 `uploadQueue` 调用 `product_upload_file`。
- 调用 `product_upload_file` 时保留 `uploadQueue` 中的 `dedupeKey/sourceRelativePath/sourceLocalPath`，重复文件会复用第一次上传得到的 OSS URL。
- 大文件、图片、视频、PDF 等本地文件只通过 `product_upload_file` 拿 STS 后直传 OSS；创建商品时只传 OSS URL 和业务字段。
- 创建商品前，向用户总结即将写入的关键信息，并取得明确确认。
- 只有在用户确认后，才调用 `product_create`，并传入 `confirm: true`。
- 商品创建成功后，调用 `product_get_detail` 验证结果。
- 大整数 ID 一律按字符串传入，避免 JavaScript 精度丢失。

### 你不应该做什么

- 不要要求用户粘贴或暴露 `Admin-Token`。
- 不要在没有用户明确确认的情况下调用 `product_create`。
- 不要把本地文件路径直接交给远程 HTTP MCP；远程服务不能读取用户本地文件，并且 Codex 主链路不依赖远端 MCP。
- 不要把视频、图片、附件等文件内容或 base64 塞进 MCP 请求；这会触发 `Payload Too Large`、网关超时或 MCP 请求超时。
- `status=3` 表示作废状态；只有用户明确要求创建为作废状态时才传入。

### 推荐创建流程

1. `product_bridge_config_status`
2. `product_auth_status`
3. `product_precheck_package`
4. `product_list_categories`
5. `product_get_category_config`
6. `product_list_suppliers`
7. `product_list_regions`
8. `product_get_dict`
9. `product_check_name_duplicate`
10. `product_upload_file`
11. 向用户总结并确认写入操作
12. `product_create`，必须包含 `confirm: true`
13. `product_get_detail`

## 这个仓库做什么

Product MCP 提供三类能力：

| 能力 | 说明 |
| --- | --- |
| 本地 Chrome Token Bridge | 通过 Chrome DevTools MCP 读取用户已登录 ERP 页面中的 `localStorage.Admin-Token`，并直连 ERP 后端完成查询、上传、创建和验收 |
| 本地文件工具 | 预检商品资料包、校验文件、按要求裁剪图片、通过 STS 上传 OSS |
| 远程 HTTP MCP Server | legacy/未来扩展入口；Codex 默认主链路不依赖它 |

### 本地与远程边界

推荐边界是：Codex 用户只使用本地 bridge。bridge 会自动读取 Chrome 登录态，并直连 ERP 后端完成查询、文件上传、创建和详情验收。远程 MCP 不再是 Codex 主链路的一部分，只在未来需要非 Codex 客户端或远程授权扩展时重新部署。

| 场景 | 应使用 | 原因 |
| --- | --- | --- |
| Chrome 登录态、`Admin-Token` 缓存 | 本地 bridge | token 只存在用户 Chrome，本地读取且不返回 token 内容 |
| 本地资料包、`D:\...` 路径、图片裁剪 | 本地 bridge | 远程服务不能读取用户磁盘 |
| 大视频、图片、PDF、3D 文件上传 | 本地 bridge 的 `product_upload_file` | 本地校验后直传 OSS，避免远程 HTTP MCP 的请求体大小和超时限制 |
| 分类、单位、供应商、区域、字典查询 | 本地 bridge 直连 ERP 后端 | 后端数据权威，同时避免依赖远端 MCP 服务可用性 |
| 创建商品 | 本地 bridge 直连 ERP 后端 | 避免合法大字段触发远端 MCP 网关请求体限制 |
| 查询详情 | 本地 bridge 直连 ERP 后端 | 创建后验收不依赖远端 MCP 服务可用性 |

因此，Codex 场景不再需要远程 MCP。商品创建时应先把本地文件通过 `product_upload_file` 上传为 OSS URL，再把 URL 传给 `product_create`；本地 bridge 会直连 ERP 后端提交创建请求。

## 架构

```text
MCP Client
  -> Local Token Bridge, stdio
    -> Chrome DevTools MCP
      -> logged-in ERP tab
      -> localStorage.Admin-Token
    -> ERP backend APIs
    -> OSS STS API
```

## 工具清单

### 远程 HTTP MCP 工具

这些工具仍可由远程 MCP Server 暴露，用于 legacy 或未来扩展入口；Codex 默认不依赖远端 MCP。远程调用需要请求携带当前用户的 `Authorization`，不接收本地文件路径、文件内容或 base64 大文件。

| Tool | 读写 | 用途 |
| --- | --- | --- |
| `product_list_categories` | 只读 | 查询商品分类树 |
| `product_get_category_config` | 只读 | 查询分类下的单位、基础配置、技术参数、可选配置 |
| `product_list_suppliers` | 只读 | 查询并扁平化供应商选项 |
| `product_list_regions` | 只读 | 查询适用区域 |
| `product_get_dict` | 只读 | 查询系统字典 |
| `product_check_name_duplicate` | 只读 | 按商品中文名称查询是否存在同名商品，创建前查重 |
| `product_get_detail` | 只读 | 创建后查询商品详情，用于验收 |
| `product_create` | 写入 | 远程 MCP legacy 写入入口；Codex 默认通过本地 bridge 直连 ERP 后端 |

### 本地 Bridge 工具

这些工具在本地 bridge 中可用。本地路径读取、图片裁剪、文件上传、ERP 查询、商品创建和创建后验收都应通过本地 bridge 完成。

| Tool | 读写 | 用途 |
| --- | --- | --- |
| `product_bridge_config_status` | 只读 | 返回本地 bridge 实际生效的环境、URL 前缀和配置路径，不读取 Chrome 或 token |
| `product_auth_status` | 只读 | 检查 Chrome ERP 登录态是否可用，不返回 token 内容 |
| `product_precheck_package` | 本地只读 | 解析并校验本地商品资料包 |
| `product_check_name_duplicate` | 只读 | 必填校验通过后、上传前按商品中文名称查重 |
| `product_upload_file` | 上传写入 | 校验、必要时裁剪并上传本地文件到 OSS |
| ERP 后端直连工具 | 混合 | 自动携带 Chrome token 调用 ERP 后端，不依赖远端 MCP |

## 安装与运行

需要 Node.js 18.18 或更高版本。

```bash
npm ci
npm run build
npm start
```

本地 smoke 测试：

```bash
npm run smoke
```

`smoke` 测试不会创建真实商品。它会启动模拟后端，验证工具注册、请求映射和响应归一化。

## 远程 MCP Server

默认端点：

```text
POST /mcp
GET /healthz
```

### 环境变量

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

`PRODUCT_MCP_BACKEND_BASE_URL` 必须是服务端可访问的后端 API 基础地址，语义上应等同于前端 `/api` 或 `/dev-api` 指向的后端。

### 鉴权

远程 MCP 请求需要携带：

```http
Authorization: Bearer <user-token>
```

服务端会把同一个 `Authorization` 转发给 ERP 后端，并附带配置中的 `clientid` 请求头。

## 本地 Token Bridge

本地 bridge 是推荐给 Codex 用户的入口。它可以避免用户手动复制 token。

### Bridge 配置

默认配置文件：

```text
product-token-bridge.config.json
```

关键字段：

```json
{
  "environment": "stage",
  "environments": {
    "stage": {
      "projectUrl": "https://test.eysscm.com/erp/commodity/commodity",
      "matchUrlPrefixes": ["https://test.eysscm.com/erp/"],
      "backendBaseUrl": "https://test.eysscm.com/api"
    },
    "prod": {
      "projectUrl": "https://eysscm.com/erp/commodity/commodity",
      "matchUrlPrefixes": ["https://eysscm.com/erp/", "https://www.eysscm.com/erp/"],
      "backendBaseUrl": "https://eysscm.com/api"
    }
  },
  "tokenStorageKey": "Admin-Token",
  "clientId": "e5cd7e4891bf95d1d19206ce24a7b32e",
  "language": "zh_CN"
}
```

`environment` 默认使用 `stage`。如需切到生产环境，可以把配置改为 `"environment": "prod"`，或在启动 bridge 前设置 `PRODUCT_MCP_ENV=prod`。`PRODUCT_MCP_PROJECT_URL`、`PRODUCT_MCP_MATCH_URL_PREFIXES`、`PRODUCT_MCP_BRIDGE_BACKEND_BASE_URL` 可用于临时覆盖对应地址。

### MCP Client 配置

如果希望 MCP 客户端自动从 Chrome 获取登录态，可以配置 stdio server：

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

使用 bridge 前，用户必须先在 Chrome 中登录 ERP 系统，并保留一个匹配 `matchUrlPrefixes` 的 ERP 页面。

### Token 缓存与失效

本地 bridge 会在进程内缓存第一次读取到的 `Admin-Token`，最长缓存 2 小时。缓存只存在于当前 bridge 进程内存中，不写入磁盘，也不会返回 token 内容。

缓存命中时，后续工具调用会直接复用 token，避免每次都重新唤起 Chrome DevTools MCP 调试确认窗口。

第一次需要读取 Chrome 登录态时，bridge 会先通过 npm 预检并自动解析 `chrome-devtools-mcp@latest`。如果当前机器缺少该 npm 包但 npm 网络可用，会自动安装/缓存后继续；如果 npm、网络或代理不可用，`product_auth_status` 会返回 `CHROME_DEVTOOLS_MCP_UNAVAILABLE` 和恢复建议。

没有有效 token 缓存时，bridge 会正常尝试连接 Chrome 并读取 ERP 页面的 token。它会优先直接读取当前选中的 Chrome 页面；如果当前页不是 ERP 页面或没有 token，才回退到页面列表匹配。回退时会在 `select_page` 后校验 `evaluate_script` 实际运行的 `location.href`，如果没有落到匹配页，会用 `bringToFront: true` 再选中一次并重试；仍不一致时返回页面上下文不匹配原因。只有在 `chrome-devtools-mcp` 已可用但无法连接 Chrome 时，才返回 `CHROME_REMOTE_DEBUGGING_NOT_ALLOWED` 和远程调试操作步骤；如果 Chrome 可连接但 ERP 未登录或 token 不存在，则按登录态缺失处理。`0.1.12` 起，只有在匹配页失败、页上下文错配、token 读取失败等错误路径中，才会附带脱敏后的 `chromePages` 诊断；正常成功结果不会返回页签列表，也不应把列页签作为常规步骤。

缓存失效规则：

- 超过 2 小时自动失效，下次调用会重新从 Chrome 读取。
- 远程 Product MCP 或 ERP 后端返回 401/403 时，bridge 会清空缓存，重新从 Chrome 读取 token，并自动重试一次。
- 如果短时间内连续出现 401/403，bridge 不会每次都重新唤起 Chrome；它会保留最近一次刷新结果并返回后端错误，避免权限错误或持续失效状态造成反复 Chrome 远程调试确认。
- `product_auth_status` 支持 `forceRefresh: true`，用于主动绕过缓存并重新读取 Chrome。

## 部署

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

验证：

```bash
curl http://127.0.0.1:8787/healthz
```

### Docker

```bash
cd product-mcp
docker build -t product-mcp:0.1.12 .
docker run -d --name product-mcp --env-file deploy.env -p 8787:8787 product-mcp:0.1.12
```

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

## 工具细节

### `product_bridge_config_status`

返回本地 bridge 实际生效的配置，不读取 Chrome、不读取 token、不请求 ERP 后端。适合插件代理或 AI Agent 在排查旧 URL、环境切换、配置更新是否生效时使用。

成功结果示例：

```json
{
  "ok": true,
  "bridge": {
    "name": "product-token-bridge",
    "version": "0.1.12",
    "configPath": "C:\\Users\\user\\.erp-product\\product-token-bridge.config.json"
  },
  "environment": "stage",
  "projectUrl": "https://test.eysscm.com/erp/commodity/commodity",
  "matchUrlPrefixes": ["https://test.eysscm.com/erp/"],
  "tokenStorageKey": "Admin-Token",
  "readsChromeToken": false
}
```

### `product_auth_status`

检查配置的 Chrome ERP 页面中是否存在 `localStorage.Admin-Token`。

当 `chrome-devtools-mcp` 已安装但无法连接 Chrome 时，会返回远程调试操作步骤：

```json
{
  "ok": false,
  "code": "CHROME_REMOTE_DEBUGGING_NOT_ALLOWED",
  "requiresUserAction": true,
  "remoteDebuggingSettingsUrl": "chrome://inspect/#remote-debugging",
  "steps": [
    "1. 确认使用的是 Chrome浏览器，不是 Edge浏览器。",
    "2. 在 Chrome 地址栏打开：chrome://inspect/#remote-debugging",
    "3. 勾选或开启 “Allow remote debugging for this browser instance”。",
    "4. 回到或新开 ERP 页面：https://test.eysscm.com/erp/commodity/commodity",
    "5. 确认 ERP 页面已登录；如果登录过期，请重新登录并刷新页面。",
    "6. 完成后回到 Codex，重新检查登录态。"
  ],
  "nextToolCall": {
    "name": "product_auth_status",
    "arguments": {}
  }
}
```

AI 应等待用户完成上述操作后，再按 `nextToolCall` 继续。不要把“没有 token 缓存”直接解释成远程调试未开启；遇到 `Could not find DevToolsActivePort` 时，应优先提示用户打开 `chrome://inspect/#remote-debugging` 并勾选允许项。

成功结果示例：

```json
{
  "ok": true,
  "environment": "stage",
  "projectUrl": "https://test.eysscm.com/erp/commodity/commodity",
  "matchUrlPrefixes": ["https://test.eysscm.com/erp/"],
  "matchedPageUrl": "https://test.eysscm.com/erp/commodity/commodity",
  "tokenStorageKey": "Admin-Token",
  "tokenPresent": true,
  "tokenProvider": "token_bridge_daemon",
  "tokenSource": "cache",
  "tokenCache": {
    "enabled": true,
    "maxTtlSeconds": 7200,
    "fromCache": true,
    "fetchedAt": "2026-06-17T08:00:00.000Z",
    "expiresAt": "2026-06-17T10:00:00.000Z",
    "expiresInSeconds": 6500
  }
}
```

### `product_precheck_package`

本地运行。读取商品资料包目录或商品资料 Markdown 文件，解析已支持字段和文件表格，校验本地文件，并返回创建草稿和上传队列。

仓库内提供最新字段范本：

```text
templates/商品资料模板.md
```

使用时把这个文件复制到用户自己的商品资料包目录，命名为 `商品资料.md`，再替换商品字段、供应商、分类名称和文件相对路径。模板中的本地文件路径只是结构示例，真实创建前必须指向用户资料包中实际存在的文件。

输入：

```json
{
  "packagePath": "D:\\path\\to\\product-package",
  "includeDraft": true
}
```

说明：

- 不上传文件。
- 不创建商品。
- 必要时会使用 `sharp` 强制裁剪有比例要求的图片。
- 裁剪产物写入 `.generated/prepared/`。
- `uploadQueue` 每一项都会带上 `dedupeKey`、`sourceRelativePath`、`sourceLocalPath`。AI 调用 `product_upload_file` 时应原样保留这些字段，用于同一资料包内重复文件的 OSS URL 复用。

命令行验证：

```bash
npm run build
node dist/packagePrecheckCli.js "D:/path/to/product-package"
```

### `product_check_name_duplicate`

只读工具。按商品中文名称查询 ERP 商品管理列表，并在 MCP 侧做精确同名判断。

后端接口：

```text
POST /user/erp/product/_page
```

输入：

```json
{
  "productNameCn": "测试商品",
  "pageSize": 20
}
```

使用规则：

- 仅在 `product_precheck_package` 必填校验通过后调用。
- 必须在任何 `product_upload_file` 或 `product_create` 之前调用。
- 如果返回 `exists: true` 或 `blocking: true`，中断该商品上传和创建，并向用户说明已存在同名商品。
- 多商品并行 worker 必须把该失败通知返回给总控，包含资料包路径、商品中文名称和 `duplicates`。

### `product_upload_file`

本地运行。校验本地文件，必要时处理图片，通过 ERP 后端获取 OSS STS token，直传 OSS，并返回 OSS URL。同一 bridge 进程内，如果再次上传相同 `dedupeKey` 且源文件未变化，会直接复用第一次上传的 OSS URL，结果中 `reusedUpload` 为 `true`。

视频、图片、PDF、3D 文件等不要通过远程 HTTP MCP 传文件内容或 base64。`product_upload_file` 会在本地读取文件并直传 OSS，商品创建时只需要使用返回的 OSS URL。

输入：

```json
{
  "localPath": "D:/path/to/file.png",
  "usage": "productMainImage",
  "title": "optional title",
  "description": "optional description",
  "languageList": ["zh", "en"],
  "dedupeKey": "optional key from product_precheck_package",
  "sourceRelativePath": "./图片/main.png",
  "sourceLocalPath": "D:/path/to/product-package/图片/main.png"
}
```

常用 `usage`：

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

本地 bridge 版本的 `product_create` 会读取 Chrome 登录态，并在本机直接调用 ERP 后端创建接口，不再把完整创建 payload 转发给远端 MCP 网关。这样长图文、销售支持、竞品对比、案例等合法大字段不会因为远端 MCP 网关请求体限制触发 `Payload Too Large`。

写入操作。通过以下后端接口创建真实 ERP 商品：

```text
POST /user/erp/commodity
```

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

`confirm: true` 是必填项。`status` 支持 `1` 上架、`2` 下架、`3` 作废；默认建议使用 `1`，只有用户明确要求作废状态时才传 `3`。

`product_create` 兼容两种输入风格：可以继续使用 `supplierId`、`supplierName`、`packageInfo` 等 MCP 便捷字段；也可以直接使用后端 `CommoditySaveDTO` 的 `suppliers` 数组、顶层包装/装柜字段、`tenantId`、`relatedCommodityId` 等字段。两者同时存在时，顶层后端 DTO 字段优先覆盖 `packageInfo` 中的同名包装字段。

`product_create` 只应接收业务字段和已经上传得到的 OSS URL。不要把本地路径、二进制文件内容或 base64 大文件传给它。

成功结果示例：

```json
{
  "ok": true,
  "id": "123456",
  "productId": "123456",
  "frontendEditPath": "/erp/commodity/editCommodity/123456",
  "frontendViewPath": "/erp/commodity/viewCommodity/123456"
}
```

## 排错

### 未获取到 Chrome token

可能原因：

- Chrome 未打开。
- ERP 页面未登录。
- 当前页面 URL 不匹配 `matchUrlPrefixes`。
- 目标环境的 token key 不是 `Admin-Token`。

推荐给用户的提示：

```text
请打开 Chrome 并登录 ERP 系统，保留一个匹配配置 URL 前缀的 ERP 页面，刷新页面后重新调用 product_auth_status。
```

### 远程 MCP 返回 401

- 直接 HTTP 连接必须提供 `Authorization: Bearer <user-token>`。
- 使用本地 bridge 时，先检查 `product_auth_status`。

### 本地文件路径失败

- 远程 MCP 不能读取本地路径。
- 本地路径应通过本地 bridge 的 `product_precheck_package` 或 `product_upload_file` 处理。
- 确认路径为绝对路径，或相对于 bridge 进程工作目录。

### Payload Too Large 或上传超时

- 不要把大视频、高清图片、PDF、3D 文件或 base64 内容传给远程 HTTP MCP。
- 先调用本地 bridge 的 `product_upload_file`，让文件从用户机器直传 OSS。
- 再把返回的 OSS URL 放入 `product_create` 的 `medias`、`certifications`、`salesSupports` 或其它业务字段。

## 仓库拆分建议

本仓库只负责 Product MCP 运行时代码。

推荐使用两个兄弟仓库：

```text
product-mcp          # 本仓库，MCP server 和 bridge
erp-product-plugin   # Codex plugin marketplace wrapper
```

Codex plugin marketplace 可以通过 `PRODUCT_MCP_HOME` 或兄弟目录查找来启动本仓库的本地 bridge。

---

<a id="en"></a>

<p align="right">
  <a href="#zh"><kbd>中文</kbd></a>
  <a href="#en"><kbd>English</kbd></a>
</p>

# Product MCP

Product MCP is an MCP service for ERP product operations. It includes a remote HTTP MCP Server and a local Chrome Token Bridge.

Its goal is to avoid manual token copying. When the user has already logged in to ERP in Chrome, an AI Agent can use the local bridge to obtain the current login state safely, then precheck product packages, upload files, query ERP references, and create products.

## Quick Contract For AI Agents

If you are an AI Agent, read this section first.

### What You Should Do

- In Codex/local package workflows, connect to the local bridge as the single entry point. Category, supplier, region, dictionary, detail lookup, file upload, and product creation all use the Chrome login state through the local bridge and call the ERP backend directly.
- To confirm the local bridge's effective environment, `projectUrl`, `matchUrlPrefixes`, or config path, call `product_bridge_config_status` first. It does not read Chrome, the token, or the ERP backend.
- Call `product_auth_status` first. It preflights and warms `chrome-devtools-mcp`, then confirms that the ERP login state is available in local Chrome.
- Only when `product_auth_status` returns `CHROME_REMOTE_DEBUGGING_NOT_ALLOWED`, stop the task, tell the user to open `chrome://inspect/#remote-debugging` in Chrome and enable "Allow remote debugging for this browser instance", then call `product_auth_status` again after the user completes those steps.
- Use read-only lookup tools to resolve real backend IDs. Do not ask the user to manually fill category, unit, supplier, or region IDs.
- For a local product package, call `product_precheck_package` first. After required-field validation passes, call `product_check_name_duplicate` with the Chinese product name; if it returns `exists: true`, stop upload and creation for that product.
- In parallel multi-product creation, a worker that sees `product_check_name_duplicate.exists=true` must notify the controller with the package path, Chinese product name, and `duplicates`.
- After duplicate check passes, call `product_upload_file` for items in the returned `uploadQueue`.
- Preserve `dedupeKey/sourceRelativePath/sourceLocalPath` from each `uploadQueue` item when calling `product_upload_file`; repeated files reuse the first OSS URL.
- Upload large files, images, videos, PDFs, and other local files only through `product_upload_file`, which obtains STS and uploads directly to OSS; pass only OSS URLs and business fields to product creation.
- Before creating a product, summarize the key fields that will be written and ask the user for explicit confirmation.
- Call `product_create` only after confirmation, and pass `confirm: true`.
- After creation succeeds, call `product_get_detail` to verify the result.
- Pass large numeric IDs as strings to avoid JavaScript precision loss.

### What You Should Not Do

- Do not ask the user to paste or reveal `Admin-Token`.
- Do not call `product_create` without explicit user confirmation.
- Do not pass local file paths directly to the remote HTTP MCP. The remote server cannot read local user files, and the Codex main path does not depend on remote MCP.
- Do not put video, image, attachment, or base64 file content into MCP requests. This can cause `Payload Too Large`, gateway timeouts, or MCP request timeouts.
- `status=3` means void. Pass it only when the user explicitly asks to create the product in a voided state.

### Recommended Creation Flow

1. `product_bridge_config_status`
2. `product_auth_status`
3. `product_precheck_package`
4. `product_list_categories`
5. `product_get_category_config`
6. `product_list_suppliers`
7. `product_list_regions`
8. `product_get_dict`
9. `product_check_name_duplicate`
10. `product_upload_file`
11. Summarize the write operation and ask the user to confirm
12. `product_create` with `confirm: true`
13. `product_get_detail`

## What This Repository Does

Product MCP provides three capability groups:

| Capability | Description |
| --- | --- |
| Local Chrome Token Bridge | Reads `localStorage.Admin-Token` from a logged-in ERP page through Chrome DevTools MCP, then calls the ERP backend directly for lookup, upload, creation, and verification |
| Local File Tools | Prechecks product packages, validates files, crops images when required, and uploads files to OSS through STS |
| Remote HTTP MCP Server | Legacy/future extension entry point; the Codex default path does not depend on it |

### Local And Remote Boundary

The recommended boundary is: Codex users use only the local bridge. The bridge reads the Chrome login state and calls the ERP backend directly for lookup, file upload, product creation, and detail verification. Remote MCP is no longer part of the Codex main path; redeploy it only when non-Codex clients or remote-auth extension paths are needed.

| Scenario | Use | Why |
| --- | --- | --- |
| Chrome login state and `Admin-Token` cache | Local bridge | The token lives in the user's Chrome; the bridge reads it locally and never returns the token value |
| Local product packages, `D:\...` paths, image cropping | Local bridge | The remote service cannot read the user's disk |
| Large videos, images, PDFs, 3D files | `product_upload_file` in the local bridge | The file is validated locally and uploaded directly to OSS, avoiding remote HTTP MCP request-size and timeout limits |
| Category, unit, supplier, region, and dictionary lookup | Local bridge direct ERP backend call | Backend reference data stays authoritative without depending on remote MCP availability |
| Product creation | Local bridge direct ERP backend call | Avoids remote MCP gateway body limits for valid large create payloads |
| Product detail lookup | Local bridge direct ERP backend call | Post-create verification does not depend on remote MCP availability |

For Codex workflows, remote MCP is no longer required. Upload local files through `product_upload_file` first, then pass the returned OSS URLs to `product_create`; the local bridge submits the request directly to the ERP backend.

## Architecture

```text
MCP Client
  -> Local Token Bridge, stdio
    -> Chrome DevTools MCP
      -> logged-in ERP tab
      -> localStorage.Admin-Token
    -> ERP backend APIs
    -> OSS STS API
```

## Tool Surface

### Remote HTTP MCP Tools

These tools can still run on the remote MCP Server for legacy or future extension entry points. Codex does not depend on the remote MCP by default. Remote calls must carry the current user's `Authorization` and must not include local file paths, file bytes, or large base64 payloads.

| Tool | Access | Purpose |
| --- | --- | --- |
| `product_list_categories` | Read | Query the product category tree |
| `product_get_category_config` | Read | Query units, base configs, technical params, and optional configs for a category |
| `product_list_suppliers` | Read | Query and flatten supplier options |
| `product_list_regions` | Read | Query applicable regions |
| `product_get_dict` | Read | Query system dictionary values |
| `product_check_name_duplicate` | Read | Check whether a same Chinese product name already exists before creation |
| `product_get_detail` | Read | Query product details after creation for verification |
| `product_create` | Write | Legacy remote write entry point; Codex defaults to local bridge direct ERP backend calls |

### Local Bridge Tools

These tools are available in the local bridge. Local path reads, image preparation, file uploads, ERP lookups, product creation, and post-create verification should go through the local bridge.

| Tool | Access | Purpose |
| --- | --- | --- |
| `product_bridge_config_status` | Read | Return the effective local bridge environment, URL prefixes, and config path without reading Chrome or token |
| `product_auth_status` | Read | Check whether Chrome ERP login state is available without returning token content |
| `product_precheck_package` | Local read | Parse and validate a local product package |
| `product_check_name_duplicate` | Read | Check duplicate Chinese product name after required validation and before upload |
| `product_upload_file` | Upload write | Validate, optionally crop, and upload a local file to OSS |
| ERP backend direct tools | Mixed | Call the ERP backend with the Chrome token attached automatically, without remote MCP |

## Install And Run

Node.js 18.18 or later is required.

```bash
npm ci
npm run build
npm start
```

Local smoke test:

```bash
npm run smoke
```

The smoke test does not create a real product. It starts a fake backend and verifies tool registration, request mapping, and response normalization.

## Remote MCP Server

Default endpoints:

```text
POST /mcp
GET /healthz
```

### Environment Variables

Copy `.env.example` and set real values in the deployment environment.

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

`PRODUCT_MCP_BACKEND_BASE_URL` must be a server-side reachable backend API base URL. Semantically, it should point to the same backend as the frontend `/api` or `/dev-api` proxy.

### Authentication

Remote MCP requests must include:

```http
Authorization: Bearer <user-token>
```

The server forwards the same `Authorization` to ERP backend APIs and also sends the configured `clientid` request header.

## Local Token Bridge

The local bridge is the recommended entry point for Codex users. It avoids manual token copying.

### Bridge Config

Default config file:

```text
product-token-bridge.config.json
```

Important fields:

```json
{
  "environment": "stage",
  "environments": {
    "stage": {
      "projectUrl": "https://test.eysscm.com/erp/commodity/commodity",
      "matchUrlPrefixes": ["https://test.eysscm.com/erp/"],
      "backendBaseUrl": "https://test.eysscm.com/api"
    },
    "prod": {
      "projectUrl": "https://eysscm.com/erp/commodity/commodity",
      "matchUrlPrefixes": ["https://eysscm.com/erp/", "https://www.eysscm.com/erp/"],
      "backendBaseUrl": "https://eysscm.com/api"
    }
  },
  "tokenStorageKey": "Admin-Token",
  "clientId": "e5cd7e4891bf95d1d19206ce24a7b32e",
  "language": "zh_CN"
}
```

`environment` defaults to `stage`. To switch to production, set `"environment": "prod"` in the config or start the bridge with `PRODUCT_MCP_ENV=prod`. `PRODUCT_MCP_PROJECT_URL`, `PRODUCT_MCP_MATCH_URL_PREFIXES`, and `PRODUCT_MCP_BRIDGE_BACKEND_BASE_URL` can temporarily override those resolved URLs.

### MCP Client Config

Use this stdio server config when the MCP client should get the login state from Chrome automatically:

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

Before using the bridge, the user must log in to ERP in Chrome and keep an ERP page that matches `matchUrlPrefixes`.

### Token Cache And Invalidation

The local bridge caches the first `Admin-Token` it reads in process memory for up to 2 hours. The cache is memory-only, never written to disk, and the token value is never returned.

When the cache is valid, later tool calls reuse the token and avoid reopening the Chrome DevTools MCP confirmation flow for every call.

The first time Chrome login state is needed, the bridge preflights and resolves `chrome-devtools-mcp@latest` through npm. If the package is missing and npm network access works, it is installed/cached automatically before continuing. If npm, network, or proxy access fails, `product_auth_status` returns `CHROME_DEVTOOLS_MCP_UNAVAILABLE` with recovery guidance.

When there is no valid token cache, the bridge normally tries to connect to Chrome and read the ERP page token. It first tries to read the currently selected Chrome page directly. If that page is not an ERP page or has no token, it falls back to page-list matching. During fallback, after `select_page`, the bridge verifies the `location.href` where `evaluate_script` actually ran. If it did not land on the matched page, the bridge selects again with `bringToFront: true` and retries; if it is still mismatched, it returns a page-context mismatch reason. It returns `CHROME_REMOTE_DEBUGGING_NOT_ALLOWED` with remote-debugging steps only when `chrome-devtools-mcp` is available but cannot connect to Chrome. If Chrome is reachable but ERP is not logged in or no token exists, handle it as a missing login state. Starting in `0.1.12`, redacted `chromePages` diagnostics are attached only on error paths such as no matching tab, page-context mismatch, or token read failure. Normal successful responses do not return tab lists, and tab listing must not become a routine step.

Cache invalidation rules:

- The token automatically expires after 2 hours; the next call reads from Chrome again.
- If the remote Product MCP or ERP backend returns 401/403, the bridge clears the cache, reads the token from Chrome again, and retries once.
- If 401/403 keeps happening in a short window, the bridge does not reopen Chrome for every call. It keeps the latest refreshed result and returns the backend error, avoiding repeated Chrome remote-debugging prompts caused by permission errors or a persistently invalid token.
- `product_auth_status` supports `forceRefresh: true` to bypass the cache and read from Chrome manually.

## Deployment

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

```bash
curl http://127.0.0.1:8787/healthz
```

### Docker

```bash
cd product-mcp
docker build -t product-mcp:0.1.12 .
docker run -d --name product-mcp --env-file deploy.env -p 8787:8787 product-mcp:0.1.12
```

For HTTPS, place this service behind a company gateway or Nginx.

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

## Tool Details

### `product_bridge_config_status`

Returns the effective local bridge configuration without reading Chrome, reading the token, or calling the ERP backend. Use it when a plugin proxy or AI Agent needs to diagnose stale URLs, environment switching, or config-update pickup.

Example success result:

```json
{
  "ok": true,
  "bridge": {
    "name": "product-token-bridge",
    "version": "0.1.12",
    "configPath": "C:\\Users\\user\\.erp-product\\product-token-bridge.config.json"
  },
  "environment": "stage",
  "projectUrl": "https://test.eysscm.com/erp/commodity/commodity",
  "matchUrlPrefixes": ["https://test.eysscm.com/erp/"],
  "tokenStorageKey": "Admin-Token",
  "readsChromeToken": false
}
```

### `product_auth_status`

Checks whether the configured Chrome ERP page contains `localStorage.Admin-Token`.

When `chrome-devtools-mcp` is installed but cannot connect to Chrome, the tool returns remote-debugging steps:

```json
{
  "ok": false,
  "code": "CHROME_REMOTE_DEBUGGING_NOT_ALLOWED",
  "requiresUserAction": true,
  "remoteDebuggingSettingsUrl": "chrome://inspect/#remote-debugging",
  "steps": [
    "1. Open local Chrome and make sure it is Chrome, not Edge or another browser.",
    "2. Open chrome://inspect/#remote-debugging in the Chrome address bar.",
    "3. Enable “Allow remote debugging for this browser instance”.",
    "4. Return to or open the ERP page: https://test.eysscm.com/erp/commodity/commodity",
    "5. Make sure the ERP page is logged in; if the session expired, log in again and refresh.",
    "6. Return to Codex and check login state again."
  ],
  "nextToolCall": {
    "name": "product_auth_status",
    "arguments": {}
  }
}
```

AI agents should wait until the user completes those steps before following `nextToolCall`. Do not treat a missing token cache by itself as a remote-debugging failure. For `Could not find DevToolsActivePort`, tell the user to open `chrome://inspect/#remote-debugging` and enable the allow setting first.

Example success result:

```json
{
  "ok": true,
  "environment": "stage",
  "projectUrl": "https://test.eysscm.com/erp/commodity/commodity",
  "matchUrlPrefixes": ["https://test.eysscm.com/erp/"],
  "matchedPageUrl": "https://test.eysscm.com/erp/commodity/commodity",
  "tokenStorageKey": "Admin-Token",
  "tokenPresent": true,
  "tokenProvider": "token_bridge_daemon",
  "tokenSource": "cache",
  "tokenCache": {
    "enabled": true,
    "maxTtlSeconds": 7200,
    "fromCache": true,
    "fetchedAt": "2026-06-17T08:00:00.000Z",
    "expiresAt": "2026-06-17T10:00:00.000Z",
    "expiresInSeconds": 6500
  }
}
```

### `product_precheck_package`

Runs locally. It reads a product package directory or product Markdown file, parses supported fields and file tables, validates local files, and returns a create draft plus an upload queue.

The repository ships the latest field template:

```text
templates/商品资料模板.md
```

Copy this file into the user's own product package directory as `商品资料.md`, then replace product fields, supplier/category names, and relative file paths. File paths in the template are structural examples; before real creation they must point to files that actually exist in the user's package.

Input:

```json
{
  "packagePath": "D:\\path\\to\\product-package",
  "includeDraft": true
}
```

Notes:

- It does not upload files.
- It does not create a product.
- Images with required aspect ratios are force-cropped by `sharp` when needed.
- Cropped outputs are written under `.generated/prepared/`.
- Every `uploadQueue` item includes `dedupeKey`, `sourceRelativePath`, and `sourceLocalPath`. AI agents should preserve these fields when calling `product_upload_file` so repeated files in the same package can reuse the first OSS URL.

CLI verification:

```bash
npm run build
node dist/packagePrecheckCli.js "D:/path/to/product-package"
```

### `product_check_name_duplicate`

Read-only tool. It searches the ERP product management list by Chinese product name, then performs exact same-name matching inside MCP.

Backend endpoint:

```text
POST /user/erp/product/_page
```

Input:

```json
{
  "productNameCn": "测试商品",
  "pageSize": 20
}
```

Rules:

- Call it only after `product_precheck_package` required-field validation passes.
- Call it before any `product_upload_file` or `product_create`.
- If it returns `exists: true` or `blocking: true`, stop upload and creation for that product and explain that a same-name product already exists.
- In parallel multi-product creation, the worker must return a failure notification to the controller with the package path, Chinese product name, and `duplicates`.

### `product_upload_file`

Runs locally. It validates a local file, prepares an image when needed, obtains an OSS STS token from the ERP backend, uploads directly to OSS, and returns the OSS URL. In the same bridge process, uploading the same `dedupeKey` again with an unchanged source file reuses the first OSS URL and returns `reusedUpload: true`.

Do not send video, image, PDF, 3D file, or base64 file content through the remote HTTP MCP. `product_upload_file` reads the file locally and uploads it directly to OSS; product creation only needs the returned OSS URL.

Input:

```json
{
  "localPath": "D:/path/to/file.png",
  "usage": "productMainImage",
  "title": "optional title",
  "description": "optional description",
  "languageList": ["zh", "en"],
  "dedupeKey": "optional key from product_precheck_package",
  "sourceRelativePath": "./图片/main.png",
  "sourceLocalPath": "D:/path/to/product-package/图片/main.png"
}
```

Common `usage` values:

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

The local-bridge `product_create` reads Chrome login state and calls the ERP backend create endpoint directly from the user's machine. It no longer forwards the full create payload through the remote MCP gateway, so valid large fields such as rich sales support, competitor comparisons, media metadata, and customer cases do not hit remote MCP `Payload Too Large` limits.

Write operation. Creates a real ERP product through:

```text
POST /user/erp/commodity
```

Minimal input:

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

`confirm: true` is mandatory. `status` supports `1` on shelf, `2` off shelf, and `3` void. Prefer the default `1`; pass `3` only when the user explicitly asks for a voided state.

`product_create` accepts both input styles: existing MCP convenience fields such as `supplierId`, `supplierName`, and `packageInfo`; and backend `CommoditySaveDTO` fields such as `suppliers`, top-level package/container fields, `tenantId`, and `relatedCommodityId`. When both styles provide the same package field, the top-level backend DTO field wins over `packageInfo`.

`product_create` should receive only business fields and OSS URLs that were already uploaded. Do not pass local paths, binary file content, or large base64 payloads to it.

Example success result:

```json
{
  "ok": true,
  "id": "123456",
  "productId": "123456",
  "frontendEditPath": "/erp/commodity/editCommodity/123456",
  "frontendViewPath": "/erp/commodity/viewCommodity/123456"
}
```

## Troubleshooting

### Missing Chrome token

Likely causes:

- Chrome is not open.
- The ERP page is not logged in.
- The current page URL does not match `matchUrlPrefixes`.
- The token key in the target environment is not `Admin-Token`.

Recommended user-facing prompt:

```text
Please open Chrome, log in to the ERP system, keep an ERP page that matches the configured URL prefix, refresh the page, then call product_auth_status again.
```

### Remote MCP returns 401

- Direct HTTP clients must provide `Authorization: Bearer <user-token>`.
- Local bridge users should check `product_auth_status` first.

### Local file path fails

- Remote MCP cannot read local paths.
- Local paths should be handled through `product_precheck_package` or `product_upload_file` in the local bridge.
- Make sure the path is absolute, or relative to the bridge process working directory.

### Payload Too Large Or Upload Timeout

- Do not send large videos, high-resolution images, PDFs, 3D files, or base64 content to the remote HTTP MCP.
- Call `product_upload_file` in the local bridge first so the file uploads directly from the user's machine to OSS.
- Then pass the returned OSS URL into `product_create` fields such as `medias`, `certifications`, `salesSupports`, or other business fields.

## Repository Split

This repository should stay focused on Product MCP runtime code.

Recommended sibling repositories:

```text
product-mcp          # this repo, MCP server and bridge
erp-product-plugin   # Codex plugin marketplace wrapper
```

The Codex plugin marketplace wrapper can start this repository's local bridge through `PRODUCT_MCP_HOME` or sibling directory lookup.

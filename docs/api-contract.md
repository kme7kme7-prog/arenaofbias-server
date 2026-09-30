# API 契约 · arenaofbias-server

> 本文档是「娱乐面 React 站」与「专业面静态画廊」两个前端对接本后端的**唯一硬接口文档**。
> 文中全部端点、字段、状态码与限制均以 `server/` 目录当前代码为准逐条核实；
> 与代码现状存在出入、或尚待双方确认之处，均以「**待拍板**」标出。
>
> 核实基准：`server/app.mjs`（路由表）、`auth.mjs`、`library.mjs`、`arena.mjs`、`catalog.mjs`、`ranking.mjs`、`config.mjs`、`http.mjs`、`content.mjs`、`db.mjs`。

---

## 1. 总述

### 1.1 服务定位

本服务是整个体系中**唯一的动态服务与唯一写库者**，负责账号、投票、排行榜、投稿审核与作品沙盒伺服。`ArenaGalleri` 提供静态画廊前端与原作展示，`arenaofbias` 提供主站，`arenaofbias-server` 提供动态 API、数据库、`/admin/` 管理页面和投稿沙盒，`arenaofbias-data` 构建后端读取的馆藏数据包。两个用户前端各自部署并调用本服务；数据库（`DATA_DIR/platform.db`）由本服务独占，前端不直接读写。旧 same-prompt-gallery 已归档。

服务同时监听**两个端口**：

| 端口 | 默认 | 职责 |
| --- | --- | --- |
| 站点 / API 端口 | 5173 | 全部 `/api/*` 接口、`/admin/` 管理页面、`/media/*` 投稿媒体和数据包静态资源 |
| 作品内容端口 | 5180 | 按令牌子域伺服单个作品目录（沙盒隔离，见 3.12） |

### 1.2 Base URL

| 环境 | Base URL |
| --- | --- |
| 代码默认 | `http://localhost:5173`（API 与媒体）；作品内容为 `http://{token}.localhost:5180`；启动仍需提供 `DIST_DIR` 数据包 |
| 2026-09-28 本机联调 | 前端 `http://localhost:4175`；API 与媒体 `http://localhost:5190`；作品内容 `http://{token}.localhost:5191`。后端设 `PORT=5190`、`CONTENT_PORT=5191`、`SITE_ORIGINS=http://localhost:4175`、`DIST_DIR=<已构建数据包目录>`、`DATA_DIR=<隔离运行目录>`、`CAPTURE=0`；前端 API base URL 指向 `http://localhost:5190/` |
| 生产环境 | 正式 API 为 `https://api.arenaofbias.icu`，由 systemd `arenaofbias-server` 管理，API 监听 `127.0.0.1:5273`、作品监听 `127.0.0.1:5180`；作品源为 `*.w.arenaofbias.icu`。最近已记录发布版本见 [HANDOFF](../HANDOFF.md)，每次部署仍须现场核对。作品迁至独立可注册主域仍是已知运维项。 |

作品内容 URL 不写在各端点文档里逐个列出，而是由响应字段（`bootstrap.site.content`、作品对象的 `scene`、对战对象的 `a`/`b`）以完整 URL 形式下发，前端直接消费，不自行拼接。投稿 `captures` / `cover` 返回相对路径 `media/...`，前端以 API 站点根解析；馆藏 `scene` 路径取自画廊所用数据包。

### 1.3 认证方式

- 认证基于 **Cookie 会话**。注册 / 登录成功后，响应头种下：
  `COOKIE_SECURE=1` 时为 `Set-Cookie: __Host-sp_session=<token>; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure`（无 Domain）；未启用 Secure 的本地环境仍用 `sp_session`。
- 会话 Cookie 为 HttpOnly，前端脚本不可读；服务端只存其 SHA-256。重名会话 Cookie 按未登录处理。
- 前端请求需携带 Cookie（`fetch` 使用 `credentials: 'include'`，XHR 使用 `withCredentials = true`）。`COOKIE_SAME_SITE` 支持 `Lax`（默认）、`Strict`、`None`；跨站 HTTPS 部署设 `None` 并开启 `COOKIE_SECURE=1`，否则服务拒绝启动。第三方 Cookie 仍受浏览器设置限制，建议前端与 API 使用同站域名。
- 登出（`POST /api/auth/logout`）删除服务端会话并下发 `Max-Age=0` 的清空 Cookie。
- 角色：`member`（默认）与 `admin`。管理员账号只能经 CLI 新建（`npm run admin -- --create <用户名>`，密码从标准输入读取、不回显），或将已有普通账号提权（`npm run admin -- <用户名>` 或管理员角色接口）。公开注册拒绝 `ADMIN_USERNAMES` 中的保留用户名；已有账号登录时仍按该配置同步管理员角色。

### 1.4 通用错误格式

所有错误响应均为 JSON，形状如下（`server/http.mjs` 的 `HttpError`）：

```json
{ "error": "人类可读的中文错误信息", "code": "可选的机器可读代码" }
```

- `error` 恒存在，面向最终用户，可直接展示。
- `code` 仅在少数业务错误上出现，例如 `"insufficient"`（对战池不足）、`"exhausted"`（该用户已评完全部组合）。前端逻辑判断请用 `code`，不要匹配 `error` 文案。
- HTTP 状态码全集：`400`（参数无效）、`401`（未登录 / 凭证错误）、`403`（无权限 / 来源无效）、`404`（不存在）、`405`（方法不允许）、`409`（状态冲突）、`413`（体积超限）、`415`（Content-Type 非 JSON）、`429`（限流 / 待审超限）、`500`（服务端错误，固定文案「服务器出错了，请稍后再试」）。
- 非 GET/HEAD 的 `/api/*` 请求必须带有可信 `Origin`：请求自身的完整 origin 或 `SITE_ORIGINS` 白名单中的完整 origin（精确协议、主机与端口），否则 `403 请求来源无效`。同源判断只在 `TRUST_PROXY=1` 时使用代理传入的 HTTPS 协议。
- JSON 请求体默认上限 64 KB；`POST /api/works` 单独放宽至 6 MB（封面以 data URL 内嵌所致）。
- JSON 请求体必须是对象；合法的 `null`、数组或其它标量返回 `400`。

### 1.5 跨域约定（CORS）

- `SITE_ORIGINS` 同时控制可信前端的凭据 CORS、写请求与作品 `frame-ancestors`；填写不含路径或末尾 `/` 的 origin，以逗号分隔。不反射任意来源，不使用 `*`。
- 可信来源的 API、媒体与数据包静态响应下发 `Access-Control-Allow-Origin: <origin>`、`Access-Control-Allow-Credentials: true` 与 `Vary: Origin`，包括 API 错误响应。
- 可信来源的响应还下发 `Access-Control-Expose-Headers: X-Datapack-Stale`，使跨域前端可读取数据包过期提示头。
- `/api/*` 的 OPTIONS 预检按请求方法匹配已有路由，成功返回 `204`；允许 `Content-Type` 和 `X-Datapack-Version`，缓存 600 秒。未知端点返回 `404`，不支持的方法返回 `405`，外部来源或其它请求头返回 `403`。
- 非可信来源的读响应不下发许可头；非可信来源的 API 写请求和预检被拒绝。无 Origin 的读请求仍可供服务端与 CLI 使用。

### 1.6 限流一览

限流为固定窗口计数（`http.mjs` 的 `rateLimit`），命中返回 `429`，错误文案因桶而异：

| 桶 | 额度 | 计数键 | 作用于 |
| --- | --- | --- | --- |
| auth | 10 次 / 分钟 | 客户端 IP | 注册、登录 |
| write | 120 次 / 分钟 | 用户 ID（未登录时为 IP） | 投稿提交、投票、表情、评论写入/删除、校准写回 |
| drafts | 12 次 / 10 分钟 | 用户 ID | 上传草稿 |
| matches | 60 次 / 分钟 | 用户 ID（未登录时为 IP） | 创建对战 |
| guess result | 20 次 / 分钟 | 客户端 IP | `POST /api/guess/result`，另受 guess/matches 桶约束 |
| export | 2000 次 / 分钟 | 导出令牌 | 导出元数据及文件；另有每 IP 10000 次 / 分钟兜底 |
| read API | 180 次 / 分钟 | 客户端 IP | `/api/*` GET/HEAD（收录导出除外），跨端点、登录状态共享 |
| read catalog | 30 次 / 分钟 | 客户端 IP | bootstrap、show1/works、works、prompts、votes、ratings、leaderboard、guess/today 的 GET/HEAD，共用一桶，参数不影响计数 |
| read files | 1200 次 / 分钟 | 客户端 IP | 后端静态文件与所有作品源 GET/HEAD，共用一桶 |
| read pages | 60 次 / 分钟 | 客户端 IP | 所有作品源 HTML/HTM，共用一桶；HTML 同时计入 read files |

读取额度可通过 `READ_API_PER_MIN`、`READ_CATALOG_PER_MIN`、`READ_FILES_PER_MIN`、`READ_PAGES_PER_MIN` 调整（最小 1）。超限响应带 `Retry-After` 秒数；可信 Origin 的 API 错误仍保留 CORS 许可。HEAD 计数与 GET 相同。OPTIONS 和写 API 不占读取额度，继续沿用自己的来源校验和写限流。

`/api/curate/export/:token` 及其 `/file` 由 export 桶单独计数，不受新的通用 API/边缘资源桶限制，保持批量收录所需额度。导出令牌的校验、失效及每 IP 兜底不变。

API 域静态 `/data.json`（含等价编码路径）仅管理员登录后返回；其他访问返回 404。`.datapack-source.json` 对所有人返回 404。管理员页面无需改请求方式；画廊使用自己部署的展示目录。Show1 榜单与配对分由后端聚合，逐票兼容接口保留，详见 3.21。VPS 的两个静态前端需安装 Nginx 读取限制，详见 [部署说明](deploy.md#公开读取与反爬配置)。

`TRUST_PROXY=1` 仅适用于本机单层反代：连接来源必须为环回地址，IP 取 `X-Forwarded-For` 最后一项有效 IP；其他连接或无效头回退到连接 IP。边缘代理必须覆盖原头或在尾部追加真实客户端 IP，多层代理部署须另行明确解析链路。限流为单机内存计数，进程重启即清零，多实例部署不共享。

---

## 2. 数据模型

以下字段定义以 `server/db.mjs`（表结构）与 `server/catalog.mjs`（馆藏读取）为准。HTTP 层暴露的是经 `library.toPublic` 整形后的「公开视图」，二者分列。

### 2.1 作品（work）

作品分两类：**馆藏作品**（curated，随数据包 `dist/data.json` 分发，平台视为已验证）与**投稿作品**（upload，写入数据库，走审核流）。

**投稿作品（数据库行，时间均为毫秒整数）：**

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | `up-` + 8 位小写字母数字（如 `up-3f9k2m1x`） |
| `taskId` | string | 所属题目 ID |
| `ownerId` / `ownerName` | string / null | 作者；作者账号删除后为 null |
| `title` / `summary` / `note` | string | 标题（≤40 字）/ 简介（≤200 字）/ 备注（≤1000 字） |
| `modelId` / `modelName` / `vendor` | string / null | 模型归属；`modelId` 命中数据包模型表时名称与厂商取自模型表 |
| `effort` | string | 强度档位，大小写不敏感地归入 `Low / Medium / High / XHigh / Max`；未知值原样保留 |
| `modelVersion` | string | 模型具体版本或快照，≤60 字；区别于模型注册 ID 与 Harness 版本 |
| `generationMode` | string | `single-turn`（单轮）、`multi-turn`（多轮）、`agent`（智能体执行）；空串为未注明 |
| `humanIntervention` | string | `none`（仅初始提示，未改代码）、`prompt-guided`（额外人工提示指导，未改代码）、`code-edited`（人工改代码）；空串为未注明 |
| `generatedOn` | string | 实际生成日期，有效的 `YYYY-MM-DD`；不以上传日期代填 |
| `evidenceUrl` | string | 公开对话或运行记录的 HTTP / HTTPS 链接，≤2000 字、不含账号密码；服务端不抓取链接内容 |
| `tool` | string | 兼容输出，由 Harness 注册表名称或「其他」原文生成，不再独立存储 |
| `harnessId` / `harnessOther` | string / null、string | Harness 注册表 ID 或自填「其他」，两者互斥；旧作品分别为 null、空串。写入时 ID 传空串与 null 相同，表示未注明 |
| `harnessVersion` | string | Harness 版本（≤40 字）；仅有 Harness 时可填写 |
| `providerId` / `providerOther` | string / null、string | 服务商注册表 ID 或自填「其他」，两者互斥；旧作品分别为 null、空串。写入时 ID 传空串与 null 相同，表示未注明 |
| `status` | `unverified` \| `verified` \| `questioned` | 审核状态，默认 `unverified` |
| `audience` | `hidden` \| `show1` \| `show2` \| `both` | 兼容输出，由两个展示开关计算；v18 删除数据库列 |
| `reason` | string | 审核理由；`verified` 时恒为空串 |
| `reviewerName` / `reviewedAt` | string / null | 审核人从最近一次审核 audit 解析；审核时间保留在作品行 |
| `contentKey` | string | 作品永久内容令牌（`w` + 32 位十六进制），作品 origin 的子域名 |
| `checks` / `trial` | object | 上传检查报告 / 试加载探针数据（仅作者与管理员可见） |
| `trial.calibration` | object / null | Show1 逐作品展示设置，含可选的 `framing`（画布）与 `camera`（3D 视角）；没有时缺省 |
| `captures` | object | 截图映射 `{条件id: 文件名}`，由自动截图写回 |
| `cover` | string / null | 封面文件名（`cover.png` / `cover.jpg` / `cover.webp`） |
| `files` / `bytes` / `digest` | number / number / string | 文件数、解压后字节数、全包 SHA-256 |
| `createdAt` / `reviewedAt` | number / null | 时间戳（公开视图中转为 ISO 字符串） |

**HTTP 公开视图（`toPublic`）：**

投稿作品：

```json
{
  "task": "chinese-architecture",
  "id": "up-3f9k2m1x",
  "curated": false,
  "title": "体素小城", "summary": "……", "note": "……",
  "model": "grok-4.6", "modelName": "Grok 4.6", "vendor": "xAI",
  "effort": "High", "tool": "CLI",
  "harness": "claude-code", "harnessName": "Claude Code", "harnessVersion": "1.0",
  "provider": "official", "providerName": "官方",
  "status": "verified", "reason": "",
  "owner": "alice", "mine": false,
  "addedAt": "2026-09-27T08:00:00.000Z", "reviewedAt": null,
  "scene": "http://w<32hex>.localhost:5180/",
  "captures": { "first": "media/up-3f9k2m1x/first.jpg", "mobile": "media/up-3f9k2m1x/mobile.jpg" },
  "cover": "media/up-3f9k2m1x/cover.webp",
  "files": 12, "bytes": 183411
}
```

- `scene` 为完整 origin URL（末尾带 `/`），iframe 直接加载。
- `captures` / `cover` 为相对 API 站点的路径（前端拼 base URL）；无封面时 `cover` 为 `null`。
- **特权字段**（仅作者本人或管理员可见，普通访客与匿名者不返回）：`checks`、`trial`、`sourceName`、`root`、`entry`、`reviewer`。
- 投稿作品公开视图另有 `calibration`（对象或 `null`），从 `trial.calibration` 提取；`trial` 其余数据仍为特权字段。馆藏作品不使用这套 Show1 校准数据，也不增加该字段；Show2 画廊沿用自己的展示方式。

馆藏作品（公开视图字段更少，注意**没有 `scene`**，见 2.7 待拍板）：

```json
{ "task": "…", "id": "grok-4.6", "curated": true, "title": "…", "model": "…",
  "modelName": "…", "vendor": "…", "effort": "…", "tool": "…", "cover": "…", "status": "verified",
  "harness": null, "harnessName": null, "harnessVersion": "", "provider": null, "providerName": null }
```

### 2.2 任务 / 题目（task）

馆藏题目由数据包定义；社区题目经 `POST /api/questions` 写入 SQLite，加入同一个投稿与盲评目录。字段见第 4 节与 3.14。平台层关心的两个派生属性：

- `id` / `title`：标识与标题。
- `acceptsUploads`：`promptPending` 为真时置假——提示词原文尚未公开的题目**不接受上传**（`POST /api/drafts` 返回 `409`）。

### 2.3 模型（model）

由数据包完整注册表 `modelPool` 和展示列表 `models` 定义：`{ id, name, vendor, logo, brandUrl, brandName }`。投稿时若给出 `modelId` 且命中模型表，服务端以表内 `name` / `vendor` 为准；未登记模型的自填 `modelName`（≤60 字）存为 `model_other`，提交或审核中传入的厂商声明（≤40 字）追加到 `note`，`vendor` 返回空串，`modelId` 置 null（排行键退化为 `x:<小写模型名>`）。

### 2.4 用户（user）

数据库字段：`id`（16 位十六进制）、`name`（显示名）、`name_key`（NFKC + trim + 小写的唯一键）、`role`（`member` / `admin`）、`salt` / `hash`（标准 scrypt N=16384, r=8, p=1, keylen=32）、`hash_params`（可空 JSON）、`created_at`。`hash_params=NULL` 表示标准参数；迁入的旧用户可记录 `{ "N": 32768, "r": 8, "p": 1, "keylen": 64 }`。旧用户成功登录后立即换新 salt/hash 并清空 `hash_params`；标准用户无额外哈希或查询。

HTTP 公开视图恒为：

```json
{ "id": "…", "name": "…", "nickname": "…", "role": "member" }
```

未登录时用户字段为 `null`。`nickname` 默认返回登录用户名，可经 `PATCH /api/me` 修改；数据库增加 `nickname` 列，`name` 仍为登录用户名。用户名规则：NFKC 规范化后 2–24 位文字（Unicode 字母）、数字、下划线或连字符；密码 8–128 位。

### 2.5 对局（match）

数据库字段：`id`（24 位十六进制）、`user_id`（可空，匿名对局）、`task_id`、`a_work` / `b_work`（两侧作品 ID）、`a_token` / `b_token`（两侧内容令牌，`m` + 32 位十六进制，唯一）、`created_at`、`expires_at`（3 小时）、`choice`（`a` / `b` / `tie` / `skip`，未投为 null）、`decided_at`。新增 `datapack_root`（创建时 `DIST_DIR` 的真实目录）、`datapack_version` 和两侧 `a_identity` / `b_identity` JSON 快照。旧对局这些新增列为 null，只能按当前数据包尽力解析。

对局**从不**经列表端点暴露；只在创建与投票两个端点的响应中出现（见 3.8、3.9）。内容令牌在对局有效期内经内容端口伺服对应作品，令牌本身不泄露作品身份。

### 2.6 投票（vote）

数据库字段：`id`、`match_id`（唯一）、`user_id`、`task_id`、`a_work` / `b_work`、`pair_key`（`题目:作品A+作品B`，ID 排序后拼接）、`choice`（`a` / `b` / `tie`，`skip` 不产生投票行）、`created_at`，以及 `a_identity` / `b_identity` JSON 原始快照、`a_correction` / `b_correction` JSON 显式更正和 `source`（`arena` / `show1` / `legacy`，v18 删除冗余的 `identity_source`）。快照含当时模型 ID、名称、厂商、档位、归一化档位、model/config 计分 key、内容摘要 `digest`，以及 `harnessId`、`harnessVersion`、`providerId`。后三项不参与 `configKey` 或 `digest` 计算。馆藏摘要为入口页 SHA-256，投稿为全包 SHA-256。v8 迁移前的 legacy 票在 `a_identity` / `b_identity` 中存的是裸的旧模型 ID，并非 JSON；这类票不参与计分，也不能按推测更正。迁移前没有身份快照的对局不能再投票。新票按持久快照或显式更正计分，原始快照保持不变。约束：`UNIQUE(user_id, pair_key)`——**同一用户对同一作品组合只计一票**。

计入排行的投票需同时满足：投票时已登录、双方作品当前均为 `verified` 且存在、非本人作品、未评过该组合。作品被标记存疑或删除后，其相关投票即时退出排行；恢复后重新计入（见 3.9）。审核只影响是否计入，不会改写新票的计分归属。需要改正归属时由管理员明确更正单票，审计记录包含更正前有效值、更正后值、理由和操作者；缺少原始双侧快照的 legacy 票不可按推测更正。

### 2.7 审核状态流转

```
unverified ──审核──▶ verified ──审核──▶ questioned
    ▲                   │                    │
    └────── 审核退回 ────┴────── 审核退回 ◀───┘
```

- `unverified`：初始状态，**不进入**盲投对战池，不进入排行；在作品列表中可见。
- `verified`：进入对战池与排行。
- `questioned`：存疑。必须填写理由（作者与访客均可见）；退出对战池与排行，且**不可再互动**（表情返回 `409`）。
- 删除为软删除（`deleted_at`），馆藏作品不可经 API 删除（`409`，须在数据仓库移除）。

### 2.8 评论（comment）

v6 新增 `comments` 表：`id`（24 位十六进制）、`task_id`、`work_id`、`user_id`（账号删除后可空）、`body`、`created_at`（毫秒）、`deleted_at`（可空）。评论依附于已上架的馆藏作品或 `verified` 投稿；馆藏作品不在 SQLite 的 `works` 表中，因此 `work_id` 不设外键。删除评论只设置 `deleted_at`，公开读取不返回已删除项。

---

## 3. 端点

约定：除注明外，请求体均为 JSON（`Content-Type: application/json`），响应均为 JSON 且 `Cache-Control: no-store`。GET 路由同时接受 HEAD。认证列中的「登录」指有效会话 Cookie；「管理员」指 `role === 'admin'`。

### 3.1 `GET /api/bootstrap` —— 首屏聚合

**认证**：无（匿名返回阉割版）。**限流**：无。

首屏一次取齐：当前用户、站点配置、全部投稿、表情汇总、各题对战池规模、排行总计、我的计数、管理员待审数。

```json
{
  "datapack": "<数据仓库的 40 位 Git commit SHA，或 null>",
  "catalogDigest": "<实际加载 data.json 原始字节的 SHA-256>",
  "apiVersion": 1,
  "serverVersion": "<服务端构建版本或 dev>",
  "user": { "id": "…", "name": "alice", "role": "member" },
  "site": {
    "content": "http://{token}.localhost:5180",
    "cdn": ["cdn.jsdelivr.net", "unpkg.com", "cdnjs.cloudflare.com", "esm.sh", "fonts.googleapis.com", "fonts.gstatic.com"],
    "capture": true,
    "efforts": ["Low", "Medium", "High", "XHigh", "Max"],
    "emojis": ["👍", "❤️", "🔥", "🤯", "👏", "👀"],
    "limits": { "uploadBytes": 31457280, "coverBytes": 3145728, "pendingPerUser": 5, "provisionalGames": 30 }
  },
  "works": [ /* 全部未删除投稿的公开视图，按创建时间倒序 */ ],
  "questions": [ /* 社区题目公开视图，见 3.14 */ ],
  "reactions": {
    "counts": { "task-id/work-id": { "🔥": 3 } },
    "mine": { "task-id/work-id": ["🔥"] }
  },
  "arena": { "chinese-architecture": { "works": 40, "entries": 33, "uploads": true } },
  "totals": { "votes": 128, "voters": 17, "entries": 33 },
  "me": { "votes": 12, "pending": 1 },
  "review": null
}
```

- `site.content` 为作品 origin 模板，`{token}` 占位；前端无需自行替换（`scene` / `preview` 均为替换好的完整 URL），此字段仅供诊断与展示。
- `datapack` 只在已加载数据包带有有效 GitHub 来源文件时返回真实 SHA；无来源元数据或标为 `local` 的本地包返回 `null`。`catalogDigest` 是实际加载的 `data.json` 原始字节的 SHA-256，本地开发前后端在 `datapack=null` 时可据此比较是否使用同一目录数据版本。`serverVersion` 在进程启动时优先读取 `SERVER_VERSION`，其次读取部署目录 Git HEAD；非 Git 部署读取 `.server-version`，均不可用时为 `dev`。它标识服务代码，不是数据包版本；数据包以 `datapack` 字段判读，部署后分别核对两者。
- `works` **包含未验证与存疑投稿**（不含馆藏作品，馆藏经数据包分发），访客可见非特权字段。
- `arena[题目]`：`works` = 对战池作品数（馆藏 + 已验证投稿），`entries` = 不同「模型+档位」配置数，`uploads` = 该题是否接受上传。
- 匿名：`user`、`me` 为 `null`，`reactions.mine` 为 `{}`；`review` 仅管理员非 null（`{ "unverified": <待审数> }`）。

### 3.2 `POST /api/auth/register` —— 注册

**认证**：无。**限流**：auth 桶（10 次/分钟/IP）。

请求体：`{ "name": "…", "password": "…", "turnstileToken": "…" }`；Show1 可用 `username` 代替 `name`。邮箱选填且不在注册时验证；Turnstile 启用时必须提供 token，未配置两把密钥时自动关闭。

成功 `200`（**同时种下会话 Cookie，即注册即登录**）：

```json
{ "user": { "id": "…", "name": "alice", "role": "member" } }
```

Show1 兼容字段额外包含 `username` 和 `email`（未绑定为 `null`）。`GET /api/auth/me` 的 `user` 返回 `{ id, username, role, email }`，绑定后为真实归一化邮箱。

错误：`400` 用户名 / 密码不合规或人机验证失败；`409` 用户名已被使用或属于 `ADMIN_USERNAMES` 保留名（同一错误文案，不区分原因）；`415`；`429`；人机验证服务不可用时 `503`。

### 3.3 `POST /api/auth/login` —— 登录

**认证**：无。**限流**：auth 桶。请求体同注册。

成功 `200`：`{ "user": … }` 并种下会话 Cookie。错误：`401 用户名或密码不正确`（对不存在的账号同样执行哈希比较，不泄露账号是否存在）；其余同 3.2。

### 3.4 `POST /api/auth/logout` —— 登出

**认证**：无（无会话亦为成功）。**限流**：无。请求体：无。

响应：`{ "ok": true }`，删除服务端会话并清空 Cookie。

### 3.4.1 邮箱验证码、绑定与找回

`GET /api/auth/turnstile` 返回 `{ "siteKey": string | null }`。只有 `TURNSTILE_SITE_KEY` 与 `TURNSTILE_SECRET_KEY` 都配置时才启用；注册提交和发码请求都校验 `turnstileToken`。

`POST /api/auth/email/send`：绑定请求 `{ "purpose": "bind", "email": "…", "turnstileToken": "…" }`，需登录，成功返回 `{ "sent": true, "email": "归一化邮箱" }`。重置请求 `{ "purpose": "reset", "username": "…", "turnstileToken": "…" }`，无论账号是否存在或是否绑定邮箱，成功响应均为 `{ "sent": true, "email": "" }`；不提供邮箱占用提示。发码按 IP 和目标邮箱每 15 分钟限流，另有同地址 60 秒冷却（可用 `MAIL_*` 调整）。SMTP 未配置时绑定返回 `503`；重置仍采用统一响应。

`POST /api/auth/email/verify`：`{ "purpose": "bind", "email": "…", "code": "六位数字" }` 或 `{ "purpose": "reset", "username": "…", "code": "六位数字" }`。成功 `{ "ok": true }`，不消耗验证码。验证码默认 10 分钟有效、输错 5 次作废；数据库只存哈希。

`POST /api/auth/email/bind`：需登录，`{ "email": "…", "code": "…" }`；成功 `{ "user": <Show1 兼容用户> }`。同一账号可换绑，邮箱全局唯一且大小写归一。

`POST /api/auth/password/reset`：`{ "username": "…", "code": "…", "password": "…" }`；成功 `{ "reset": true }` 并删除该用户所有会话。错误验证码和不存在的账号统一返回 `400` 的验证码错误。

### 3.5 草稿：`POST /api/drafts` 与 `DELETE /api/drafts/:id`

草稿是「上传 → 检查 → 试加载 → 确认提交」流水线的中间态，有效期 24 小时。

**`POST /api/drafts?task=<题目id>&name=<文件名>&template=<static|vite>`**

`template` 可选，必须为该社区题目允许的格式；省略时从上传内容推断。Vite 项目必须含已构建的 `dist/index.html` 或其它识别的构建入口，存在源 `index.html` 时仍优先伺服构建目录；服务端不运行上传项目的构建脚本。

**认证**：登录。**限流**：drafts 桶（12 次/10 分钟/用户）。**请求体**：原始 ZIP 或单个 HTML 文件的二进制（**非 JSON**），上限 30 MB。

服务端解包并静态检查（不执行任何上传代码）：拒绝分卷 / 加密 / ZIP64 压缩包、符号链接、依赖目录与密钥文件、危险路径；要求根目录（或 `dist/`、`build/`、`out/`）存在 `index.html`，或包内恰有一个顶层 HTML；入口引用的关键脚本 / 样式缺失直接 `400`。解压后总大小 ≤150 MB、单文件 ≤50 MB、文件数 ≤2000。

成功 `200`：

```json
{
  "draft": {
    "id": "…", "task": "chinese-architecture",
    "sourceName": "mine.zip", "root": "", "entry": "index.html",
    "files": 12, "bytes": 183411,
    "checks": [
      { "id": "format", "state": "ok", "label": "文件格式", "detail": "ZIP · 12 个文件 · 解压后 179.1 KB" },
      { "id": "entry", "state": "ok", "label": "入口页面", "detail": "index.html" },
      { "id": "local", "state": "ok", "label": "本地资源", "detail": "…" },
      { "id": "external", "state": "warn", "label": "外部资源", "detail": "…" },
      { "id": "readme", "state": "info", "label": "说明文件", "detail": "…" },
      { "id": "duplicate", "state": "ok", "label": "重复检测", "detail": "未发现与已有作品相同的内容" }
    ],
    "preview": "http://d<32hex>.localhost:5180/",
    "expiresAt": "2026-09-28T08:00:00.000Z"
  }
}
```

- `preview` 为草稿试加载 origin（`d` 令牌，24 小时后失效），iframe 打开后由内容服务器注入探针脚本 `__sp_probe.js`。
- `checks[].state` 取值 `ok` / `info` / `warn`；`duplicate` 项在上传内容与馆藏或他人投稿完全相同时为 `warn`。
- 每位用户最多同时保留 3 份草稿（`draftsPerUser`），超出时最旧的自动废弃。

错误：`401` 未登录；`404 题目不存在`；`409 提示词原文尚未公开，暂不接受上传`；`400` 各类包体 / 内容问题；`413` 超 30 MB；`429`。

**`DELETE /api/drafts/:id`** —— 丢弃草稿

**认证**：登录（仅草稿所有者）。响应 `{ "ok": true }`。错误：`404 试加载已结束`（草稿不存在或非本人）。

### 3.6 投稿：`POST /api/works` 与 `DELETE /api/works/:task/:id`

**`POST /api/works`** —— 由草稿正式投稿

**认证**：登录。**限流**：write 桶。**请求体上限 6 MB**（封面为 base64 data URL 内嵌）。

```json
{
  "draftId": "…",
  "confirmed": true,
  "title": "体素小城",
  "summary": "……", "note": "……",
  "modelId": "grok-4.6",
  "modelName": "（无 modelId 时必填）",
  "effort": "High",
  "tool": "CLI",
  "harnessId": "claude-code", "harnessVersion": "1.0", "providerId": "official",
  "cover": "data:image/webp;base64,…",
  "trial": { "loaded": true, "loadMs": 120, "errors": 0, "errorSamples": [], "failedResources": [], "blocked": [], "canvases": 1, "media": 3, "words": 120 }
}
```

- `confirmed` 必须为 `true`（作者已在试加载中确认运行正常），否则 `400`。
- 模型二选一：`modelId` 命中数据包模型表，或自填 `modelName`。
- `trial` 为试加载探针回传数据，服务端逐字段消毒（数值截断、字符串截长、样例限条数）。
- `cover` 仅接受 PNG / JPEG / WebP（魔数校验），≤3 MB。
- `harnessId` / `providerId` 须存在于当前数据包注册表，停用的 `listed: false` 条目仍可引用；也可分别填写 `harnessOther` / `providerOther`。同一维度的 ID 与「其他」不能同时非空；设置一边会清空另一边。两个「其他」及 `harnessVersion` 经 NFKC 归一化并去首尾空白后最多 40 字。版本只能随 Harness 填写，清空 Harness 会清空版本。字段未出现时保持原值，旧数据包没有注册表时可填「其他」。
- 普通用户须填写 Harness ID、「其他」或兼容字段 `tool` 中至少一项；过渡期旧前端只传 `tool` 仍可投稿。管理员可留空。仅传 `tool`（或 Harness 两项均空）时将其存入 `harness_other`；有非空 Harness 声明时以声明为准。输出 `tool` 从 Harness 派生，不自动猜测 ID。

成功 `200`：`{ "work": <作品公开视图> }`。作品初始状态 `unverified`，并自动排队无头截图（1440×900 与 390×844 两档，写回 `captures`；截图能力可用性见 `bootstrap.site.capture`）。

启用内容审查时，响应含作者特权字段 `moderation.status: "pending"`，上传请求不等待 Flex。此时 `scene` 是一小时有效的随机 `p<32hex>` 预览源，作品尚不公开；内容状态与 `unverified` 核验状态独立，详见 3.24 节。

截图浏览器只允许当前作品源的文档，以及该源和 HTTPS CDN 白名单内的 GET/HEAD 资源。请求逐跳检查重定向，跨源导航、WebSocket、Service Worker 及未经过路由的浏览器连接被阻断；截图环境须预配置 Playwright ≥ 1.48 和 Chrome。

错误：`401`；`404 试加载已过期`；`400`（未确认 / 缺标题 / 缺 Harness 与 tool / 模型不存在或缺失 / 来源字段无效 / 封面无效）；`413 封面图片不能超过 3 MB`；`429 你已有 5 件作品在等待核验`（`pendingPerUser`）。

**`DELETE /api/works/:task/:id`** —— 删除投稿

**认证**：登录，且为作者本人或管理员。响应 `{ "ok": true }`。

错误：`401` / `403 只能删除自己上传的作品`；`404 作品不存在`；`409 馆藏作品由仓库收录流程管理`（馆藏作品不可经 API 删除）。

### 3.7 审核、互动与账号管理

**`POST /api/works/:task/:id/review`** —— 审核投稿（仅管理员）

**认证**：管理员。请求体：

```json
{ "status": "verified", "reason": "（questioned 时必填，≤500 字）",
  "modelId": "（选填：审核时顺带纠正模型归属）", "modelName": "…", "effort": "…",
  "title": "作品标题", "summary": "摘要", "show_gallery": true, "show_arena": true,
  "harnessId": "claude-code", "harnessVersion": "1.0", "providerId": "official" }
```

- `status` 取值 `verified` / `questioned` / `unverified`；`questioned` 必须给 `reason`（`400` 否则）；置为 `verified` 会清空理由。
- 仅当请求体出现 `modelId` / `modelName` 键时才重取模型身份，否则保持原值；`effort` 同理。
- `title`、`summary` 与两个布尔门面开关均可选；审核通过时可同时修改。兼容旧的 `audience` 参数，将其换算为两个开关；响应中的 `audience` 由最终开关计算。审核状态和 audit 在同一事务写入。
- 审核可选 `harnessId`、`harnessOther`、`harnessVersion`、`providerId`、`providerOther`；按 3.6 节的互斥、40 字及版本规则校验，只更新请求中出现的维度。

成功 `200`：`{ "work": <作品公开视图（管理员视角，含特权字段）> }`。错误：`401` / `403 仅管理员可以操作`；`404`；`400 审核结果无效`。

**`POST /api/works/:task/:id/reactions`** —— 表情反应（开关式）

**认证**：登录。**限流**：write 桶。请求体：`{ "emoji": "🔥" }`。

同一用户对同一作品的同一表情**再次提交即取消**（toggle）。响应：

```json
{ "counts": { "🔥": 3, "👍": 1 }, "mine": ["🔥"] }
```

错误：`401`；`404 作品不存在`；`409 存疑作品仅供参考，不能再互动`；`400 不支持这个表情`（表情须在 `bootstrap.site.emojis` 白名单内）。馆藏作品同样可互动。

**`GET /api/me`** —— 本人题目、投稿与参与统计

**认证**：登录。响应：

```json
{
  "questions": [ <本人社区题目公开视图> ],
  "works": [ <本人投稿公开视图，含特权字段> ], "votes": 12,
  "joinedAt": "…ISO…",
  "activity": { "from": "YYYY-MM-DD", "to": "YYYY-MM-DD", "days": [ { "date": "YYYY-MM-DD", "count": 2 } ], "total": 12, "activeDays": 5 },
  "receivedReactions": { "counts": { "🔥": 2 }, "total": 2 }
}
```

活跃统计按 UTC+8 的近 365 天汇总本人发布题目、投稿、有效落库投票和当前表情记录；历史投稿删除后仍计入活跃。收到的表情仅统计本人当前未删除投稿且排除自评。

**`PATCH /api/me`** —— 更新昵称

认证：登录；限流：write 桶。请求 `{ "nickname": "河畔观测员" }`，响应 `{ "user": <用户公开视图> }`。昵称经 NFKC 与首尾去空白后为 1–24 字，不能含控制字符；无效返回 `400`。不能更改登录用户名或角色。题目与作品作者公开显示昵称。

**`GET /api/review`** —— 审核台（仅管理员）

**认证**：管理员。响应：

```json
{
  "works": [ <全部投稿公开视图，管理员视角> ],
  "audit": [ { "at": "…ISO…", "actor": "alice", "action": "submit", "task": "…", "work": "up-…", "detail": "…" } ]
}
```

`audit` 为审计日志倒序最多 200 条，`action` 取值含 `submit` / `verified` / `questioned` / `unverified` / `delete` / `role`。

**`GET /api/admin/users`** —— 账号列表（仅管理员）

**认证**：管理员。**限流**：无。

成功 `200`（按注册时间升序）：

```json
{ "users": [ { "id": "…", "name": "alice", "role": "member", "createdAt": "2026-09-27T08:00:00.000Z" } ] }
```

- 每项仅含 `id` / `name` / `role` / `createdAt`：`name` 为登录用户名（非昵称），`createdAt` 为 ISO 时间；不下发昵称、`name_key` 与凭据（`salt` / `hash`）。
- `role` 为生效角色：`ADMIN_USERNAMES` 内的账号无论库中存值恒为 `admin`。

错误：`401`（未登录）/ `403 仅管理员可以操作`。

**`POST /api/admin/users/:id/role`** —— 调整账号角色（仅管理员）

**认证**：管理员。**限流**：无。请求体：`{ "role": "admin" }`（取值 `admin` / `member`）。

成功 `200`：`{ "user": { "id": "…", "name": "bob", "role": "admin" } }`，并写审计日志（`action` 为 `role`，`detail` 形如 `bob → 管理员`，无关联题目 / 作品）。

错误：`401` / `403 仅管理员可以操作`；`400 角色无效`；`404 用户不存在`；`409 不能修改自己的角色，避免把自己锁在管理端之外`（防自降权，自己的角色只能由另一名管理员调整）。

### 3.8 `POST /api/arena/matches` —— 创建盲投对战

**认证**：无（匿名可创建，但不计票）。**限流**：matches 桶（60 次/分钟）。

请求体：`{ "task": "chinese-architecture", "previous": "<上一场对局id，选填>" }`

成功 `200`：

```json
{ "id": "…24hex…", "task": "chinese-architecture",
  "a": "http://m<32hex>.localhost:5180/", "b": "http://m<32hex>.localhost:5180/",
  "counted": true }
```

- `a` / `b` 为两侧作品的**不透明令牌 origin**（`m` 令牌，对局有效期 3 小时），iframe 直接加载；页面与地址均不泄露作品 / 模型身份。左右顺序随机。
- `counted`：登录用户恒 `true`，匿名恒 `false`。
- 对局创建时一次捕获当前馆藏目录和两侧身份。随后切换数据包，旧令牌仍从原目录提供 HTML 与相对资源，旧对局仍可揭晓/投票；部署应保留该目录到相关对局全部过期并经过清理宽限期。
- 前端在写请求上携带 `X-Datapack-Version: <前端所构建的数据仓库 SHA>`（读请求不带，避免跨源 GET 预检）；创建馆藏对局、馆藏题目草稿及该草稿的正式投稿时，如果该值与服务端当前可信 SHA 不同，请求照常处理，响应头增加 `X-Datapack-Stale: 1`，响应体形状不变。对局仍绑定创建时的服务端快照。社区题目不参与此检查；缺少请求头时不增加提示头。
- 抽样规则：先抽两个不同「模型+档位」配置，再各抽一件作品；偏向对局数少的配置、偏向实力相近者（同档 90% 概率软匹配，分差过大重掷 2 次）；避开上一场两侧作品、本人作品与已评组合。
- `previous` 缺省时，登录用户自动取本人该题最近一场对局作为「上一场」回避。

错误：`404 题目不存在`；`409 + code:"insufficient"` 对战池不足两个配置；`409 + code:"exhausted"` 该用户已评完全部组合；`429`。

### 3.9 `POST /api/arena/matches/:id/vote` —— 投票并揭晓

**认证**：无（但匿名票**不计入**排行）。**限流**：write 桶。

请求体：`{ "choice": "a" }`（`a` / `b` / `tie` / `skip`）。

成功 `200`（注意：**不计票也返回 200**，以 `counted` / `reason` 区分）：

```json
{ "choice": "a", "counted": true, "reason": "",
  "a": <作品公开视图>, "b": <作品公开视图> }
```

- 响应的 `a` / `b` 即**揭晓**：投票后返回两侧作品的完整公开视图（含模型名）。
- `counted=false` 时 `reason` 取值：`skipped`（skip）、`anonymous`（未登录）、`changed`（投票时某侧作品已失效）、`own`（涉及本人作品）、`duplicate`（已评过该组合）。
- `skip` 同样终局化对局，但不产生投票记录。
- 对局绑定创建者：登录用户创建的对局仅本人可投；匿名创建的对局任何人可投（但仍不计票）。
- 作品被标记存疑 / 删除后，其参与的历史投票**即时退出**排行统计；恢复验证后自动回归。

错误：`404 这一组已经失效`（对局不存在 / 过期 / 非本人）；`409 这一组已经提交过了`；`400 选择无效`；`429`。

### 3.10 `GET /api/leaderboard` —— 排行榜

**认证**：无。**限流**：无。

查询参数：`task=<题目id>`（缺省为全部题目合计）；`category=<题型>`（数据包题目的 `category`，如 `建模`、`文学`、`静态网页`；只统计该题型的题目，不能与 `task` 同用）；`by=config`（默认，按「模型+档位」）或 `by=model`（按模型跨档位合计）；可选的 `harness`、`provider`（注册表 ID，或 `unset` 表示未登记）。

来源筛选只缩小计入的票和作品池，**不改变计分维度**（仍是「模型+档位」或模型）：
- 一张票只有两侧的身份快照（有更正时取更正）都满足全部筛选条件时才计入；只满足一侧的是跨来源比较，不计入。
- 快照只保存注册表 ID，自填的「其他」与未注明一样记作 `unset`；快照没有这些键的旧票同样记作 `unset`。
- `unranked` 与 `works` 计数按作品当前的来源字段筛选。
- 带筛选时响应多一个 `"filters": { "harness": …, "provider": … }`；不带筛选时响应形状、计票范围与缓存键都与不支持筛选时完全相同。

题型：响应回显 `category`（未指定为 `null`）。既无 `task` 也无 `category` 的综合榜多一个 `standings`：`{ [题型]: { [key]: 该题型内名次 } }`，只列已有排名的题型，沿用同一计分单位与来源筛选。社区题目没有题型，只计入综合榜。

```json
{
  "task": null, "category": null, "by": "config",
  "standings": { "建模": { "grok-4.6|high": 2 } },
  "totals": { "votes": 128, "voters": 17, "entries": 33 },
  "rows": [
    { "rank": 1, "key": "grok-4.6|high", "model": "grok-4.6", "modelName": "Grok 4.6", "vendor": "xAI",
      "effort": "High", "score": 1082, "interval": 96, "games": 41, "wins": 25, "draws": 4, "losses": 12,
      "winRate": 0.6585, "voters": 15, "tasks": 3, "works": 2, "provisional": false }
  ],
  "unranked": [ { "key": "…", "model": "…", "modelName": "…", "vendor": "…", "effort": "…", "works": 1 } ],
  "provisionalGames": 30,
  "updatedAt": "2026-09-27T08:00:00.000Z"
}
```

- 评分算法：Bradley–Terry 模型（平局各计半胜，弱先验 N(0,1)），映射到 Elo 刻度——均值 1000，400 分对应十倍胜率差；`interval` 为 95% 不确定区间半宽。与顺序无关。
- `provisional`：对局数 < `provisionalGames`（30）者为暂定。
- `unranked`：池内存在但尚无计入对局的配置，按模型名字典序排列。
- 排行在票数或作品状态变化时失效重建，并以数据包版本参与缓存键。

错误：`404 题目不存在`（`task` 参数无效）；`400 invalid_query`（`harness` 或 `provider` 既不是当前注册表 ID 也不是 `unset`；`category` 不是当前题目的题型，或与 `task` 同时出现）。

### 3.11 `/media/*` —— 投稿媒体

`GET /media/<work-id>/<file>`，其中 `<work-id>` 形如 `up-XXXXXXXX`，`<file>` ∈ `cover.png` / `cover.jpg` / `cover.webp` / `first.jpg` / `mobile.jpg`。

- 响应头：旧流程作品为 `Cache-Control: public, max-age=300`，参与内容审查的作品为 `no-store`；`Content-Security-Policy: default-src 'none'`（防止媒体被当页面执行）。内容未通过的媒体只供作者或管理员会话访问，其他请求为 404。
- 404：`{ "error": "文件不存在" }`。
- 路径越界（`..` 等）在路径解析层被拒，等同 404。

### 3.12 作品内容伺服（令牌子域）

内容端口（默认 5180）按 Host 首段令牌伺服作品，规则 `^[wmd][0-9a-f]{32}$`：

| 前缀 | 令牌来源 | 指向 | 有效期 | 注入脚本 | Cache-Control |
| --- | --- | --- | --- | --- | --- |
| `d…` | 草稿创建 | 草稿目录 | 24 小时 | `__sp_probe.js`（试加载探针） | `no-store` |
| `m…` | 对战创建 | 对局某侧作品 | 3 小时（随对局） | `__sp_fold.js`（盲投折页） | `no-store` |
| `w…` | 投稿提交（`contentKey`） | 作品目录 | 随作品存续 | 无 | `private, max-age=600` |

- 仅接受 GET / HEAD，其余方法 `405`。
- 畸形 URL 返回 `400` 错误页，不使共享进程退出；请求期间消失的资源返回 `404`。
- 令牌无效：`404` 错误页「作品地址无效」；令牌存在但目标不可用（草稿过期、对局结束、作品删除、对局侧作品被下架）：`410` 错误页「作品已不可用」。
- 全部响应施加沙盒 CSP：`sandbox allow-scripts allow-same-origin allow-forms allow-modals allow-popups …`，外部资源仅放行 `bootstrap.site.cdn` 白名单内的公共 CDN；`frame-ancestors` 限定为 `SITE_ORIGINS`（即作品只能被站点 iframe 嵌入）；`Referrer-Policy: no-referrer`。
- 注入脚本作为 HTML 首个 `<script>` 插入，仅作用于 `d` / `m` 令牌；`w` 令牌作品**原样伺服**。
- 目录默认入口为作品的 `entry` 字段（通常 `index.html`）。

### 3.13 站点静态文件

`GET /*`（非 `/api/`、非 `/media/`、非 `/admin/`）分发 `DIST_DIR` 内的数据包资源。HTML/HTM（含目录映射的 `index.html`）及不存在的文件返回纯文本 `404 Not found`；其余响应使用 `Content-Security-Policy: sandbox; default-src 'none'` 与 `Referrer-Policy: no-referrer`，防止 SVG/XML 在 API 同源执行脚本。可信管理端 `/admin/` 保留自身站点 CSP。作品 HTML 从独立内容源打开；独立画廊从自己的静态部署读取馆藏数据与作品目录（见第 4 节）。

### 3.14 `POST /api/questions` —— 发布社区题目

认证：登录；限流：write 桶。请求体 `{ "title": "…", "summary": "…", "prompt": "…", "tags": ["UI"], "templates": ["static", "vite"] }`。标题、测试简述、完整提示词必填，最多 70 / 400 / 20000 字；提示词除首尾空白外保留原文。标签 1–6 个，每个 1–24 字，按 NFKC 与大小写归一去重，已有标签沿用其名称。格式至少选一种 `static` / `vite`，省略时默认两种。

成功 `200`：`{ "question": { "id": "q-<16hex>", "title": "…", "summary": "…", "prompt": "…", "tags": ["UI"], "templates": ["static", "vite"], "owner": "作者昵称", "version": 1, "community": true, "createdAt": "…ISO…", "date": "YYYY-MM-DD" } }`。作者从会话读取，不能由客户端指定。错误：`401` / `400` / `429`。社区题目通过 `bootstrap.questions` 公开、通过 `me.questions` 返回本人题目，立即接受关联投稿；其 `arena` 初始为空池。

### 3.15 作品评论

评论只属于已上架作品：馆藏作品或状态为 `verified` 的投稿。盲测对局创建响应与未揭晓页面均不带评论；前端应在展示已揭晓作品时单独请求评论。

**`GET /api/works/:task/:work/comments`** —— 公开读取最近 100 条未删除评论，按时间倒序。认证、限流均无。成功 `200`：

```json
{ "comments": [ { "id": "<24hex>", "body": "喜欢这个作品", "createdAt": "…ISO…",
  "author": "alice", "mine": false, "canDelete": false } ] }
```

`author` 为当前昵称（无昵称时为用户名）；账号删除后为 `null`。`mine` / `canDelete` 随当前会话变化。作品不存在或未上架时返回 `404`。

**`POST /api/works/:task/:work/comments`** —— 登录发布评论，使用 `write` 桶。请求 `{ "body": "喜欢这个作品" }`；去除首尾空白后须为 1–280 字。成功 `200`：`{ "comment": <上述评论对象> }`。错误：`401` / `400` / `404` / `429`。

**`DELETE /api/comments/:id`** —— 评论本人或管理员软删除，使用 `write` 桶。成功 `200`：`{ "ok": true }`；无须请求体。错误：`401` / `403`（非本人且非管理员）/ `404`（不存在或已删除）/ `429`。

### 3.16 Show1 投稿作品校准

校准只适用于 SQLite `works` 表中的投稿作品。数据存于 `trial.calibration`，作品原始 HTML 不改写；馆藏作品与 Show2 画廊展示方式不受该字段控制。

**`GET /api/works/:id/calibration`** —— 已上架投稿公开读取；未上架投稿仅作者或管理员可读。不限流。成功 `200`：`{ "calibration": <对象或 null> }`；不存在、馆藏作品或无权读取未上架投稿时返回 `404`。

**`PATCH /api/works/:id/calibration`** —— 投稿作者或管理员写回，使用 `write` 桶。请求 `{ "calibration": { "framing": <对象或 null>, "camera": <对象或 null> } }`；可只提交其中一项，另一项保持原值。`{ "calibration": null }` 清空全部校准。成功 `200`：`{ "calibration": <写入后的对象或 null> }`。错误：`401` / `403` / `404` / `400`（结构或数值无效）/ `429`。

- `framing`：`{ "width": 1280, "height": 720, "zoom": 1, "offsetX": 0, "offsetY": 0 }`。宽、高须为整数，分别在 320–3840、240–3840；`zoom` 为 0.25–4；两个 offset 为 -1–1。五项都必须存在且为有限数，不接受额外字段。
- `camera`：`{ "position": [1, 2, 3], "target": [0, 0, 0] }`。两项各为恰好三个有限数，绝对值小于 10⁷，不接受额外字段。
- 分别传 `framing: null` 或 `camera: null` 可清除对应部分。`trial` 中原有的试加载报告保持不变；投稿作品公开视图只额外暴露 `calibration`，不暴露整个 `trial`。

### 3.17 Show1 历史作品的审核与站点展示（schema v7）

`audience` 为 `hidden` / `show1` / `show2` / `both`，API 保留兼容输出，v18 删除 `works.audience` 及其索引。实际可见性只由 `show_gallery`、`show_arena` 决定；早期迁移仍按当时的 `audience` 回填开关。新投稿和管理员代传默认展览馆开启、竞技场关闭；Show1 历史待审作品升级后两个开关关闭。管理员审核通过时可指定门面。后台审核视图可取得随机作品内容令牌用于私密试加载；令牌本身具有预览能力，不应公开转发。

**`GET /api/show1/works`** —— Show1 公开作品列表，不需要登录、无限流。成功 `200`：`{ "works": [<作品公开视图>], "reactions": { "counts": {}, "mine": {} } }`。只返回 `verified` 且 `show_arena=1` 的 SQLite 作品；`/api/bootstrap.works` 只看 `show_gallery`。竞技场盲评池同样使用 `show_arena`。Show1 题目定义仍由数据包负责，此接口不创建题目。

本轮不修改 `server/show1compat.mjs`：Show1 旧 `/api/works` 等兼容端点的返回形状不增加来源字段。共享 `/api/show1/works` 使用作品公开视图，会随之出现新字段。

**`POST /api/works/:task/:id/review`** —— 原审核端点仍接受 `audience: "show1" | "show2" | "both"`。对 `hidden` 迁入作品，旧请求设置 `status=verified` 时须指定非 `hidden` 的 audience；新请求可改传两个布尔门面开关。仍需管理员身份，遵循现有 Origin 校验与审核错误格式；成功返回的管理员作品视图含兼容 `audience`。

迁移脚本与执行参数见 `docs/show1-migration.md`。Show1 七道新题的目标 ID 固定为 `show1-001`、`show1-002`、`show1-003`、`show1-005` 至 `show1-008`；004 沿用 `chinese-architecture`。七道题的正式定义进入数据包前，作品仍可在后台审核，但前端没有完整题目元数据。

### 3.18 双系统管理端（schema v9）

以下端点均须管理员会话；非管理员返回 `401`（未登录）或 `403`。写请求走同源检查、`write` 限流并记录 audit。错误仍按 1.4 节的 `{ "error": "中文提示", "code": "可选代码" }` 格式返回。

**`GET /api/admin/works`** 合并馆藏精选和 SQLite 投稿。查询参数：`task`（题目 ID）、`status=verified|unverified|questioned`、`source=curated|upload`、`face=gallery|arena` 与 `show=on|off`（两者一起使用）、`harness` 与 `provider`（取注册表 ID、`other` 表示只填了「其他」、`unset` 表示未注明；其他值 `400 invalid_query`）、`search`（标题、模型、题目 ID、Harness 与服务商名称）、`page`（默认 1）、`pageSize`（默认 30，最多 100）。成功形状：

```json
{ "works": [{ "task": "one", "id": "a", "source": "curated", "status": "verified", "show_gallery": true, "show_arena": true, "calibration_gallery": null, "calibration_arena": null, "has_calibration_gallery": false, "has_calibration_arena": false }], "total": 1, "page": 1, "pageSize": 30 }
```

作品对象还含原有管理员作品视图字段。精选开关和取景先读 `work_overrides`，缺失时展览馆开关默认开启、竞技场开关默认关闭。查询错误：`400 invalid_query`、`404 not_found`（题目不存在）。

**`POST /api/admin/works/:task/:id/face-settings`** 请求 `{ "show_gallery": false, "show_arena": true }`，可只给其中一个布尔键。投稿只更新 `works` 两个开关；精选 upsert `work_overrides`，不修改数据包。响应 `{ "work": <合并管理员作品视图> }`。错误：`400 invalid_face_settings`、`404 not_found`、`429`。

**`POST /api/admin/works/batch-face-settings`** 仅管理员可用，使用 write 限流。请求 `{ "works": [{ "task": "题目 ID", "id": "作品 ID" }], "show_gallery": false, "show_arena": true }`，两个开关至少给一个，且只能为布尔值；一次须选 1–200 件。复用单件开关逻辑，在同一个数据库事务内更新所有作品并为每件写一条 `face-settings` audit；任一作品不存在或参数无效时整批回滚。成功 `200`：`{ "works": [<合并管理员作品视图>, …] }`，顺序与请求一致。错误：`401` / `403`、`400 invalid_work_list|invalid_face_settings`、`404 not_found`、`429`。

**`POST /api/admin/works/:task/:id/calibration`** 请求 `{ "face": "gallery" | "arena", "calibration": { "framing": { "width": 1440, "height": 900, "zoom": 1, "offsetX": 0, "offsetY": 0 }, "camera": { "position": [0,0,5], "target": [0,0,0] } } }`。`calibration` 可为 `null` 清空；对象可只给其中一项，单项为 `null` 则删除该项。投稿画廊取景仍在 `trial.calibration`，竞技场取景在 `works.calibration_arena`；精选取景写覆盖表的两个附加列。响应 `{ "task": "one", "id": "a", "face": "arena", "calibration": <当前对象或 null> }`。错误：`400 invalid_face|invalid_calibration`、`404 not_found`、`429`。校验范围沿用 3.16 节。

**`GET /api/admin/tasks/:id/editorial?face=gallery|arena`** 响应 `{ "task": "one", "face": "arena", "commentary": "…", "weights": [0.2,0.2,0.2,0.2,0.1,0.1] | null, "updatedAt": "…" | null }`。**`POST /api/admin/tasks/:id/editorial`** 请求 `{ "face": "arena", "commentary": "点评", "weights": [0.2,0.2,0.2,0.2,0.1,0.1] }`；`gallery` 只接受 `commentary`，不得传 `weights`。竞技场权重须 6 个 0–1 数，总和在 `1 ± 0.001`。成功返回同 GET。错误：`400 invalid_face|invalid_editorial|invalid_weights`、`404 not_found`、`429`。

Show1 `/api/prompts` 在有 `arena` 覆盖时按题目映射合并 `commentary`、`weights`；没有覆盖时仍逐项返回快照内容。历史票的快照权重与娱乐榜回放不随覆盖修改。

**`GET /api/admin/traffic?days=N`** `N` 默认 30，范围 1–90。响应 `{ "days": 30, "daily": [{ "day": "2026-09-28", "pv": 12, "uniqueIps": 8 }], "paths": [{ "path": "/", "pv": 9 }], "users": { "total": 24, "new": 2 } }`。`daily` 按 UTC 日补齐零值；`paths` 最多 20 条；错误 `400 invalid_query`。

**`POST /api/admin/works/upload`** 原始 HTML 或 ZIP 请求体，查询参数 `task`、`name`（含扩展名）、`title`、`modelId` 或 `modelName`、`summary`、`tool`、`harnessId`、`harnessOther`、`harnessVersion`、`providerId`、`providerOther`、`template`、`show_gallery=0|1`、`show_arena=0|1`。来源字段遵循 3.6 节规则；管理员可不填 Harness，`tool` 不再自动设为录入渠道。沿用草稿检查和投稿存储，直接核验为 `verified`；开关缺省时展览馆开启、竞技场关闭。响应 `{ "work": <合并管理员作品视图> }`。错误沿用 `/api/drafts` 和 `/api/works`，另有 `400 invalid_face_settings`、`413`、`429`。该流程在 audit 中留下 `submit` 和 `verified` 两条记录。

竞技场配对和 Bradley–Terry 计分都只纳入当前 `show_arena=1` 的已验证作品；精选没有覆盖记录时竞技场开关默认关闭。`votes.source='arena'` 的限制不变。Show1 娱乐榜仍从全量历史票回放。

### 3.19 管理员收件箱、作品编辑与收录

以下 API 均须管理员会话；写请求遵循同源检查和 write 限流。收件箱位于 `DATA_DIR/inbox`，只保存待登记的 HTML/ZIP，不会因上传本身发布作品。

- **`GET /api/admin/inbox`** 返回 `{ "entries": [...] }`，按加入时间升序。每项含 `id`、原文件名 `name`、`kind`（HTML/ZIP）、字节数 `size`、毫秒时间戳 `addedAt`、从文件名推断的 `suggest: { title, model }` 和预览路径 `preview`。
- **`POST /api/admin/inbox?name=<文件名>[&overwrite=1]`** 请求体为原始 HTML 或 ZIP，最多 30 MB；文件名只接受 `.html`、`.htm`、`.zip`（含「标题，模型.html」格式）。上传前执行包检查；同名文件默认返回 `409 inbox_conflict`，`overwrite=1` 覆盖。成功 `200`：`{ "ok": true, "name": "…" }`，写 `inbox-upload` audit。
- **`GET /admin/inbox/:id/...`** 是预览文件路径，不是 API；仅管理员可读取，其他用户或文件不存在时返回纯文本 `404`。`/file` 返回原始文件；ZIP 的预览路径由列表给出，响应使用 `no-store`。
- **`POST /api/admin/inbox/register`** JSON 请求含 `id`、`task`、可选的 `title`、`summary`、`modelId` 或 `modelName`、`effort`、`tool`、`harnessId`、`harnessOther`、`harnessVersion`、`providerId`、`providerOther`；标题和模型名可从文件名建议值补齐。来源字段遵循 3.6 节规则；不填时 `tool` 为空，不写录入渠道。走现有草稿检查与投稿流程。缺省登记为 `unverified` 且两个门面均关闭；`publish: true` 时直接核验为 `verified`，缺省展览馆开启、竞技场关闭，可用 `show_gallery` / `show_arena` 指定。成功 `200`：`{ "work": <管理员作品视图> }`，移除收件箱文件并写 `inbox-register` audit；无效或已移除的 `id` 返回 `404`。
- **`DELETE /api/admin/inbox?id=<收件箱 ID>`** 移除暂存文件，成功 `200`：`{ "ok": true }`，写 `inbox-remove` audit；文件不存在返回 `404`。
- **`POST /api/admin/works/:task/:id/meta`** 仅编辑 SQLite 投稿，不编辑馆藏。JSON 请求可含 `title`、`summary`、`modelName`、`modelId`、`effort`、`harnessId`、`harnessOther`、`harnessVersion`、`providerId`、`providerOther`；至少提供一个允许字段。标题不能为空，`modelId` 须存在于目录。来源字段按 3.6 节校验；同一维度设置 ID 会清空「其他」，反之亦然，清空 Harness 同时清空版本。成功 `200`：`{ "work": <管理员作品视图> }`，写 `meta` audit；无效字段或内容返回 `400`，投稿不存在或目标为馆藏返回 `404 not_found`。
- **`POST /api/admin/works/:task/:id/nominate`** 仅对已核验、尚未收录、且题目在当前数据包内的投稿有效。生成有效期 14 天的随机导出令牌；重复提名会换发令牌，数据库仅存 SHA-256。返回 `{ "exportUrl": "<当前来源>/api/curate/export/<令牌>", "command": "npm run intake:from-server -- <exportUrl>" }`。提名不改变作品的公开展示状态。管理员列表以 `nominatedAt` 标记提名，以 `curatedAs` 标记已收录。
- **`DELETE /api/admin/works/:task/:id/nominate`** 撤回提名并使令牌立即失效，返回 `{ "ok": true }`；已收录返回 `409`。提名和撤回均写审计记录。
- **`GET /api/curate/export/:token`** 无需登录，返回 `task`、`id`、`title`、`summary`、`modelId`、`modelName`、`vendor`、`effort`、`tool`、`harnessId`、`harnessOther`、`harnessVersion`、`providerId`、`providerOther`、`note`、`createdAt`、`root`、`entry`、`digest` 及 `files: [{ path, size, sha256 }]`。**`GET /api/curate/export/:token/file?path=<相对路径>`** 返回原始文件。两者按令牌每分钟限流 2000 次，另有每 IP 每分钟 10000 次兜底；命中返回 `429` 和 `Retry-After`。无效、过期、撤回或已被数据包接管的令牌返回 `404`，非法文件路径返回 `404`。
- 数据包中某馆藏结果带 `sourceUpload: "up-…"` 时，后端在数据包版本变化后异步设置对应投稿的 `curated_as`、清除提名字段、继承投稿的展览馆与竞技场开关（已有馆藏 override 不覆盖），并以系统身份写审计；成功接管的版本不重复更新，失败会记录并在下次刷新时重试。

### 3.20 Show1 猜模型接口

这些端点无需登录；写请求仍须可信 Origin 和 JSON 请求体，使用每分钟 60 次的 matches 限流桶（若单独配置 guess 桶则优先）。日期采用 UTC+8 日历日；公开模型字段为 `id`、`name`、`vendor`、`released`、`openWeights`、`contextK`、`modalities`、`reasoning`、`priceOut`、`priceTier`、`difficulty`。

- **`GET /api/guess/today`** 返回 `200`：`{ "dayKey": "YYYY-MM-DD", "dayNumber": 0, "attributes": ["…"], "models": [<公开模型>] }`。不下发当天答案。
- **`POST /api/guess/check`** 请求 `{ "guessId": "模型 ID 或名称", "gameId": "可选练习局 ID", "final": false }`；不带 `gameId` 时按当天每日池判定，带 `gameId` 时按内存练习局判定。成功 `200`：`{ "feedback": <逐属性反馈>, "answer": <公开模型或 null> }`；猜中或 `final: true` 才附答案。未知模型返回 `400 unknown-model`，练习局不存在返回 `404 game-expired`。
- **`POST /api/guess/practice/start`** 请求 `{ "difficulty": 1 }`；支持 1–4 档，非法值回落到 1。成功 `200`：`{ "gameId": "<24 位十六进制>" }`；练习局只保存在进程内，重启后失效。所选难度无可用模型时返回 `503`。
- **`POST /api/guess/result`** 请求 `{ "won": true, "attempts": 3, "dayKey": "可选 YYYY-MM-DD" }`，`attempts` 须为 1–8 的整数，日期须在游戏纪元 `2026-09-13` 至当天之间；缺省为当天。服务端自行派生 `answer_id`。按同一 IP 或用户 ID 加日期去重，只计最早一条；迁移前的重复历史行保留并标为 `superseded=1`，不参与有效成绩读取。重复上报仍返回 `204`。另有每 IP 每分钟 20 次限流，超过返回 `429`。练习结果不通过此端点上报；步数或日期无效返回 `400`。`won` 与 `attempts` 是**客户端自报数据**，没有服务端游戏状态验证，不能作为可信成绩或严肃运营统计。

每日答案选择算法及模型数据也随 Show1 前端交付，玩家可以从前端推导答案。这是已知设计边界，当前每日模式只适用于娱乐玩法。

### 3.21 Show1 兼容层

这些端点延续 Show1 的请求与响应形状。写请求遵循本服务 Origin、鉴权与限流规则。只读题库合并共用数据包与迁入快照，作品保留迁入快照；符合 `show_arena=1` 且允许公开的已验证新投稿增量进入作品列表。旧快照票不再参与读取、计分或配对；Show1 的新票不进入画廊 Bradley–Terry 榜单。现有数据库中的旧票须通过停机维护命令显式清零，启动和迁移不会自动删票。

| 方法与路径 | 请求与响应 |
| --- | --- |
| `GET /api/prompts` | `{ prompts: [...] }`；合并历史快照与数据包正式题目，竞技场 editorial 覆盖对应题目的 `commentary`、`weights`。 |
| `GET /api/works` | `{ works: [...] }`；快照作品加符合条件的 live 投稿。 |
| `GET /api/votes?scope=entertainment\|formal` | `{ votes: [...] }`；只读库内 `source=show1` 的票，按时间和 ID 排序，不合入旧快照。scope 必填，非法或缺失为 400。 |
| `POST /api/votes` | 登录必需；提交 `id`、`promptId`、`winnerRid/Mid`、`loserRid/Mid`、`mode`、`outcome`，成功 `201 { vote }`；同 ID 同票幂等重放，已投同一对返回 `409 pair`；`formal` 仅管理员。 |
| `GET /api/ratings?scope=entertainment\|formal` | `{ ratings: { [modelId]: number }, games: { [modelId]: number } }`；按库内票回放未取整 Elo，供配对，复用聚合缓存。scope 必填。 |
| `GET /api/show1/leaderboard?scope=entertainment\|formal&category=all\|text\|web` | 主站聚合榜单，scope 必填，category 缺省 all；非法参数 400。见下方。 |
| `GET /api/comments?round=<题目编号>` | `{ comments: [...] }`；无效题目 `400`。 |
| `POST /api/comments` | 登录必需；请求 `id`、`roundId`、`side`、`body`，成功 `201 { comment }`。 |
| `GET /api/reactions?prompt=<题目编号>` | `{ counts, mine }`；无效题目 `400`。 |
| `POST /api/reactions` | 登录必需；请求 `id`、`promptId`、`mid`、`kind`，成功 `201 { counts, mine }`；`kind:null` 撤销。 |
| `POST /api/track` | 最佳努力记录 `path` 浏览量，成功 `204`。 |

正式题目在数据仓库登记 `arenaId`（稳定三位编号）、`kind`（`text` / `web`）和 `category`。共享后端将同一个 task ID 映射到 Show1 编号，新增题目及其已验证、开启竞技场展示的投稿可以进入娱乐玩法；长短提示词使用同一个 task ID 与编号，以 `promptVariants: [{id, label, prompt}]` 返回两份原文，由前端按钮切换；作品可通过 `promptVariant` 标明使用的版本，同一模型的两版展示在一起。既有快照题目保留编号、名称及权重，正式提示词由数据包提供；未进入数据包的历史题目仍保留。此登记不写入社区 `questions` 表，也不改变作品审核和展示开关。

旧分享卡端点已移除，访问返回 `404`。兼容层的详细字段可参考 `test/fixtures/show1-golden/` 中的固定响应。

主站榜单响应：`{ scope, category, board, allBoard, radar, scopedPromptCount }`。`board`、`allBoard` 为 `{ rows, totalVotes, modelCount, promptCount }`，后者固定综合赛道，供页头统计；`scopedPromptCount` 是当前赛道实际投过票的题数。每行包含 `modelId`、`name`、`sigil`、`retired`、`rating`、`games`、`wins`、`losses`、`draws`、`winrate`、`topics`、`trial`。`radar` 为 `{ profiles: { [modelId]: [六维分] }, average: [六维均值] }`。空榜为零票、空 rows/profiles、画像均值六个 50；不返回逐票数据。

- 主站保持顺序 Elo：基准 1200、K=32，`P(A)=1/(1+10^((R_B-R_A)/400))`，胜／负／平分别使用 1／0／0.5；按服务端保存时间和 ID 重放，内部不取整，展示 rating 才取整。Elo 对顺序敏感，这与画廊使用的 Bradley–Terry 是两种独立口径。
- 娱乐包括 blind/party，正式只含 formal，互不混入。平局增加双方 games/draws，胜率为 wins/games；少于 30 次比较标记暂定。当前已发布作品仅覆盖 1 题的模型继续不进榜，发布第 2 题后进入；无当前作品但有本轮票的模型保留为历史阵容。
- 六维使用相同过滤和次序，各维 Elo 步长为 `32 × 投票保存权重`；零权重不变，缺少快照权重时使用当前题目权重，再缺失则六维均分。展示映射为 `clamp(50+(R-1200)/4,0,100)`，它表达按题目权重分配的偏好画像。
- 两个范围的三赛道结果与配对参考分缓存在 server，数据库写入或数据包版本变化后重建。重复提交同 UUID 同票返回原结果、不增票；同 UUID 改模式或改结果返回 `409 id`。清零命令先备份，再同事务清除全部 votes/matches 并记录审计；重启后两站都从零票开始。
- 身份更正优先于原始身份快照用于读取和计分，原始快照不覆盖；更正后双方同模型的比较不计入榜单、画像或配对分，原票仍保留在流水和数据库。

---

### 3.22 生成信息与管理筛选（schema v17）

`works` 追加 `model_version`、`generation_mode`、`human_intervention`、`generated_on`、`evidence_url` 五列；迁移只追加列，历史行默认为空串（未注明），不推断历史来源、日期或人工介入情况。

上表中的五个 API 字段同时支持投稿、审核、管理员直接上传、收件箱登记与 `/api/admin/works/:task/:id/meta`。投稿、馆藏的公开作品视图、管理员视图与收录导出均返回它们；请求省略字段保持已有值，空串显式清空，非字符串或非法值返回 `400 invalid_generation`。字段属于作者或管理员声明；证据链接不表示平台已经核验链接中的内容。后台编辑和审核的 audit 保存变化前后值。

`GET /api/admin/works` 新增 `model`（注册 ID 或 `other` 表示未登记模型）、`effort`（档位文本，大小写不敏感；`unset` 为未注明）、`generationMode` 和 `humanIntervention`（各自枚举值或 `unset`）。筛选可以组合，仍在分页前执行。搜索另外覆盖厂商和模型版本。响应追加 `efforts` 数组，取全部作品实际记录的非空档位，供后台选择自定义档位；其余分页字段不变。

推理档位输入提供常用值与手填。空串只表示未注明，明确使用默认设置可填写 `Default`；历史空串不改写成 `Default`。新对局的身份快照保留五个生成字段，历史快照不回填，计分键仍为模型或模型+档位。

数据仓收录将非空生成字段写入 manifest、task.json 和作品 README，构建 data.json 时透传。manifest 与 task.json 同时声明时必须一致；消费旧包时缺失字段仍按未注明处理。Show1 旧兼容端点的返回形状保持不变。

### 3.23 冗余字段清理（schema v18）

追加迁移删除 `works.audience`、`tool`、`vendor`、`reviewed_by`、`deleted_by` 和 `votes.identity_source`。`model_name` 改名为 `model_other`：仅保留未登记模型的手填名称，登记模型的名称和厂商读取当前数据包字典；字典缺少该 ID 时名称返回 ID、厂商为空。模型版本 `model_version` 保持不变。

旧 `tool` 只在没有 Harness ID 且「其他」为空时回填 `harness_other`。未登记模型的非空旧 `vendor` 在删列前原样追加为 `note` 中的「手填模型厂商：…」，保留原备注且不截断。缺失的审核、删除 audit 从旧操作人列补存，审核人通过最近一次审核记录读取。展示开关保留原值；所有历史对局、投票身份快照及更正值原样保留。旧客户端仍可提交 `tool`、`audience`，API 和收录导出的兼容字段由保留字段生成。升级前须备份数据库，退回 v17 或更早的代码须同时恢复兼容的数据库备份。

### 3.24 自动内容审查（schema v19）

追加幂等迁移，仅新增 `works.moderation` JSON 列；默认 `{ "status": "legacy" }`，既有作品保持原行为。`CONTENT_MODERATION=1` 时新投稿、管理员上传、收件箱登记均先设 `pending`。送审声明变更后重新设 `pending`，随机 revision 防止旧调用结果覆盖新版声明；人工决定也不会被较早的自动结果覆盖。启动恢复持久化的 pending 队列。内容状态与来源核验 `status` 独立。

| `moderation.status` | 含义 | 可公开 |
| --- | --- | --- |
| `legacy` | 旧流程，未自动审查 | 按原门面/核验规则 |
| `pending` | 排队或审查中 | 否 |
| `approved` | 自动或人工确认内容通过 | 按原门面/核验规则 |
| `review` | 疑似风险或自动审查失败，待人工 | 否 |
| `rejected` | 内容不通过 | 否 |

`moderation` 仅返回作者/管理员，包含 `status`、毫秒 `at`，完成结果可含 `source: automatic|human`、中文 `reason`、风险 `categories`、`error` 代码、`model`、`serviceTier`、`responseId`、`usage`、`coverage` 或人工 `reviewer`。不含 API 密钥或服务商原始错误响应。`bootstrap.site.contentModeration` 表示开关；管理员 `review.unverified` 同时计算来源待核验与内容待处理作品。

内容尚未通过时，公开 bootstrap、Show1 动态作品、盲评、评论/表情与收录导出均不可使用该作品；公开 `w<32hex>` 源返回 410，媒体请求仅允许作者/管理员，否则 404。作者/管理员作品 DTO 的 `scene` 是随机 `p<32hex>` 源，有效一小时、进程重启失效，返回 `Cache-Control: no-store`。该地址本身具有预览能力，不应公开转发。自动截图也使用此源。参与审查的已公开作品源与媒体使用 `no-store`，防止新审核状态被已有缓存跳过。

- **`POST /api/works/:task/:id/moderation`**：仅管理员；JSON `{ "status": "approved" | "rejected", "reason": "人工理由" }`。理由必填，最多 500 字；无效决定或缺理由 400，无权限 403，作品不存在 404。成功 200 `{ "work": <作者/管理员作品视图> }`，写 `content-review` audit。内容通过不改变来源核验或门面开关。
- **`POST /api/works/:task/:id/moderation/retry`**：仅管理员，无需请求体；仅开启自动审查时可用，否则 409。成功 200 `{ "work": <pending 作品视图> }`，写 `content-retry` audit，重新进入队列并暂不公开。

送审使用 Responses API，`gpt-6-luna`、`service_tier: flex`、`store: false`、低推理档、严格 JSON schema。材料为投稿声明、入口静态文字、两档实际页面文字、可选封面及桌面/手机首屏。疑似风险返回 review，明确风险可返回 rejected。未遍历所有文件、滚动区域或交互；语境模糊交人工。缺密钥、截图不完整、超出材料限额、请求超过 15 分钟、429/其他错误、未完成/拒答/无效结构或未确认 Flex 均转 review，不自动重试或切换标准档。`CAPTURE=0` 无法完成自动审查。关闭开关不放行已有待审或被拒作品。

## 4. 数据包契约（`dist/data.json`）

数据包由数据仓库（arenaofbias-data）构建产出；部署到 `DIST_DIR` 的副本是服务端馆藏目录输入。画廊前端从自己的静态部署消费对应数据与馆藏资源；若前后端各持有副本，应同步版本。其结构属契约的一部分。后端仓库当前无默认 `dist/`，运行前必须提供数据包。

### 4.1 顶层结构

```json
{
  "title": "同题异答",
  "subtitle": "…", "description": "…", "repo": "…",
  "schemaVersion": 1, "sourceCommit": "<数据仓库 commit SHA>",
  "models": [ <模型> ],
  "harnesses": [ <Harness> ], "providers": [ <服务商> ],
  "tasks": [ <题目> ]
}
```

**模型（model）**：`{ "id", "name", "vendor", "logo", "brandUrl", "brandName" }`。

**Harness / 服务商注册表**：顶层 `harnesses`、`providers` 均含完整条目与 `listed`，停用 ID 仍可解析历史作品。旧包缺少数组时服务端按 `[]` 读取。注册表条目含 `id`、`name`、`kind`、`maker`（Harness）或 `operator`（服务商）、`url`、`logo`、`aliases`、`listed`。服务端 `catalog.model()` 查完整 `modelPool`（含停用模型），同 ID 的 `models` 条目优先；`catalog.models()` 仍只返回展示列表。缺少 `modelPool` 的旧包只查 `models`。Harness 与服务商查询接纳注册表中全部 ID。

**题目（task）**：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` / `title` / `summary` | string | 标识 / 标题 / 简介 |
| `date` | string | 日期（`YYYY-MM-DD`） |
| `tags` | string[] | 标签 |
| `prompt` / `promptUrl` | string | 提示词原文与出处链接 |
| `promptPending` | boolean（可缺省） | 为真时该题**不接受上传**（服务端据此置 `acceptsUploads=false`） |
| `sandtable` / `sceneProfile` | 可缺省 | 沙盘 / 场景档案标记 |
| `conditions` | array | 截图条件 `[{ "id", "label", "note", "mobile" }]`，`id` 与馆藏作品的 `captures` 键对应 |
| `results` | array | 馆藏作品列表 |

**馆藏作品（result）**：

| 字段 | 说明 |
| --- | --- |
| `id` | 题目内唯一 |
| `model` | 模型 ID（对应 `models[].id`） |
| `effort` / `sourceLabel` | 档位 / 来源标签（服务端映射为 `tool`） |
| `harness` / `harnessVersion` / `provider` | Harness ID 或 null / 版本字符串（缺省 `""`）/ 服务商 ID 或 null；缺省即未注明 |
| `title` / `summary` / `addedAt` | 标题 / 简介 / 收录时间 |
| `scene` | 作品目录相对路径（如 `results/grok-4.6/`），画廊前端按其静态部署路径加载；后端按其 `DIST_DIR` 副本供盲评使用 |
| `source` / `readme` | 源码 / 说明链接 |
| `gallery` | `[{ "src", "caption" }]` 图集 |
| `captures` | `{ "条件id": "截图相对路径" }` |
| `previewModel` / `previewLoader` / `captureNote` / `guide` | 沙盘预览等可缺省字段 |

### 4.2 更新方式与缓存

- 已发布数据包目录包含 `.datapack-source.json`，形如 `{ "source": "github", "repo": "owner/arenaofbias-data", "commit": "<40 位数据包 SHA>" }`。`data.json.sourceCommit` 是打包前的源码 SHA，与数据包 SHA 分别校验格式，不要求相等；缺少来源文件或来源标为 `local` 时视为 `unversioned/dev`，即使 `data.json` 自称某 SHA 也不作为可信 pin。旧数据包缺少 `schemaVersion` 按版本 1 读取；不支持其它 schemaVersion。
- `DIST_DIR` 可直接指向不可变版本目录，或为指向它的 symlink/junction。切换指针到另一版本目录后，服务无需重启；缓存以真实目录和来源 SHA 为版本标识，不依赖 mtime。无来源文件的开发目录按 `data.json` 内容摘要检测变化。
- 对局保存其原版本真实目录，作品页面及资源在切换或重启后仍从该目录读取；历史票的计分身份自足于数据库，不要求永久保留旧包。清理旧目录时应保留当前目录，以及 `matches.expires_at` 尚未超过宽限期所引用的 `matches.datapack_root`。目录已被清理的对局，令牌不再提供内容，投票返回 `410`；服务也会释放该目录的内存快照。
- 后端站点端口可从 `DIST_DIR` 分发 JSON、图片等资源，但不提供作品 HTML；馆藏盲评使用内容端口的独立令牌源，独立画廊则从自身静态部署加载馆藏资源与页面。
- 版本目录一经发布必须保持内容不可变；直接覆盖仍被旧对局引用的同一目录不能保证旧资源可用。

### 4.3 消费方注意点

- 服务端使用 `id`、`title`、`promptPending`、`results[].id/model/effort/title/summary/sourceLabel/harness/harnessVersion/provider/scene/captures/gallery`，以及顶层 `models`、`harnesses`、`providers`；其余字段由画廊前端自行解释。
- 馆藏作品在平台 API（`bootstrap.works`、对战揭晓等）中**不携带 `scene` 字段**；需要播放馆藏场景的前端应以数据包 `scene` 路径为准。**待拍板**：娱乐面若也要经平台统一播放馆藏作品，是扩展 `toPublic` 下发 `scene`，还是娱乐面同样消费数据包，需双方确认。
- 服务端重复检测会读取馆藏作品 `scene/index.html` 的 SHA-256，数据包内该文件缺失时该作品不参与重复比对（不报错）。

---

## 5. 版本与变更纪律

1. 本文档与 `server/` 代码同库维护；**凡契约变更（端点、字段、状态码、限制、数据包结构）必须先改文档、走 PR，经两个前端负责方过目后方可合并**。
2. **字段只增不减**：已发布响应中的字段不得删除、不得改名、不得改变语义；新增字段默认缺省 / 可空，前端对未知字段一律忽略。破坏性格式变更通过新增端点或显式版本化进行，不原地修改。
3. 数据库表结构变更只允许在 `server/db.mjs` 的 `MIGRATIONS` 末尾追加幂等迁移（PRAGMA `user_version` 驱动），不改写已发布迁移。
4. 错误 `error` 文案面向用户、可随时调整，**不构成契约**；契约只承诺状态码与 `code` 字段。
5. 限流额度为运营参数，调整不视为契约变更，但应在本文档 1.6 节同步更新。
6. 本文档中标有「**待拍板**」的条目为与代码现状有出入或尚未决策之处，逐条拍板后更新文档并消除标记。

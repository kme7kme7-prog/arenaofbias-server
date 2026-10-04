# API 契约 · arenaofbias-server

## 竞技场收录作品的稳定内容地址（2026-10-03）

- Show1 `GET /api/works` 的公开 datapack 作品使用 `c<32hex>` 内容 origin；地址为持久化随机索引，按 task/id 联合识别，SQLite v37 追加 `curated_content_keys` 表。正常重启、再次拉清单不换键，不需要签名 secret。投稿 `w` 地址不变。
- 仅当前数据包中的公开、开启娱乐池且有内容目录的作品可取得 `c` 键。每次 GET/HEAD（含子资源）重新从当前目录读取作品并检查 `publicContent` 和娱乐开关；移出目录或关闭娱乐池后旧地址返回 410。返回 `Cache-Control: no-store`；键本身不授予权限。
- `p` 仍是作者/管理员私看与截图机的 bearer 预览源：一小时有效、重启失效。已有有效 `p` 无需迁移，新索引不延长或改变它的权限。
- `c` HTML 注入就绪探针：在其他阻塞脚本前首先发送 `aob:work-loading`，随后按原时序发送 `aob:work-ready`；竞技场请求其他已有作品源时用 `aob=prev` 请求同一探针，普通 `w` 地址未带此参数时保持原样。错误页不发送上述消息。父页等待文档到达最多二十秒；当前作品窗口首次 loading 或 iframe 文档 load 后，给该文档十秒就绪等待，重复信号不续期。初始 about:blank 不算文档到达，自动恢复仍仅一次。CSP 和部署配置不变。

> 本文档是「娱乐面 React 站」与「专业面静态画廊」两个前端对接本后端的**唯一硬接口文档**。
> 文中全部端点、字段、状态码与限制均以 `server/` 目录当前代码为准逐条核实；
> 与代码现状存在出入、或尚待双方确认之处，均以「**待拍板**」标出。
>
> 核实基准：`server/app.mjs`（路由表）、`auth.mjs`、`library.mjs`、`arena.mjs`、`catalog.mjs`、`ranking.mjs`、`config.mjs`、`http.mjs`、`content.mjs`、`db.mjs`。

---

## 1. 总述

### 1.1 服务定位

本服务是整个体系中**唯一的动态服务与唯一写库者**，负责账号、投票、排行榜、投稿审核与作品沙盒伺服。`ArenaGalleri` 提供静态画廊前端与原作展示，`arenaofbias` 提供主站，`arenaofbias-server` 提供动态 API、数据库、`/admin/` 管理页面和投稿沙盒，`arenaofbias-data` 构建后端读取的数据包数据包。两个用户前端各自部署并调用本服务；数据库（`DATA_DIR/platform.db`）由本服务独占，前端不直接读写。旧 same-prompt-gallery 已归档。

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

作品内容 URL 不写在各端点文档里逐个列出，而是由响应字段（`bootstrap.site.content`、作品对象的 `scene`、对战对象的 `a`/`b`）以完整 URL 形式下发，前端直接消费，不自行拼接。投稿 `captures` / `cover` 返回相对路径 `media/...`，前端以 API 站点根解析；数据包 `scene` 路径取自画廊所用数据包。

### 1.3 认证方式

- 认证基于 **Cookie 会话**。注册 / 登录成功后，响应头种下：
  `COOKIE_SECURE=1` 时为 `Set-Cookie: __Host-sp_session=<token>; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure`（无 Domain）；未启用 Secure 的本地环境仍用 `sp_session`。
- 会话 Cookie 为 HttpOnly，前端脚本不可读；服务端只存其 SHA-256。重名会话 Cookie 按未登录处理。
- 登录与注册生成新会话并撤销请求中唯一的旧会话 Cookie。绝对有效期仍为 30 天；服务端闲置有效期普通账号为 24 小时，管理员为 30 分钟，以有效认证请求刷新。v32 为 sessions 追加 last_seen_at，旧会话从创建时间计算闲置期，不延长原过期时间。
- 前端请求需携带 Cookie（`fetch` 使用 `credentials: 'include'`，XHR 使用 `withCredentials = true`）。`COOKIE_SAME_SITE` 支持 `Lax`（默认）、`Strict`、`None`；跨站 HTTPS 部署设 `None` 并开启 `COOKIE_SECURE=1`，否则服务拒绝启动。第三方 Cookie 仍受浏览器设置限制，建议前端与 API 使用同站域名。
- 生产会话 Cookie 只属于 `api.arenaofbias.icu`；game 与 Gallery 都必须直接请求 `https://api.arenaofbias.icu` 才能共用登录状态，经前端自身域名反代的 `/api` 会产生独立会话。
- 登出（`POST /api/auth/logout`）删除服务端会话并下发 `Max-Age=0` 的清空 Cookie。
- 角色：`user`（普通用户，默认）、`moderator`（普通管理员）、`admin`（高级管理员）。管理员账号只能经 CLI 新建（`npm run admin -- --create <用户名>`，密码从标准输入读取、不回显），或将已有普通账号提权（`npm run admin -- <用户名>` 或管理员角色接口）。公开注册拒绝 `ADMIN_USERNAMES` 中的保留用户名；已有账号登录时仍按该配置同步管理员角色。

### 1.3.1 三级权限

`isStaff` 包含 admin / moderator，`isSenior` 仅 admin。高级管理员可审核自己的作品与题目；普通管理员不能对自己发布的作品作审核决定，返回 `403` 并提示需要其他管理员处理，编辑自己的作品信息可以。

| 操作 | admin | moderator |
| --- | --- | --- |
| 作品内容审核、重新自动审核、人工核验、对应批量接口 | 允许 | 允许，禁止处理自己的作品 |
| 作品信息编辑、门面开关、校准、收件箱 | 允许 | 允许；自己的作品只可编辑信息 |
| GET review、GET admin/works、私密预览令牌 | 允许 | 允许 |
| 题目审核、题目编辑、GET admin/questions | 允许 | 403 |
| 删除他人的题目或作品 | 允许，无票才可删除 | 403 |
| 角色管理、流量、主编视角、其他未开放的旧管理员接口 | 允许 | 403 |

作者删除本人题目或作品沿用原作者规则。工作人员发作品跳过 AI 内容审查与人工内容审核，保存 human / approved，仍为 unverified，人工核验通过才公开；工作人员发题目仍进 pending，且不受 3 道待审上限约束。普通用户流程保持原有审核规则。`/admin/` 支持普通管理员登录，隐藏题目、删除他人条目、角色、流量等无权限入口；最终权限以后端 403 为准。

### 1.4 通用错误格式

所有错误响应均为 JSON，形状如下（`server/http.mjs` 的 `HttpError`）：

```json
{ "error": "人类可读的中文错误信息", "code": "可选的机器可读代码" }
```

- `error` 恒存在，面向最终用户，可直接展示。
- `code` 仅在少数业务错误上出现，例如 `"insufficient"`（对战池不足）、`"exhausted"`（该用户已评完全部组合）。前端逻辑判断请用 `code`，不要匹配 `error` 文案。
- HTTP 状态码全集：`400`（参数无效）、`401`（未登录 / 凭证错误）、`403`（无权限 / 来源无效）、`404`（不存在）、`405`（方法不允许）、`409`（状态冲突）、`413`（体积超限）、`415`（Content-Type 非 JSON）、`429`（限流 / 待审超限）、`500`（服务端错误，固定文案「服务器出错了，请稍后再试」）。
- 非 GET/HEAD 的 `/api/*` 请求必须带有可信 `Origin`：请求自身的完整 origin 或 `SITE_ORIGINS` 白名单中的完整 origin（精确协议、主机与端口），否则 `403 请求来源无效`。同源判断只在 `TRUST_PROXY=1` 时使用代理传入的 HTTPS 协议。
- JSON 请求体默认上限 64 KB；`POST /api/works` 与 `POST /api/questions` 放宽至 6 MB（示例作品封面以 data URL 内嵌所致）。
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
| read API | 180 次 / 分钟 | 客户端 IP | `/api/*` GET/HEAD，跨端点、登录状态共享 |
| read catalog | 30 次 / 分钟 | 客户端 IP | bootstrap、show1/works、works、prompts、votes、ratings、leaderboard、guess/today 的 GET/HEAD，共用一桶，参数不影响计数 |
| read files | 1200 次 / 分钟 | 客户端 IP | 后端静态文件与所有作品源 GET/HEAD，共用一桶 |
| read pages | 60 次 / 分钟 | 客户端 IP | 所有作品源 HTML/HTM，共用一桶；HTML 同时计入 read files |

读取额度可通过 `READ_API_PER_MIN`、`READ_CATALOG_PER_MIN`、`READ_FILES_PER_MIN`、`READ_PAGES_PER_MIN` 调整（最小 1）。超限响应带 `Retry-After` 秒数；可信 Origin 的 API 错误仍保留 CORS 许可。HEAD 计数与 GET 相同。OPTIONS 和写 API 不占读取额度，继续沿用自己的来源校验和写限流。


API 域静态 `/data.json`（含等价编码路径）仅管理员登录后返回；其他访问返回 404。`.datapack-source.json` 对所有人返回 404。管理员页面无需改请求方式；画廊使用自己部署的展示目录。Show1 榜单与配对分由后端聚合，逐票兼容接口保留，详见 3.21。VPS 的两个静态前端需安装 Nginx 读取限制，详见 [部署说明](deploy.md#公开读取与反爬配置)。

`TRUST_PROXY=1` 仅适用于本机单层反代：连接来源必须为环回地址，IP 取 `X-Forwarded-For` 最后一项有效 IP；其他连接或无效头回退到连接 IP。边缘代理必须覆盖原头或在尾部追加真实客户端 IP，多层代理部署须另行明确解析链路。限流为单机内存计数，进程重启即清零，多实例部署不共享。

---

## 2. 数据模型

以下字段定义以 `server/db.mjs`（表结构）与 `server/catalog.mjs`（数据包读取）为准。HTTP 层暴露的是经 `library.toPublic` 整形后的「公开视图」，二者分列。

### 2.1 作品（work）

对外只有一套作品，以 `task/id` 标识；数据包中的作品 ID 可以跨题重复。文件保存在数据包目录或 SQLite 作品对应的上传目录，存储分流仅在后端内部。数据包条目默认已通过核验，数据库新作品默认 `unverified`。两者共用展示开关、盲评资格、文字编辑、核验与删除操作。历史 `curated_as` 非空的数据库作品继续排除，防止同一件作品重复显示。

统一发布者形状：

```json
{ "author": { "role": "admin", "name": null, "avatar": null }, "mine": false }
```

- `author.role` 为创建时角色，持久化于 `author_role`，不随账号后来升降权变化，可取 `admin` / `moderator` / `user`。数据包题目与作品固定为 `admin`。
- 公开与作者接口（bootstrap、me、作品列表、对局揭晓）中，`admin` / `moderator` 的姓名与头像恒为 null，前端显示站点名；普通用户返回昵称和头像，已注销作者姓名为 null。管理员视图另行返回可追溯的真实账号昵称。
- `mine` 根据当前会话与作者账号计算。DTO 删除 `owner`、`ownerName`、`ownerAvatar`、`curated`、`community`、`source`、`curatedAs`、`nominatedAt`；内容审核对象内的 `moderation.source` 仍表示审核方式。

作品公开视图示例：

```json
{
  "task": "chinese-architecture", "id": "up-3f9k2m1x",
  "title": "体素小城", "summary": "……", "note": "……",
  "model": "grok-4.6", "modelName": "Grok 4.6", "vendor": "xAI",
  "effort": "High", "tool": "CLI", "harness": "claude-code", "harnessName": "Claude Code",
  "provider": "official", "generationMode": "single-turn", "humanIntervention": "none",
  "status": "verified", "reason": "",
  "author": { "role": "user", "name": "alice", "avatar": "avatar-id" }, "mine": false,
  "addedAt": "2026-09-27T08:00:00.000Z", "reviewedAt": null,
  "scene": "http://w<32hex>.localhost:5180/",
  "captures": { "first": "media/up-3f9k2m1x/first.jpg" },
  "cover": "media/up-3f9k2m1x/cover.webp", "files": 12, "bytes": 183411
}
```

| 字段 | 规则 |
| --- | --- |
| `title` / `summary` / `note` | 标题 ≤40 字、简介 ≤200 字、补充说明 ≤1000 字 |
| `model` / `modelName` / `vendor` | 登记模型或自由文本；编辑字段名为 `modelId`，自填模型使用 `modelName` / `vendor` |
| `effort` | 新作品必填，归一到 Low / Medium / High / XHigh / Max，其他档位保留；编辑不可显式清空 |
| `harness` / `harnessName` / `tool` | Harness 注册表或自填名称派生；编辑使用 `harnessId` / `harnessOther`，不收集 Harness 版本 |
| `provider` | official / unofficial / null；新作品及核验通过前须填写；编辑使用 `providerId` |
| `generationMode` | single-turn / multi-turn / 空串；历史 agent 读取为 single-turn，新写 agent 返回 400 |
| `humanIntervention` | none / prompt-guided / code-edited / 空串 |
| `promptVariant` | 数据包提示词版本 ID，非空时输出 |
| `status` / `reason` | unverified / verified / questioned；存疑须有理由，verified 时理由清空 |
| `moderation` | 内容审核状态，作者视图裁剪自动拒绝理由，管理员视图保留完整结果 |
| `arena` | 作者或管理员视图的服务端结论：in_pool / off / not_qualified / waiting；不再返回 curated 状态 |

资源字段 `scene`、`captures`、`cover`、`files`、`bytes`、`checks`、`trial`、`sourceName`、`root`、`entry` 仅出现在后端托管文件的数据库作品上。`scene` 为完整 URL；出现的 `captures` / `cover` 一律按 API 根地址解析。`checks`、`trial`、`sourceName`、`root`、`entry`、`reviewer` 为作者或管理员特权字段。数据库作品的 `calibration` 从 `trial.calibration` 提取。

数据包作品省略上述资源字段，前端按 `task/id` 取自己数据包中的资源，并以 bootstrap 列表决定哪些作品可以公开。覆盖后的业务字段、核验 `status` / `reason` 在公开与管理员接口中一致生效。数据包作品的展示模型可编辑，原始数据包模型身份仍保留用于计分；已有投票始终按冻结快照或显式更正计分。

### 2.2 任务 / 题目（task）

公开题目 DTO：

```json
{
  "id": "one", "title": "题目", "summary": "测试简述", "prompt": "完整提示词",
  "category": "静态网页", "domains": ["产品与品牌"], "templates": ["static", "vite"],
  "version": 1, "date": "2026-10-03", "createdAt": null,
  "author": { "role": "admin", "name": null, "avatar": null }, "mine": false,
  "acceptsUploads": true, "cover": null
}
```

数据包题目默认 `approved`，`acceptsUploads` 默认 `!promptPending`；数据库题目默认接受上传。管理员可以编辑投稿开关与指定封面。`cover` 为同题已有作品 ID，未指定为 null；封面选举 `featured` 仍保留。提示词版本、截图条件等资源字段由前端的数据包提供，不加入题目 DTO。数据库题目的既有标签仍保留。

管理员视图另含 `moderation`、`works`（两种存储合计未删除作品数）、`votes`（投票记录数）、`samples`（发起者随题附带的数据库示例；数据包题目为空）。待审、拒绝、撤下题目仅在作者或有权限的管理视图可见；题目撤下或删除后，关联作品不公开，相关票暂停计分，重新通过后恢复。

### 2.2.1 覆盖层与迁移（schema v38）

迁移追加到 MIGRATIONS 末尾并可重复运行。`works` 与 `questions` 新增 `author_role`；回填优先识别管理员创建题目、管理员上传 / 收件箱登记的历史路径，再按作者当前角色回填。旧 member 账号转为公开角色 user，已有 admin 账号保持高级管理员。历史审计、投票 JSON、`curated_as` / `nominated_at` 列与值保留。

`questions` 新增 `accepts_uploads`、`cover_work`。数据包题目编辑、审核、投稿开关、封面与删除存于 `question_overrides`；数据包作品文字、开关、校准、核验决定与删除存于 `work_overrides`。删除数据包条目等于永久隐藏；文件仍由独立数据仓维护，不在服务端移除。数据库条目写本行并软删除。

### 2.3 模型（model）

由数据包完整注册表 `modelPool` 和展示列表 `models` 定义：`{ id, name, vendor, logo, brandUrl, brandName }`。投稿时若给出 `modelId` 且命中模型表，服务端以表内 `name` / `vendor` 为准，忽略请求中的 `vendor`，数据库 `model_vendor` 存空串；未登记模型的自填 `modelName`（≤60 字）存为 `model_other`，`vendor`（trim 后≤40 字，可为空串）存为 `model_vendor` 并在作品视图返回，`modelId` 置 null（排行键退化为 `x:<小写模型名>`）。作者编辑或管理员审核时，省略 `vendor` 保留自定义厂商，显式空串或切换为登记模型会清空该列；自定义厂商参与内容审核。旧 `note` 中的「手填模型厂商：…」保留，不回填新列。

### 2.4 用户（user）

数据库字段：`id`（16 位十六进制）、`name`（显示名）、`name_key`（NFKC + trim + 小写的唯一键）、`role`（`admin` / `moderator` / `user`）、`salt` / `hash`（标准 scrypt N=16384, r=8, p=1, keylen=32）、`hash_params`（可空 JSON）、`created_at`。`hash_params=NULL` 表示标准参数；迁入的旧用户可记录 `{ "N": 32768, "r": 8, "p": 1, "keylen": 64 }`。旧用户成功登录后立即换新 salt/hash 并清空 `hash_params`；标准用户无额外哈希或查询。

HTTP 公开视图恒为：

```json
{ "id": "…", "name": "…", "nickname": "…", "role": "user" }
```

未登录时用户字段为 `null`。`nickname` 默认返回登录用户名，可经 `PATCH /api/me` 修改；数据库增加 `nickname` 列，`name` 仍为登录用户名。用户名规则：NFKC 规范化后 2–24 位文字（Unicode 字母）、数字、下划线或连字符；密码 8–128 位。

### 2.5 对局（match）

数据库字段：`id`（24 位十六进制）、`user_id`（可空，匿名对局）、`task_id`、`a_work` / `b_work`（两侧作品 ID）、`a_token` / `b_token`（两侧内容令牌，`m` + 32 位十六进制，唯一）、`created_at`、`expires_at`（3 小时）、`choice`（`a` / `b` / `tie` / `skip`，未投为 null）、`decided_at`。新增 `datapack_root`（创建时 `DIST_DIR` 的真实目录）、`datapack_version` 和两侧 `a_identity` / `b_identity` JSON 快照。旧对局这些新增列为 null，只能按当前数据包尽力解析。

对局**从不**经列表端点暴露；只在创建与投票两个端点的响应中出现（见 3.8、3.9）。内容令牌在对局有效期内经内容端口伺服对应作品，令牌本身不泄露作品身份。

### 2.6 投票（vote）

数据库字段：`id`、`match_id`（唯一）、`user_id`、`task_id`、`a_work` / `b_work`、`pair_key`（`题目:作品A+作品B`，ID 排序后拼接）、`choice`（`a` / `b` / `tie`，`skip` 不产生投票行）、`created_at`，以及 `a_identity` / `b_identity` JSON 原始快照、`a_correction` / `b_correction` JSON 显式更正和 `source`（`arena` / `show1` / `legacy`，v18 删除冗余的 `identity_source`）。快照含当时模型 ID、名称、厂商、档位、归一化档位、model/config 计分 key、内容摘要 `digest`，以及 `harnessId`、`providerId`。这两项不参与 `configKey` 或 `digest` 计算；旧快照里的 `harnessVersion` 读取输出时忽略，不重写原始快照。数据包摘要为入口页 SHA-256，投稿为全包 SHA-256。v8 迁移前的 legacy 票在 `a_identity` / `b_identity` 中存的是裸的旧模型 ID，并非 JSON；这类票不参与计分，也不能按推测更正。迁移前没有身份快照的对局不能再投票。新票按持久快照或显式更正计分，原始快照保持不变。约束：`UNIQUE(user_id, pair_key)`——**同一用户对同一作品组合只计一票**。

计入排行的投票需同时满足：投票时已登录、双方作品当前均为 `verified` 且存在、非本人作品、未评过该组合。作品被标记存疑或删除后，其相关投票即时退出排行；恢复后重新计入（见 3.9）。审核只影响是否计入，不会改写新票的计分归属。需要改正归属时由管理员明确更正单票，审计记录包含更正前有效值、更正后值、理由和操作者；缺少原始双侧快照的 legacy 票不可按推测更正。

### 2.7 审核状态流转

```
unverified ──审核──▶ verified ──审核──▶ questioned
    ▲                   │                    │
    └────── 审核退回 ────┴────── 审核退回 ◀───┘
```

- `unverified`：初始状态，**不进入**盲投对战池，不进入排行。普通用户作品沿用内容审核与人工核验流程；工作人员作品虽已内容放行，也必须完成核验才公开。数据包作品默认 verified，核验退回时同样隐藏。
- `verified`：可公开展示；非文字题还须内容放行、`show_arena` 开启、`generationMode=single-turn` 且 `humanIntervention=none` 才进入盲评池与排行。已转为数据包的原投稿不重复进池。
- `questioned`：存疑。必须填写理由（作者与访客均可见）；退出对战池与排行，且**不可再互动**（表情返回 `409`）。
- 删除为软删除（`deleted_at`），数据包作品同样可经 API 软删除（覆盖层永久隐藏，不移动文件），有票不能删除。

### 2.8 评论（comment）

v6 新增 `comments` 表：`id`（24 位十六进制）、`task_id`、`work_id`、`user_id`（账号删除后可空）、`body`、`created_at`（毫秒）、`deleted_at`（可空）。评论依附于已上架的数据包作品或 `verified` 投稿；数据包作品不在 SQLite 的 `works` 表中，因此 `work_id` 不设外键。删除评论只设置 `deleted_at`，公开读取不返回已删除项。

---

## 3. 端点

约定：除注明外，请求体均为 JSON（`Content-Type: application/json`），响应均为 JSON 且 `Cache-Control: no-store`。GET 路由同时接受 HEAD。认证列中的「登录」指有效会话 Cookie；「管理员」指 `role === 'admin'`。

### 3.1 `GET /api/bootstrap` —— 首屏聚合

**认证**：无（匿名返回阉割版）。**限流**：无。

首屏一次取齐当前用户、站点配置、全部公开题目与作品、表情汇总、各题对战池规模、排行总计、我的计数和工作人员待审数。apiVersion 为 2，Gallery 须与后端同版本发布；旧版 Gallery 遇到 2 降级为静态存档。Show1 兼容层输出保持原形状。

`domains` 返回题目可选的完整领域词表，目前 25 项；`domainGroups` 返回 `{title, domains}` 四组（理工与健康、人文与社会、空间与产品、生活与娱乐），只用于表单排布，展开后与词表一致。每题仍可选 1–2 项。后台新建与编辑都使用这份分组和同一套复选控件，选满后可取消并更换。`category` 的存储值继续为文学 / 静态网页 / 建模，界面统一显示文本 / 设计 / 三维；设计的 Gallery 投稿格式仍为单个 HTML 文件。词表扩充不迁移已有题目，不改历史投票与排行分组。

```json
{
  "datapack": "<数据仓库的 40 位 Git commit SHA，或 null>",
  "catalogDigest": "<实际加载 data.json 原始字节的 SHA-256>",
  "apiVersion": 2,
  "serverVersion": "<服务端构建版本或 dev>",
  "providers": [{ "id": "official", "name": "官方", "listed": true }, { "id": "unofficial", "name": "非官方", "listed": true }],
  "user": { "id": "…", "name": "alice", "role": "user", "emailBound": true },
  "site": {
    "content": "http://{token}.localhost:5180",
    "cdn": ["cdn.jsdelivr.net", "unpkg.com", "cdnjs.cloudflare.com", "esm.sh", "fonts.googleapis.com", "fonts.gstatic.com", "registry.npmmirror.com"],
    "capture": true,
    "contentModeration": true,
    "autoModeration": true,
    "efforts": ["Low", "Medium", "High", "XHigh", "Max"],
    "emojis": ["lick", "lol", "press", "luck", "yes", "drool", "knock", "stare", "no"],
    "limits": { "uploadBytes": 31457280, "coverBytes": 3145728, "pendingPerUser": 5, "provisionalGames": 30 }
  },
  "works": [ /* 两种存储中 visibleTo(show2) 的作品，已应用覆盖 */ ],
  "questions": [ /* 两种存储中全部公开题目，已应用覆盖，见 2.2 */ ],
  "domains": [ "数学", "物理", "化学", "生物", "天文", "建筑", "自然景观", "交通与机械", "产品与品牌", "文学艺术", "游戏娱乐" ],
  "reactions": {
    "counts": { "task-id/work-id": { "press": 3 } },
    "mine": { "task-id/work-id": ["press"] }
  },
  "arena": { "chinese-architecture": { "works": 40, "entries": 33 } },
  "featured": { "chinese-architecture": { "cover": "work-id", "models": { "model-id": "work-id", "x:custom model": "up-work-id" } } },
  "totals": { "votes": 128, "voters": 17, "entries": 33 },
  "me": { "votes": 12, "pending": 1, "pendingLimit": 5, "updates": 0 },
  "review": null
}
```

- `site.content` 为作品 origin 模板，`{token}` 占位；前端无需自行替换（`scene` / `preview` 均为替换好的完整 URL），此字段仅供诊断与展示。
- `datapack` 只在已加载数据包带有有效 GitHub 来源文件时返回真实 SHA；无来源元数据或标为 `local` 的本地包返回 `null`。`catalogDigest` 是实际加载的 `data.json` 原始字节的 SHA-256，本地开发前后端在 `datapack=null` 时可据此比较是否使用同一目录数据版本。`serverVersion` 在进程启动时优先读取 `SERVER_VERSION`，其次读取部署目录 Git HEAD；非 Git 部署读取 `.server-version`，均不可用时为 `dev`。它标识服务代码，不是数据包版本；数据包以 `datapack` 字段判读，部署后分别核对两者。
- `works` 为两种存储中当前对 Gallery 公开的作品，统一 author DTO，覆盖字段与状态已生效；不在列表中的数据包作品前端不得公开。
- `arena[题目]` 只保留 poolStats：`works` 为对战池作品数，`entries` 为模型配置数；删除 uploads，投稿开关读取 questions[].acceptsUploads。
- `featured`：按题目返回已当选的封面 `cover`（作品 ID 或 null）及各模型跨档位的代表作 `models`。只列已有当选记录的题目和模型；空结果为 `{}`，缺少封面时为 null。模型键使用 `catalog.modelKey(work)`：有 `modelId` 时用该 ID，否则用 `x:` 加上模型名的 NFKC、首尾去空白、小写结果。数据包和投稿均用作品 `id`，无需来源前缀。
- 代表作与封面只选当前盲评合格且至少 5 场比较的作品，以作品分的 `score - interval` 最大者当选；同模型代表作跨推理档位选择。每日重算时按当前票重新评估候选与旧当选者的保守分，新候选至少高出 40 分才替换。每题按服务器时区自然日最多重算一次，包括没有达标作品的日子；结果与重算日期保存在 SQLite，重启不重排。bootstrap 懒触发后台计算并先返回旧结果；已撤出、存疑、删除或其他不合格的当选作品在读取时立即移除，剩余结果仍等次日重算。文字题跳过，前端自行兜底。
- 匿名：`user`、`me` 为 `null`，`reactions.mine` 为 `{}`。工作人员的 `review` 返回 `unverified`、`content`、`autoRejected`、`injected`、`questions`；普通管理员的 questions 固定为 0。`unverified` 与统一核验队列一致：题目已公开、内容已放行、未存疑；数据包作品须 status=unverified，数据库作品须尚无展览馆面决定（reviewed.gallery 为 null，可包含竞技场已核验的作品），历史 curated_as 条目排除。待审题目的示例待题目通过后计入。其余内容计数仍取未删除数据库作品，排除所属题目已删除的作品：content 为 moderation.status=review，autoRejected 为 rejected 且 source 不为 human（包括 automatic、recheck 和缺省 source），injected 为 categories 含 prompt-injection，后两者可重叠。questions 为未删除 pending 题目数。pending 仍在自动队列、rejected 已有决定，均不计入 content。
- `site.capture` 表示截图当前是否可用；浏览器启动失败后为 false，冷却五分钟后的下一件作品会尝试恢复。`site.contentModeration` 表示内容审核开关；`site.autoModeration` 为 `moderator.enabled && Boolean(apiKey) && capturer.available`，只有开关、密钥与截图能力齐备时为 true，截图恢复后自动变回 true。前端在内容审核开启且 autoModeration=false 时显示「管理员检查内容」；旧后端缺少该字段时按 true 兼容。
- `user.emailBound` 仅当前会话用户在 bootstrap 中返回，反映是否绑定邮箱；不加入 `auth.public`，评论等公开用户数据不包含该字段。
- `me.pending` 只统计本人未删除、仍为 `unverified` 的投稿，排除内容已拒绝或所属题目已拒绝的作品；内容 `pending` / `review` 与题目待审的示例仍占名额。上传作品和创建题目附示例共用此计数。
- `me.pendingLimit` 为本人实际等待核验上限；基础上限由 `PENDING_PER_USER` 配置（默认 5），`site.limits.pendingPerUser` 保留此基础值。未删除的 `verified` 作品至少 `TRUSTED_MIN_VERIFIED` 件（默认 3），且近 90 天没有被标为存疑的作品，采用 `TRUSTED_PENDING_PER_USER`（默认 20）。存疑检查包括当前状态与存疑审计记录，删除作品或后来恢复为已验证不会消除该次存疑。高级与普通管理员不受限制，返回 `null`。
- `me.updates` 为本人未删除投稿中，最近一次核验（`reviewed_at`）或内容审核决定（`moderation.at`）晚于 `users.works_seen_at` 的件数；内容排队 `pending` / `review` 不算决定。尚未标记已读时只统计最近 7 天的变化。调用 `POST /api/me/works/seen` 后已发生的变化归零。
- `providers` 固定返回上述两项，不依赖数据包中的历史登记表。作品公开、作者与管理员视图的 `provider` 只为 `official`、`unofficial` 或 null，不再返回 `providerName`。

### 3.1.1 `GET /api/fold.js` —— 作品控件折叠脚本

**认证**：无。响应为 `text/javascript; charset=utf-8`，`Cache-Control: no-cache`；支持 HEAD，沿用受信任前端 CORS 与 API 读取限流。返回服务端 `server/fold.js` 的原始字节，供 Gallery 在同源数据包 iframe 加载完成后注入，已加载的文档立即扫描。

盲评令牌页面继续默认注入折叠脚本；公开及预览作品的 HTML 仅在 URL 带 `aob=fold` 时额外注入，脚本资源 `/__sp_fold.js` 无需重复携带参数。可同时使用 `aob=bridge&aob=fold`，相机恢复和捕获规则保持。草稿试加载不启用此 opt-in。

子页面报告 `{source:'sp-fold', count}`，父页面通过 `{source:'sp-arena', fold:boolean}` 切换；`false` 显示控件，`true` 隐藏控件。控件 DOM 与状态保留，接受消息时只认当前父窗口。检测启发式与超过 6 个块 / 本次覆盖 40% 的保护规则沿用现有脚本。

错误提示区域（`#err`、`#error`、`role=alert|alertdialog`）及其重试、换源按钮不折叠。

Show1 娱乐盲测小窗可单独 opt-in `aob=arena-fold`，注入 `/__aob_fold.js`（`server/arena-fold.js`），不限题目类别；放大及正式模式不附加此参数。它与原折叠脚本互斥，不改变 `aob=fold` / Gallery 语义；草稿不启用。策略要求大幅 Canvas，识别覆盖其上的 fixed/absolute 控制容器，以及由多个短文本绝对定位节点构成的非交互标注层，保护入口、表单、带语义标记的介绍内容；未识别时保持原貌。沿用上述父子消息协议，默认收起，可恢复原 DOM/输入状态，并检测迟加载容器；count 仍仅报告控制面板数量。脚本资源同样先经过作品访问门禁，不扩大公开范围。Canvas 内文字和布局内 UI 不保证可自动识别。

娱乐建模/3D 场景/物理模拟/体素世界小窗在上述参数之外附加 `aob=arena-scene`，仅在存在唯一可识别大 Canvas 时将其原容器链铺满，收起链外产品页内容并触发原作品 resize；不移动/重建 Canvas 或修改相机。没有 Canvas 或多个候选时不选择。含 radio/range/select 且不含邮箱、密码或 textarea 的产品配置表单可随场景隔离隐藏；普通表单、凭据输入与开始体验入口仍保留。场景布局不受 `sp-arena` 面板开关控制；放大/正式使用不含两项 Arena 参数的原地址恢复完整页面。后台竞技场取景沿用同一类别与 opt-in 参数，并保留 bridge 相机通信；展览馆取景不附加 Arena 参数。源文件及访问权限不变。

APEX-65 当前打包版本使用独立 SHA256 固定的相机适配：仅竞技场取景（aob=bridge、face=arena）与 arena-scene 文档动态引用 /__aob_apex_camera.mjs，将 OrbitControls 最远距离从 220 扩到 2200，并注册既有抓取/恢复桥接。普通、展览馆、正式 m 文档不改；版本不匹配不适配，模块请求仍经过原作品访问门禁，不改存储文件或相机数据格式。Tessera 65 同样按 bundle SHA256 固定适配，仅上述竞技场路径引用 /__aob_tessera_camera.mjs：取消隐藏工具栏的相机留白，距离扩为 baseRadius 的 0.08–10 倍，跳过预览相机入场补间并接入既有抓取/恢复。

娱乐专用批量镜头保存在 `server/entertainment-calibration.json`，以 `task/id` 索引，入口与允许转换的本地脚本分别校验 SHA256。该配置不写数据库共享的 `calibration_arena`：只有非 draft、非正式 `m` 的竞技场取景（`face=arena&aob=bridge`）或 `aob=arena-scene` 文档读取新镜头。普通作品、展览馆和正式盲测不读取本批配置；不匹配的版本保持原文件。

内容服务按上述版本匹配为本地脚本附加 `aob=entertainment-camera`，仍先经过原内容访问门禁，再动态接入相机桥接。源文件不落盘改写，外部脚本地址不改。娱乐镜头包含 position/target；个别透视作品可另存受限的 fov（20–100），不扩展共享相机 API 格式。桥接在绘制前保持娱乐保存镜头，关闭娱乐预览的自动绕转；直接 canvas 拖动/滚轮后释放镜头保持，窗口调整保留当前视角。未带娱乐标记的桥接仍沿用既有行为。

娱乐 `arena-fold` 的非正式文档使用独立就绪探针：DOM 可用后每 80ms 检查，连续两次满足条件才上报 `aob:work-ready`；`arena-scene` 还要求 Canvas 实际绘制且已识别的大加载浮层消失。它不依赖 `window load` 或不可见 iframe 的帧回调，也不使用 8 秒强制成功。普通/Gallery 与正式 `m` 探针保持原策略。Show1 娱乐前端场景文档就绪预算为 30 秒，静态为 10 秒、导航为 20 秒；失败最多刷新换组一次，刷新期间废弃旧 iframe 的就绪信号。加载浮层识别是启发式判断，不保证识别 Canvas 内或任意自定义加载页。

### 3.2 `POST /api/auth/register` —— 注册

**认证**：无。**限流**：auth 桶（10 次/分钟/IP）。

请求体：`{ "name": "…", "password": "…", "email": "…", "code": "六位数字" }`；Show1 可用 `username` 代替 `name`。邮箱与验证码必填，先通过 `purpose: "register"` 发码；注册不再要求 `turnstileToken`，人机验证在发码时完成。校验验证码后，在同一事务消费验证码、创建账号并写入归一化 `email` 与 `email_verified_at`。

成功 `200`（**同时种下会话 Cookie，即注册即登录**）：

```json
{ "user": { "id": "…", "name": "alice", "role": "user" } }
```

Show1 兼容字段额外包含 `username` 和 `email`（未绑定为 `null`）。`GET /api/auth/me` 的 `user` 返回 `{ id, username, role, email }`，绑定后为真实归一化邮箱。

错误：`400` 缺少邮箱或验证码、用户名 / 密码 / 邮箱不合规、验证码不正确或已过期；`409` 邮箱已占用（「该邮箱已被其他账号绑定，请换一个。」）、用户名已被使用或属于 `ADMIN_USERNAMES` 保留名；`415`；`429`。格式检查之后先校验验证码，验证码有效才判断用户名和邮箱是否被占用，因此没有有效验证码时只会得到 400，不会暴露账号或保留名是否存在。

### 3.3 `POST /api/auth/login` —— 登录

**认证**：无。**限流**：auth 桶及登录失败预算。请求体 `{ "name": "…", "password": "…", "turnstileToken": "…" }`（兼容 `username`）。旧账号无需先绑定邮箱即可登录。配置 Turnstile 时，所有账号必须提交有效的一次性 token；服务端在密码校验前验证，不按用户名区别验证流程。未配置密钥的本地环境沿用密码登录。

成功 `200`：`{ "user": … }` 并种下会话 Cookie。错误：`401 用户名或密码不正确`（对不存在的账号同样执行哈希比较，不泄露账号是否存在）；其余同 3.2。

人机验证失败返回 `400`，验证服务不可用返回 `503`，均不执行密码哈希，也不增加密码失败计数。同一归一化账号跨 IP、同一来源 IP 跨账号各自最多 5 次密码失败 / 15 分钟，触发后临时封禁登录 15 分钟；并发尝试也占预算，全站最多 32 个在途登录流程，超限返回 `429 login_limited` 与 `Retry-After`。成功登录清空该账号失败计数，来源 IP 仍保留其失败预算。管理员密码失败写 `admin-login-failed` 审计，触发封禁写 `login-blocked` 审计与服务日志；不记录密码或 token，不永久封禁管理员用户名。

### 3.4 `POST /api/auth/logout` —— 登出

**认证**：无（无会话亦为成功）。**限流**：无。请求体：无。

响应：`{ "ok": true }`，删除服务端会话并清空 Cookie。

### 3.4.1 邮箱验证码、绑定与找回

`GET /api/auth/turnstile` 返回 `{ "siteKey": string | null }`。只有 `TURNSTILE_SITE_KEY` 与 `TURNSTILE_SECRET_KEY` 都配置时才启用；发码请求校验 `turnstileToken`，注册提交无需 token。

`POST /api/auth/email/send`：绑定请求 `{ "purpose": "bind", "email": "…", "turnstileToken": "…" }`，需登录，成功返回 `{ "sent": true, "email": "归一化邮箱" }`；邮箱已被其他账号绑定时返回 `409`，该判断在限流与 Turnstile 之后。重置请求 `{ "purpose": "reset", "username": "…", "turnstileToken": "…" }`，无论账号是否存在或是否绑定邮箱，成功响应均为 `{ "sent": true, "email": "" }`；不提供邮箱占用提示。发码按 IP 和目标邮箱每 15 分钟限流，另有同地址 60 秒冷却（可用 `MAIL_*` 调整）。SMTP 未配置时绑定返回 `503`；重置仍采用统一响应。

`POST /api/auth/email/verify`：`{ "purpose": "bind", "email": "…", "code": "六位数字" }` 或 `{ "purpose": "reset", "username": "…", "code": "六位数字" }`。成功 `{ "ok": true }`，不消耗验证码。验证码默认 10 分钟有效、输错 5 次作废；数据库只存哈希。

注册发码：`POST /api/auth/email/send` 的 `{ "purpose": "register", "email": "…", "turnstileToken": "…" }` 无需登录；校验邮箱格式，沿用上述 IP / 邮箱限流及 Turnstile gate。邮箱已被绑定时不返回 409：响应与正常发码相同，但不生成验证码，改发一封注册提醒（mailer 收到 `{ to, code: null, purpose: "registered" }`），提示直接登录或找回密码；邮件未配置或发送失败为 `503`，成功 `{ "sent": true, "email": "归一化邮箱" }`，邮件说明为注册验证。注册验证码仅由注册接口校验消费，不能用于 bind/reset；v24 迁移扩展验证码表的 purpose 约束并保留现有验证码。

测试与审计脚本可在隔离进程创建 `createPlatform({ config, limits, mailer })`，其中 `mailer` 提供 `ready: () => true` 和 `send: async ({ to, code, purpose }) => …`，捕获验证码后先调用 send 再 register。示例辅助函数见 `test/helpers/email.mjs`；HTTP 响应不包含验证码，也没有验证码读取端点。外部 smoke 脚本可使用本地测试 SMTP（如 `test/email-auth.test.mjs`）读取邮件内容。已有无邮箱账号测试可直接构建旧账号夹具再登录，不能通过 HTTP 绕过注册验证。

旧账号邮箱限制：发起题目、上传与草稿（POST / GET / DELETE）、Gallery 与 Show1 表情回应均要求绑定邮箱，否则 `403 { "code": "email_required", "error": "请先绑定邮箱" }`。绑定后当前会话立即可用；评论、登录和换绑规则沿用现有行为。

`POST /api/auth/email/bind`：需登录，`{ "email": "…", "code": "…" }`；成功 `{ "user": <Show1 兼容用户> }`。同一账号可换绑，邮箱全局唯一且大小写归一。

`POST /api/auth/password/reset`：`{ "username": "…", "code": "…", "password": "…" }`；成功 `{ "reset": true }` 并删除该用户所有会话。错误验证码和不存在的账号统一返回 `400` 的验证码错误。

### 3.5 草稿：`POST /api/drafts` 与 `DELETE /api/drafts/:id`

草稿是「上传 → 检查 → 试加载 → 确认提交」流水线的中间态，有效期 24 小时。

新题目示例使用 `task=__new__`。此保留值支持 POST 上传与 GET 恢复草稿，支持 `static` / `vite` / `text`；不能作为真实题目公开或经 `POST /api/works` 提交，后者返回 `400`。须连同题目通过 `POST /api/questions` 提交。

**`POST /api/drafts?task=<题目id>&name=<文件名>&template=<static|vite|text>`**

`template` 可选，必须为该题目允许的格式；省略时从上传内容推断。数据包题目没有非空 `templates` 时，文学推断为 `["text"]`，其余为 `["static","vite"]`。Vite 项目必须含已构建的 `dist/index.html` 或其它识别的构建入口，存在源 `index.html` 时仍优先伺服构建目录；服务端不运行上传项目的构建脚本。

**认证**：登录。**限流**：drafts 桶（12 次/10 分钟/用户）。**请求体**：原始 ZIP 或单个 HTML 文件的二进制（**非 JSON**），上限 30 MB。

`template=text` 的请求体为单个 `.txt` / `.md` / `.markdown` UTF-8 文本文件，同样受 `uploadBytes` 上限限制，并限制为 200000 个 Unicode 字符（包括空白）。拒绝 ZIP、其它扩展名、二进制控制字符、无法 UTF-8 解码或纯空白的文件。后端生成自包含 `index.html`，同时保存原始字节为 `original.txt` / `original.md` / `original.markdown`，可在草稿或作品预览 origin 下读取。Markdown 支持标题、段落、列表、引用、强调、代码、分隔线、GFM 管道表格（含列对齐，单元格内的 `|` 写作 `\|`）与 TeX 公式：行内 `$…$`、`\(…\)`、`$$…$$`，独占行或跨行（不含空行）的 `$$…$$`、`\[…\]`。`$` 按 Pandoc 规则：起始 `$` 后不能是空白，结束 `$` 前不能是空白且后面不能紧跟数字，所以 `$5 和 $10` 保持文字；`\$` 为字面美元符号；代码内不解析公式；未闭合的块公式按普通段落显示。公式输出为转义后的 TeX，只有含公式的页面才从 `cdn.jsdelivr.net/npm/` 加载固定版本 KaTeX 0.16.47（带 SRI）在浏览器内渲染，加载失败时显示 TeX 原文；此时 `checks` 的 external 项为「公式由平台加载 KaTeX 显示」，文本作品不会因平台自带的 KaTeX 被提示外部依赖。原始 HTML 转义，链接与图片语法保留为文本，作者内容不加载外部资源。单词内的 `_`（如 `a_1`、`snake_case`）不触发强调。已上传的文本作品保留上传时生成的页面，不会自动重新排版。`.txt` 保留段落和换行。生成页使用衬线正文、适中行宽和随系统切换的深浅色；`checks` 的 format 项提供「识别为 Markdown · 约 N 字」等提示，并保存 `template: "text"`。入口沿用试加载探针、内容审核、截图与核验流程。

服务端解包并静态检查（不执行任何上传代码）：忽略 `node_modules`、`.git`、`.svn`、`.hg` 路径段下的文件，不解压、不存储，也不计入解压体积和文件数；有文件因此被忽略时，`checks` 增加 `{ "id": "ignored", "state": "info", "label": "依赖目录", "detail": "已忽略 N 个依赖或版本库文件（node_modules、.git 等）" }`。拒绝分卷 / ZIP64 压缩包及危险路径；保留文件拒绝加密、符号链接、密钥文件（`.env`、`.env.*`、`.npmrc`、`.pypirc`、`id_rsa`、`id_ed25519`）；要求根目录（或 `dist/`、`build/`、`out/`）存在 `index.html`，或包内恰有一个顶层 HTML；ZIP 入口引用的关键脚本 / 样式缺失直接 `400`；单个 HTML 中引用的本地文件缺失只在 `local` 检查中给出 `warn`，由试加载判断能否运行。解压后总大小 ≤150 MB、单文件 ≤50 MB、文件数 ≤2000；原始上传仍受 30 MB 上限约束。

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
- `checks[].state` 取值 `ok` / `info` / `warn`；`duplicate` 项在上传内容与数据包或他人投稿完全相同时为 `warn`。
- 每位用户最多同时保留 3 份草稿（`draftsPerUser`），超出时最旧的自动废弃。

错误：`401` 未登录；`404 题目不存在`；`409 提示词原文尚未公开，暂不接受上传`；`400` 各类包体 / 内容问题；`413` 超 30 MB；`429`。

**`DELETE /api/drafts/:id`** —— 丢弃草稿

**认证**：登录（仅草稿所有者）。响应 `{ "ok": true }`。错误：`404 试加载已结束`（草稿不存在或非本人）。

**`GET /api/drafts?task=<题目id>`** —— 取回本人在该题最新的未过期草稿

**认证**：登录。响应 `{ "draft": <同上草稿对象> | null }`，供投稿页离开后继续试加载；不存在或已过期时为 `null`。

### 3.6 投稿：`POST /api/works`、`PATCH /api/works/:task/:id` 与 `DELETE /api/works/:task/:id`

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
  "harnessId": "claude-code", "providerId": "official",
  "promptVariant": "short",
  "generationMode": "single-turn", "humanIntervention": "none",
  "cover": "data:image/webp;base64,…",
  "trial": { "loaded": true, "loadMs": 120, "errors": 0, "errorSamples": [], "failedResources": [], "blocked": [], "canvases": 1, "media": 3, "words": 120 }
}
```

- `confirmed` 必须为 `true`（作者已在试加载中确认运行正常），否则 `400`。
- 模型二选一：`modelId` 命中数据包模型表，或自填 `modelName`。
- `trial` 为试加载探针回传数据，服务端逐字段消毒（数值截断、字符串截长、样例限条数）。
- `cover` 仅接受 PNG / JPEG / WebP（魔数校验），≤3 MB。
- `harnessId` 须存在于当前数据包注册表，停用的 `listed: false` 条目仍可引用；也可填写 `harnessOther`。Harness ID 与「其他」不能同时非空；设置一边会清空另一边。`harnessOther` 经 NFKC 归一化并去首尾空白后最多 40 字。字段未出现时保持原值，旧数据包没有注册表时可填 Harness「其他」。
- 不再收集 Harness 版本。上传、作者 PATCH、管理员审核/meta 与收件箱登记均忽略旧客户端的 `harnessVersion`（含空串和非空值），不校验、不写入，也不触发重新内容审核；只提交该字段的 meta/PATCH 是成功的空操作。作品 DTO、新投票身份与送审文本均不包含它。数据库 `harness_version` 列及存量值保留，旧数据包中的该字段读取时忽略。
- `providerId` 新投稿必填，只接受 `official` 或 `unofficial`，其他值 `400`。编辑禁止显式清空，缺省保留旧值；通过核验前须补齐服务商和推理档位。上传与审核忽略未知字段 `providerOther` / `providerName`，作者 PATCH 与管理员 meta 按未知字段规则返回 `400`。v25 迁移保留 `official`，其余非空旧 ID 或手填名称归为 `unofficial`，未填保持 null，并清空 `provider_other`；旧数据包读取时同样归类。
- 普通用户须填写 Harness ID、「其他」或兼容字段 `tool` 中至少一项；过渡期旧前端只传 `tool` 仍可投稿。管理员可留空。仅传 `tool`（或 Harness 两项均空）时将其存入 `harness_other`；有非空 Harness 声明时以声明为准。输出 `tool` 从 Harness 派生，不自动猜测 ID。
- `promptVariant`（schema v21）：题目在数据包里有 `promptVariants` 时，普通用户必须填写其中一个 `id`，管理员可留空；无效 ID 为 `400 invalid_prompt_variant`。单一提示词的题目忽略该字段并存为空串。作品视图仅在非空时输出 `promptVariant`，前端据此与同模型、同来源的其他版本合为一张卡片。
- 生成信息只保留 `generationMode` 与 `humanIntervention`，取值规则见作品字段表；服务端不要求必填，未注明的非文字作品不进盲评池。旧请求中的 `modelVersion`、`generatedOn`、`evidenceUrl` 一律忽略（任何类型均不报错），公开/管理员视图、审计、送审声明与新身份快照均不输出。数据库旧列与值保留，不删除、不清空；历史审计日志和快照的结构化停用字段在读取时剥离，原记录不改写。

成功 `200`：`{ "work": <作品公开视图> }`。作品初始状态 `unverified`，并自动排队无头截图（1440×900 与 390×844 两档，写回 `captures`；截图能力可用性见 `bootstrap.site.capture`）。

普通用户启用内容审查时，响应含作者特权字段 `moderation.status: "pending"`，上传请求不等待 Flex。此时 `scene` 是一小时有效的随机 `p<32hex>` 预览源，作品尚不公开；内容状态与 `unverified` 核验状态独立，详见 3.24 节。

高级与普通管理员提交（含题目示例、收件箱登记）保存 `moderation={status:"approved",source:"human",reviewer,reason:"管理员发布",at}`，`status="unverified"`，跳过自动审查，直接等人工核验。

截图浏览器只允许当前作品源的文档，以及该源和 HTTPS CDN 白名单内的 GET/HEAD 资源。请求逐跳检查重定向，跨源导航、WebSocket、Service Worker 及未经过路由的浏览器连接被阻断；截图环境须预配置 Playwright ≥ 1.48 和 Chrome。

错误：`401`；`404 试加载已过期`；`400`（未确认 / 缺标题 / 缺 Harness 与 tool / 模型不存在或缺失 / 来源字段无效 / 封面无效）；`413 封面图片不能超过 3 MB`；等待核验满额时 `429`，文案为 `你已有 N 件作品在等待核验（上限 M 件），核验完成或删除作品后名额会释放`，N 与 bootstrap 的 `me.pending` 相同，M 为 `me.pendingLimit`。

**`PATCH /api/works/:task/:id`** —— 作者修改投稿信息

**认证**：登录，作者本人；管理员调用时等同 `/api/admin/works/:task/:id/meta`。**限流**：write 桶。请求体可含 `title`、`summary`、`note`、`modelId` / `modelName` / `vendor`、`effort`、`promptVariant`、Harness 与服务商字段及生成信息五个字段，未出现的保持原值，规则同 `POST /api/works`。作者只能在 `status` 为 `unverified` 时修改，已核验或存疑返回 `409`；多版本题目不能清空 `promptVariant`，也不能清空 Harness。作者修改送审声明且开启内容审查时重新置为 `pending` 并排队；管理员通过此接口修改等同管理员 meta，保持现有 `moderation`。成功 `200`：`{ "work": <作者作品视图> }`，写 `meta` audit。错误：`401` / `403 只能修改自己上传的作品` / `404` / `409` / `400`（没有可修改的内容或字段无效）/ `429`。

**`DELETE /api/works/:task/:id`** —— 删除投稿

**认证**：登录，且为作者本人或管理员。响应 `{ "ok": true }`。

错误：401 / 403 / 404；有 Gallery 或 Show1 投票的作品返回 409。高级管理员可删除任意无票作品，普通用户与普通管理员仅沿用作者删除本人作品规则；数据包作品写覆盖层 deleted_at。

### 3.7 审核、互动与账号管理

**`POST /api/works/:task/:id/review`** —— 人工核验（高级与普通管理员）

**认证**：管理员。请求体：

```json
{ "status": "verified", "reason": "（questioned 时必填，≤500 字）",
  "modelId": "（选填：审核时顺带纠正模型归属）", "modelName": "…", "effort": "…",
  "title": "作品标题", "summary": "摘要", "show_gallery": true, "show_arena": true,
  "harnessId": "claude-code", "providerId": "official" }
```

- `status` 取值 `verified` / `questioned` / `unverified`；`questioned` 必须给 `reason`（`400` 否则）；置为 `verified` 会清空理由。
- 仅当请求体出现 `modelId` / `modelName` 键时才重取模型身份，否则保持原值；`effort` 同理。
- `title`、`summary` 与两个布尔门面开关均可选；审核通过时可同时修改。作品首次转为 `verified`（原状态非 `verified`）且请求未给开关、也未给 `audience` 时，两个开关都开启并记为本面决定：通过即公开，符合盲评条件的同时进池。已是 `verified` 的重复核验保持原开关。兼容旧的 `audience` 参数，将其换算为两个开关；响应中的 `audience` 由最终开关计算。审核状态和 audit 在同一事务写入。管理员在审核中修改声明保持现有 `moderation`，不重新置为 `pending` 或排队。
- 可选布尔 `entertainment` 与两面开关使用同一缺省。首次核验且请求没有该字段时，`show_entertainment` 一并开启，`entertainment_route` 保持 0。显式 `false` 表示三面都公开并清空收件箱标记。显式 `true` 只在 `verified` 时有效，三个开关都关闭，`entertainment_route` 置 1，作品进入竞技场收件箱；此时公开列表、正式配对和娱乐花名册都看不到它。重复核验不带该字段时，保持原来的娱乐开关和收件箱标记。非布尔返回 `400`。
- 作品转为 `verified` 时，`reviewed_gallery_at` 与 `reviewed_arena_at` 同时补上还没有的那一章；已有章不改。开关只决定 `show_gallery` / `show_arena`，不再决定盖哪一面。v34 用同样规则回填已验证但缺章的旧行，不改 `entertainment_route`。
- 审核可选 `harnessId`、`harnessOther`、`providerId`；按 3.6 节的 Harness 与服务商规则校验，只更新请求中出现的维度。旧 `harnessVersion` 忽略。
- 内容尚未放行（`moderation.status` 不为 `legacy` / `approved`）时提交 `status: "verified"` 返回 `409 请先完成内容审核`。`questioned` / `unverified` 不受此限制。

成功 `200`：`{ "work": <作品公开视图（管理员视角，含特权字段）> }`。错误：`401` / `403 仅管理员可以操作`；`404`；`400 审核结果无效`。

**`POST /api/admin/works/batch-moderation`** —— 批量内容决定

认证：管理员；每批消耗一次 write 限流。请求 `{ "works": [{ "task": "…", "id": "…" }], "status": "approved" | "rejected", "reason": "…" }`，`works` 为 1–100 件。理由规则与单件内容决定一致：通过省略或空白理由时保存「人工复核通过」，拒绝必须提供非空理由，最多 500 字。列表、状态或理由无效时整体 `400`，不执行任何项目。

每件在独立事务内复用 `reviewContent`，写 `content-review` audit；单件失败不影响其它项。成功请求返回 `200`：`{ "results": [...] }`，结果保持请求顺序，每项为 `{ "task": "…", "id": "…", "ok": true, "work": <管理员作品视图> }` 或 `{ "task": "…", "id": "…", "ok": false, "error": { "status": 404, "code": "…", "message": "…" } }`。每批只刷新一次缓存。认证、同源与限流错误为 `401` / `403` / `429`。

**`POST /api/admin/questions`** —— 保留的高级管理员发题入口

请求字段同 `POST /api/questions`，创建结果同样为 pending，不再直接 approved；不占 3 道待审名额。普通管理员使用 `POST /api/questions` 发题。

**`GET /api/admin/inbox/works`** —— 竞技场收件箱

认证：管理员。返回 `{ "works": [<管理员作品视图>] }`，只含 `entertainment_route = 1` 的投稿。`entertainment_route`：`0` 常规，`1` 收件箱待处理，`2` 已归属。

**`POST /api/admin/works/batch-inbox`** —— 收件箱归属

认证：管理员；write 限流。请求 `{ "works": [{ "task": "…", "id": "…" }], "task": "目标题", "entertainment": false }`，1–200 件，同一事务。`task` 可省略，省略时只记审计、作品留在收件箱。给出 `task` 时复用归属迁移，并把 `entertainment_route` 从 1 改为 2。`entertainment: true` 同时打开 `show_entertainment`。不在收件箱的作品使整批 `404`。成功 `200`：`{ "works": [<管理员作品视图>] }`。

作品编辑统一使用 `POST /api/admin/works/:task/:id/meta`（见 3.19）。原 `/display` 路由已删除，请求返回 404。

**`POST /api/admin/works/batch-review`** —— 批量来源核验

认证：管理员；每批消耗一次 write 限流。请求 `{ "works": [{ "task": "…", "id": "…" }], "status": "verified" | "questioned", "reason": "…", "meta": { "effort": "High", "providerId": "official", "harnessId": "…", "harnessOther": "…" } }`，`works` 为 1–100 件，`meta` 选填且仅允许这四个字段，字段校验同单件 meta。列表、状态或理由无效时整体 `400`，不执行任何项目；`questioned` 必须提供非空理由，最多 500 字。

每件在独立事务中先调用 `setMeta`（有修改时写 `meta` audit），再调用 review 并写核验 audit。`verified` 要求内容已为 `approved` / `legacy`，否则单件 `409 请先完成内容审核`；最终推理档位与服务商必须齐全，否则单件 `400`。核验通过强制 `show_gallery: true`；可选布尔 `show_arena`（非布尔整体 `400`），缺省时按首次核验规则开启。单件失败回滚该件全部修改，包括 meta 与 audit；管理员修改声明保持现有 `moderation`。响应 `200` 的 `results` 顺序与成功/失败项结构同 batch-moderation，每批只刷新一次缓存。认证、同源与限流错误为 `401` / `403` / `429`。

**`POST /api/works/:task/:id/reactions`** —— 表情反应（开关式）

**认证**：登录。**限流**：write 桶。请求体：`{ "emoji": "press" }`（表情贴纸 id，图形由前端提供）。

同一用户对同一作品的同一表情**再次提交即取消**（toggle）。响应：

```json
{ "counts": { "press": 3, "yes": 1 }, "mine": ["press"] }
```

错误：`401`；`404 作品不存在`；`409 存疑作品仅供参考，不能再互动`；`400 不支持这个表情`（表情须在 `bootstrap.site.emojis` 白名单内）。数据包作品同样可互动。

**`GET /api/me`** —— 本人题目、投稿与参与统计

**认证**：登录。响应：

```json
{
  "questions": [ <本人未删除题目视图，含 moderation（pending / approved / rejected / legacy）> ],
  "works": [ <本人投稿公开视图，含特权字段，符合条件时含 queueAhead / changed> ], "votes": 12,
  "reviewStats": { "medianHours": 18.5 },
  "joinedAt": "…ISO…",
  "activity": { "from": "YYYY-MM-DD", "to": "YYYY-MM-DD", "days": [ { "date": "YYYY-MM-DD", "count": 2 } ], "total": 12, "activeDays": 5 },
  "receivedReactions": { "counts": { "press": 2 }, "total": 2 }
}
```

活跃统计按 UTC+8 的近 365 天汇总本人发布题目、投稿、有效落库投票和当前表情记录；历史投稿删除后仍计入活跃。收到的表情仅统计本人当前未删除投稿且排除自评，只计 `site.emojis` 内的贴纸（Show1 的 👍/👀/🤯 表态不计）。

`queueAhead` 仅对当前展览馆核验队列中 `status=unverified` 的作品返回：内容已放行、题目已公开、未收录且 `reviewed.gallery` 为空。它是该队列中排在该作品前面的件数，与 bootstrap 的 `review.unverified` 同口径（包含竞技场已核验、展览馆尚无决定的投稿），按 `created_at` 升序、同时间按作品 ID 升序；其它作品省略字段。

`reviewStats.medianHours` 为全站未删除、当前为 `verified` 且近 30 天有核验时间的作品，从创建至核验的耗时中位数，单位为小时；少于 5 个样本返回 `null`。`changed: true` 仅在本件作品有晚于已读时间的核验或内容审核决定时返回；首次读取同样只看最近 7 天。其它作品省略 `changed`。

**`POST /api/me/works/seen`** —— 标记作品状态变化已读

认证：登录；限流：write 桶，遵循同源校验。无需请求体，将当前用户的 `works_seen_at`（可空毫秒时间，v31 迁移新增）设为当前时间，成功 `200`：`{ "ok": true }`。错误：`401` / `403`（Origin 不受信任）/ `429`。后续发生的决定仍会产生 `me.updates` 和 `changed: true`。

**`PATCH /api/me`** —— 更新昵称

认证：登录；限流：write 桶。请求 `{ "nickname": "河畔观测员" }`，响应 `{ "user": <用户公开视图> }`。昵称经 NFKC 与首尾去空白后为 1–24 字，不能含控制字符；无效返回 `400`。不能更改登录用户名或角色。题目与作品作者公开显示昵称。

**`GET /api/review`** —— 审核台（高级与普通管理员）

**认证**：管理员。响应：

```json
{
  "works": [ <两种存储的未删除作品，排除历史 curated_as，管理员视角> ],
  "audit": [ { "at": "…ISO…", "actor": "alice", "action": "submit", "task": "…", "work": "up-…", "detail": "…" } ]
}
```

投稿的 `moderation` 原样返回已存完整结果，包括存在的 `status`、`source`（automatic / human / recheck）、`reason`、`categories`、`signals`、`error` 及 usage 等其他字段，不使用作者视图的理由裁剪。字段按实际结果可缺省：legacy 通常只有 status，pending 含 status/revision/at；无错误时不补 error，无信号时不补 signals。数据包作品默认内容审核 approved，核验决定读取覆盖层。

`audit` 为审计日志倒序最多 200 条，`action` 取值含 `submit` / `verified` / `questioned` / `unverified` / `delete` / `role`。

**`GET /api/admin/users`** —— 账号列表（仅高级管理员）

**认证**：管理员。**限流**：无。

成功 `200`（按注册时间升序）：

```json
{ "users": [ { "id": "…", "name": "alice", "role": "user", "createdAt": "2026-09-27T08:00:00.000Z" } ] }
```

- 每项仅含 `id` / `name` / `role` / `createdAt`：`name` 为登录用户名（非昵称），`createdAt` 为 ISO 时间；不下发昵称、`name_key` 与凭据（`salt` / `hash`）。
- `role` 为生效角色：`ADMIN_USERNAMES` 内的账号无论库中存值恒为 `admin`。

错误：`401`（未登录）/ `403 仅管理员可以操作`。

**`POST /api/admin/users/:id/role`** —— 调整账号角色（仅高级管理员）

**认证**：管理员。**限流**：无。请求体：`{ "role": "admin" }`（取值 `admin` / `moderator` / `user`）。

成功 `200`：`{ "user": { "id": "…", "name": "bob", "role": "admin" } }`，并写审计日志（`action` 为 `role`，`detail` 形如 `bob → 管理员`，无关联题目 / 作品）。

错误：`401` / `403 仅管理员可以操作`；`400 角色无效`；`404 用户不存在`；`409 不能修改自己的角色，避免把自己锁在管理端之外`（防自降权，自己的角色只能由另一名管理员调整）；由 `ADMIN_USERNAMES` 固定的管理员须先修改服务器配置，直接降权返回 `409`。

### 3.8 `POST /api/arena/matches` —— 创建盲投对战

**认证**：无（匿名可创建，但不计票）。**限流**：matches 桶（60 次/分钟）。

对局有效期 3 小时。服务启动及每分钟清理过期且没有正式票引用的记录，保留正式票及其对局；匿名无票对局全站最多 10000 条，容量已满返回 `429 anonymous-capacity` 与 `Retry-After: 60`。猜模型练习局只存内存，已有 5000 局容量上限，另加 3 小时有效期，过期返回 `404 game-expired`。

请求体：`{ "task": "chinese-architecture", "previous": "<上一场对局id，选填>" }`

成功 `200`：

```json
{ "id": "…24hex…", "task": "chinese-architecture",
  "a": "http://m<32hex>.localhost:5180/", "b": "http://m<32hex>.localhost:5180/",
  "calibration": { "a": null, "b": { "width": 1280, "height": 800, "zoom": 1, "offsetX": 0, "offsetY": 0 } },
  "counted": true }
```

- `a` / `b` 为两侧作品的**不透明令牌 origin**（`m` 令牌，对局有效期 3 小时），iframe 直接加载；页面与地址均不泄露作品 / 模型身份。左右顺序随机。
- `calibration.a` / `calibration.b`：该侧竞技场取景校准（管理员按门面保存的 `framing`），无校准为 `null`；父页面据此裁切 iframe。已保存的 3D 视角（`camera`）不随接口下发，由内容服务器在对局页内嵌恢复（视角桥，见 §5）。
- `counted`：登录且绑定邮箱时为 `true`，匿名或未绑定邮箱时为 `false`。
- 对局创建时一次捕获当前数据包目录和两侧身份。随后切换数据包，旧令牌仍从原目录提供 HTML 与相对资源，旧对局仍可揭晓/投票；部署应保留该目录到相关对局全部过期并经过清理宽限期。
- 前端在写请求上携带 `X-Datapack-Version: <前端所构建的数据仓库 SHA>`（读请求不带，避免跨源 GET 预检）；创建数据包对局、数据包题目草稿及该草稿的正式投稿时，如果该值与服务端当前可信 SHA 不同，请求照常处理，响应头增加 `X-Datapack-Stale: 1`，响应体形状不变。对局仍绑定创建时的服务端快照。题目不参与此检查；缺少请求头时不增加提示头。
- 抽样规则：按 `promptVariant`（缺失为空串）与「模型+档位」分组，只在同一提示词版本的不同配置间抽取，再各均匀抽一件作品；长短版不跨组，配置分仍跨版本合计。偏向对局数少的配置、偏向实力相近者（同档 90% 概率软匹配，分差过大重掷 2 次）；避开上一场两侧作品、本人作品与已评组合。无提示词变体的题目行为不变。
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
- `counted=false` 时 `reason` 取值：`skipped`（skip）、`anonymous`（未登录）、`unbound`（未绑定邮箱）、`changed`（投票时某侧作品已失效）、`own`（涉及本人作品）、`duplicate`（已评过该组合）。未绑定账号正常揭晓双方结果，但不写入投票。
- `skip` 同样终局化对局，但不产生投票记录。
- 对局绑定创建者：登录用户创建的对局仅本人可投；匿名创建的对局任何人可投（但仍不计票）。
- 作品被标记存疑 / 删除后，其参与的历史投票**即时退出**排行统计；恢复验证后自动回归。

错误：`404 这一组已经失效`（对局不存在 / 过期 / 非本人）；`409 这一组已经提交过了`；`400 选择无效`；`429`。

### 3.10 `GET /api/leaderboard` —— 排行榜

**认证**：无。**限流**：无。

查询参数：`task=<题目id>`（缺省为全部题目合计）；`category=<题型>`（数据包题目的 `category`，如 `建模`、`文学`、`静态网页`；只统计该题型的题目，不能与 `task` 同用）；`domain=<领域>`（只统计 `domains` 含该领域的题目，可与 `category` 叠加，不能与 `task` 同用；一道题有两个领域时在两个领域里都完整计入）；`by=config`（默认，按「模型+档位」）或 `by=model`（按模型跨档位合计）；可选 `harness`（注册表 ID 或 `unset`）及 `provider=official|unofficial|unset`（`unset` 表示未注明）。

来源筛选只缩小计入的票和作品池，**不改变计分维度**（仍是「模型+档位」或模型）：
- 一张票只有两侧的身份快照（有更正时取更正）都满足全部筛选条件时才计入；只满足一侧的是跨来源比较，不计入。
- Harness 快照只保存注册表 ID，自填的「其他」与未注明一样记作 `unset`。读取旧票时将非空的旧服务商 ID 或已保存手填名称归为 `unofficial`，原始快照不重写；没有保存服务商声明的旧票仍为 `unset`。
- `unranked` 与 `works` 计数按作品当前的来源字段筛选。
- 带筛选时响应多一个 `"filters": { "harness": …, "provider": … }`；不带筛选时响应形状、计票范围与缓存键都与不支持筛选时完全相同。

题型与领域：响应回显 `category`、`domain`（未指定为 `null`）。`totals.votes` / `totals.voters` 只计实际参与拟合的比较：同一计分单位（按配置为同一配置，按模型为同一模型）两件作品之间的票不计入；`totals.tasks` 为这些比较涉及的题目数，前端据此在领域榜少于 2 题或 50 次比较时提示样本不足。既无 `task`、`category` 也无 `domain` 的综合榜多一个 `standings`：`{ [题型]: { [key]: 该题型内名次 } }`，只列已有排名的题型，沿用同一计分单位与来源筛选。已公开的题目按 `category` 进入对应题型；迁移后分类仍为空的旧题只计入综合榜。

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

非文字题的单件作品分供代表作选择使用，不改变上述配置榜响应与算法。先以当前两件作品均 `isEligible` 的 arena 票计算该题原配置级 Bradley–Terry 强度，再以作品为单位拟合，先验为 N(配置 logit 强度, 0.5²)。同配置内不同作品的票也参与作品拟合；旧快照或显式更正中的配置键保持原计分口径。内部 `arena.workScores(taskId)` 返回 `{ id, score, interval, games }[]`；`score` 在配置分的 Elo 刻度上估计作品偏差，保持配置中心，不按作品数量再次归零；`interval` 仍为 95% 后验不确定区间半宽（以配置先验均值为锚）。超过现有 200 条目阈值时沿用 worker。文字题不计算作品分。

错误：`404 题目不存在`（`task` 参数无效）；`400 invalid_query`（`harness` 既不是当前注册表 ID 也不是 `unset`，或 `provider` 不在上述三项中；`category` 不是当前题目的题型，或与 `task` 同时出现；`domain` 没有任何当前题目使用，或与 `task` 同时出现）。

### 3.11 `/media/*` —— 投稿媒体

`GET /media/<work-id>/<file>`，其中 `<work-id>` 形如 `up-XXXXXXXX`，`<file>` ∈ `cover.png` / `cover.jpg` / `cover.webp` / `first.jpg` / `mobile.jpg`。

- 响应头：旧流程作品为 `Cache-Control: public, max-age=300`，参与内容审查的作品为 `no-store`；`Content-Security-Policy: default-src 'none'`（防止媒体被当页面执行）。内容未通过的媒体只供作者或管理员会话访问，其他请求为 404。
- 404：`{ "error": "文件不存在" }`。
- 路径越界（`..` 等）在路径解析层被拒，等同 404。

### 3.12 作品内容伺服（令牌子域）

内容端口（默认 5180）按 Host 首段令牌伺服作品，规则 `^[wmdp][0-9a-f]{32}$`：

| 前缀 | 令牌来源 | 指向 | 有效期 | 注入脚本 | Cache-Control |
| --- | --- | --- | --- | --- | --- |
| `d…` | 草稿创建 | 草稿目录 | 24 小时 | `__sp_probe.js`（试加载探针） | `no-store` |
| `m…` | 对战创建 | 对局某侧作品 | 3 小时（随对局） | `__sp_fold.js`（盲投折页）+ 就绪探针 + 视角桥（有存档视角时） | `no-store` |
| `w…` | 投稿提交（`contentKey`） | 作品目录 | 随作品存续 | 视角桥（仅当存有校准视角） | `private, max-age=600` |
| `p…` | 后台/作者预览 | 作品目录 | 预览键有效期 | 视角桥（仅当存有校准视角） | `no-store` |

- 仅接受 GET / HEAD，其余方法 `405`。
- 畸形 URL 返回 `400` 错误页，不使共享进程退出；请求期间消失的资源返回 `404`。
- 令牌无效：`404` 错误页「作品地址无效」；令牌存在但目标不可用（草稿过期、对局结束、作品删除、对局侧作品被下架）：`410` 错误页「作品已不可用」。
- 全部响应施加沙盒 CSP：`sandbox allow-scripts allow-same-origin allow-forms allow-modals allow-popups …`，外部资源仅放行 `bootstrap.site.cdn` 白名单内的公共 CDN；`frame-ancestors` 限定为 `SITE_ORIGINS`（即作品只能被站点 iframe 嵌入）；`Referrer-Policy: no-referrer`。
- `registry.npmmirror.com` 仅允许已核对的 Three.js 0.170.0：`https://registry.npmmirror.com/three/0.170.0/files/`。CSP、上传检查和截图网络守卫使用同一固定路径；该镜像的其他包或版本仍被拦截。
- 注入脚本作为 HTML 首个 `<script>` 插入。`d` / `m` 令牌按上表注入；`w` / `p` 令牌无校准数据时**原样伺服**。
- **就绪探针**（`m` 令牌）：等 `window load` + 渲染循环 3 帧 + 600ms 后 `parent.postMessage('aob:work-ready','*')`，8 秒兜底；竞技场换局纸幕以此握手钉住「作品画完才掀幕」。
- **视角桥**（`server/bridge.mjs`，移植自融合前竞技场）：作品存有管理员保存的 3D 视角（按门面）时，内嵌 `window.__AOB_SAVED__` 并注入桥运行时；桥登记作品的 OrbitControls（全局 UMD 拦截 `window.THREE`，importmap ESM 则改写映射经 `/__aob__/` 虚拟路由转发 `three` 与 `OrbitControls.js`），在机位创建后套回存档视角。`m` 令牌只恢复竞技场视角、绝不抓取；`w` / `p` 令牌带 `?aob=bridge` 时另注入 `__AOB_CAPTURE__`，桥应答 `{aob:'get-camera'}` → `{aob:'camera', camera}` 的 postMessage 握手（作品在独立源，无法直接读 iframe 窗口），供后台校准面板抓取当前视角；`?face=arena|gallery` 选择起步视角来源。importmap 仅改写可安全转发的目标（https CDN 或作品同源路径），其余原样保留；`/__aob__/` 虚拟路由校验并拒绝穿越与非 https 绝对目标。
- 目录默认入口为作品的 `entry` 字段（通常 `index.html`）。

### 3.13 站点静态文件

`GET /*`（非 `/api/`、非 `/media/`、非 `/admin/`）分发 `DIST_DIR` 内的数据包资源。HTML/HTM（含目录映射的 `index.html`）及不存在的文件返回纯文本 `404 Not found`；其余响应使用 `Content-Security-Policy: sandbox; default-src 'none'` 与 `Referrer-Policy: no-referrer`，防止 SVG/XML 在 API 同源执行脚本。可信管理端 `/admin/` 保留自身站点 CSP。作品 HTML 从独立内容源打开；独立画廊从自己的静态部署读取数据包数据与作品目录（见第 4 节）。

### 3.14 题目与人工审核（schema v38）

**`POST /api/questions`**：登录并绑定邮箱，write 限流，请求体上限 6 MB。`title` / `summary` / `prompt` 必填，长度上限 70 / 400 / 20000 字；提示词仅去首尾空白。`category` 为文学 / 静态网页 / 建模；`domains` 有值时为词表内 1–2 项；`templates` 文学固定 text，其他分类为 static / vite 的非空子集；可选 tags 沿用既有规则。

不附作品时传题目字段；附示例时另传 `draftId`、`confirmed:true`、`work`（同作品表单字段）。草稿须属于本人、未过期且 task=__new__。题目与示例及审计在同一事务写入，失败保留可重试草稿。响应 `{ "question": <题目作者视图>, "work"?: <作品作者视图> }`，统一 author/mine DTO。

所有角色发起的新题目均为 pending，只有高级管理员可人工通过；普通用户至多 3 道未删除 pending 题目，工作人员免限额。附带作品按发布者角色决定内容审查：普通用户照常审查，工作人员 human / approved，但保持 unverified；题目与作品必须各自通过才公开。本人题目在 `GET /api/me` 中可见。保留的 `POST /api/admin/questions` 仅高级管理员可调用，也创建 pending。

**`GET /api/admin/questions`**：仅高级管理员，返回全部未删除题目（数据包及数据库，含 pending / rejected / 已撤下）。统一 DTO 加 moderation、works、votes、samples；有账号的 author.name 为昵称。works 合计两种存储，samples 仅数据库题目发起者附带的示例。示例 scene 使用私密预览令牌。

**`POST /api/questions/:id/moderation`**：仅高级管理员。请求 `status=approved|rejected` 与 reason，拒绝须给非空理由，最多 500 字；通过可调整 category/domains，沿用分类与模板兼容校验。数据包题目的决定写覆盖表。拒绝已公开题目等于撤下，关联作品隐藏且票暂停计分，重新 approved 后恢复。写 question-review 审计并刷新排行缓存。

**`POST /api/admin/questions/batch-moderation`**：仅高级管理员，1–100 个题目 ID，复用单件规则；每件独立事务，返回逐件 results，失败项含状态码与理由。高级管理员可审核自己的题目。

**`POST /api/admin/questions/:id/meta`**：仅高级管理员，任何题目可改 title / summary / prompt / category / domains / acceptsUploads / cover。acceptsUploads 须为布尔值，cover 须为同题现有作品 ID，null 清除。公开且有作品的题目不能改提示词；有作品的题目不能改提交格式（作品数合计两种存储）。数据包写 question_overrides，数据库写本行；保持原 moderation，写 question-edit 审计，提示词只记录是否变化与长度。

**`DELETE /api/questions/:id`**：高级管理员可删除任意无票题目；有 Gallery 或 Show1 投票返回 409。作者删除自己题目沿用原规则：公開题目有其他作者作品或有票不可删。数据包题目覆盖层软删除，题下数据包作品随之隐藏，关联数据库作品同步软删除；文件不动。公开、本人与管理员列表不返回已删除题目，写 question-delete 审计。

上述写接口均遵循 Origin 校验、write 限流和通用错误格式。普通管理员对题目管理接口返回 403。历史 v22/v23/v29 字段和原审核记录保留，v38 增加发布者与覆盖层（见 2.2.1）。

### 3.15 作品评论

评论只属于已核验且至少在一个展示面公开的作品，两种存储使用相同规则；撤下题目的作品不可读写评论。盲测对局创建响应与未揭晓页面均不带评论；前端应在展示已揭晓作品时单独请求评论。

**`GET /api/works/:task/:work/comments`** —— 公开读取最近 100 条未删除评论，按时间倒序。认证、限流均无。成功 `200`：

```json
{ "comments": [ { "id": "<24hex>", "body": "喜欢这个作品", "createdAt": "…ISO…",
  "author": "alice", "mine": false, "canDelete": false } ] }
```

`author` 为当前昵称（无昵称时为用户名）；账号删除后为 `null`。`mine` / `canDelete` 随当前会话变化。作品不存在或未上架时返回 `404`。

**`POST /api/works/:task/:work/comments`** —— 登录发布评论，使用 `write` 桶。请求 `{ "body": "喜欢这个作品" }`；去除首尾空白后须为 1–280 字。成功 `200`：`{ "comment": <上述评论对象> }`。错误：`401` / `400` / `404` / `429`。

**`DELETE /api/comments/:id`** —— 评论本人或管理员软删除，使用 `write` 桶。成功 `200`：`{ "ok": true }`；无须请求体。错误：`401` / `403`（非本人且非管理员）/ `404`（不存在或已删除）/ `429`。

### 3.16 Show1 投稿作品校准

校准只适用于 SQLite `works` 表中的投稿作品。数据存于 `trial.calibration`，作品原始 HTML 不改写；数据包作品与 Show2 画廊展示方式不受该字段控制。

**`GET /api/works/:id/calibration`** —— 已上架投稿公开读取；未上架投稿仅作者或管理员可读。不限流。成功 `200`：`{ "calibration": <对象或 null> }`；不存在、数据包作品或无权读取未上架投稿时返回 `404`。

**`PATCH /api/works/:id/calibration`** —— 投稿作者或管理员写回，使用 `write` 桶。请求 `{ "calibration": { "framing": <对象或 null>, "camera": <对象或 null> } }`；可只提交其中一项，另一项保持原值。`{ "calibration": null }` 清空全部校准。成功 `200`：`{ "calibration": <写入后的对象或 null> }`。错误：`401` / `403` / `404` / `400`（结构或数值无效）/ `429`。

- `framing`：`{ "width": 1280, "height": 720, "zoom": 1, "offsetX": 0, "offsetY": 0 }`。宽、高须为整数，分别在 320–3840、240–3840；`zoom` 为 0.25–4；两个 offset 为 -1–1。五项都必须存在且为有限数，不接受额外字段。
- `camera`：`{ "position": [1, 2, 3], "target": [0, 0, 0] }`。两项各为恰好三个有限数，绝对值小于 10⁷，不接受额外字段。
- 分别传 `framing: null` 或 `camera: null` 可清除对应部分。`trial` 中原有的试加载报告保持不变；投稿作品公开视图只额外暴露 `calibration`，不暴露整个 `trial`。

### 3.17 Show1 历史作品的审核与站点展示（schema v7）

`audience` 为 `hidden` / `show1` / `show2` / `both`，API 保留兼容输出，v18 删除 `works.audience` 及其索引。实际可见性只由 `show_gallery`、`show_arena` 决定；早期迁移仍按当时的 `audience` 回填开关。新投稿入库时展览馆开启、竞技场关闭，首次核验通过时缺省两面都开启；管理员代传与收件箱发布同样走这条缺省，可显式指定。Show1 历史待审作品升级后两个开关关闭。后台审核视图可取得随机作品内容令牌用于私密试加载；令牌本身具有预览能力，不应公开转发。

**`GET /api/show1/works`** —— Show1 公开作品列表，不需要登录、无限流。成功 `200`：`{ "works": [<作品公开视图>], "reactions": { "counts": {}, "mine": {} } }`。只返回 `verified` 且 `show_arena=1` 的 SQLite 作品；`/api/bootstrap.works` 只看 `show_gallery`。竞技场盲评池同样使用 `show_arena`。Show1 题目定义仍由数据包负责，此接口不创建题目。

本轮不修改 `server/show1compat.mjs`：Show1 旧 `/api/works` 等兼容端点的返回形状不增加来源字段。共享 `/api/show1/works` 使用作品公开视图，会随之出现新字段。

**`POST /api/works/:task/:id/review`** —— 原审核端点仍接受 `audience: "show1" | "show2" | "both"`。对 `hidden` 迁入作品，旧请求设置 `status=verified` 时须指定非 `hidden` 的 audience；新请求可改传两个布尔门面开关。仍需管理员身份，遵循现有 Origin 校验与审核错误格式；成功返回的管理员作品视图含兼容 `audience`。

迁移脚本与执行参数见 `docs/show1-migration.md`。Show1 七道新题的目标 ID 固定为 `show1-001`、`show1-002`、`show1-003`、`show1-005` 至 `show1-008`；004 沿用 `chinese-architecture`。七道题的正式定义进入数据包前，作品仍可在后台审核，但前端没有完整题目元数据。

### 3.18 双系统管理端（schema v9）

以下端点均须工作人员会话；权限按 1.3.1 节区分：作品列表、编辑、门面和校准允许普通管理员，题目、主编、流量、角色及其他运营入口仅高级管理员。普通管理员不能对自己的作品作审核、门面或校准决定。无权限返回 `401`（未登录）或 `403`。写请求走同源检查、`write` 限流并记录 audit。错误仍按 1.4 节的 `{ "error": "中文提示", "code": "可选代码" }` 格式返回。

**`GET /api/admin/works`** 合并两种存储的未删除作品，应用覆盖并排除历史 curated_as。查询参数：`task`（题目 ID）、`status=verified|unverified|questioned`、`author=admin|user`（admin 包含 moderator）、`face=gallery|arena` 与 `show=on|off`（两者一起使用）、`harness`（注册表 ID、`other` 表示只填了「其他」、`unset` 表示未注明）、`provider=official|unofficial|unset`（其他值 `400 invalid_query`）、`search`（标题、模型、题目 ID、Harness 与服务商显示名）、`page`（默认 1）、`pageSize`（默认 30，最多 100）。成功形状：

```json
{ "works": [{ "task": "one", "id": "a", "author": { "role": "admin", "name": null, "avatar": null }, "mine": false, "status": "verified", "show_gallery": true, "show_arena": true, "calibration_gallery": null, "calibration_arena": null, "has_calibration_gallery": false, "has_calibration_arena": false, "arena_eligible": true, "arena_generation_ok": true }], "total": 1, "page": 1, "pageSize": 30 }
```

管理员作品视图带两个只读字段：`arena_eligible` 即服务端盲评池资格（`library.isEligible`）的判定结果；`arena_generation_ok` 表示生成信息是否合格（文字题恒为 true，其余须单轮且无人工介入）。后台竞技场系统据此显示「在正式盲测池」「不符合盲评条件（多轮 / 人工介入）」或「不在正式盲测池」，不在前端重复判断题型。

作品对象还含原有管理员作品视图字段。数据包作品开关和取景先读 `work_overrides`，缺失时三面默认开启（视同已核验的投稿），旧 Show1 快照轮次的娱乐面默认关闭（见 2.1）。查询错误：`400 invalid_query`、`404 not_found`（题目不存在）。

投稿的管理员作品视图另含 `reviewed: { gallery: <ISO 时间|null>, arena: <ISO 时间|null> }`，表示两面各自最近一次明确决定；数据包不输出此字段。核验请求显式带布尔 `show_gallery` / `show_arena` 时只更新对应面的时间。v30 为已核验和存疑的旧投稿将两面时间回填为 `COALESCE(reviewed_at, updated_at)`，未核验旧投稿保持 null；娱乐盲测开关不记录面决定。

**`POST /api/admin/works/:task/:id/face-settings`** 请求 `{ "show_gallery": false, "show_arena": true }`，可只给其中一个布尔键。投稿更新 `works` 开关，并记录请求中显式指定面的决定时间，保持核验状态不变；数据包作品 upsert `work_overrides`，不修改数据包。批量开关沿用同样的按面记录规则。响应 `{ "work": <合并管理员作品视图> }`。错误：`400 invalid_face_settings`、`404 not_found`、`429`。

**`POST /api/admin/works/batch-face-settings`** 仅管理员可用，使用 write 限流。请求 `{ "works": [{ "task": "题目 ID", "id": "作品 ID" }], "show_gallery": false, "show_arena": true }`，两个开关至少给一个，且只能为布尔值；一次须选 1–200 件。复用单件开关逻辑，在同一个数据库事务内更新所有作品并为每件写一条 `face-settings` audit；任一作品不存在或参数无效时整批回滚。成功 `200`：`{ "works": [<合并管理员作品视图>, …] }`，顺序与请求一致。错误：`401` / `403`、`400 invalid_work_list|invalid_face_settings`、`404 not_found`、`429`。

**`POST /api/admin/works/:task/:id/calibration`** 请求 `{ "face": "gallery" | "arena", "calibration": { "framing": { "width": 1440, "height": 900, "zoom": 1, "offsetX": 0, "offsetY": 0 }, "camera": { "position": [0,0,5], "target": [0,0,0] } } }`。`calibration` 可为 `null` 清空；对象可只给其中一项，单项为 `null` 则删除该项。投稿画廊取景仍在 `trial.calibration`，竞技场取景在 `works.calibration_arena`；数据包作品取景写覆盖表的两个附加列。响应 `{ "task": "one", "id": "a", "face": "arena", "calibration": <当前对象或 null> }`。错误：`400 invalid_face|invalid_calibration`、`404 not_found`、`429`。校验范围沿用 3.16 节。

**`GET /api/admin/tasks/:id/editorial?face=gallery|arena`** 响应 `{ "task": "one", "face": "arena", "commentary": "…", "weights": [0.2,0.2,0.2,0.2,0.1,0.1] | null, "updatedAt": "…" | null }`。**`POST /api/admin/tasks/:id/editorial`** 请求 `{ "face": "arena", "commentary": "点评", "weights": [0.2,0.2,0.2,0.2,0.1,0.1] }`；`gallery` 只接受 `commentary`，不得传 `weights`。竞技场权重须 6 个 0–1 数，总和在 `1 ± 0.001`。成功返回同 GET。错误：`400 invalid_face|invalid_editorial|invalid_weights`、`404 not_found`、`429`。

Show1 `/api/prompts` 在有 `arena` 覆盖时按题目映射合并 `commentary`、`weights`；没有覆盖时仍逐项返回快照内容。历史票的快照权重与娱乐榜回放不随覆盖修改。

**`GET /api/admin/traffic?days=N`** `N` 默认 30，范围 1–90。响应 `{ "days": 30, "daily": [{ "day": "2026-09-28", "pv": 12, "uniqueIps": 8 }], "paths": [{ "path": "/", "pv": 9 }], "users": { "total": 24, "new": 2 } }`。`daily` 按 UTC 日补齐零值；`paths` 最多 20 条；错误 `400 invalid_query`。

**`POST /api/admin/works/upload`** 仍仅高级管理员可用，原始 HTML / ZIP 参数与校验沿用原入口。创建时按工作人员发布规则保存 human / approved，理由「管理员发布」，核验状态 unverified，进入人工核验队列；不再自动 verified。可排队生成截图，响应 `{ "work": <管理员作品视图> }`。普通管理员可使用正常投稿或收件箱登记入口。

竞技场配对和 Bradley–Terry 计分都只纳入当前 `show_arena=1` 的已验证作品；数据包作品没有覆盖记录时竞技场开关默认开启，管理员关闭后按覆盖记录保持。`votes.source='arena'` 的限制不变。Show1 娱乐榜仍从全量历史票回放。

### 3.19 管理员收件箱与作品编辑

以下 API 开放给高级与普通管理员。写请求遵循 Origin 校验和 write 限流。收件箱位于 DATA_DIR/inbox，仅暂存待登记 HTML/ZIP，上传本身不公开作品。

- `GET /api/admin/inbox`：按加入时间返回 entries，含 id/name/kind/size/addedAt/suggest/preview。
- `POST /api/admin/inbox?name=<文件名>[&overwrite=1]`：原始 HTML/ZIP，最多 30 MB，先检查包。已存在同名文件且不覆盖返回 409 inbox_conflict；成功写 inbox-upload 审计。
- `GET /admin/inbox/:id/...`：暂存文件预览，仅工作人员可读，其他请求返回 404，响应 no-store。
- `POST /api/admin/inbox/register`：传 id/task/effort/providerId 及可选作品信息。保存 human / approved、unverified，仍须别次人工核验；旧 publish 参数不再直接公开。登记成功移除暂存文件并写 inbox-register 审计，返回管理员作品 DTO。
- `DELETE /api/admin/inbox?id=<ID>`：移除暂存文件并写 inbox-remove 审计，不等于删除已发布作品。
- `POST /api/admin/works/:task/:id/meta`：两种存储统一编辑 title/summary/note、promptVariant、modelId/modelName/vendor、effort、harnessId/harnessOther、providerId、generationMode/humanIntervention。未提供字段保持原值，校验与作品表单一致，旧停用字段沿用忽略规则。数据包写 work_overrides.display_json，数据库写本行；不触发重新内容审核，写 meta 审计。普通管理员可编辑自己作品的信息。响应 `{ "work": <管理员作品视图> }`。

原 `POST /api/admin/works/:task/:id/display` 路由已删除，后台所有编辑统一调用 meta。核验、内容决定、开关、校准、收件箱归属及相应批量接口拒绝普通管理员处理自己的作品，403 提示需由其他管理员处理；高级管理员可以处理自己作品。

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
| `GET /api/prompts` | `{ prompts: [...] }`；合并历史快照、数据包题目与已审核公开的数据库题目。已有 `arenaId` 保留三位编号，其他题目沿用 canonical task ID（如 `q-48c3b43eeb284f6d`），无需另行登记竞技场编号；竞技场 editorial 覆盖对应题目的 `commentary`、`weights`。 |
| `GET /api/works` | `{ works: [...] }`；快照作品加符合条件的 live 投稿与公开收录。快照 HTML 和 live 投稿还须通过内容源当前的 `publicContent` 门禁；任务缺失、撤下或不可公开的源不进入清单，快照非 HTML 内容保留。历史身份映射、票与题目定义不删除。 |
| `GET /api/votes?scope=entertainment\|formal` | `{ votes: [...] }`；只读库内 `source=show1` 的票，按时间和 ID 排序，不合入旧快照。scope 必填，非法或缺失为 400。 |
| `POST /api/votes` | 登录必需；提交 `id`、`promptId`、`winnerRid/Mid`、`loserRid/Mid`、`mode`、`outcome`。未绑定邮箱时有效请求返回 `200 { counted: false, reason: 'unbound' }`，不写入对局或票；已绑定时成功 `201 { vote }`，同 ID 同票幂等重放，已投同一对返回 `409 pair`；`formal` 仅管理员。新 `blind` / `party` 票要求该题当前公开娱乐作品至少 10 件（非演示、按 id 去重），不足返回 `409 { code: "pool", error: "作品收集中（数量/10），暂未开放娱乐盲测" }`；已存票幂等重放及历史榜单保留，正式范围不套此门槛。 |
| `GET /api/ratings?scope=entertainment\|formal` | `{ ratings: { [modelId]: number }, games: { [modelId]: number } }`；按库内票回放未取整 Elo，供配对，复用聚合缓存。scope 必填。 |
| `GET /api/show1/leaderboard?scope=entertainment\|formal&category=all\|text\|web` | 主站聚合榜单，scope 必填，category 缺省 all；非法参数 400。见下方。 |
| `GET /api/comments?round=<题目编号>` | `{ comments: [...] }`；无效题目 `400`。 |
| `POST /api/comments` | 登录必需；请求 `id`、`roundId`、`side`、`body`，成功 `201 { comment }`。 |
| `GET /api/reactions?prompt=<题目编号>` | `{ counts, mine }`；无效题目 `400`。 |
| `POST /api/reactions` | 登录且绑定邮箱；请求 `id`、`promptId`、`mid`、`kind`，成功 `201 { counts, mine }`；`kind:null` 撤销。未绑定返回 `403 email_required`。 |
| `POST /api/track` | 最佳努力记录 `path` 浏览量，成功 `204`。 |

正式题目在数据仓库登记 `arenaId`（稳定三位编号）、`kind`（`text` / `web`）和 `category`。共享后端保留这些编号；无 `arenaId` 的公开数据包题及展览馆创建、已审核公开的数据库题，直接沿用 task ID。兼容层题目 ID 契约为 `/^(?:\d{3}|[a-z][a-z0-9-]{0,63})$/`；题目、作品、投票、评论和反应统一使用此 ID。数据库题未提供 `kind` 时由类别与 templates 判定文字或网页。待审、拒绝或删除的数据库题不进入公开题目/作品目录，作品仍须通过原有公开内容、审核和娱乐展示门禁。

新增题目及其已验证、开启竞技场展示的投稿会保留在公开清单中；娱乐盲测须至少有 10 件不同 id 的非演示公开娱乐作品且有跨模型组合，未达门槛仍可浏览，降到门槛以下关闭新对局。长短提示词使用同一个 task ID 与编号，以 `promptVariants: [{id, label, prompt}]` 返回两份原文，由前端按钮切换；作品可通过 `promptVariant` 标明使用的版本，同一模型的两版展示在一起。既有快照题目保留编号、名称及权重，正式提示词由数据包提供；未进入数据包的历史题目仍保留。不新增数据库迁移，不改变展览馆审核、作品展示开关或正式盲测接口。Show1 前端须同步支持 canonical ID 后再对外发布此兼容层改动。

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

当前 API 只保留 `generationMode`、`humanIntervention`，同时支持投稿、审核、管理员直接上传、收件箱登记与 `/api/admin/works/:task/:id/meta`。投稿、数据包作品的公开作品视图与管理员视图均返回这两项；请求省略字段保持已有值，空串显式清空，非字符串或非法值返回 `400 invalid_generation`。历史 `agent` 读取为 `single-turn`，禁止新写。三个停用字段一律忽略，单独 PATCH/meta 是成功空操作；不会触发重新审核，也不写字段审计。后台编辑和审核的 audit 只记录两项生成信息的变化前后值。

`GET /api/admin/works` 新增 `model`（注册 ID 或 `other` 表示未登记模型）、`effort`（档位文本，大小写不敏感；`unset` 为未注明）、`generationMode` 和 `humanIntervention`（各自枚举值或 `unset`）。筛选可以组合，仍在分页前执行。搜索另外覆盖厂商。响应追加 `efforts` 数组，取全部作品实际记录的非空档位，供后台选择自定义档位；其余分页字段不变。竞技场开关已开启但生成信息不合格时，后台作品表显示「不符合盲评条件（多轮 / 人工介入）」。

推理档位输入提供常用值与手填，新投稿必填，编辑禁止显式清空。历史空串表示未注明，明确使用默认设置可填写 `Default`；历史空串不改写成 `Default`。新对局的身份快照只保留两项生成字段，历史快照读取时剥离停用字段、不回写，计分键仍为模型或模型+档位。

数据仓收录将非空生成字段写入 manifest、task.json 和作品 README，构建 data.json 时透传。manifest 与 task.json 同时声明时必须一致；消费旧包时缺失字段仍按未注明处理。Show1 旧兼容端点的返回形状保持不变。

### 3.23 冗余字段清理（schema v18）

追加迁移删除 `works.audience`、`tool`、`vendor`、`reviewed_by`、`deleted_by` 和 `votes.identity_source`。`model_name` 改名为 `model_other`：仅保留未登记模型的手填名称，登记模型的名称和厂商读取当前数据包字典；字典缺少该 ID 时名称返回 ID、厂商为空。模型版本 `model_version` 保持不变。

旧 `tool` 只在没有 Harness ID 且「其他」为空时回填 `harness_other`。未登记模型的非空旧 `vendor` 在删列前原样追加为 `note` 中的「手填模型厂商：…」，保留原备注且不截断。缺失的审核、删除 audit 从旧操作人列补存，审核人通过最近一次审核记录读取。展示开关保留原值；所有历史对局、投票身份快照及更正值原样保留。旧客户端仍可提交 `tool`、`audience`，API 和收录导出的兼容字段由保留字段生成。升级前须备份数据库，退回 v17 或更早的代码须同时恢复兼容的数据库备份。

### 3.24 自动内容审查（schema v19）

追加幂等迁移，仅新增 `works.moderation` JSON 列；默认 `{ "status": "legacy" }`，既有作品保持原行为。`CONTENT_MODERATION=1` 时普通用户新作品先设 pending；高级与普通管理员新作品直接 human / approved、unverified，所有入口仍须人工核验（见 3.18 / 3.19）。作者修改送审声明后重新设 `pending`，管理员 meta 与 review 修改保持现有 `moderation`，随机 revision 防止旧调用结果覆盖新版声明；人工决定也不会被较早的自动结果覆盖。启动恢复持久化的 pending 队列。内容状态与来源核验 `status` 独立。

| `moderation.status` | 含义 | 可公开 |
| --- | --- | --- |
| `legacy` | 旧流程，未自动审查 | 按原门面/核验规则 |
| `pending` | 排队或审查中 | 否 |
| `approved` | 自动或人工确认内容通过 | 按原门面/核验规则 |
| `review` | 疑似风险或自动审查失败，待人工 | 否 |
| `rejected` | 内容不通过 | 否 |

`moderation` 仅返回作者/管理员。普通作者只收到 `{ status, at }`，且仅在 `rejected` 时附 `reason`：人工拒绝为人工理由，自动拒绝（含复查）统一为固定文案「自动内容审查未通过，请联系管理员」，模型文字不返回作者；管理员保留完整结果，可含 `source: automatic|human|recheck`、中文 `reason`、风险 `categories`、`signals`、`error` 代码、`model`、`serviceTier`、`responseId`、`usage`、`coverage` 或人工 `reviewer`。`at` 为毫秒时间，旧 legacy 记录可缺省。不含 API 密钥或服务商原始错误响应。题目作者视图采用相同裁剪规则；管理员题目视图保留完整结果。`bootstrap.site.autoModeration` 与管理员审核计数见 3.1。

内容尚未通过时，公开 bootstrap、Show1 动态作品、盲评、评论/表情均不可使用该作品。普通用户作品沿用人工已作决定的公开规则：`status` 不为 `unverified`，或 `moderation.source` 为 `human`；自动通过（以及关闭审查时的 `legacy`）本身不公开。工作人员发布及数据包作品还要求 `status` 不为 `unverified`，创建时 human / approved 不能替代最后的人工核验。评论和表情继续要求 verified。在此之前作者/管理员使用预览源。公开 `w<32hex>` 源返回 410，媒体请求仅允许作者/管理员，否则 404。作者/管理员作品 DTO 的 `scene` 是随机 `p<32hex>` 源，有效一小时、进程重启失效，返回 `Cache-Control: no-store`。该地址本身具有预览能力，不应公开转发。自动截图也使用此源。参与审查的已公开作品源与媒体使用 `no-store`，防止新审核状态被已有缓存跳过。

- **`POST /api/works/:task/:id/moderation`**：仅管理员；JSON `{ "status": "approved" | "rejected", "reason": "人工理由" }`。通过理由选填，省略或空白时保存「人工复核通过」；拒绝理由必填，理由保存最多 500 字；无效决定或拒绝缺理由 400，无权限 403，作品不存在 404。成功 200 `{ "work": <管理员作品视图> }`，写 `content-review` audit 并刷新竞技场缓存。内容通过不改变来源核验或门面开关；示例作品需题目也人工通过、进入 catalog 后才公开，无需再次操作作品。
- **`POST /api/works/:task/:id/moderation/retry`**：仅管理员，无需请求体；仅开启自动审查时可用，否则 409。成功 200 `{ "work": <pending 作品视图> }`，写 `content-retry` audit 并刷新竞技场缓存，重新进入队列并暂不公开。

送审使用 Responses API，`gpt-6-luna`、`service_tier: flex`、`store: false`、xhigh 推理档、`max_output_tokens: 25000`、严格 JSON schema。材料为标题、简介、备注、生成信息、入口静态文字（模型名、厂商、档位、Harness 与服务商说明不送审）、可选封面，以及桌面/手机两档各两次截图：加载后 3.5 秒的首屏（即公开 captures），和滚动、点击中央后约 12 秒的延迟截图（`first-late.jpg` / `mobile-late.jpg`，仅供审查，不进入 captures、不经 `/media/` 提供）；每次截图都收集主页面和全部 iframe 的文字，共四段。截图上下文隐藏 `navigator.webdriver`，并把 UA 中的 `HeadlessChrome` 改为 `Chrome`。四张截图或四段文字缺任何一项都按截图不完整转 review。疑似风险返回 review，明确风险可返回 rejected。针对审查模型的提示词注入直接拒绝、不进入人工复核：先由规则扫描标题、简介、备注、模型名、厂商、档位、Harness/服务商说明、页面与渲染文字（命中则不调用模型，`categories` 含 `prompt-injection` 与 `signal:injection`），模型自身标出 `prompt-injection` 同样拒绝并替换其理由。`categories` 取固定枚举。管理员仍可用人工审核接口改判。未遍历所有交互；语境模糊交人工。

静态信号：结果返回后扫描作品内全部 `.html/.htm/.js/.mjs/.cjs/.svg`（合计上限 64MB，超出记为「部分脚本过大未扫描」）。命中密码输入框、`navigator.webdriver` / `HeadlessChrome`、以字面外部地址赋值 `location` / `location.assign|replace` / `window.open`、meta refresh，或可在审查后更换内容的 CDN 地址（jsdelivr / esm.sh 的 `gh/` 路径，jsdelivr `npm/`、unpkg、esm.sh 上不带精确 `x.y.z` 版本的包）时，approved 改为 review，`reason` 追加命中项，`categories` 追加 `signal:<id>`，管理员结果另含 `signals`。混淆代码可以绕过这些规则，它们只保证明显信号由人工确认。作品 CSP 的 jsdelivr 来源收紧为 `https://cdn.jsdelivr.net/npm/`，`gh/` 等其他路径一律不加载；上传检查把 `cdn.jsdelivr.net/gh` 列为会被拦截的外部资源。

定期复查：`CONTENT_RECHECK_HOURS`（默认 24，0 关闭）在开启审查时生效，进程启动一小时后每小时检查一次到期作品。范围为已公开（见上）且未转数据包的投稿，在待审队列空闲时逐件重新截图（`recheck-*.jpg`，不更新 captures）。基线存于 `.data/media/<id>/baseline.json`：数字归一后的首屏文字摘要、全部 CDN 响应体的 SHA-256 及检查时间；自动审查截图完整时写入，没有基线的作品在首次复查时补建。截图不完整则跳过，下一轮重试。文字和 CDN 都未变时只更新检查时间。有变化时重新送审：通过则写 `content-recheck` audit 并保持公开；否则（含调用失败）以 `source: "recheck"`、理由前缀「定期复查发现内容变化：…」写入结果，作品立即撤下等待人工。缺密钥、截图不完整、超出材料限额、请求超过 15 分钟、429/其他错误、未完成/拒答/无效结构或未确认 Flex 均转 review，不自动重试或切换标准档。`CAPTURE=0` 无法完成自动审查。关闭开关不放行已有待审或被拒作品。

### 3.25 盲评资格维护与代表作持久化（schema v26）

v26 仅追加幂等建表 `featured_picks(task_id, scope, model_key, work_id, conservative, picked_at)` 与 `featured_refreshes(task_id, day)`，不回填作品、不打开竞技场开关，也不修改旧 CHECK 约束。`scope` 为 `cover` 或 `model`；封面的 `model_key` 为空串。日刷新状态独立保存，未有当选者的题目也不会在同日重复拟合。

## 4. 数据包契约（`dist/data.json`）

数据包由数据仓库（arenaofbias-data）构建产出；部署到 `DIST_DIR` 的副本是服务端数据包目录输入。画廊前端从自己的静态部署消费对应数据与数据包资源；若前后端各持有副本，应同步版本。其结构属契约的一部分。后端仓库当前无默认 `dist/`，运行前必须提供数据包。

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

**Harness / 服务商注册表**：数据包顶层 `harnesses` 含完整条目与 `listed`，停用 ID 仍可解析历史作品；旧包缺少 Harness 数组时服务端按 `[]` 读取。Harness 条目含 `id`、`name`、`kind`、`maker`、`url`、`logo`、`aliases`、`listed`。`providers` 公开构建仅列 `official` / `unofficial`，均为 `listed: true`；服务端目录及 bootstrap 固定这两项，旧包其余服务商引用读取为 `unofficial`。服务端 `catalog.model()` 查完整 `modelPool`（含停用模型），同 ID 的 `models` 条目优先；`catalog.models()` 仍只返回展示列表。缺少 `modelPool` 的旧包只查 `models`。

**题目（task）**：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` / `title` / `summary` | string | 标识 / 标题 / 简介 |
| `date` | string | 日期（`YYYY-MM-DD`） |
| `tags` | string[] | 标签 |
| `prompt` / `promptUrl` | string | 提示词原文与出处链接 |
| `promptPending` | boolean（可缺省） | 为真时该题**不接受上传**（服务端据此置 `acceptsUploads=false`） |
| `sandtable` / `sceneProfile` | 可缺省 | 沙盘 / 场景档案标记 |
| `conditions` | array | 截图条件 `[{ "id", "label", "note", "mobile" }]`，`id` 与数据包作品的 `captures` 键对应 |
| `results` | array | 数据包作品列表 |

**数据包作品（result）**：

| 字段 | 说明 |
| --- | --- |
| `id` | 题目内唯一 |
| `model` | 模型 ID（对应 `models[].id`） |
| `effort` / `sourceLabel` | 档位 / 来源标签（服务端映射为 `tool`） |
| `harness` / `provider` | Harness ID 或 null / `official`、`unofficial` 或 null；缺省即未注明。旧数据包的 `harnessVersion` 忽略 |
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
- 后端站点端口可从 `DIST_DIR` 分发 JSON、图片等资源，但不提供作品 HTML；数据包盲评使用内容端口的独立令牌源，独立画廊则从自身静态部署加载数据包资源与页面。
- 版本目录一经发布必须保持内容不可变；直接覆盖仍被旧对局引用的同一目录不能保证旧资源可用。

### 4.3 消费方注意点

- 服务端使用 `id`、`title`、`promptPending`、`results[].id/model/effort/title/summary/sourceLabel/harness/provider/scene/captures/gallery`，以及顶层 `models`、`harnesses`、`providers`；其余字段由画廊前端自行解释。
- 数据包作品在平台 API 中省略所有资源字段（见 2.1），前端以本地同版本数据包提供资源，以 bootstrap DTO 判断可公开条目并合并当前业务字段。
- 服务端重复检测会读取数据包作品 `scene/index.html` 的 SHA-256，数据包内该文件缺失时该作品不参与重复比对（不报错）。

---

## 5. 版本与变更纪律

1. 本文档与 `server/` 代码同库维护；**凡契约变更（端点、字段、状态码、限制、数据包结构）必须先改文档、走 PR，经两个前端负责方过目后方可合并**。
2. **字段只增不减**：已发布响应中的字段不得删除、不得改名、不得改变语义；新增字段默认缺省 / 可空，前端对未知字段一律忽略。破坏性格式变更通过新增端点或显式版本化进行，不原地修改。
3. 数据库表结构变更只允许在 `server/db.mjs` 的 `MIGRATIONS` 末尾追加幂等迁移（PRAGMA `user_version` 驱动），不改写已发布迁移。
4. 错误 `error` 文案面向用户、可随时调整，**不构成契约**；契约只承诺状态码与 `code` 字段。
5. 限流额度为运营参数，调整不视为契约变更，但应在本文档 1.6 节同步更新。
6. 本文档中标有「**待拍板**」的条目为与代码现状有出入或尚未决策之处，逐条拍板后更新文档并消除标记。

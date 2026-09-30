# arenaofbias-server

生产部署、差异数据包和回滚步骤见 [部署文档](docs/deploy.md)。

Show1×Show2 融合工程的**共享后端**：整个体系中唯一的动态服务，独占数据库，负责账号、投票、排行榜、投稿审核与作品沙盒伺服。两个前端（画廊/平台 UI）各自独立部署，全部通过本服务的 HTTP API 读写数据。本仓库**不含任何前端页面**。

- 纯 Node.js（>= 22.13），**零依赖**（无 dependencies / devDependencies，无需 `npm install`）。
- 数据库为 `DATA_DIR/platform.db`（默认 `.data/platform.db`），首次启动自动创建，不进 git。
- 同时监听两个端口：API/数据包端口（代码默认 5173）与作品沙盒内容端口（代码默认 5180，每个作品以独立子域 origin 伺服，互相隔离）。实际画廊联调分别使用 5190、5191，前端位于 4175。

## 运行

```bash
npm run fetch:datapack    # 按 datapack.json 安装 .datapack/versions/<SHA>
npm run activate:datapack # 原子切换 .datapack/current；已是该版本时不操作
npm start        # node server/index.mjs
npm run admin -- <用户名>   # 提升某用户为管理员（server/cli.mjs）
npm run admin -- --create <用户名> # 从标准输入读取密码并创建管理员
npm test         # node --test test/*.test.mjs
```

启动前需安装数据包。默认优先使用 `.datapack/current`，不存在时兼容旧 `./dist`；也可通过 `DIST_DIR` 指定。下载器与前端共用数据仓库维护的 `scripts/datapack-client.mjs` 副本（跨仓冒烟核对字节一致），流式解压、安装前校验，已安装版本不覆盖。

管理员账号只能通过 CLI 新建，或将已有普通账号提权；提权可由获授权的管理员或 CLI 执行。`--create` 在交互终端输入密码时不回显，也可从标准输入读取；不接受命令行密码参数。公开注册对 `ADMIN_USERNAMES` 保留名与已占用用户名统一返回 `409`。

- `same-prompt-gallery` 负责静态画廊前端与原作展示；`arenaofbias-server` 独占 API、账号/投票/投稿数据库和投稿沙盒；`arenaofbias-data` 负责生成供后端读取的馆藏数据包。后端不复制前端源码，也不提供画廊入口页面。
- 本地与生产均需先取得数据仓库构建产物，将 `DIST_DIR` 指向它的根目录。若前端与后端各自持有数据包副本，部署时应确保两者版本一致。

例如本轮本机联调（PowerShell；先将首行替换为实际已构建数据包的绝对路径）：

```powershell
$env:DIST_DIR = 'C:\path\to\built-datapack'
$env:DATA_DIR = 'C:\path\to\isolated-runtime-data'
$env:PORT = '5190'
$env:CONTENT_PORT = '5191'
$env:SITE_ORIGINS = 'http://localhost:4175'
$env:CAPTURE = '0'
npm start
```

前端独立启动，并将画廊的 `API_BASE_URL` 设置为 `http://localhost:5190/api/`（包含 `/api/`）；`CAPTURE=0` 时截图队列不启动、不处理投稿截图，只适用于不验自动截图的联调或明确接受无自动截图的部署。`CONTENT_ORIGIN_TEMPLATE` 默认随 `CONTENT_PORT` 生成 `http://{token}.localhost:5191`。生产部署按实际 HTTPS 域名设置这些变量，并由代理提供作品源泛域名。

数据包更新可不重启：安装后原子切换 `DIST_DIR` 所指链接，服务按真实目录和 `.datapack-source.json` 中的**产物** commit 加载。`data.json.sourceCommit` 是不同的**源码**提交。对局持久保存真实版本目录，HTML 与后续资源固定到该目录；新对局使用新版。普通目录不能原地覆盖，修改进程环境变量也不会自动切换运行中的服务。Windows/文件系统不支持原子替换链接时，切换命令保留旧链接并报错，应停服后人工切换。

`npm run prune:datapack` 默认只列出可清理目录；加 `-- --apply` 才删除。保留当前版本、配置 pin、未过期对局及默认一小时宽限期内使用的版本（`DATAPACK_CLEANUP_GRACE_MS` 可调）。清理与发布切换应串行运行，宽限期应覆盖实际请求超时；不依赖历史 votes 保留资源。数据库不在或旧库未迁移时拒绝清理。`DATAPACK_VERSIONS_DIR` 可设置版本存储根。运行数据备份必须包含 SQLite、works 和 media。

开发包的 `bootstrap.datapack` 为 `null`，两端通过原始 `data.json` 的 `catalogDigest` 核对，不能冒认固定版本。数据格式和前端版本校验见 [API 契约](docs/api-contract.md)。

新投票保存对局时的模型/档位、Harness/服务商与计分 key；来源维度不改变计分。管理员可运行 `npm run correct:vote -- <管理员> <投票ID> <a或b> <更正JSON文件> <原因>`；JSON 允许 `modelId/modelName/vendor/effort/harnessId/providerId`。更正单独保存，原始快照不变，并写审计。没有身份快照的 legacy 票不参与计分，也不能更正。

作品来源使用两个数据包注册表：Harness 表示驱动模型产出作品的工具或环境，服务商表示实际提供推理服务的一方。投稿可选注册表 ID 或填写「其他」；普通用户过渡期仍可只提交原始 `tool` 声明。接口字段及互斥规则见 [API 契约](docs/api-contract.md)。

## 环境变量（server/config.mjs）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | 监听地址 |
| `PORT` | `5173` | 站点 / API 端口 |
| `CONTENT_PORT` | `5180` | 作品沙盒内容端口 |
| `DIST_DIR` | `.datapack/current`，不存在时 `./dist` | 当前数据包链接或不可变目录 |
| `DATA_DIR` | `./.data` | 数据库与运行数据目录 |
| `CONTENT_ORIGIN_TEMPLATE` | `http://{token}.localhost:<CONTENT_PORT>` | 作品 origin 模板，默认端口 5180；`{token}` 必须占满一个 host label，生产需独立泛域名 |
| `SITE_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | 可信前端 origin（逗号分隔，含协议与端口），同时允许凭据 CORS、API 写操作和 iframe 嵌入作品 |
| `ADMIN_USERNAMES` | 空 | 始终持有管理员角色的用户名（逗号分隔） |
| `CONTENT_CDN_ALLOWLIST` | `cdn.jsdelivr.net,unpkg.com,cdnjs.cloudflare.com,esm.sh,fonts.googleapis.com,fonts.gstatic.com` | 作品允许加载脚本/样式/字体/数据的公共 CDN 白名单 |
| `CAPTURE` | 开（`0` 关闭） | 投稿作品的无头截图（预配置 Playwright ≥ 1.48 + 本地 Chrome）；文档只访问当前作品源，资源只访问作品源和 HTTPS CDN 白名单，逐跳检查重定向，禁用 Service Worker / WebSocket |
| `CAPTURE_BROWSER` | `chrome` | 截图所用浏览器通道 |
| `CONTENT_MODERATION` | 关（`1` 开启） | 新投稿先保持私密，异步审查文字、封面及桌面/手机首屏；异常转人工 |
| `MODERATION_API_KEY` / `OPENAI_API_KEY` | 未配置 | 服务器审核 API 密钥，前者优先；不下发至浏览器 |
| `MODERATION_BASE_URL` | `https://api.openai.com/v1` | Responses API 根地址；生产使用 HTTPS |
| `MODERATION_MODEL` | `gpt-6-luna` | 审核模型；请求固定 `service_tier: flex` |
| `COOKIE_SECURE` | 关（`1` 开启） | session cookie 改名 `__Host-sp_session`，加 Secure 标记，Path=/ 且不带 Domain；本地未开启时仍为 `sp_session` |
| `COOKIE_SAME_SITE` | `Lax` | `Lax` / `Strict` / `None`；跨站 HTTPS 部署用 `None`，并必须开启 `COOKIE_SECURE=1` |
| `TRUST_PROXY` | 关（`1` 开启） | 仅信任本机单层反代的 `X-Forwarded-For` 最后一项有效 IP；非本机连接或无效头使用连接 IP。边缘代理须覆盖原头或追加真实客户端 IP |
| `READ_API_PER_MIN` / `READ_CATALOG_PER_MIN` | `180` / `30` | 按真实 IP 限制 API GET/HEAD（收录导出沿用自己的令牌/IP 桶），以及跨端点共享的整表/榜单读取；最小为 1 |
| `READ_FILES_PER_MIN` / `READ_PAGES_PER_MIN` | `1200` / `60` | 按真实 IP 限制后端静态/作品资源与作品 HTML，跨作品域名共享；最小为 1 |
| `SERVER_VERSION` | Git HEAD 或 `dev` | 启动时确定的服务端版本，返回在 bootstrap 中 |
| `SMTP_HOST` / `SMTP_PORT` | 未配置 / `465` | 验证码 SMTP 主机与端口（465 隐式 TLS；其它端口默认 STARTTLS） |
| `SMTP_USER` / `SMTP_PASS` | 未配置 | SMTP 登录身份和密码；缺少任一项时不能发验证码 |
| `SMTP_FROM` / `SMTP_FROM_NAME` | 用户名 / `Arena of Bias` | 发件地址和名称 |
| `SMTP_STARTTLS` | 开（`0` 关闭） | 只供本地明文 SMTP 测试；生产保持开启 |
| `MAIL_SMTP_TIMEOUT_MS` | `20000` | SMTP 超时毫秒数 |
| `MAIL_CODE_TTL_MS` / `MAIL_CODE_MAX_ATTEMPTS` | `600000` / `5` | 验证码有效期和输错上限 |
| `MAIL_COOLDOWN_MS` / `MAIL_IP_MAX` / `MAIL_EMAIL_MAX` | `60000` / `8` / `3` | 发码冷却及 15 分钟内按 IP、邮箱限流 |
| `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` | 未配置 | 两项均配置才开启；站点密钥经 `/api/auth/turnstile` 下发 |
| `TURNSTILE_VERIFY_URL` | Cloudflare siteverify | 校验地址，本地测试可指向桩服务 |

收录流程不需要数据仓库路径环境变量：管理员提名后，在 `arenaofbias-data` 中运行返回的命令；数据包发布并切换后，带 `sourceUpload` 的馆藏作品自动接管投稿。

公开浏览保留，超出读取额度返回 `429` 和 `Retry-After`；登录、换 Cookie、换参数或作品域名不会重置 IP 额度。API 域的完整 `/data.json` 仅供已登录管理员使用，包来源文件不公开。两个前端的 Nginx 静态资源需另按 [部署说明](docs/deploy.md#公开读取与反爬配置)启用 `deploy/nginx/` 配置；仅升级后端不会保护前端静态站。公开展示内容仍可被低频读取，公开源码仓库也不受这些限流保护。

## 自动内容审查

服务器设置 `CONTENT_MODERATION=1`，在服务器环境中配置 `MODERATION_API_KEY` 或 `OPENAI_API_KEY`，并启用已有截图环境（`CAPTURE=1`、预配置 Playwright 与 Chrome）。默认调用 OpenAI Responses API 的 GPT-6 Luna Flex；不新增 npm 依赖。缺少密钥、截图不完整、超时或 Flex 容量不足时保留私密状态，转人工复核；不自动改用标准档。

内容状态独立于 `unverified / verified / questioned`：`pending` 等待自动审查，`approved` 可公开，`review` 等人工，`rejected` 不公开。公开门面开关仍生效；只有核验为 `verified` 的作品才能进盲评。作者和管理员响应中会发放有效一小时的随机预览地址，地址本身具有预览能力，不应转发；封面和截图仍校验作者/管理员会话。后台支持人工通过、拒绝和重新自动审查，并记录审计。修改送审文字后重新进入 `pending`，启动时恢复尚未处理的队列。

送审材料是投稿声明、入口 HTML 的静态文字、实际桌面/手机页面文字、可选封面及两张首屏截图；没有遍历所有页面、滚动区域、交互后画面或资源包图片，也不证明模型声明真实。模型结论只是初筛，疑似内容转人工。升级已有作品标为 `legacy`，维持原发布行为；关闭自动审查后新作品也走原流程，已经待审/拒绝的作品仍受访问限制。页面无法读取、文字超过 10 万字符、入口 HTML 超过 5 MiB 或单张送审图超过 20 MiB 时转人工。

## API 概览（server/app.mjs）

站点端口（默认 5173）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/bootstrap` | 首屏聚合：当前用户、站点配置、作品列表、反应汇总、各题对战池、排行榜总计、我的投票/待审数、管理员待审计数 |
| POST | `/api/auth/register` | 注册并建立会话（限流） |
| POST | `/api/auth/login` | 登录（限流） |
| POST | `/api/auth/logout` | 登出 |
| GET | `/api/auth/turnstile` | 获取 Turnstile 站点密钥；未开启时返回 `null` |
| POST | `/api/auth/email/send` | 发绑定或重置密码验证码 |
| POST | `/api/auth/email/verify` | 预校验验证码 |
| POST | `/api/auth/email/bind` | 登录后绑定或更换邮箱 |
| POST | `/api/auth/password/reset` | 凭邮箱验证码重置密码并撤销所有会话 |
| POST | `/api/questions` | 发布社区题目，保留提示词、标签和允许的提交格式（需登录） |
| POST | `/api/drafts?task=&name=&template=` | 上传 ZIP/HTML，检查后暂存为草稿；`template=static|vite` 可选，Vite 项目必须含构建产物（需登录，限流） |
| DELETE | `/api/drafts/:id` | 丢弃草稿（需登录） |
| POST | `/api/works` | 由草稿正式投稿，入审核队列并排队截图（需登录） |
| DELETE | `/api/works/:task/:id` | 删除投稿（需登录，本人或管理员） |
| POST | `/api/works/:task/:id/review` | 审核投稿（仅管理员） |
| POST | `/api/works/:task/:id/moderation` | 人工内容通过/拒绝，需理由（仅管理员） |
| POST | `/api/works/:task/:id/moderation/retry` | 重新排队自动内容审查（仅管理员） |
| POST | `/api/works/:task/:id/reactions` | emoji 反应（需登录） |
| GET | `/api/me` | 本人题目、投稿、投票、近 365 天活跃热图和收到的表情（需登录） |
| PATCH | `/api/me` | 修改昵称，登录用户名不变（需登录） |
| GET | `/api/review` | 全部投稿与审计日志（仅管理员） |
| POST | `/api/arena/matches` | 创建一场盲投对战（限流） |
| POST | `/api/arena/matches/:id/vote` | 对一场对战投票（限流） |
| GET | `/api/leaderboard?task=&by=` | 排行榜，`by=config|model`，`task` 可选 |
| GET | `/api/show1/leaderboard?scope=entertainment&category=all` | 主站 Elo 榜单、比较统计、六维画像；`scope=entertainment|formal`，`category=all|text|web` |
| GET | `/media/up-xxxxxxxx/(cover.png|cover.jpg|cover.webp|first.jpg|mobile.jpg)` | 投稿的封面/截图（CSP: default-src 'none'） |
| GET | `/*` | `DIST_DIR` 内的静态数据包资源；HTML/HTM（含目录入口）返回 404，其余响应使用无脚本 CSP sandbox；作品只从内容源运行 |

内容端口（默认 5180）：按 `CONTENT_ORIGIN_TEMPLATE` 的 `{token}` 子域伺服单个作品目录，施加沙盒 CSP 与 CDN 白名单（见 `server/content.mjs`）。

前端独立部署时，`SITE_ORIGINS` 填前端真实 origin（不含路径或末尾 `/`），所有 fetch/XHR 携带会话凭据（`credentials: 'include'` / `withCredentials = true`）。可信来源支持 API 的 OPTIONS 预检及 `Content-Type` 请求头；不使用通配 CORS。`captures` / `cover` 的 `media/...` 路径按后端站点根解析，不能按前端路径解析。跨站 Cookie 还受浏览器第三方 Cookie 设置限制；优先采用同站域名的前端和 API 部署。

## 投票清零

主站榜单和配对分只读取数据库中的 Show1 票，不再重放迁入的旧快照票；作品和题库快照继续用于展示。画廊的 Bradley–Terry 榜单仍独立计入 `source=arena` 的票。

两站全部清零使用显式维护命令。先检查数量；正式执行时停服务，指定一个不存在的备份文件和操作者，再重启本轮后端：

```bash
npm run reset:votes -- --db /absolute/path/platform.db
npm run reset:votes -- --db /absolute/path/platform.db --apply --backup /absolute/path/before-reset.db --actor <name>
```

执行前通过 SQLite `VACUUM INTO` 备份（包含 WAL 中已提交的内容），然后同一事务删除全部票和对局、写入审计。账号、作品、评论、表情和猜模型成绩不清除。新对局和投票需重新创建；前端应在新后端与清零完成后发布。只回滚旧代码会重新展示旧快照票，恢复旧状态需同时恢复数据库备份和旧代码。

## 测试

```bash
npm run check
npm test    # API、迁移、版本切换、投票快照、更正审计及清理保留规则
```

后端功能提交为本地 `51eb3cb`（`gallery-integration`），配套画廊前端功能提交为 `1ee5dae`（`backend-datapack-integration`）。功能提交前 19 项测试通过；跨端口真实浏览器联调也已覆盖登录/刷新、题目、昵称、HTML 投稿、审核、盲评、榜单及个人统计。公网 HTTPS、跨站 Cookie、自动截图、真机和全部原作交互尚未验证；这不等同于全站交互验证。上述分支均未 push。

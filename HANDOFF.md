# HANDOFF.md · 当前状态

## 2026-09-30 · vote-release（已推送、上线，两站旧票已清零）

- 用户明确要求「推送部署」，与此前两站全部投票清零的授权一起执行。已通过 SSH 核实公网和版本文件均为 `d69919e`，数据包 `2cb2a5b`、库 v19、622 票/622 对局、267 作品/27 用户；quick_check=ok。保留当前 Luna Flex、截图和 SSH relay 配置，不更改密钥。
- 已将远端 `main@2ead072`（含线上内容审核与 relay）以及本地主线 `aa67258`（共用题目登记）合入投票分支；冲突保留双方交接、读取限流、审核队列和共享题库逻辑。更新读取测试夹具的已发布内容状态后，check 68 文件 0 错、完整测试 141/141。
- server `c0ab6acf225ebcb4d99a7c3a5e145d011ee93d37`、主站 `980541642706a3cd9141c3c90ab0da55bec93b87` 已普通快进推送到上游 main 与各自 `show1-vote-processing`，并从对应提交归档发布；本轮收尾仅文档提交，不重新部署。合并保留共用题目登记、主站原文切换和纸墨双主题。server GitHub CI 36694501472 成功。
- 先用线上快照演练，再停 systemd 服务执行 `VACUUM INTO` 备份，清除全部 622 票/622 对局并追加一条 votes-reset 审计；其余表逐行一致，quick_check/外键通过。重新启动后库仍 v19，27 用户、267 作品、16 评论、56 表情、6 猜题成绩保留；两站去重记录已一并清零，旧快照不再参与计分。未创建生产测试票。
- VPS 后端 check 68 文件、141/141 测试通过；线上 139 个跟踪文件逐字节匹配目标提交。主站从 Git archive 独立构建，复用已验证现有依赖，786 文件完整 SHA256 校验通过；更新 6 文件、移除 4 旧资源后切换。公网 6 组分榜、两组配对分、画廊榜单均零，3 个入口与 10 个 JS/CSS 哈希一致；HTML no-cache，资源沿用 max-age=2592000。
- 浏览器确认主站空榜、娱乐/正式与分类切换、纸墨主题、390px 无横向溢出、实际两侧作品投票入口及画廊首页/空榜正常，无控制台 error。没有执行生产登录投票、投稿、付费审核或全量原作交互；写入与计分由隔离测试覆盖。
- 完整停写数据库备份 `before-reset.db`、旧代码和验收证据位于 `/root/arenaofbias-vote-release-20260930-c0ab6ac/`；主站上一版本保留为 `/www/wwwroot/show1-dist.prev`，更早副本保留在 show1-dist-backups。数据包、Gallery 静态目录、Nginx 和审核/截图/relay 配置均保留。恢复旧后端会重新读取冻结快照，回滚须按归档一起恢复数据库，且先核对新业务写入。详情见 `docs/archive/2026-09-30-vote-release-wsnxxxs.md`；本机发布材料在忽略的 `output/vote-release/`。

## 2026-09-30 · vote-branch-sync（改名与远端检查，未推送）

- 用户要求移除本轮分支名的 codex 字样；server 与主站两条分支均已改名为 `show1-vote-processing`。worktree 路径不变；其他人的分支未操作。
- 已 fetch origin；server `origin/main@26da6d6` 无新增提交，当前分支包含远端主线，`git merge-tree --write-tree HEAD origin/main` 无冲突。后端功能代码不变，沿用上一轮 133/133 测试结果，本轮未重复运行。
- 主站远端新增双主题提交，已 rebase 到 `origin/main@09387a9`；唯一 HANDOFF 冲突保留双方记录，榜单代码自动合并且主题/动效检查通过。详情见 `docs/archive/2026-09-30-vote-branch-sync-wsnxxxs.md`。本轮未 push、部署或操作业务数据库。

## 2026-09-30 · show1-vote-processing（本地实现，未推送、未部署）

- 用户确认主站和画廊全部投票清零，计算继续放在 server。当前分支 `show1-vote-processing` 位于 `C:\Users\Ryan\.codex\worktrees\show1-vote-processing\arenaofbias-server`；从 `115ac34` 开始，收工前快进到本轮期间新增的 `main@2e879fb`，保留公开读取限流，并将新接口接入该规则。原工作区的他人改动未操作。
- 新增 `/api/show1/leaderboard`：主站顺序 Elo、胜负平统计、六维加权画像、娱乐/正式与综合/写作/网页分榜全部由后端聚合并缓存；配对 `/api/ratings` 复用同一聚合。保留单题模型不进榜、家族显示名等现行规则。管理员身份更正参与计分，更正后同模型比较不计分；同 UUID 改模式返回冲突。
- 旧快照票停止参与读取、计分和配对，题库与作品快照保留。`npm run reset:votes` 默认只读预览；停服务后显式指定数据库、备份和操作者执行，先 `VACUUM INTO`，再同事务清除全部 votes/matches、写审计。两站去重一起重置，旧对局失效；账号、作品、评论、表情和猜题成绩保留。无依赖、迁移或数据包变更。
- 验证：`npm run check` 64 文件 0 错；`npm test` 133/133。临时库覆盖所有票源、备份、审计失败回滚、完整性与外键；真实 HTTP 和浏览器验证主站投票/平局/分榜/失败重试、390px 布局及清零重启后旧快照不回流。隔离演练库 3 票/3 对局归零，画廊聚合也为零。
- 配套主站仓库同名分支从 `38dad57` 接入聚合接口；画廊已有服务端 Bradley–Terry，前端无改动。发布顺序：新共享后端与停机备份清零 → 主站前端。只回滚旧后端会重新显示冻结快照票，恢复旧状态需连同数据库备份恢复。
- 本轮只清隔离演练库；现有本地业务库与生产库均未操作。用户尚未回答实际清零的执行环境问题；不据范围确认推断上线授权。沿用完成修改后英文简单句提交的用户授权，身份 `wsnxxxs`，不 push。详细归档见 `docs/archive/2026-09-30-show1-vote-processing-wsnxxxs.md`；验收生成物在忽略的 `output/`，临时服务收工关闭。

## 2026-09-30 · shared-question-intake（代码已上线，新题库待更新数据包）

- 正式题目由 arenaofbias-data 共用登记，兼容层读取稳定 arenaId/kind/category/promptVariants，并保留未迁移的历史题目、名称和权重。长短版使用同一 task ID，不拆题。
- 本地数据包 20 道正式题映射为 Show1 的 25 道题（含 5 道仅历史题）。新增题目的已验证且开启 arena 展示的投稿可参与娱乐玩法；未更改审核/展示开关或历史票。
- check 59 文件 0 错，npm test 127/127；真实 HTTP 核对编号和两组变体，前端浏览器原文切换通过。测试数据库位于 output/shared-question-intake-20260930，业务 .data/platform.db 未写入。
- 实现 `aa67258` 已推送 `codex/shared-question-intake`，随后随 vote-release 合入 main 的 `c0ab6ac` 并上线；本次只更新文档，不重新部署。公网 bootstrap 仍报告生产数据包 `2cb2a5b`，20 道正式题的新版数据包尚未切入生产。数据包已正式发布，下一步更新消费版本并配套发布 Gallery，不能把源码上线视为新题库上线。
- Gallery 当前维护仓库为 `wsnxxxs/ArenaGalleri`，旧仓已归档；Gallery 本轮 UI 实现在新仓功能分支，尚未合入 main。原实现验证与后续状态补记见 docs/archive/2026-09-30-shared-question-intake-wsnxxxs.md。

## 2026-09-30 · anti-scraping（本地完成，未推送、未部署）

- 为两个前端的共享后端增加按真实 IP 的 GET/HEAD 读取额度：API 180/min、整表/榜单共用 30/min、静态与所有作品域名共用 1200/min、作品 HTML 共用 60/min；换参数、Cookie 或域名不重置。超限带 429、Retry-After，可信 API Origin 保留 CORS；写操作沿用现有规则，收录导出保留独立令牌/IP 额度。
- API 域完整 `/data.json` 仅管理员可读，编码与 Windows 大小写别名一并检查；包来源文件不公开。准备 `deploy/nginx/` 两份 include，在 Show1、Gallery、API、作品四个 vhost 共享资源、整表、HTML、模型包及并发限制；安装、真实 IP、验收与回滚步骤见 `docs/deploy.md`。仅更新 Node 不会保护 Nginx 直接提供的两个前端。
- Gallery 已移除 Pages 发布 job，保留只读 CI；展示目录裁掉 modelPool/sourceUpload/sourceDigest，429 显示稍后刷新。用户明确选择只保留正式站点，现有 Pages 需在后续获准上线、正式站验收后关闭；目前旧副本仍在线。Show1 客户端逐票重放与评分未改，无需前端代码调整。
- 验证：check 59 文件、0 错；完整测试 126/126，新增 4 项真实 HTTP 回归。隔离 Nginx 1.30.5 语法通过，跨四个 Host 的 GET/HEAD、参数/Cookie/XFF 轮换达到共享 429，Retry-After=30，导出仍校验令牌。画廊最新正式包的首页/模型预览正常且控制台无 error，限流提示已目视检查。
- 无依赖、迁移或本轮数据包 pin 改动；未改现有业务库、生产 Nginx 或线上站点，未做公网压力测试或全部原作交互验收。公开源码/数据包及低频、分布式抓取仍是边界。隔离服务与浏览器标签已关闭，证据在忽略的 `output/anti-scraping-7232a4ec8f9347cba866be53a91e5a2f/`。
- 用户 initial AGENTS 已授权完成修改后提交；本轮使用已核实 GitHub 身份 wsnxxxs，各改动仓库一条英文 commit，不 push。详细范围与验证见 `docs/archive/2026-09-30-anti-scraping-wsnxxxs.md`。

## 2026-09-30 · luna-flex-relay（正式连接已接通，真实图文审核通过）

- 用户提供 154.36.185.169 并授权配置，明确保留 Xray 与 443。新增独立 Node 内置模块审核接口 `scripts/moderation-relay.mjs`，仅监听审查服务器 127.0.0.1:5280，经现有服务器的 SSH 本地转发访问。只接受已配置 Key 的指定模型、Flex、store=false、非流式 Responses 请求；仅连接官方接口，保留 HTTP 状态，不降档、不重试，正文上限 81 MiB、上游时限 15 分钟。
- 审查服务器独立运行环境为 `/opt/arenaofbias-review/runtime/node-v22.23.3-linux-x64/`（官方 SHA256 校验），原全局 Node v22.12.0 保留；relay 以无登录 shell 的 arena-review 用户运行，Key 环境文件 /etc/arenaofbias-review.env 为 root 0600。专用 SSH 公钥只允许目标 127.0.0.1:5280，访问其他端口实测被 administratively prohibited 拒绝；固定远端主机公钥。未修改共享 sshd 配置、Nginx、Xray 或防火墙。
- 新服务器 `arenaofbias-review-relay`、原服务器 `arenaofbias-moderation-tunnel` 均 active、enabled。原服务器 moderation.conf 的 base URL 已为 http://127.0.0.1:5280/v1，Wants/After 专用 tunnel，保留审核/截图开关；实际进程已加载，公网 contentModeration=true。原平台运行源码仍 d69919e，无前端、数据包、数据库迁移或代码重新部署。
- 首次真实 Flex 调用正常返回 review，原因是原截图机器无中文字体；本地下载图像确认方框，安装 Debian fonts-noto-cjk 后重启截图环境。第二次实际桌面/手机截图经 SSH→relay→官方 Responses→原审核模块返回 HTTP 200、completed、gpt-6-luna、flex、approved，理由为文字图片正常，2362 输入/34 输出共 2396 tokens；首次 2579 tokens。两个验证均使用隔离页面与内存 library，未创建生产投稿、用户或人工决定。
- 验证：check 61 文件 0 错，新增 1 项定向测试覆盖凭证、路径、JSON、模型/Flex/store/stream 限制、正常透传、429 无重试及断连 503。两侧 health 通过，SSH 密钥限制通过；正式画廊、bootstrap、管理页、榜单 200；库 v19 quick_check=ok，267 件作品/27 用户均保留，所有旧作品 legacy。Xray ActiveState/MainPID/启动时间与 443 原监听逐项保持一致，没有重启或删除 Xray。
- 审查服务器证据在 `/root/arenaofbias-review-setup-20260930/`；原服务器备份原 moderation.conf、API/截图/字体/运行/数据库验证在 `/root/arenaofbias-review-connect-20260930/`。本地截图前后与测试生成物为 output/release-luna-relay/，不提交；密钥与密码均未写入仓库或验收日志。回滚只恢复配置、重启平台并停止专用新服务，不触碰 Xray 或数据库。详见 `docs/archive/2026-09-30-luna-flex-relay-wsnxxxs.md` 与 docs/deploy.md 6.1。

## 2026-09-30 · luna-flex-enable（密钥与开关已配置，VPS 官方接口连接未通）

- 用户授权代填 Key 并启用。密钥经隐藏输入写入服务器 moderation.conf（root，0600），不入库、不写本地文件或日志；保留原禁用配置于 `/root/arenaofbias-luna-enable-20260930/moderation-before.conf`。daemon-reload、重启后服务 active，运行进程确认 Key 存在，CONTENT_MODERATION=1、CAPTURE=1、gpt-6-luna、官方 base URL；公网 bootstrap 的 site.contentModeration=true。运行源码仍 d69919e，未重新部署代码。
- VPS 用实际生产截图/审核模块验证隔离正常页面，两档截图生成成功，但连接官方 API 失败，结果进入 review/request_failed；未收到 OpenAI HTTP 响应。独立探测连接超时 ETIMEDOUT，系统 DNS 将 api.openai.com 解析为 179.60.193.16 与 2a03:2880:f129:83:face:b00c:0:25de；无相关 hosts 项、无既有代理环境变量，Cloudflare DoH 探测 ECONNRESET。未更改系统 DNS、hosts 或设置转发代理。
- 本机用隐藏输入进行一次真实文字+两张生成纯色图片的调用：HTTP 200、completed、model=gpt-6-luna、service_tier=flex、approved；176 输入/53 输出，共 229 tokens。因此 Key 和目标模型在本机已验证，不能把该结果称为 VPS 自动审核已跑通。
- 重启前后均 267 件作品、27 用户，全部 legacy，库 v19 quick_check=ok；无生产测试投稿或旧作品重审。新的自动审核任务当前会因接口连接失败转人工，不自动放行或降至标准档。证据在远端 `/root/arenaofbias-luna-enable-20260930/` 与本地 `output/release-luna-enable/`。
- 用户询问第二台服务器用途，已解释可由支持地区的审核服务接收文字/截图、调用 OpenAI、返回结果，网站与数据库可留在当前 VPS；尚无现成服务器连接信息，未购买、迁移或搭建远端审核服务。详见 `docs/archive/2026-09-30-luna-flex-enable-wsnxxxs.md`。

## 2026-09-30 · luna-flex-release（已部署，自动审核待配置密钥）

- 用户明确授权先部署。server `d69919eedb0731c1edeb834763a4c018d69a8568` 与配套 gallery `50c0893c07806bb05c746dca5e6d71c41260b0a0` 已普通快进推送到各仓 main 并上线；包含内容审核所需的先前安全修复。线上后端跟踪文件逐字节匹配 d69919e，服务 active；本轮收尾文档提交不重新部署，公网版本继续指向实际代码 d69919e。
- 线上库从 v18 升至 v19。迁移演练与停写后的正式迁移均确认原 16 张表的所有原列/行保持一致；quick_check 与外键检查通过，267 件作品、27 用户、622 张票保留，旧作品按 legacy 保持原发布状态。
- server 数据包保持 `2cb2a5b265e8bda8c8069a4b498f1046d825acee`，gallery pin 同步到该线上包，catalogDigest 一致。前端从已推送提交的 Git archive 构建，1183 个文件完整 SHA256 清单校验通过，实际更新 7 个文件、删除 0 个；未夹带未上线的海报迁移。
- 截图运行环境独立安装在 `/opt/arenaofbias-capture`，Playwright 1.63.0 与 Chrome 154 的实际生产截图模块完成桌面/手机本地夹具验证；服务源码仍只用 Node 内置模块。`/etc/systemd/system/arenaofbias-server.service.d/moderation.conf` 已准备模型、官方接口和 Chrome 配置；当前 `CONTENT_MODERATION=0`、`CAPTURE=0`，未配置 MODERATION_API_KEY，bootstrap 的 contentModeration=false，尚未自动审查。
- 验证：Windows 与 VPS 后端 check 59 文件 0 错、测试 128/128；server GitHub CI 36681917167 成功。前端 check 36 文件 0 错、测试 11/11、固定数据包构建及配套 integration smoke 通过；intake 83 件 0 错/3 条既有 warning。公网 bootstrap、管理页、画廊、Show1 首页、榜单均 200；浏览器桌面/390px 手机页面正常，无控制台错误或手机横向溢出。前端 GitHub workflow 原已手动停用，本轮未启用，验证在本地执行。
- 回滚材料、停写备份与验收证据在 `/root/arenaofbias-luna-release-20260930/`；旧画廊在 `/www/wwwroot/gallery.prev`，更早副本保留为 gallery.prev.before-luna-20260930。回滚后端须同时恢复备份 v18 库与旧 26da6d6 代码，不能只退代码。原工作区他人改动保留。实际付费 API、生产投稿与登录人工审核未执行；密钥配置后再启用并验证一次真实投稿。详细记录见 `docs/archive/2026-09-30-luna-flex-release-wsnxxxs.md`。

## 2026-09-30 · luna-flex-moderation（本地实现，未推送、未部署）

- 用户选择 GPT-6 Luna Flex 自动审查文字/图片，疑似交人工；默认 OpenAI 官方 Responses API，可用环境变量配置网关。不新增 npm 依赖。`CONTENT_MODERATION=1` 启用，密钥只在服务器配置；要求已有 Playwright/Chrome 和 `CAPTURE=1`。无密钥、截图不足、容量错误、拒答、无效响应或超时转人工，不切换标准档。
- 追加幂等 v19 `works.moderation` JSON，历史作品 legacy 保持原发布规则；新投稿、管理员上传、收件箱登记先 pending。内容状态独立于来源核验，未通过的作品从公开列表/Show1 动态池/盲评/互动/收录导出移除，原作品源及媒体受限。作者/管理员获一小时 bearer 预览源，预览地址不可公开转发。启动恢复 pending，送审文字变更重审，旧结果不能覆盖人工决定或较新声明。后台与前端均有人工决定/重试入口和审计。
- 范围：声明、入口静态文字、两档实际页面文字、可选封面及桌面/手机首屏；没有扫描整包、所有页面、滚动区或交互后画面。自动通过也不验证模型来源；盲评仍需原核验通过。关闭开关不会放行已有待审/拒绝作品。
- 验证：check 59 文件 0 错，完整测试 128/128。6 项内容审核 HTTP 回归涵盖持有与放行、权限、直传/收件箱、Flex 失败无降档、人工/编辑旧结果竞争、队列恢复、缺密钥/截图、迁移重跑；v16/v17 升级回归保持历史行、投票和审计。真实 Chrome / Playwright 1.63.0 完成 1440×900、390×844 截图并送到本地模拟接口；模拟 429 后正确转人工。实际浏览器验证后台人工通过、前端人工拒绝/重试、手机上传成功与状态，390px 无横向溢出。
- 使用隔离 worktree `C:\Users\Ryan\.codex\worktrees\luna-flex-moderation\arenaofbias-server`，分支 `codex/luna-flex-moderation`，基线 `115ac342`；原工作区他人未提交文件未动。前端配套在 `luna-flex-gallery\same-prompt-gallery`，同名分支；不修改数据仓和 pin。本地证据/独立测试库在 `output/playwright/`，服务器 worktree `node_modules` 是指向既有前端依赖的测试 junction，不提交、不代表新增服务依赖。
- 真实付费 API 未调用，缺正式密钥；未操作现有业务库或生产配置。部署先按 docs/deploy.md 备份、发布配套后端再前端。退回旧代码会忽略访问限制，不能只回滚代码。用户已授权一轮一条英文 commit，GitHub 身份核实为 wsnxxxs；不 push、不上线。详细记录见 `docs/archive/2026-09-30-luna-flex-moderation-wsnxxxs.md`。

## 2026-09-30 · security-fixes（本地修复，未推送、未部署）

- 修复上一轮 SR-01～SR-04：API 数据包静态路由拒绝 HTML/HTM（含目录入口），其他资源附加无脚本 CSP sandbox；作品请求异常转为 400/404/500，避免退出共享进程；截图文档限当前作品源、资源限该源及 HTTPS CDN，逐跳验证重定向，禁用 Service Worker/WebSocket，浏览器其他连接经拒绝代理阻断；代理限流只使用本机单层反代尾部的有效 IP。
- 截图保持两档尺寸，补 Windows 默认 HTTP `*.localhost` 的 Node 取资源兼容，保留原 Host 与浏览器 origin；预配置 Playwright 最低版本为 1.48。无 npm 依赖、迁移或数据包改动；管理员页面、JSON 与图片仍可用。README、接口契约和部署注意事项同步。
- 验证：`npm run check` 57 文件、0 错；`npm test` 122/122。新增 4 项定向回归覆盖静态同源边界、畸形 URL 后进程存活、伪造 XFF 前缀的真实登录限流、截图资源/重定向路由。实际 Chrome / Playwright 1.62.1 完成桌面和手机截图，直接请求、WebSocket 与跨源重定向的测试端口收到 0 次请求；默认作品 Host 与 HTTPS CDN 脚本在两档均正常。
- 所有 HTTP 验证使用隔离测试服务/临时库；未连接生产、未操作现有业务库或 Nginx。截图证据为本地生成物 `output/audit/security-capture-20260930/`，不提交。详情见 `docs/archive/2026-09-30-security-fixes-wsnxxxs.md`。
- 本轮沿用用户完成修改后提交一条英文 commit 的授权，GitHub 身份已核实为 `wsnxxxs`；不推送或上线。本轮临时测试服务已关闭，测试创建的临时库由测试清理。
- 用户要求删除上一轮目录 `C:\Users\Ryan\AppData\Local\Temp\arenaofbias-security-review-lAEFO8`；本轮按明确路径执行原生 PowerShell 删除再次被自动审批以 `blocked by policy` 拒绝，目录仍在，未改用其他方式绕过。

## 2026-09-30 · schema-cleanup-release（已获推送与上线授权）

- 用户复核 `0c7d94f`、`8c5a8eb` 和 data `ef10cdd` 后明确授权按顺序上线；采用普通 main 快进推送。data `ef10cdd9ab28dfe52a60a5a072a3cd10ae422ab3` 已发布不可变数据包 `2cb2a5b265e8bda8c8069a4b498f1046d825acee`，本轮 server pin 更新到该包。后端修复已推送，GitHub CI 118/118 通过。
- 现场门禁：公网 bootstrap、版本文件均为 `338bb3f3befcf0a76293018072c00e5d8a7d8b8a`；线上全部已跟踪文件与该提交一致，库 v16。服务仍为 systemd `arenaofbias-server`，正式目录 `/www/wwwroot/arenaofbias-server`。
- 上线前演练：服务器隔离检出 `8c5a8eb`，语法检查与 118/118 测试通过；新包差异安装的完整树校验通过。最新线上快照 v16→v18，267 件作品、622 张票、27 用户和所有表保留；投票快照、更正、对局及既有审计逐行一致，quick_check/外键通过，全部 45 个模型 ID 可解析，3 个旧 ID 不进入下拉。
- 回滚材料与验收记录集中在服务器 `/root/arenaofbias-predeploy-20260930T042530Z`：`code.tar.gz`、`server-version`、`datapack-current`、`platform-preview.db`、`rehearsal.json`。实际切换前停写后另存 `platform.db`；部署后的 `verification.json`、`http-verification.json` 是最终验收依据，尚未生成时不得认为已上线。只回滚旧代码不兼容 v18，必须同时恢复数据库和旧包指针。
- 两项已知小问题按用户意见保留：setMeta 不接收 vendor，管理员可写入备注；兼容厂商追加后备注可略超 1000 字。详情见 `docs/archive/2026-09-30-schema-cleanup-release-wsnxxxs.md`。

## 2026-09-30 · security-review（本地审查，未修复、未部署）

- 审查代码基线 `8c5a8eb7973b2b4b9cc26a6e6d0381e1d4445ddc`。发现 4 项：P1 数据包作品 HTML 可在 API 同源执行；P1 作品请求 URL 异常可退出共享服务；P1 启用截图时缺少导航/网络边界；P2 信任 X-Forwarded-For 首项导致条件性限流绕过。详细证据、触发条件和最小修复建议见 `docs/archive/2026-09-30-security-review-wsnxxxs.md`。
- 同源 HTML 已用临时库和浏览器确认：读取管理员接口、PATCH 本人资料均 200。畸形作品请求在隔离子进程中使进程 exit=1。截图边界仅验证当前 CSP 下页面导航到另一个环回端口会产生请求，未运行实际后台截图或取得内部页面截图。限流探针：固定转发头第 11 次登录返回 429，轮换首项后 11 次均进入鉴权并返回 401。
- 既有防护复核：管理员保留名拒绝公开注册，Secure 会话使用 Host 前缀并拒绝重复 Cookie，写 API 校验 Origin，收件箱响应施加无同源权限的 CSP sandbox，上传路径/解压量有约束，SQL 参数绑定，验证码错误次数及会话撤销有覆盖。未发现这些检查路径的新越权。
- 验证：`npm run check` 56 文件 0 错；`npm test` 118/118。未连接生产、未读取现有业务库/密钥/日志，未核实线上 Nginx 转发头、静态路由、CAPTURE 或作品域名；报告不把历史部署记录当作当前线上状态。
- 本轮只更新交接与归档；浏览器证据在本地生成物 `output/audit/security-review-20260930-api-origin.png`。审查期间出现的 `datapack.json` 更新不属于本轮，保留且不纳入提交。提交授权沿用用户 initial AGENTS 的完成修改后提交要求，身份已核实为 GitHub `wsnxxxs`；不推送。
- 本轮临时服务已停止；临时目录 `C:\Users\Ryan\AppData\Local\Temp\arenaofbias-security-review-lAEFO8` 删除被自动审批以 `blocked by policy` 拒绝，保留待人工清理。

## 2026-09-30 · schema-cleanup-review（本地修订，未推送、未部署）

- 修复审阅指出的手填模型厂商丢失：未发布的 v18 在删除 vendor 前将非空手填厂商原样追加到 note，原备注不截断；新投稿和审核的兼容 vendor 声明也写入 note，同一声明不重复追加。作品 API 的 vendor 对手填模型仍为空，厂商声明可从 note 查看和导出。
- 已获授权只读连接服务器。当前代码 `338bb3f3befcf0a76293018072c00e5d8a7d8b8a`、库 v16、267 件作品，手填厂商非空 0 件；5 份备份同条件均 0 件。预升级库用 model_name 查询，不存在 model_other；未更新线上代码/数据包或迁移线上库。
- 线上作品有 24 个模型 ID 不在展示列表，其中 3 个也不在完整注册表，共影响 21 件作品。用户确认按备份原名称/厂商在 data 仓补登记 `gemini-3.5-flash-lite`、`qwen3.8-27b`、`qwen3.8-max`，均 listed:false，不猜测版本和对应关系。服务端 catalog.model 改查完整 modelPool（展示条目优先），catalog.models 仍返回展示列表。
- 最新备份 `/root/arenaofbias-predeploy-20260929T172856Z/platform.db` 下载副本迁移 v16→v18：267 件作品、599 张票和其余表保留，投票快照/更正及对局原样不变，重跑、quick_check 和外键通过。用 data 新构建核对全部 45 个已引用模型 ID 均可解析。本地原业务库仅读取，为 v13 且有 works 表，未迁移。
- 验证：server 语法检查 56 文件 0 错、完整测试 118/118；补审核备注断言后定向 30/30。data 语法检查 25 文件 0 错、收录检查 83 件 0 错/3 条既有 warning、assemble 成功。上线须先发布含这 3 个旧 ID 的数据包并更新 server pin，再迁移后端；本轮未发布/未改 pin。归档见 `docs/archive/2026-09-30-schema-cleanup-review-wsnxxxs.md`。

## 2026-09-30 · schema-cleanup（本地实现，未推送、未部署）

- 按用户第一档范围追加幂等 v18，保留 v1–v17：删除作品表 `audience`、`tool`、`vendor`、`reviewed_by`、`deleted_by` 五列及投票表 `identity_source`。`model_name` 改为 `model_other`，仅保留未登记模型手填名；登记模型不再复制名称、厂商，读取当前字典，缺项时返回模型 ID 与空厂商。
- 旧 tool 在没有 Harness ID 且「其他」为空时回填；缺失的审核/删除审计从旧列补存。审核人查最近审核 audit，审核、删除状态与审计同事务。API 保留派生的 tool/audience；只传 tool 的旧客户端归入 Harness「其他」。Show1 兼容读写与导入脚本同步适配，投票 source、原始快照、更正和对局数据包绑定不改动。
- 验证：`npm run check` 56 文件 0 错；`npm test` 117/117。覆盖 v16/v17 升 v18、重复迁移/重开、旧字段回填、操作人审计、SQLite quick_check/外键、手填模型、字典改名及历史榜单/快照稳定。未做浏览器布局验收，本轮未改页面。
- 所有库验证仅用隔离临时库；未操作既有本地业务库或生产库，数据仓无改动。上线前备份，v18 删除/改名列后不能只回滚旧代码，须恢复兼容数据库。第二档文件合并、第三档馆藏结构与提名表未做。详细归档见 `docs/archive/2026-09-30-schema-cleanup-wsnxxxs.md`。
- 本轮提交授权沿用用户 initial AGENTS 中“完成修改后用英文简单句 commit 一条”，身份为已核实 GitHub `wsnxxxs`；未获 push 或部署授权。

## 2026-09-30 · work-generation-metadata（本地实现，未推送、未部署）

- 用户授权由本轮决定适当字段范围；补作品生成信息与后台选项，用户/投票表保持现有结构。追加幂等 v17 迁移：模型版本、生成方式、人工介入、实际生成日期、公开证据链接共五列，旧行均为未注明，不回填。
- 接通投稿、管理员上传/收件箱、编辑、审核、公开视图与收录导出；审核/编辑 audit 保存新字段前后值，新对局快照保存生成信息，计分键不变。后台提供常用档位和自由文本，区分默认档位与未注明；新增模型、档位、生成方式、人工介入筛选，保留自定义档位。
- data 仓配套保留五字段至 manifest/task/README/data.json 并检查有效性及冲突。无数据包 pin 改动，无历史作品修改。用户 initial AGENTS 要求完成修改后英文简单句 commit；无需再次询问提交授权。
- 验证：`npm run check` 55 文件 0 错；`npm test` 116/116，含迁移幂等、API 更新/清空/保留、非法值拒绝、筛选、审计、导出、身份快照与旧榜单兼容。隔离临时库启动成功；Browser 打开 localhost/127.0.0.1 均被客户端 `ERR_BLOCKED_BY_CLIENT` 拦截，实际表单交互及布局未验收，不能称为已完成浏览器验证。
- 未操作现有本地业务库或生产数据库。上线前备份业务库，再使用本轮后端启动迁移至 v17；配套数据仓能力须随收录工具更新。详细归档见 `docs/archive/2026-09-30-work-generation-metadata-wsnxxxs.md`。
- 本轮临时目录 `C:\Users\Ryan\AppData\Local\Temp\arenaofbias-work-metadata-review-20260930` 删除被自动审批以 `blocked by policy` 拒绝，保留待人工清理；临时服务已停止。

## 2026-09-30 · provenance-round4（待 PR 审阅，未部署）

- 从 `origin/main@31651f3` 建立；线上已部署 `31651f3`、数据包 `e5ef61c`、数据库 v16（2026-09-30 01:00 CST，部署前备份 `/root/arenaofbias-predeploy-20260929T165446Z`）。本轮无迁移、无数据包变化。
- `GET /api/leaderboard` 新增 `harness`、`provider` 筛选（注册表 ID 或 `unset`）：两侧快照（更正优先）都满足才计入；计分键不变；带筛选时响应多 `filters`，不带筛选时代码路径、缓存键和响应与此前相同。
- `npm run check` 54 文件 0 错，`npm test` 116/116；用部署版 `31651f3` 与本分支对同一 v15 副本计算全部榜单，未筛选输出逐字节相同。详见 `docs/archive/2026-09-30-provenance-round4-wsnxxxs.md`。

## 2026-09-30 · provenance-round3-admin（已合并为 PR #11 / `31651f3`，已部署）

- 从 `origin/main@fec38c2`（含第 2 轮）建立，数据包 pin 不变（`e5ef61c`）。无数据库迁移。
- 第 2 轮两处小修：写入时 Harness/服务商 ID 传空串按「未注明」处理；更正投票的报错改为中文「Harness / 服务商」。
- 后台作品列表支持 `harness` / `provider` 筛选（注册表 ID、`other`、`unset`），搜索覆盖两者名称。管理界面在审核、编辑信息、收件箱登记三处可选登记项、其他、未注明及 Harness 版本；「其他」原文命中注册表名称或别名时提示「可能是 X」并可一键改选，不自动改写；只提交改动过的字段。注册表直接取管理页已加载的 `/data.json`，未新增接口。
- `npm run check` 54 文件 0 错；`npm test` 116/116。临时库真实浏览器验证了列表显示与筛选、审核改选、编辑清空、收件箱登记，控制台无错误；截图因浏览器面板未绘制而改用 DOM 检查。
- 上线顺序：server 第 2 轮 → 本轮 → Show2 第 3 轮（wsnxxxs/same-prompt-gallery#5，合并即发布 Pages）。详见 `docs/archive/2026-09-30-provenance-round3-admin-wsnxxxs.md`。

## 2026-09-30 · provenance-round2（已合并为 PR #9 / `fec38c2`，随 `31651f3` 部署）

- 从 `origin/main@2ae065df3fc78f08022c4a04209b5f6a608d9bb3` 建立。数据仓第 1 轮已合并并发布；本分支 pin 为产物 `e5ef61c882e11319ebe1f06ca5534cb1b4723adb`，`npm run fetch:datapack` 校验通过。线上 pin 在第 2 轮部署前仍为 `574b17e`。
- 追加幂等 v16 迁移：`works` 新增 Harness/服务商的 ID、「其他」和 Harness 版本共五列及两个部分索引；不回填。投稿、管理员审核/编辑/录入、馆藏映射、收录导出与公开视图接入新字段。`tool` 保留供旧客户端使用，不再以「管理员代传」填录入渠道。对局身份快照新增三个来源键，不改变计分 key、摘要和排行榜筛选。Show1 旧兼容端点及 Q13 两项修复未动。
- `npm run check`：54 文件、0 错；`npm test`：116/116 通过，包括 Show1 golden。指定数据包下空库升 v16，bootstrap 200；注册表 ID 与「其他」两次投稿、审核、公开输出、提名、导出成功。旧 `origin/main` 代码在 v16 库 INSERT/SELECT 成功；3 张旧格式快照票的新旧 `config`、`model` 榜单排除 `updatedAt` 后逐字节相同。
- 未提交、推送、开 PR、部署或切换线上数据包。部署顺序：已发布的第 1 轮数据包 → 本轮后端 → 第 3 轮前端。只回滚代码即可继续使用 v16 库；部署核对与线上库副本的榜单复核步骤见 `docs/archive/2026-09-30-provenance-round2-wsnxxxs.md`。提交前需用户决定是否提交及 GitHub 身份。

## 2026-09-29 · fix-round3（待 PR 审阅，未部署）

- 从 `origin/main@0b512bd` 建立。S-03 在 `COOKIE_SECURE=1` 时使用 `__Host-sp_session`，拒绝重名会话 Cookie；未启用 Secure 的本地环境仍用 `sp_session`。上线将使全部现有用户登出一次。用户作品迁往独立可注册主域仍是运维待办。
- C-02 配对先按配置对抽样，再从选中配置对内均匀抽作品；登录和注册改异步 scrypt。排行条目不超过 200 时在主线程求解，超过 200 时交给 worker；同一缓存键的并发请求共用计算 Promise。40 配置冷榜单复测为 102.24、101.91、127.81 ms；1000 配置求解期间主线程定时器延迟为 47.20 ms。完整探针数字在本地 `output/audit/round3.md`，不入库。
- R09 猜模型成绩按同日 IP 或用户去重，首条保留，另有每 IP 限流；追加幂等 v15 迁移，保留全部历史行并将较晚的重复记录标为 `superseded=1`，部分唯一索引仅约束有效记录。该接口仍是客户端自报数据。R08 每日答案可从前端推导，是娱乐玩法的已知设计边界。
- DP-08 核实当前备份脚本先做数据库快照再备份文件，恢复多余作品目录会在启动时移入 `.data/orphans`，结论“已缓解”，无代码修改。R05 契约已补 Show1 兼容层与版本判读；README 明确 `CAPTURE=0` 截图队列不工作。新增 `docs/deploy.md` 和差异包脚本，部署、合并均未执行。

## 2026-09-29 · Show1 模态判色修复（已部署）

- 用户确认“模态完全相同就变绿”，替代多模态恒黄规则。`server/show1/guess-logic.mjs` 按完整集合比较，忽略顺序和重复；不同模型同为「图」也是绿。不同多模态集合仍黄，一纯文本一多模态仍灰，胜负仍按模型身份。
- 本轮从 `main@0b512bd` 建立 `codex/guess-modality-match`，与 VPS 98 份已跟踪文件逐份核对一致（忽略部署换行差异）。前端仓库同步修复基于 `arenaofbias/main@d871c75`；旧站 PM2 已停用，当前服务为 systemd `arenaofbias-server`，不走旧 Show1 的 deploy:vps。
- 复现：截图中的 GPT-4.1 / Claude Opus 5 / Claude Fable 5 对 Claude Opus 4.6 都被旧逻辑错误判 near。新增回归先红后绿；覆盖全部模型自己猜自己、同模态不同模型、顺序/重复、不同集合，以及每日/练习真实 HTTP 端点。
- `npm run check`：49 文件 0 错；`npm test`：105/105 通过。无依赖、数据库迁移或数据包变更。用户本轮已要求修复本地、GitHub 与 VPS。
- 已部署 systemd `arenaofbias-server`，公网 API 和桌面/390px 页面通过；同「图」的四个截图模型均绿、图+视仍黄、纯文本仍灰、猜中目标全绿。真实练习局不写每日战绩；前端无需重建。
- 备份 `/www/wwwroot/arenaofbias-server-backups/modality-20260929T125932Z`；数据库 v14、quick_check=ok。26 用户/267 作品/599 票/16 评论/56 评价/4 猜题记录逐行无变化。完整记录见 `docs/archive/2026-09-29-modality-match-Atmeplz.md`。上文版本核对优先于下方各历史分支的部署状态。
- GitHub 上游拒绝 Atmeplz 直接推送（403，仓库权限 push=false），因此本轮通过个人 fork 的 `codex/guess-modality-match` 提交 PR，待仓库管理员合并。VPS 已运行该修复；后续部署须保留此补丁，不能以尚未合并的上游 main 覆盖。

## 2026-09-29 · fix-round2（待 PR 审阅，未部署）

- SH-01 后台重置邮件纳入关停等待，与 HTTP 请求共用进程级 10 秒上限；R01 将已核验且 `show_arena=1` 的新投稿增量并入 Show1 `/api/works` 与兼容投票清单；R07 追加投票权重迁移，旧 live 票按先前最近的竞技场 editorial audit 还原，否则用原题权重，今后投票即保存权重。
- DP-07 自动接管要求提名、题目及导出源 digest 一致，不符只记 `curate-reject` 审计。依赖数据仓 PR #1 的 `sourceDigest`。C-08 Windows junction 切换失败恢复旧链接；DP-03 激活成功后才原子写 pin；DP-04 新数据库快照成功生成后才替换旧 staging 文件。
- data PR #1 合并后 `datapack/f0b466a14bc3c16d578d8ac76f9287fa57f4283d` 发布产物 `574b17e006ef2955b8b4a267192828e2aa63d7f8`；本分支 pin 已更新。datapack-client 下载、校验、隔离目录激活通过；`npm run check` 47 文件 0 错，`npm test` 104/104。`output/audit/round2.md` 与 `output/audit/beta-repair.md` 仅保留本地，不入库。当前本地数据库 v13 无 Show1 live 票，生产回填数量待部署时统计。未部署、不合并、不推 main；须与画廊 PR #3 同时部署。

## 2026-09-29 · share-v2（待 PR 审阅，未部署）

- 从 `origin/main@360ec7a` 建立，已 rebase 到 `origin/main@2dfd952`（含 fix-round1）。删除 Show1 兼容层四条分享 501 占位路由；Show1 与 Show2 前端已确认不再调用。无 npm 依赖、无数据库迁移。
- 找回密码发码在完成 Turnstile 校验后立即返回统一响应，真实 SMTP 在后台执行；失败只记日志。测试让 SMTP 暂缓确认，验证绑定邮箱的响应先于发信完成。
- `npm run check && npm test` 通过（rebase 后 96/96）。配套 Show1 `share-v2` PR 应先于本 PR 的路由删除部署，以免仍在运行的旧前端收到 404；本轮不合并、不部署。

## 2026-09-29 · fix-round1（待 PR 审阅，未部署）

- 从 `origin/main@9c32bb9` 建立。修复审计 S-01、S-02、C-01、C-03、C-04、C-05、C-06、DP-01、DP-06 服务端部分；无 npm 依赖、无数据库迁移、未改动已有数据。
- 保留管理员名公开注册统一 409；新增 `npm run admin -- --create <用户名>`，密码从标准输入读取。收件箱预览加 CSP sandbox 和 nosniff；投稿封面先暂存，作品与审计同事务，启动隔离孤立目录；静态文件流处理错误；关停最多等待 10 秒；JSON 只收对象；校准和自动接管失效排行榜；导出按令牌每分钟 2000 次，IP 兜底 10000 次。
- 审计基线与修复后探针、真实浏览器预览验证完成；`npm run check && npm test`：44 文件语法检查、96/96 测试通过。分享卡 PR #4 只读补审见 `output/audit/share-review.md`。本轮未部署、未合并。
- 生产仍运行 `origin/main@9c32bb9`。上线前确认生产 `ADMIN_USERNAMES` 对应账号由可信人员持有；本轮没有迁移。先审阅本 PR 与数据仓 `curate-v2` PR，再决定部署顺序；server `share-v2` 的后台 SMTP 与关停语义交叉见 SH-01。

## 2026-09-29 · email-auth-v2（待 PR 审阅，未部署）

- 本分支从 `origin/main@6872c8d` 建立。追加 v13 幂等迁移：用户可空邮箱与验证时间、大小写不敏感唯一索引、只存哈希的验证码表；没有改写存量迁移或数据。
- 恢复零依赖 SMTP 和 Turnstile；注册只需账号密码，启用 Turnstile 时注册提交与邮箱发码均校验 token。登录后可绑定/换绑邮箱；绑定邮箱可重置密码并清除该用户全部会话。重置发码响应统一，不透露账号/邮箱状态。Show1 旧分享卡 501 保持不变。
- 验证：`npm run check` 通过；`npm test` 最终数量见本轮归档；本地 Show1 Vite 代理 + 共享后端 + 假 SMTP 完成注册、绑定、找回、重新登录联调。部署前配置 `SMTP_*`，生产开启 Turnstile 时再配置两把 `TURNSTILE_*`；先部署本 PR，再部署 Show1 PR。未部署、未合并。


## 2026-09-29 · curate-v2 审阅修订

- 在 `curate-v2` 追加修订：catalog 切换后的接管通过 `setImmediate` 执行，成功 revision 只处理一次，失败记日志并在下次 refresh 重试，避免请求内事务嵌套；导出单文件不再重算全量文件哈希；接管时继承投稿的展览馆与竞技场开关，已有馆藏 override 保持原样。
- 验证：`npm run check` 38 文件 0 错；`npm test` 81/81 通过。新增回归覆盖在批量设置事务中切换数据包、异步接管和开关继承。详见 `docs/archive/2026-09-29-curate-v2-review-wsnxxxs.md`。

## 2026-09-29 · curate-v2

- 本分支从 `origin/cleanup-round1` 建立，依赖尚未合并的 PR #1。共享生产后端仍为 `22271ea`；本轮不部署。数据仓库配套分支为 `curate-v2`。
- 移除请求内 Git 收录，改为管理员提名与可撤回的 14 天导出令牌。数据库迁移 v12 只增加四个可空字段；旧的 `curated_as` 保留。数据包结果带 `sourceUpload` 时，catalog 版本变化触发一次幂等接管。
- 远端 `git ls-remote origin "refs/heads/intake/*"` 返回空，未发现旧按钮推送的远端 intake 分支。
- 验证：`npm run check` 38 文件 0 错；`npm test` 80/80 通过。本地跨仓演练从投稿、审核、提名、收录、构建到自动接管成功；演练 intake 分支及临时数据库已删除。详见 `docs/archive/2026-09-29-curate-v2-wsnxxxs.md`。

> 接手先读 `AGENTS.md`；接口与运行方式见 `README.md`、`docs/api-contract.md`，轮次过程见 `docs/archive/`。

## 当前基线（2026-09-29）

- 当前工作分支 `cleanup-round1` 已 rebase 到 `origin/main@22271ea`；本轮改动已获用户审阅通过，合并和部署由 kme7kme7-prog 决定。main 基线包含 `9bd44a5` 分面审核、`94e7d89` 公共后台、`75ba480` 馆藏参与分面审核、`2fffe04` 迁移 v10、`6ef99df` 迁移 v11，以及 `22271ea` 将 Show1 golden 文件纳入仓库。
- **共享后端已经在生产环境运行，当前部署版本为 `22271ea`，已通过线上 `/api/bootstrap` 的 `serverVersion` 确认。** `arenaofbias.icu/api` 和 `api.arenaofbias.icu` 由本服务提供。生产数据库迁移版本和数据包版本尚未核实。
- 本服务是 Show1 与 Show2 的唯一动态 API 和数据库写入者，零 npm 依赖（Node ≥ 22.13）。本轮未新增数据库迁移；当前代码的迁移序列到 v11。馆藏数据包本地 pin 为产物提交 `92f8ab99e3ca7835521a439b850d36dff2858878`，`.datapack/current` 已指向该版本；这不代表生产数据包状态。

## 本轮改动

- Show1 golden 文件由上游 `22271ea` 纳入 `test/fixtures/show1-golden/`；两个相关测试文件采用上游版本，照常比对仓库内 fixture。
- 后台作品表支持本页多选，并在当前展览馆或竞技场视图批量开关。新增管理员 API，每批 1–200 件，复用单件设置逻辑；整批同一事务，逐件写 `face-settings` audit，失败回滚。
- 馆藏版本请求头不一致时继续处理请求，响应增加 `X-Datapack-Stale: 1`；可信来源通过 CORS 的 `Access-Control-Expose-Headers` 可读取该提示；对局仍绑定服务端快照。画廊前端仍会在 bootstrap 阶段独立检查数据包版本并暂停不匹配的动态功能；Show1 未查到该错误码或请求头处理。
- 畸形 Cookie 被跳过；畸形路由参数编码返回 400。`docs/api-contract.md` 已补管理员收件箱、meta、curate、猜模型接口，并按代码修正相关默认开关描述。

## 验证与待确认

- 原轮每项完成后均运行 `npm run check && npm test`；rebase 到 `22271ea` 并补 CORS 暴露头后完整复验通过：语法检查 38 文件、0 错误；测试 79 项、79 通过、0 失败、0 跳过。Show1 golden 用例已使用仓库内 fixture 正常比对。
- 未做后台页面的真实浏览器交互验收，也未在生产环境运行本分支。部署前先确认生产数据库版本和数据包版本，备份运行数据，再核对画廊独立版本门禁对上线顺序的影响。
- 数据库结构只允许在 `server/db.mjs` 的 `MIGRATIONS` 末尾追加幂等迁移。`.data/`、`dist/`、`.datapack/`、`node_modules/` 和日志为本地数据或生成物，不入库、不手改。

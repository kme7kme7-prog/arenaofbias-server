# HANDOFF.md · 当前状态

## 本轮：服务商仅官方 / 非官方（2026-10-01 Brisbane，已本地提交，未推送、未部署）

- 用户本轮要求服务商统一为 `official`（官方）/ `unofficial`（非官方），未填为 null；Harness 不变。后端固定两项 providers 并在 bootstrap 返回，上传、作者 PATCH、管理员审核仅接受这两个 ID 或 null/空串，其余 400。上传/审核忽略旧自由文本字段，PATCH/meta 按未知字段规则拒绝；公开、我的作品和审核列表不再输出 `providerName`。后台选项、筛选与表单已同步，手填与相似名称提示仅为 Harness 保留。
- MIGRATIONS 末尾追加 v25：`official` 保留，其他非空旧 ID 或手填名称归为 `unofficial`，未填保持 null，清空 `provider_other`；可重复执行。旧数据包和旧投票快照读取时同样归类，不重写原票快照。榜单支持 `provider=official|unofficial|unset`，filters 回显与两侧都符合才计票规则保持。
- 本地 Node 24.16.0：check 73 文件/0 错，全量 test 175/175（无失败/取消/跳过），来源定向测试 7/7（补充实际 `/api/me` 输出后再通过），diff --check 通过；后台语法与内存表单函数验证通过。首轮定向测试发现两处新夹具/断言问题（v24 已移除 model_name，作者 PATCH 新增 meta 审计），修正后通过。邮箱幂等测试固定检查 v24，避免追加迁移后误测 v25。
- 数据仓同步本地提交 `0f68eca`，实际源码 182 件：77 官方/1 非官方/104 未填；check 30/0、test 16/16、intake 182 件/0 错/9 既有提示、完整 build:data 通过。后端直接读取其开发构建包，核对 20 题、两项 providers 和作品分类数量通过；未切换后端本地包或消费者 pin，生成物未提交。
- 已用 GitHub `/user` 核对负责人 wsnxxxs，按用户本轮授权每仓一条英文简单句提交，未推送、部署或操作生产库。上线须先部署后端并完成 v25 迁移，再启用 Gallery 二值提交与排行榜筛选；新版数据包按不可变发布流程另行更新 pin。未做生产 Node 22、真实 Gallery 浏览器联调、后台视觉或外部审核/截图服务验收；本轮元数据修改按 API 集成与函数测试验证。完整归档：[provider-binary](docs/archive/2026-10-01-provider-binary-wsnxxxs.md)。

## 整理收尾（2026-10-01 Brisbane，已推送，不部署）

- 四仓 main 均已完成源码推送；后端 `99311dc` 已在 origin/main，GitHub 的 Node 22 check / test CI 成功。画廊对当前 182 件本地数据包和后端的真实隔离 integration smoke 也通过。本轮没有部署、生产写入或 pin 升级；下面“待推送”是整理过程记录。
- 已删除干净且合入 main 的 shared-question-intake 后端工作树与同名本地分支。luna-flex-moderation 和 show1-vote-processing 的工作树、依赖链接及分支保留：自动审批拒绝依赖目录链接删除，理由为 `blocked by policy`，没有改用其他删除机制。
- 两处历史 output 已归档到主目录忽略的 `output/repository-housekeeping-20261001/`：luna 37 文件 / 2751142 字节，vote 2620 文件 / 159813720 字节，全部逐文件 SHA-256 一致。归档排除并记录三处依赖 junction，依赖目标与主目录业务数据保留。

## 本轮：四仓整理中的后端分支核对（2026-10-01 Brisbane，本地完成，待统一推送，不部署）

- 用户授权本轮合并、提交、推送和保留有效工作后的目录清理，明确不部署。后端主工作区与三个旧 worktree 均无待提交源码；fetch 后 `origin/main` 为 `e81cb4e`，main 另有注册邮箱绑定提交 `55e3288` 待推送。既有提交作者保持原样，本轮身份经 GitHub `/user` 核对为 wsnxxxs。
- `codex/luna-flex-moderation@2ead072`、`show1-vote-processing@4f00ac3` 已完整进入 main。`codex/shared-question-intake@7d87557` 仅有旧文档补记，有效内容已在 main 的对应归档保留；本轮以 ours 合并登记其祖先关系，保留较新的现状文档，不改变实现。
- 当前验证：Windows Node 24.16.0，`npm run check` 73 文件 / 0 错，`npm test` 173/173（0 失败/取消/跳过），`git diff --check` 通过。仓库只有 `.github/workflows/check.yml`，main push 只触发 Node 22 检查与测试，不触发部署；本轮未运行 Node 22、生产、邮件、Turnstile 或前端联调。
- worktree 清理候选：上述三个旧 worktree 的代码均可从 main 恢复。luna 的 `output/`（37 文件，2751142 字节）与 vote 的 `output/`（2620 文件，159813720 字节）含历史验收、隔离库及发布证据，删除 checkout 前须另行保留；luna 的 `node_modules` 是指向 Desktop/same-prompt-gallery/node_modules 的 junction，不能递归删除其目标。intake 无忽略文件。
- 主目录 `.data/`（含 SQLite/WAL、作品与媒体）、`.datapack/` 和 `output/` 保留；当前数据包指针仍为旧 `92f8ab9`，本轮不更新 pin 或本地包。统一推送与实际目录清理由主会话完成，本文不宣称已经推送或清理。归档：[repository-housekeeping](docs/archive/2026-10-01-repository-housekeeping-wsnxxxs.md)。

## 本轮：注册强制绑定邮箱（2026-10-01 Brisbane，已本地提交，未推送、未部署）

- 按 Gallery `register-email-binding` 契约实现匿名 `purpose: register` 发码、邮箱格式 / 占用校验、原 Turnstile 与 IP / 邮箱限流、注册验证邮件。注册必填 email/code，不再要求 Turnstile token；保留注册 auth 限流。异步密码哈希后校验 register 验证码，在同一事务消费验证码、创建用户并写入 email/email_verified_at，插入失败保留验证码可重试。bind/reset 行为保留。
- v24 仅在 MIGRATIONS 末尾追加幂等迁移，扩展 email_codes 的 CHECK 以接受 register，保留原验证码数据、主键与过期索引。bootstrap.user 增加 emailBound，仅当前会话可见，auth.public 不变。
- 旧无邮箱账号发起题目、上传、草稿 POST/GET/DELETE、Gallery 与 Show1 表情回应均 403 email_required「请先绑定邮箱」。Gallery 双盲仍揭晓，200 counted:false/reason:unbound，不写票；创建对局 counted:false。用户另行确认 Show1 兼容 /api/votes 也限制：有效未绑定请求返回同样 200 不计票响应，不写对局/票；已绑定请求保留 201 {vote}。
- 测试可注入 createPlatform 的 mailer（ready/send）并捕获 to/code/purpose；辅助函数 test/helpers/email.mjs。生产默认 SMTP，HTTP 不暴露验证码或新增读取接口。前端 integration-smoke 与外部审计脚本须先 send 再 register，使用隔离 mailer 或测试 SMTP；本轮未修改前端仓。
- 验证：Windows Node 24.16.0，npm run check 73/0，最终 npm test 173/173（无失败/取消/跳过），git diff --check 通过。首轮全量 171/173：遗漏 admin voter 邮箱夹具、平台新增读取用例触发默认 catalog 桶，补齐夹具并仅提高生命周期测试的 catalog 配置后全过；生产限流不变。预期邮件/数据库故障注入日志是断言内的测试结果。
- 用户明确范围为后端本地提交；使用 wsnxxxs 的 GitHub noreply 身份、英文简单句，一轮一条。未推送、部署、操作生产库、运行 Node 22 / 真实邮件与 Turnstile / 前端联调。上线需同时准备 Gallery 和 Show1 注册表单、Show1 未计票响应处理与 smoke 脚本。归档：[register-email-binding](docs/archive/2026-10-01-register-email-binding-wsnxxxs.md)。

## 本轮：题目分类与文本投稿（2026-10-01 Brisbane，已本地提交，未推送、未部署）

- 与 Gallery 联调后补充：文本投稿不再生成「说明文件 / README」检查项（`server/inspect.mjs`），`test/text.test.mjs` 加断言；check 72/0、test 167/167。隔离联调（临时库、CAPTURE=0、内容审核关闭）走通文学题 + 文本示例、建模题、审核改分类与审计、按分类推断格式，详见 Gallery 归档 question-categories-2。
- 后端追加 v23 幂等迁移 `questions.category`：旧题优先从标签回填分类，否则仅 text 格式回填文学，其余保持 null。新建题必填文学 / 静态网页 / 建模，格式按分类校验，标签选填 0–6 个，写入时丢弃同分类标签。公开、作者和管理员题目视图均返回 category / templates。
- 人工通过时可补充或修改分类，缺分类拒绝通过；拒绝时忽略 category。改分类与原格式不兼容时重置默认格式，并在 question-review 审计记录旧值与新值。平台题目通过现有 catalog 分类筛选加入对应榜单；数据包缺少非空 templates 时按分类推断。
- `template=text` 支持单个 UTF-8 `.txt` / `.md` / `.markdown`，沿用 uploadBytes 并限制 200000 Unicode 字符。安全 Markdown 子集生成自包含 index.html，原 HTML 转义、无外链图片或脚本；纯文本保留段落换行，原件保存为 original.<扩展名>。沿用草稿探针、内容审核、截图与核验；无新增 npm 依赖。
- 验证：Windows Node 24.16.0，check 72 文件 / 0 错、最终全量 test 167/167、git diff --check 通过。覆盖迁移、分类/格式/标签校验、审核与审计/格式重置、各题目 DTO、文学建题和投稿/预览原件、ZIP 与非法 UTF-8 拒绝、安全转义、数据包格式推断和平台文学作品进入分榜。未运行生产 Node 22、浏览器视觉验收、真实内容审核或截图服务。
- 数据仓由指定 GPT-6.1 Sol medium 子代理完成 15 道题重复分类 tags 清空，其余 5 道内容标签保留；无需修改空数组校验。check 28/0、test 16/16、intake 121 件 / 0 错 / 4 既有提示、完整构建 20 题 / 121 件通过。data 本地提交 `a2f8f95`，未推送或更新消费者 pin；后端本地数据包未变。
- 前端未修改。上线应配合 Gallery 已完成的分类契约；数据包仍按不可变版本发布，消费者更新 pin / 切换发布目录后 catalog 自动观察新的 realpath 与版本。归档：[question-category-text](docs/archive/2026-10-01-question-category-text-wsnxxxs.md)。

## 本轮：示例作品选填与上传忽略目录（2026-10-01 Brisbane，已本地提交，未推送、未部署）

- 社区建题的示例作品改为选填：`POST /api/questions` 完全不带 `draftId`、`work`、`confirmed` 时只建题，返回 `{ question }`；仍为 pending、人工审核、每人最多 3 道。带任一作品字段时沿用原路径。后台空 samples 已有空态，无需修改。
- ZIP 中 `node_modules`、`.git`、`.svn`、`.hg` 改为跳过（不解压、不存储、不计入限制），检查项 `ignored`（标签「依赖目录」）提示数量；密钥文件仍拒绝；30 MB 上限不变。无迁移、无新依赖。
- 提交：`5f2320c`（实现、测试、文档），联调后另一条提交将检查项标签由「已忽略」改为「依赖目录」并写归档。check 69/0、test 159/159、`git diff --check` 通过。
- 本地联调（隔离库、CAPTURE=0、CONTENT_MODERATION 关闭，后端 `DIST_DIR` 指向 Gallery 的固定包 `39a2fa4`）：无示例建题、附示例建题、带 node_modules/.git 的 Vite ZIP、`.env` 拒绝、我的题目、后台题目审核均通过；被忽略文件未落盘。未做真实 Luna/截图、生产 Node 22、移动端或部署。
- 上线须与 Gallery `f06dbf3` 及其后续修复一起发布：旧后端会拒绝无作品建题。本地 `.datapack/current` 仍指向旧包 `92f8ab9`，本地起服务前需 `npm run fetch:datapack` 或设 `DIST_DIR`。归档：[question-sample-optional](docs/archive/2026-10-01-question-sample-optional-wsnxxxs.md)。以下已发布记录描述现网版本。

## 四仓统一发布完成（2026-10-01 Brisbane）

- 用户已确认四个仓库同属本轮，授权提交、推送、部署 Show1、Gallery、共享后端和新增 38 件作品；此前将 Show1 / 新数据排除的发布范围已撤回。下面早期归档中的两仓范围仅为当时状态。
- 现场于 2026-09-30T17:19:05Z（Brisbane 2026-10-01 03:19:05）切换：后端 `566782e54a403c79a5ca4257a34a4beb6caa8d54`、Gallery `a68c94cb4c050202f240a64a9b3e5c69d0025d6e`、Show1 `79266513b295fb6ce8892f0afd08fbd32f61ab09`。功能与此前本地提交均已推送 main；Show1 上游与 fork 同步。后续文档提交不代表重新部署。
- 用户随后确认将并行会话首页精简一并推送、补充部署：2026-09-30T17:40:14Z（Brisbane 03:40:14），Gallery 当前源码更新为 `4717910e115413941586f170e808a32a05c1d258`，只替换 4 文件 / 0 删除，1555 文件完整校验通过；内容 pin、后端和 Show1 不变。干净源码 check 41 / 0、test 14/14、npm ci / build / intake 通过，公网精简文案与 121 件统计正确，桌面无横向溢出、console error 0。
- 数据源码 `638937a58d6aec02644106d76e2b84d51fbf9fe9` 已合并 PR #5，CI 36731686651 成功；实际消费不可变产物 `39a2fa43b25488b09069644fdcd6df50adc06dc0`，schema 1、sourceDirty false、20 题 / 121 件。后端与 Gallery pin、catalogDigest 一致；Show1 公开 25 题（20 共用 + 5 历史）。数据完整树及 Gallery 1555 文件、Show1 802 文件逐项 SHA-256 / 精确文件集合核验通过，旧版本保留。
- 后端本地与 VPS Node 22.23.2 均 check 69 文件 / 0 错、test 154/154；Gallery check 41 / 0、test 14/14、干净源码 build 121 件 / 55 个 site 文件；数据 check 28 / 0、test 16/16、intake 121 件 / 0 错 / 4 已知提示。Show1 干净源码 typecheck / lint / build 通过，但 npm ci 因锁文件缺两个 @emnapi 可选依赖失败，使用已验证 checkout 的 node_modules 构建，未修改依赖；此例外未隐瞒。
- 备份目录 `/root/arenaofbias-question-review-release-20260930T171825Z/`：部署前一致性 v19 `platform.db`、旧代码 `code.tar.gz`、版本/pin 记录，以及清理前 v22 `platform-before-question-delete-v22.db`；两份快照 integrity_check 均 ok。2026-09-30T17:19:52.309Z，执行人 wsnxxxs 逐题核对 kme7 的四道指定测试题零作品 / 零票后，以管理员 kme7 的短期会话通过 DELETE API 全部软删除，四条 question-delete 审计完整，会话随后撤销。结果见同目录 `question-cleanup.json`、`verification.json`。
- 生产库 v22，原始计数保留：users 27、works 267、votes 0、matches 1、comments 16、reactions 56；questions 4 条均软删除。公开 bootstrap、作者与管理员列表均不再返回四道题。服务 active，Nginx 配置检查通过，未改环境或 Nginx；CAPTURE=1、CONTENT_MODERATION=1 保留。
- 公网首页、Gallery 新作品预览、Show1 条款/隐私 375px 直达验收通过，console error 0。Gallery viewport override 未生效，本轮未完成窄屏验收；未做生产注册/投稿、真实 Luna/capture、新增 38 件完整交互或真机验证。详细版本、备份、回滚与边界见 [四仓发布归档](docs/archive/2026-10-01-four-repository-release-wsnxxxs.md)。Gallery 过时 PR #1 不合并，关闭/删分支仍待确认；占用中的本地 worktree 保留。

接手先读 [AGENTS.md](AGENTS.md)。运行与仓库边界见 [README](README.md)，接口见 [API 契约](docs/api-contract.md)，发布与回滚见 [部署文档](docs/deploy.md)。本页只保留当前状态、后续事项与历史入口；归档中的“未推送/未部署/待审阅”是各轮结束时的状态，不是当前待办。

## 发布前实现与验证记录（历史，已由顶部发布结果覆盖）

- 最初两仓发布范围后来扩展为四仓和最新作品，提交、推送、部署及四题清理均已完成，见顶部。
- 后端题目审核实现已完成，Gallery 未公开题作品标题修复已完成；两仓 API 契约完全一致。既有本地提交的头像、题型榜单、投稿流程等待与本轮一起发布；下文旧轮标题里的发布状态仅描述当轮结束时。
- 最新门禁：check 69 文件、0 错；全量 test 154/154。门禁前一轮为 153/154，既有 moderation mock 期望 rejected、实际 review；单独 moderation 6/6 和再次全量均通过，记录为间歇失败，未声称已消除原因。
- 用户以同一静态 ZIP（dist 旁有 README）实测建题成功，状态 pending；本地服务已停止。Show1 配套改动和最新 121 件作品包随后纳入统一发布。
- 本轮归档：[question-review](docs/archive/2026-10-01-question-review-wsnxxxs.md)。
## 已发布：社区题目附示例结果与人工审核（2026-10-01）

- v22 仅在 `server/db.mjs` 迁移末尾追加幂等迁移：`questions.moderation` 默认 legacy、`deleted_at` 可空。旧题仍公开，新题始终 pending（含 at），只走人工审核；每个作者最多 3 道 pending。公开 catalog、bootstrap、作品源、榜单和盲评同时受题目状态约束；作者与管理员可读取未公开题目及私有作品预览，删除题目从各列表与个人题目活动读取排除。
- `__new__` 草稿支持 static / vite 上传、自动推断和本人最新草稿恢复；禁止通过 `/api/works` 提交。`POST /api/questions` 必须带 `draftId`、`confirmed`、`work`，复用 library.submit 全部作品校验与限额，在同一事务创建题目、unverified 示例作品及两条审计。提交格式须符合题目 templates；数据库、封面文件步骤失败时整体回滚并还原草稿。成功返回作者 question/work 视图。示例作品依原 CONTENT_MODERATION 配置排队审核与截图，异常转人工，不将题目送 Luna。
- 新增 `GET /api/admin/questions`（题目 DTO + moderation / ownerName / works 数量 / 作者 samples），`POST /api/questions/:id/moderation`（人工 approved / rejected，拒绝理由必填，最多 500 字），`DELETE /api/questions/:id`（按作者/管理员、公开状态、他人作品与投票限制软删除并逐作品审计）。题目通过不改变作品内容审核或核验状态；bootstrap.review 添加 questions，保留 unverified 的原计数口径。所有新增写接口沿用 Origin、登录与 write 桶；草稿写接口也纳入 write 桶。没有增加 retry 接口。
- `admin/admin.js`、`admin/admin.css` 增加题目审核标签：pending 最早优先、详情/提示词展开、作者示例预览、通过/拒绝/删除确认、待审数与三种 question 审计 action。README 路由表和 `docs/api-contract.md` 同步 v22。接口字段、路径、取值与 Gallery 提供的契约一致，无需前端调整。
- 文件：上述后台与文档，以及 `server/app.mjs`、`server/catalog.mjs`、`server/db.mjs`、`server/library.mjs`、`server/profile.mjs`、`server/questions.mjs`；新增 `test/questions.test.mjs`，更新 `test/platform.test.mjs` 建题流程和 `test/datapack.test.mjs` 旧库夹具。作品整行快照未受题目新列影响；新迁移用例核对旧题字段保留、legacy 默认与重复执行。零依赖。
- 验证：`npm run check` 69 文件、0 错；最终全量 `npm test` 153/153，0 失败/取消/跳过；`git diff --check` 通过。新增 6 项用例覆盖草稿限制、人工可见性与 private p 预览、内容审核与题目审核互不替代、额度、删除权限/连带删除/两站投票、注入 INSERT 失败后的题目/作品/审计整体回滚和草稿文件保留。验证期间补齐旧 auth/datapack 夹具缺少的 questions 表，并将旧建题夹具改为携带示例、经人工通过；最后补强标题校验用例时，只有 title 标签的 HTML 被入口检查拒绝，补充 h1 后最终全过。预期故障注入会输出 sample insert failed，不是未解决错误。
- 格式判定跟进修复（2026-10-01）：`server/library.mjs` 将 createDraft 判定的格式保存到现有 `checks` 的 format 检查项（template 字段），建题 submit 复用该值；旧草稿缺少该值时用 package.json 与 root 同时存在才判为 vite。避免将仅有 dist 入口的 static ZIP 误判，也保留显式 static 选择，无新增迁移。`test/platform.test.mjs` 新增一项回归覆盖 dist/index.html + README 的显式 static / 自动推断，以及带 package.json 的显式 static，验证预览、建题成功及 unverified 示例。最新 `npm run check` 69 文件/0 错；全量 `npm test` 154/154，0 失败/取消/跳过；`git diff --check` 通过。只改 library、平台测试与本页；未提交、推送或部署。
- 本地隔离库后台浏览器验证：登录、题目详情与提示词展开、pending 示例私有预览、拒绝必填理由、拒绝/通过后状态与计数更新、删除二次确认并取消、question-create / question-review 日志；console error 0。截图在忽略目录 `output/question-review-browser.png`，临时服务已停止。未完成 Gallery 真实前端联调（本轮未启动 Gallery）、真实 Luna 外部调用或真实截图服务验证（本轮隔离配置无 API 密钥、capture 关闭，自动审核由本地测试桩/无密钥转人工验证）；未覆盖后台移动端。删除执行与 question-delete 日志由 API 集成测试验证，浏览器只验证确认框。
- 生产清理已完成：`q-9becba326438d52c`、`q-9c39b8642a46c310`、`q-82a12216062f8541`、`q-fa132f1b3b3bfa93`，逐题结果和备份位置见顶部及四仓发布归档。实现阶段的未提交状态仅为历史；本轮提交使用 wsnxxxs 的 GitHub noreply 身份与英文简单句。

## 历史轮次：已提交投稿流程对齐（2026-10-01，44df198，未推送、未部署）

- 迁移 v21 追加 `works.prompt_variant`（默认空串）。`POST /api/works` 接收 `promptVariant`：题目有 `promptVariants` 时普通用户必填、须为其中 ID，管理员可空；管理员上传查询参数同样接受。作品视图非空时输出 `promptVariant`。
- 新增 `GET /api/drafts?task=`（本人该题最新未过期草稿）与 `PATCH /api/works/:task/:id`（作者在 `unverified` 时修改信息，已核验 / 存疑 409）。`setMeta` 增加 `{ author }` 选项区分作者与管理员路径，允许的字段加入 `note`、`vendor`、`promptVariant`；作者路径仍要求 Harness。PATCH 路由注册在 `/api/works/:id/calibration` 之后，避免同形路径被抢先匹配。API 契约、README 路由表已同步。
- 测试：`test/platform.test.mjs` 夹具加一道双版本题目与一条新用例；`schema-cleanup` 的整行快照补 `prompt_variant`。check 68 文件 0 错，全量 test 147/147。
- 联调：本地隔离库 + `CONTENT_MODERATION=1`、`CAPTURE=0`（无密钥，自动审查转 review），配合 Gallery 同名改动走完恢复草稿、版本选择、字段校验、提交、我的作品审核状态、作者编辑，管理员人工通过后长短两份投稿合为一张卡片并可切换。Gallery 同名改动需一起发布。

## 历史轮次：已提交排行榜按题型分榜（2026-10-01，8efaccc，未推送、未部署）

- `GET /api/leaderboard` 新增 `category=<数据包题目 category>`（与 `task` 互斥，无效为 400 invalid_query），只统计该题型题目的票与作品池；响应回显 `category`。无 task/category 的综合榜多 `standings: { [题型]: { [key]: 名次 } }`，按同一单位与来源筛选分别计算、各自缓存。社区题目无题型，只进综合榜。改动在 `server/arena.mjs`、`server/app.mjs` 路由、`test/platform.test.mjs` 一条新用例，API 契约与 README 已同步。Gallery 同名改动消费这些字段，需一起发布。
- 验证：check 68 文件 0 错；全量 test 146/146（首次一轮出现 1 个失败，未能复现，随后连续 3 轮全过）。本地用 Gallery 缓存的正式 pin `4c926d5` 与临时库起服务，CLI 建管理员、开 82 件馆藏进盲评、6 个测试账号投 234 票，核对综合 / 建模 / 单题 / 非法参数与 Gallery 页面。未部署。

## 历史轮次：已提交头像库（2026-09-30，7435d06，未推送、未部署）

- 工作区改动：`users.avatar` 以 v20 幂等迁移追加（`server/db.mjs` 末尾）；头像 id 白名单 `AVATARS` 在 `server/config.mjs`，经 bootstrap `site.avatars` 下发，图片由各前端自带。未选头像的账号按用户 id 的 FNV-1a 在前 16 个里取默认值（`avatarOf`，`server/auth.mjs`）；前 16 个的顺序不能改，新头像只追加。
- 接口：`auth.public` 增加 `avatar`（Show1 兼容用户同样带上）；`PATCH /api/me` 可单独提交 `avatar` 或 `nickname`，两者都不带仍要求昵称；社区题目 DTO 增加 `ownerAvatar`。评论作者暂未带头像，Show1 需要时再加。Show1 读取会话用的 `/api/auth/me` 也返回 `avatar`（show1compat 用例同步）。`docs/api-contract.md` 尚未同步。邮箱仍为自愿绑定：强制注册绑定的尝试已按用户决定撤回，没有留下迁移。
- 验证：最近一次全量 test 145/145（含同工作区另一位 agent 的 fold 改动）；此前 check 68 文件、test 142/142（新增头像用例，v19 幂等用例改为按下标取 v19）。本地起服务配合 Gallery 副本做了无头 Chrome 验收：换头像后顶栏与个人中心更新，无 console error。未部署，生产库仍为 v19。

## 仓库与实现状态（2026-09-30）

- 本轮整理基线为 `main@1b55bb0`；fetch 后与 `origin/main` 一致，开放 PR 为零。远端只保留 main；主 agent 已删除完全合入的 show1-vote-processing 及只剩历史文档补记的 codex/shared-question-intake，本地占用中的 worktree 保留。
- 本仓是两站唯一动态 API 和数据库写入者，使用 Node ≥ 22.13 内置模块；包含 `/admin/` 管理页面。`arenaofbias` 与 `wsnxxxs/ArenaGalleri` 是独立用户前端，私有 `arenaofbias-data` 构建馆藏数据包；旧 same-prompt-gallery 已归档。
- 整理基线当时迁移到 v19、固定数据包 `4c926d5`；现在生产 v22 / 固定包 `39a2fa4`，见顶部。文档提交或数据源 main 前进不要求消费者自动追包。
- Show1 榜单、Elo 配对分与六维画像由后端聚合，只读库内 Show1 新票；旧快照票不回流。Gallery 继续使用独立的 Bradley–Terry 口径。自动审核、SSH relay、读取限流、共享题库与提示词变体均已进入 main。

## 最近已记录的部署

最新为顶部 2026-10-01 四仓发布；下列保留 2026-09-30 历史发布证据。下一次发布仍须现场核对，不能以本页替代版本门禁。

- 2026-09-30 shared-question-release：实际服务代码 `f4685c9345fa26688ae337555e5a842aba08093c`，数据包 `4c926d5`；Gallery `ccfd11d11e407af3c75c2e5482cc773a74996c2a`，Show1 静态仍为 `980541642706a3cd9141c3c90ab0da55bec93b87`。后端 main 的随后交接提交不代表服务重部署。
- Gallery 为 20 道正式题、83 件既有作品，Show1 为 25 题（20 共用 + 5 历史）；014 SupernovAI、016 云山巨城各有两份原文，长短版保持同一个 task ID。公开变体只含 id/label/prompt，不输出私有链接。Gallery 跳过空题榜单读取，首页由 20 次减为 5 次。
- 最近停写核对仍为库 v19：27 用户、267 作品、0 票/0 对局、16 评论、56 表情、6 猜题成绩；这些是发布时计数，后续正常写入可能变化。投票曾在 vote-release 清零，不能把它当作本轮操作。
- 正式四个 HTTPS vhost 已记录安装共享读取/并发限制；Gallery、API、作品三处有私有文件规则。旧 Gallery Pages 已关闭，旧仓 private/archived，数据仓 private。审核与截图已启用，通过专用 SSH tunnel 连接 relay；真实隔离图文 Flex 调用已通过，未创建生产投稿。
- 最新发布归档记录后端 check 68 文件、141/141 测试与公网题库/资产验收；没有完成全部原作、生产登录投票或全站 UI 验收。两道版本题当时均无实际作品，生产配对仍无样本。

## 后续事项与已知边界

- 2026-09-30 共享题库、投票聚合、审核和反爬，以及本次四仓配套功能和新增作品均已发布。以后收录长短版作品时应声明实际 `promptVariant`，有真实样本后再验收同模型卡片与两栏配对；不伪造作品。
- 作品目前使用 `*.w.arenaofbias.icu`，迁至与主站不同的可注册主域仍是已记录的运维项，需另行制定发布计划。
- setMeta 不接收 vendor，管理员可把手填厂商写进备注；兼容厂商追加后备注可能略超 1000 字。这两项按既有用户决定保留。猜模型每日答案可由前端推导，仍是娱乐玩法的设计边界。
- 自动审核只审声明、入口及两档页面文字、封面与首屏，不覆盖全部交互；错误/疑似转人工，不降至标准档。历史作品维持 legacy，公开展示仍受访问状态与门面开关约束。
- 旧临时目录的删除曾被自动审批拒绝，见 security-review/security-fixes、work-generation-metadata 归档；本轮不清理他人文件或生成物。

## 回滚入口

- 四仓与数据库备份在 VPS `/root/arenaofbias-question-review-release-20260930T171825Z/`；首页补充发布证据在 `/root/arenaofbias-gallery-hero-release-20260930T174014Z/`，当前 `gallery.prev` 为 `a68c94c`，旧 `ccfd11d` 保留于 `gallery.prev.bak-20260930T174014Z`；`show1-dist.prev` 仍为 `9805416`，更早 prev 另存 `.prev.bak-20260930T171905Z`。代码和数据回退先核对 v22 及上线后写入；不得直接覆盖恢复旧 v19 库或撤销授权清理。步骤见 [四仓发布归档](docs/archive/2026-10-01-four-repository-release-wsnxxxs.md)，更早证据见 [shared-question-release](docs/archive/2026-09-30-shared-question-release-wsnxxxs.md)。
- Nginx 防护备份见 [gallery-protection-deploy](docs/archive/2026-09-30-gallery-protection-deploy-wsnxxxs.md)；审核配置和 tunnel/relay 回退见 [luna-flex-relay](docs/archive/2026-09-30-luna-flex-relay-wsnxxxs.md) 与部署文档 6.1，不触碰 Xray 或业务库。
- 投票清零前备份在 `/root/arenaofbias-vote-release-20260930-c0ab6ac/`。退回旧投票代码可能重新读取冻结票快照；不得为新题库或 Nginx 回退误用清零前库。确需恢复旧票时先核对全部后续写入并按 [vote-release](docs/archive/2026-09-30-vote-release-wsnxxxs.md) 执行配套数据库/代码恢复。

## 本轮整理验证

- 仅整理文档；核对路由、配置、迁移、数据 pin、Git 提交关系与开放 PR，不把历史测试数量当作本轮测试结果。
- 已保留 shared-question-intake 独有补记的有效发布链、验收边界和仓库迁移信息，注明后来正式发布已经完成。`npm run check`：68 文件、0 错；文档相对链接检查与 `git diff --check` 通过。仅文档变化，不重复运行功能测试或浏览器；详情见 [本轮整理归档](docs/archive/2026-09-30-repository-cleanup-wsnxxxs.md)。

## 历史索引

按日期保存的原始轮次记录保留；旧状态由后续发布记录覆盖。以下索引包含现有所有轮次归档，新增记录按 [模板](docs/archive/_TEMPLATE.md) 编写。

- [2026-10-01 · 四仓发布、121 件作品与测试题清理 · wsnxxxs](docs/archive/2026-10-01-four-repository-release-wsnxxxs.md)
- [2026-10-01 · 社区题目审核与静态 ZIP 修复 · wsnxxxs](docs/archive/2026-10-01-question-review-wsnxxxs.md)
- [2026-09-30 · repository-cleanup · wsnxxxs](docs/archive/2026-09-30-repository-cleanup-wsnxxxs.md)
- [2026-09-30 · 作品生成信息与后台选项 · wsnxxxs](docs/archive/2026-09-30-work-generation-metadata-wsnxxxs.md)
- [2026-09-30 · vote-release · wsnxxxs](docs/archive/2026-09-30-vote-release-wsnxxxs.md)
- [2026-09-30 · 投票分支改名与远端检查 · wsnxxxs](docs/archive/2026-09-30-vote-branch-sync-wsnxxxs.md)
- [2026-09-30 · Show1 服务端投票聚合与两站清零 · wsnxxxs](docs/archive/2026-09-30-show1-vote-processing-wsnxxxs.md)
- [2026-09-30 · shared-question-release · wsnxxxs](docs/archive/2026-09-30-shared-question-release-wsnxxxs.md)
- [2026-09-30 · shared-question-intake · wsnxxxs](docs/archive/2026-09-30-shared-question-intake-wsnxxxs.md)
- [2026-09-30 · security-review · wsnxxxs](docs/archive/2026-09-30-security-review-wsnxxxs.md)
- [2026-09-30 · 安全防护修复 · wsnxxxs](docs/archive/2026-09-30-security-fixes-wsnxxxs.md)
- [2026-09-30 · schema-cleanup · wsnxxxs](docs/archive/2026-09-30-schema-cleanup-wsnxxxs.md)
- [2026-09-30 · schema-cleanup-review · wsnxxxs](docs/archive/2026-09-30-schema-cleanup-review-wsnxxxs.md)
- [2026-09-30 · schema-cleanup-release · wsnxxxs](docs/archive/2026-09-30-schema-cleanup-release-wsnxxxs.md)
- [2026-09-30 · 作品来源维度第 4 轮（榜单筛选） · wsnxxxs](docs/archive/2026-09-30-provenance-round4-wsnxxxs.md)
- [2026-09-30 · 作品来源维度第 3 轮（管理后台） · wsnxxxs](docs/archive/2026-09-30-provenance-round3-admin-wsnxxxs.md)
- [2026-09-30 · 作品来源维度第 2 轮 · wsnxxxs](docs/archive/2026-09-30-provenance-round2-wsnxxxs.md)
- [2026-09-30 · Luna Flex moderation deployment · wsnxxxs](docs/archive/2026-09-30-luna-flex-release-wsnxxxs.md)
- [2026-09-30 · Connect the Luna Flex review host · wsnxxxs](docs/archive/2026-09-30-luna-flex-relay-wsnxxxs.md)
- [2026-09-30 · Luna Flex content moderation · wsnxxxs](docs/archive/2026-09-30-luna-flex-moderation-wsnxxxs.md)
- [2026-09-30 · Luna Flex configuration and connectivity · wsnxxxs](docs/archive/2026-09-30-luna-flex-enable-wsnxxxs.md)
- [2026-09-30 · gallery-protection-deploy · wsnxxxs](docs/archive/2026-09-30-gallery-protection-deploy-wsnxxxs.md)
- [2026-09-30 · anti-scraping · wsnxxxs](docs/archive/2026-09-30-anti-scraping-wsnxxxs.md)
- [2026-09-29 · share-v2 · wsnxxxs](docs/archive/2026-09-29-share-v2-wsnxxxs.md)
- [2026-09-29 · Show1 modality match · Atmeplz](docs/archive/2026-09-29-modality-match-Atmeplz.md)
- [2026-09-29 · fix-round3 · wsnxxxs](docs/archive/2026-09-29-fix-round3-wsnxxxs.md)
- [2026-09-29 · 第二轮审计修复 · wsnxxxs](docs/archive/2026-09-29-fix-round2-wsnxxxs.md)
- [2026-09-29 · fix-round1 · wsnxxxs](docs/archive/2026-09-29-fix-round1-wsnxxxs.md)
- [2026-09-29 · email-auth-v2 · wsnxxxs](docs/archive/2026-09-29-email-auth-v2-wsnxxxs.md)
- [2026-09-29 · 提名收录后端 · wsnxxxs](docs/archive/2026-09-29-curate-v2-wsnxxxs.md)
- [2026-09-29 · curate-v2 审阅修订 · wsnxxxs](docs/archive/2026-09-29-curate-v2-review-wsnxxxs.md)
- [2026-09-29 · cleanup-round1 · wsnxxxs](docs/archive/2026-09-29-cleanup-round1-wsnxxxs.md)
- [2026-09-28 · 版本固定与投票身份快照 · wsnxxxs](docs/archive/2026-09-28-versioned-matches-wsnxxxs.md)
- [2026-09-28 · 快照计分与复查修复 · wsnxxxs](docs/archive/2026-09-28-snapshot-only-scoring-wsnxxxs.md)
- [2026-09-28 · 接入独立画廊 · wsnxxxs](docs/archive/2026-09-28-gallery-integration-wsnxxxs.md)
- [2026-09-28 · 画廊接入文档跟进 · wsnxxxs](docs/archive/2026-09-28-gallery-integration-docs-followup-wsnxxxs.md)
- [2026-09-28 · 汇合 gallery-integration 进 main · kme7kme7-prog](docs/archive/2026-09-28-汇合gallery-integration-kme7kme7-prog.md)
- [2026-09-27 · 管理端（admin web app）· kme7kme7-prog](docs/archive/2026-09-27-管理端-kme7kme7-prog.md)

## 控制框折叠审计与修复（2026-09-30–10-01，已提交 9b19ade，未推送、未部署）

- 授权与范围：先交付83件修改前审计表；用户随后批准同时修复两处漏藏并追加回归。仅修改 `server/fold.js`、在 `test/platform.test.mjs` 追加本轮回归、在本页末尾追加记录；保留已有头像等并行工作，不把其改动计入本轮。零新增依赖，不改 content 注入路由、作品文件或消费者数据 pin。
- 数据基线：使用正式 pin `4c926d5f8a3c240ff769de360a9168abbe4e9dfc` 的已有 rehearsal-2 副本，来源 `27f9a680886772ae9298cc188fef0868873e6921`，20题/83件作品；默认旧包92f8ab9与其422个文件仅未引用的 build-info 时间不同。另行处理的 data PR #5 新增38件尚未进入这个正式 pin，本审计不声称覆盖未发布的121件包。
- 真实复核：本地真实 `createContentHandler`、m token、隔离作品子域与 iframe；只读作品映射替代对局持久化，不写业务数据库。全部83件完成修改前/最终修改后的隐藏与恢复截图、DOM及消息记录，并逐图审阅；最终均为父页1280×720/iframe1280×660，尺寸变化的临时记录已按基线补跑。截图、日志、完整表和本轮 diff 全在忽略的 `output/fold-audit-20260930-445a1454/`，不入库。
- 结果：标记元素84→68；最终58件有标记、25件为0。解除唯一被阻断的 GPT-6 Luna Max 键盘体验入口（默认折叠下实点后“正在体验 A—Z”且 pressed），解除10个透明 checkbox/radio 的误标记，保留误藏的正文/页头/导航、小地图与建筑分页。补藏铁路 Gemini3.8 的1块底栏及飞机 DeepSeek High 的4块 static 调参卡片。键盘本体与配置按钮阵列保留。计数指被标记的 DOM 元素，仍包含1个原本 visibility:hidden 的空 toast，不等同于68个可见面板。
- 取舍：正文、导航、唯一体验入口所在混合区域整体保留，其内嵌调参按钮也保持可见；部分纯调参板附带标题/提示仍随板隐藏。飞机机构“启动”属于调参板且保留既有 F/E 快捷键，没有泛化豁免所有 Start/Play/点击类词语。无真实迟到样本，因此保留 load 后0/600/1800/4000ms扫描，不增加 MutationObserver 或查询协议。
- 协议：顶部注释供前端引用，子→父 `{source:'sp-fold', count}` 在 load 首报一次（可能0），每新批次再报、累计不减；父→子 `{source:'sp-arena', fold:boolean}` 默认隐藏，true隐藏/false显示，仅接受 parent。83件首报0、计数单调、末次与标记数相等，false恢复全部标记；本批 console error 为0。
- 验证：最终 `npm run check` 68文件/0错；完整 `npm test` 145/145通过、0失败/取消/跳过（8820ms）；`git diff --check` 通过。本轮新增3项回归覆盖内容/入口/原生输入保护、全屏层内static卡片识别、批次报告与parent消息约束/输入状态；已有上传内容服务用例追加 w 原作不注入断言，已有 m 注入断言保持。完整测试包含工作区已有头像等改动，不能把145项全部归因本轮。
- 证据：[修改前83件表](output/fold-audit-20260930-445a1454/audit-table.md)、[最终83件对照表](output/fold-audit-20260930-445a1454/after/audit-table.md)、[仅本轮fold/test差异](output/fold-audit-20260930-445a1454/our-changes.diff)、[check日志](output/fold-audit-20260930-445a1454/check-after.log)、[完整测试日志](output/fold-audit-20260930-445a1454/tests-after.log)。输出表含每件数量、元素、误藏/漏藏及两态截图绝对路径。
- 未执行：未逐件覆盖手机、全部滚动/指南/部件动画、交互后新建面板或音频可听性；这些超出本轮实际证据，不宣称全部交互验收。前端开关由另一人实现，本轮未改前端；未连接生产、未部署、未提交或推送后端。本轮本地审计服务已停止。
- 后续数据整理与发布（2026-10-01）：按用户另行授权，data PR #5 的38件完成题目去重映射、模型注册与收录验收，并已合入 main，源码 `638937a58d6aec02644106d76e2b84d51fbf9fe9`；不可变 tag `datapack/638937a58d6aec02644106d76e2b84d51fbf9fe9` 指向产物 `39a2fa43b25488b09069644fdcd6df50adc06dc0`。发布包 schema 1、sourceDirty false、20题/121件、37展示模型/203完整模型、11 Harness/10服务商；PR CI 36731000102 与发布 CI 36731686651 均成功。本地 data check 28文件/0错、测试16/16、完整构建成功、收录检查0错/4提示；原作已有空白提示保留，范围与限制见 data 本轮归档。本轮只提交/推送/合并 data，未更新消费者 pin、未部署、未提交后端；上面的折叠审计仍只覆盖固定正式83件，不包含新增38件。合并、产物与CI核对证据位于 data 忽略目录 `output/intake-pr5-reconcile/worktree/output/pr5-review/published-package-verification.json`。

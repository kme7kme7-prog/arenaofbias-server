# HANDOFF.md · 当前状态

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

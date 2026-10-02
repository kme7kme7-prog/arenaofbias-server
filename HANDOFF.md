# HANDOFF.md · 当前状态

## Gallery 审核接入盲评开关（2026-10-02，本地提交，未推送、未部署）

- 承接下方小红帽调查：Gallery 审核改为同后台分面，单件核验显式发送 show_gallery / show_arena。本仓 batch-review 接受可选布尔 show_arena（仅 verified 时生效，非布尔 400）；admin.js 已验证提示改为「是否进入盲评以盲评开关为准」；admin.test 增加两条断言。
- check 87/0、test 244/244；与 Gallery 配合的隔离合成数据 Browser 验证见 Gallery HANDOFF。未推送、未部署、未改生产数据。见 [归档](docs/archive/2026-10-02-arena-review-face-wsnxxxs.md)。

## 截图服务隔离与喷泉截图核对（2026-10-02，本地完成，未推送、未部署）

- 按用户授权，由三名 GPT-6.1 Sol / high 分工截图连接、systemd 部署与真实浏览器验收。平台改用 `arenaofbias`，Chrome 改用独立 `aob-capture` 用户和 systemd 文件系统沙盒；不是 Docker。独立 worker 固定开启 Chromium OS sandbox，不读取平台业务库或密钥，不继承平台环境；仅发布环回控制端点，平台连接后在自己进程写图片和数据库。没有新增 npm 依赖或数据库迁移。
- 新增 `scripts/capture-browser.mjs` 和 `deploy/systemd/` 两份配置；`CAPTURE_ENDPOINT_FILE` 配置后只连接 worker，故障不退回本地 Chrome，重连时重新读端点。端点文件 0640、目录 0750，含控制令牌，不公开、不输出日志。更新 `docs/deploy.md` 7.2–7.3 的安装、验收与回滚步骤；原本本地开发路径保留。
- 验证：生产基线 83e43fe 加本轮改动的干净源码，Windows check 83/0、test 233/233；VPS Node 22.23.2 check 83/0、test 233/233。首次 Linux 导出的一项 shell 测试因 Windows CRLF 失败，只修正隔离导出的换行后全过。最终共享工作区（另轮 b93a807 登录保护已提交）check 87/0、test 244/244；diff --check 通过。三项新增回归覆盖远程连接/本地图片路径、端点刷新及连接失败无本地回退/令牌日志。
- VPS 临时服务与合成页面验收：非 root 平台和独立 worker UID 分离；`chrome://sandbox` 显示 namespace、PID/network namespace、seccomp 正常；桌面/移动首屏和延迟图、中文及同源 iframe 文字正常，禁止外站 HTTP/WebSocket 命中为 0；worker 不能读取生产 DB、平台 drop-in、root SSH 文件与合成私有数据；停止 worker 后截图不可用，重启后连接恢复。未创建生产投稿，未调用 SMTP、自动审核或改生产数据。
- 用户要求先核对“古典庭园喷泉”，本轮没有改变等待时间：公开首屏仍为 load 后 3.5 秒，滚动/点击后再等 8.5 秒的延迟图仅供审核。馆藏 Opus 的记录注明 GPU/字体预热后等 25 秒；两件馆藏已有封面是完整场景。服务器隔离 worker 对 Gemini、Opus 和投稿 up-ccnksbcp 分别在 3.5/8/15/25 秒取图，三者 `navigator.gpu` 存在但 `requestAdapter()` 为 null，25 秒图为 WebGPU 错误提示；按现有 root 启动参数另做合成页能力检查，结果也没有适配器。增加延迟不能单独解决此例。已有投稿封面同样显示适配器错误；重启或周期复查不会替换现有公开封面，馆藏封面属于不可变数据包。
- 生产最终只读复核仍为 83e43fe、平台 root 运行且 active；正式源码、unit 和 `.data` owner 未改。临时平台服务已停，临时截图 service 已停并移除其 runtime unit。本轮新建两个系统用户，保留只含本轮演练的 `/opt/arenaofbias-capture/isolation-rehearsal-01a0fb12`、`/var/lib/arenaofbias/isolation-rehearsal` 与 root 私有备份 `/root/aob-capture-isolation-20261002-01a0fb12`；原 `.data` 的 1859 条混合 owner/mode 已备份供精确回滚，不能统一 chown root。证据在忽略目录 `output/capture-isolation-20261002-01a0fb12/`。
- 后续先处理截图环境的 WebGPU 能力，再调整首屏等待并决定需重截的投稿；不启用未经核验的实验 GPU 参数，不手改数据包。本轮代码按用户指示仅本地提交；未 push 或上线。共享 main 另有 b93a807 登录保护（v32、配套前端）和 1177461 调查记录，发布时必须核对整体范围，不能仅凭本轮截图演练部署整个 HEAD。完整记录见 [归档](docs/archive/2026-10-02-capture-isolation-wsnxxxs.md)。

## 红队复核与登录保护（2026-10-02，本地完成，未推送、未部署）

- 按用户指定，三名 GPT-6.1 Sol / high 并行负责认证、匿名 TTL、三个登录入口；主会话集成与生产只读核查。正式 API / 版本文件同为 83e43fe，Node 22.23.2、数据库 v31、4 个 DB 管理员，ADMIN_USERNAMES 未配置，Turnstile 双密钥已配置。没有调整真实账号角色或写入测试 canary。
- 配置 Turnstile 后所有密码登录在验密前验证一次性 token，避免管理员用户名分流与正确密码探测；管理员、Gallery、game 登录表单配套支持 token 和失败后重置。密码失败按账号跨 IP / 来源 IP 各 5 次 / 15 分钟，触发临时封禁登录 15 分钟；全站最多 32 个在途登录流程，429 带 Retry-After。管理员失败 audit、封禁 audit + journal，不保存密码/token，不仅凭用户名永久封禁。
- 登录/注册撤销请求中的旧会话；普通闲置 24h、管理员 30min、绝对 30 天。末尾幂等 v32 sessions.last_seen_at，旧会话按 created_at 回填，可能需重登。ADMIN_USERNAMES 固定管理员直接降权409，避免成功响应与有效权限不一致。
- 匿名对局3h有效期，启动+每分钟清理过期无正式票引用行，全站无票匿名对局最多10000；正式票及关联对局保留。练习局原本只存内存且限5000，新增3h TTL，保留匿名体验。后台track paths 已esc转义；已有cookie绝对过期和新token、内存练习、Nginx nodelay均纠正报告表述。
- Nginx候选补主域/game/gallery安全头和按host CSP，补自带add_header的location、429错误页及game错误CORS，隐藏文件/robots与未知静态路径不再SPA返回200；game XFF覆盖真实来源。完整候选在VPS隔离目录nginx -t通过，正式配置尚未更改。发布步骤在docs/deploy.md第8节。
- 验证：Windows混合工作区check86/0、test244/244；从已提交基线加本轮文件的LF导出排除他轮截图改动，VPS Node22 check86/0、test241/241。初次Windows旧迁移夹具漏sessions表，补齐夹具后过；初次Linux导出中的旧shell CRLF导致一项失败，仅对隔离导出转LF后全过。源码与迁移安全定向回归、三个入口浏览器关键场景均通过，前端完整结果见各仓本轮归档。
- 他轮截图服务未提交文件capture/config/test-capture、deploy/systemd、scripts/capture-browser保留，不纳入本轮。期间1177461仅追加他轮盲评池调查HANDOFF，本轮保留。未push/上线、未迁移真实业务库、未调用生产SMTP/自动审核或尝试真实管理员错误密码。SSH仍允许root密码登录、服务仍以root运行，后续变更需先核实运维通道与截图权限。完整记录见[归档](docs/archive/2026-10-02-redteam-login-hardening-wsnxxxs.md)。

## 小红帽作品可见但盲评池为零的调查（2026-10-02）

- 本轮用户要求调查完整链路。公网 API 当前 `serverVersion=83e43fe072a0280d86c76379d9964bd4a32eb4bd`，Gallery 源码 `ef7b0a5bb240a518033a1ce78bb29a36d5205cdc`；两端数据 pin 均为 `53ab3e7caae664a520a231ef4fb715c493f1baa0`，catalogDigest 均为 `95f4979445a2528dccd866a1f2e1ca72d2b431943d295fea53ceb0e8ddbdec4a`，排除本次数据版本不一致。
- `little-red-riding-hood` 的静态馆藏 results 为 0；公开 bootstrap 实际有 6 件投稿、6 个不同模型，均 verified、single-turn / none。标题为「渡林条例」「红斗篷与灰影子」「红斗篷与停火线」「狼没有说谎」「林边的红灯」「三短一长」。已在登录的正式后台按题目筛选，6 件的正式盲测和娱乐池开关均关闭，均显示「不在正式盲测池」。正式盲评大厅与公网 bootstrap 均为 works=0 / entries=0。
- 写入链路：library.insertWork 显式设 show_gallery=1 / show_arena=0；Gallery account.js 的通过核验只发送 status=verified / show_gallery=true，后端单件 review 保持省略的竞技场开关。新 batch-review 同样只显式开启展览馆。全局 verified 不等于竞技场已批准；后台竞技场系统的「通过并进盲测」才显式发送 show_arena=true。
- 读取链路：Gallery app.mergePlatform 将静态馆藏和 bootstrap.works 合并展示；bootstrap.works 按展览馆可见性筛选。library.eligible 合并馆藏/投稿后要求 verified、有 dir、未被馆藏替代、公开内容可读、show_arena=true；文学题仅豁免生成方式/人工介入限制，不豁免竞技场开关。arena.poolStats 对该池计作品数、按 model + 规范化 effort 去重计配置数；bootstrap.arena 下发后，Gallery arena.js 直接展示，entries<2 禁止开始。createMatch 再走同一 eligible 并排除本人作品，防止绕过大厅直接配对。娱乐池开关独立，不控制 Gallery 正式盲评。
- 产品提示造成误解：公共/后台 verified 的提示仍称「参与盲评并优先展示」，大厅把尚未开启盲测的题统一归为「作品不足」。建议保持分面审批规则，明确显示「已核验，是否参与盲评以竞技场批准为准」及「尚无作品进入盲评池」。本轮未实现提示修改或批准作品；至少批准两件不同配置后此题才能开始，若全部六件批准且其余条件保持，统计应为 6 件 / 6 个配置。
- 验证：现有 blind-pool 的 eligibility 和 text exemption 两项通过；admin 的旧决定迁移、单面核验、批量开关三项通过，共 5 项实际用例。首条命令另报告一个无匹配用例的 admin 文件通过，不把它算作功能验证。已只读核对生产 UI/公开接口；未创建生产对局或投票，未改业务数据、源码、数据包或部署。工作区另有持续变动的安全加固文件，本轮未修改或暂存。

## 固定新数据包与生产发布准备（2026-10-02）

- 数据源 `0291105a33d721d58b2345703817bc92c2ed5de4` 的 CI 36960742936 成功，固定不可变产物 `53ab3e7caae664a520a231ef4fb715c493f1baa0`；20 题 / 182 件，补齐领域、生成声明及模型登记信息。Gallery 私有 pin 与此同步。
- 后端功能基线 `2ceec02525d2b726499814dd5d9f5b115fc7eee3` 的干净 LF 导出在正式 VPS Node 22.23.2 上 check 82/0、test 230/230 通过；本次 pin/记录提交不修改已验源码。
- 现场 `343ed64` 的 163 个 tracked 文件全匹配，无未知 runtime 文件。生产 v27 升至 v31 前备份 SQLite 与旧源码，保持现有 root 服务及环境；不启用需要非 root 的 Chromium sandbox，不回填作品或清理业务数据。
- 本节为发布前提交记录，实际切换、完整哈希、数据库与公网验证由主会话统一发布归档记录；不得把准备完成当成部署完成。证据目录 `/root/aob-release-20261002/` 与本地忽略的 `output/release-20261002/`。

## 四仓整理：后台源码收口（2026-10-02，已验证，提交并推送）

- 本轮用户已授权四仓整理、提交、合并、推送与部署；将下方作者进度、管理员编辑/批量审核两轮完整未提交实现合并收口，保留文本公式/表格等此前提交。
- origin/main fetch 后仍为 343ed64；main 原领先 8 条，无 open PR，两个本地工作树分支均已合入 main。本轮使用本人 GitHub 身份 wsnxxxs/noreply，未删除分支或工作树。
- Windows Node 24.16.0：check 82/0，test 230/230，diff --check 通过；无新代码修复。主会话已只读核对生产 343ed64 与本地同 SHA 163 文件一致，生产数据库 v27；本轮需要追加 v28–v31，部署前备份。
- 本次保留现有 ba442b61 数据 pin；数据源 0291105 已推送、CI 产物构建中，最终不可变 pin、Linux/浏览器联调及生产发布结果由主会话后续记录。本代理未连接或改动服务器/业务库。下方“未提交/未推送”属于原功能轮当时状态，由本节提交收口覆盖。
- [完整归档](docs/archive/2026-10-02-server-cleanup-wsnxxxs.md)。


## 本轮：管理员编辑保留内容决定、审核批量接口与题目编辑（2026-10-02，实现与验证完成，未提交、未推送、未部署）

- 按用户指定用三名 GPT-6.1 Sol / medium 子代理分工 library/首轮回归、题目服务/测试、API 文档，主会话集成路由与批量作品测试。先完成管理员编辑修复，再接批量核验。开始前已读 AGENTS/HANDOFF 与完整已有 diff；保留作者进度/等待名额的所有未提交段落及 `test/author-progress.test.mjs`。期间另一会话完成文本公式/表格改动与独立提交，本轮未修改这些源码或其 HANDOFF/API 文档段落。
- 管理员 `setMeta` 与 `review` 顺带修改标题、说明、模型、档位等时保持完整 moderation；作者 PATCH 仍在送审文字变化时重置 pending 并 enqueue。管理员 meta、review、管理员 PATCH 不再 enqueue；现 moderator.enqueue 本身也仅处理 pending。`verified` 内容 approved/legacy 的 409 校验移入 library.review，单件与批量复用。现有 meta/核验 audit 照常写。
- 新增 `POST /api/admin/works/batch-moderation`（works 1–100）、`POST /api/admin/works/batch-review`（works 1–100）、`POST /api/admin/questions/batch-moderation`（ids 1–50）、`POST /api/admin/questions/:id/meta`。全部仅管理员、write 每请求一次；批次预校验失败整体 400 不写入，逐件独立事务/结果/audit，一件失败继续后续项目，每批结束 invalidate 一次。作品成功项为 `{task,id,ok:true,work}`，题目成功项为 `{id,ok:true,question}`，失败项均带 `error:{status,code,message}`；HTTP 200 的 results 按请求顺序。字段无改名；特此明确题目成功视图字段名为 `question`。无 code 的业务错误统一补 invalid_request/forbidden/not_found/conflict，意外内部错误返回单项 500/internal_error 与通用中文原因。
- 批量核验 meta 仅 effort/providerId/harnessId/harnessOther；每件在同事务先 setMeta 再 review，失败连 meta/audit 一起回滚。verified 强制 show_gallery=true，最终档位/服务商必填、内容须放行；questioned 理由必填且可处理待审内容。管理员修改不重置内容状态，因此批量核验无需 enqueue。批量题目通过不补分类/领域，缺分类或领域返回该题 400，须先单独编辑。
- 题目 meta 支持 title/summary/prompt/category/domains，复用创建的长度、分类与领域校验，保持 moderation；公开 approved/legacy 且有未删除作品时锁定提示词，任何状态下有未删除作品且改分类须重置 templates 时返回 409。question-edit audit 记录变化字段 `{from,to}`，prompt 只记 `{changed:"已修改",fromLength,toLength}`，不存全文。公开题目从数据库实时读取；arena.invalidate 清领域/题型/综合榜缓存，HTTP 回归已核对 bootstrap 与领域榜更新。
- 拆分提交定位（行号以本轮完成时文件为准）：`server/library.mjs` 仅 setMeta（763 行起，author 条件在 807 行）、review（847 行起）、reviewWithMeta（888 行起）；此前 changedAt/pendingOf/trustOf/authorWorks/pendingLimit 等段落仍属作者进度轮。`server/app.mjs` 仅 categories import、93 行起批次辅助函数、242/260 行起题目新路由、309 行起 review 校验/去 enqueue、377 行起 PATCH 的管理员不排队、424/436 行起作品批量路由、574 行起管理员 meta 去 enqueue；bootstrap/me/seen 原改动属作者进度轮。`server/questions.mjs` 48 行 setMeta SQL、90 行起 edit；不改现有 review/rejected 行为。
- 测试拆分定位：`test/admin.test.mjs` 45/59 行 helper 配置参数、156 行起 withModeratedUpload 与 6 项管理员编辑/作者回归/作品批量测试；88 行附近旧 v30 迁移夹具索引改动属作者进度轮。`test/questions.test.mjs` 61 行起服务校验用例、408/437 行起 HTTP 编辑/批量题目用例。`test/moderation.test.mjs` 355–356 行仅把旧声明变更夹具从管理员改为作者 `{author:true}`，保留过期结果保护与重启恢复 pending 的原验证目的。`docs/api-contract.md` 仅 3.6 作者 PATCH 描述、3.7 管理员编辑及两项作品批量接口、3.14 两项题目接口、3.19 管理员 meta、3.24 作者重送审范围；原作者进度新增字段及另一会话文本公式描述保留。HANDOFF 只新增本节。没有修改 config/db、迁移、Gallery/admin 页面、依赖、数据包或业务库。
- 已执行：Windows Node 24.16.0，最终 `npm run check` 82 文件 / 0 错，`npm test` 230/230，0 失败/取消/跳过，`git diff --check` 通过。最终测试包含作者进度与文本公式/表格的共享工作区改动。首轮 admin 单文件 15/15、题目单文件 17/17；首次全量 229/230，唯一旧 moderation 夹具仍期待管理员修改重置 pending，按作者路径修正后全过。批量作品夹具初次因投稿必填档位与 provider_id 的 CHECK 约束失败，已按正常投稿后模拟历史缺字段（provider_id=NULL）修正。
- 已检查但不改行为：对 approved/legacy 且已有作品或投票的题目调用原单件 moderation rejected 仍允许成功；只写题目决定及 question-review audit，不删除作品、votes 或 matches，作品自身核验/内容决定和开关不变。catalog 随即不再公开该题，bootstrap/公开作品列表/公开作品源/媒体撤下，作者与管理员仍能私有查看和预览。历史正式竞技场票留库，但因作品失去当前资格而从综合/题型/领域排行榜计分移除，单题榜返回 404，新盲评配对返回 404；既有 match 的源撤下，已绑定用户再提交非 skip 选择时保存 match 决定但不新增票，返回 counted=false、reason=changed。个人历史 votesBy/profile 计数仍保留。代表作读取立即过滤失效作品。重新 approved 后符合原资格的作品与历史票重新参与；娱乐池使用 Show1 旧 roundByTask 映射，通常社区题原本就不在其池内。此结论来自现有 questions/catalog/library/arena/featured/show1compat 源码检查，未另行操作真实有票题目。
- 未执行：浏览器/Gallery 联调、生产 Node 22、真实截图/自动审核/SMTP、生产部署或业务库操作；未 commit、push 或部署，未写推送归档。本轮无需迁移，工作区已有 v31 属作者进度轮。

## 文本作品支持公式与表格（2026-10-02，本地提交，未推送）

- server/text.mjs：Markdown 新增 GFM 管道表格（列对齐、横向滚动）和 TeX 公式（行内 `$…$`、`\(…\)`、`$$…$$`；独占行或跨行的 `$$…$$`、`\[…\]`）。`$` 按 Pandoc 规则，`$5 和 $10` 不误判；`\$` 为字面美元；代码内不解析；未闭合块公式退回段落；粗体/斜体内可含公式；单词内 `_` 不再触发斜体。公式输出转义后的 TeX，只有含公式的页面加载固定版本 KaTeX 0.16.47（jsdelivr /npm/，带 SRI），KaTeX 不可用时显示 TeX 原文。`.txt` 不变。
- server/inspect.mjs：文本作品的 external 检查固定为 ok，有公式时写「公式由平台加载 KaTeX 显示」，不再把平台自带的 KaTeX 当作作者的外部依赖。api-contract 文本上传一节同步。
- 验证：text.test 5/5（新增公式、表格、价格 `$`、转义、代码、未闭合、无公式不加载 KaTeX、.txt 不解析）；HEAD + 本轮三文件的独立检出 check 81/0、test 217/217。当前混合工作区 226 项中 1 项失败（moderation「stale results cannot replace human review…」），来自他人未提交的 library/questions/db 等改动，与本轮无关。浏览器以与作品页相同的 CSP 打开样例页：7 个公式全部由 KaTeX 渲染、0 个 katex-error、表格可横向滚动、console 0 错。
- 已上传的文本作品保留上传时生成的页面，不会自动重新排版；目前线上文本题无作品，影响为零。

## 本轮：作者核验进度与等待核验名额（2026-10-02，实现与验证完成，未提交、未推送、未部署）

- 按用户指定由 GPT-6.1 Sol / medium 子代理分工实现 library、配置迁移、文档与测试，主会话集成路由。初始工作区干净；本轮任务明确未经同意不提交，保持未提交供审阅。不改前端、管理员页面、核验流程、公开展示规则或数据包。
- 新增环境变量 `PENDING_PER_USER=5`、`TRUSTED_PENDING_PER_USER=20`、`TRUSTED_MIN_VERIFIED=3`，均沿现有配置解析方式取至少 1 的整数。管理员不受限制。迁移 v31 仅在 MIGRATIONS 末尾幂等追加可空 `users.works_seen_at INTEGER`。
- 名额排除内容被拒或所属社区题目被拒的未核验作品；内容待审与题目待审仍占名额。信用档要求未删除 verified 作品达到门槛，且近 90 天无存疑记录（审计保留删除、恢复状态前的决定），不建新表。bootstrap 展示与作品/建题附示例提交使用同一计数和实际限额。
- 接口增加 bootstrap `me.pendingLimit`（管理员 null）与 `me.updates`；GET `/api/me` 增加作品 `queueAhead` / `changed: true` 与 `reviewStats.medianHours`；POST `/api/me/works/seen` 登录、write 限流，记录当前时间并返回 `{ ok: true }`。核验队列沿现 Gallery 与 bootstrap.review.unverified 口径，含竞技场已核验但展览馆未决定的投稿；只给队列内 unverified 作者作品输出位置。通知只算核验时间与 approved/rejected 内容决定时间，首次未读回看 7 天。
- `reviewStats.medianHours` 使用全站未删除、当前 verified 且最近 30 天核验的投稿，从 created_at 到 reviewed_at 的小时数计算中位数；少于 5 件为 null。queueAhead 按 created_at 升序，同时间按作品 ID 排序。429 返回当前 N 与实际 M：`你已有 N 件作品在等待核验（上限 M 件），核验完成或删除作品后名额会释放`。API 契约已同步，前端可直接消费新增字段；显示作品变化后调用 seen 清除红点与高亮。
- 可选邮件通知未实现：现 mail.mjs 服务注册/绑定/重置邮件，10 分钟合并通知还需额外调度及生命周期处理；本轮交付站内提醒，未新增 `NOTIFY_REVIEW_EMAIL` 开关。每日上传数限制未加；现有上传和 write 限流继续生效，本轮不建议另加每日限额。
- 已执行（Windows Node 24.16.0）：`npm run check` 82 文件 / 0 错；全量 `npm test` 220/220，0 失败/取消/跳过；`git diff --check` 通过。4 项新增集成测试覆盖被拒作品/题目释放名额与两提交接口一致、信用档/90 天存疑历史、队列 created_at/ID 排序与竞技场先核验、首次 7 天变化/seen 归零/新变化和中位数奇偶样本。旧 v30 迁移夹具固定对应迁移索引，v31 的列可空、幂等执行与环境变量默认/覆盖已在临时内存库验证。
- 未执行：生产 Node 22、浏览器与真实前端联调、外部邮件/截图/自动审核验证；未连接生产、未迁移本地或线上业务库、未改数据包或 pin。业务库上线迁移留待后续部署；本轮按任务要求不提交、不推送、不部署，未写推送归档。

## 四仓整理与远端合并（2026-10-02，本地提交，未推送）

- 用户授权整理四仓并提交。fetch 后 main 领先 6 条、落后 1 条；合并远端 343ed64，保留本地六条提交及原作者。
- 解决 admin/admin.js、admin/admin.css 冲突：保留本地 arena_eligible / arena_generation_ok 资格提示，同时保留远端逐行娱乐池开关与表头；删除已无引用的 work-pool-note 样式，保留审核样式。
- 合并后 check 81/0、test 216/216、diff --check 通过。未重复浏览器或生产验收；未启动服务或迁移业务库。
- 仅本地合并提交，未推送、部署或改 pin；其它 worktree、分支、配置及生成物保留。[归档](docs/archive/2026-10-02-project-cleanup-wsnxxxs.md)。下方旧记录为各轮当时状态。

## 本轮：题目领域与排行榜领域范围（2026-10-02，本地提交，未推送）

- categories.mjs 新增 DOMAINS（11 个）与 requireDomains（1–2 个、在词表内、去重）。v29 只追加幂等列 `questions.domains TEXT NOT NULL DEFAULT '[]'`，不回填。社区题创建时 `domains` 选填（旧 Gallery 不传仍可发起），带上即校验；管理员通过时可替换，audit detail 记 `domains: {from, to}`。题目视图输出 `domains`，bootstrap 新增顶层 `domains` 词表；馆藏题目从数据包 task.domains 读取。
- 排行榜新增 `domain` 参数：只取 domains 含该领域的题目的票重新拟合，可与 category 叠加，不能与 task 同用，未被任何题目使用返回 400；缓存键含 domain，响应回显 domain，有 domain 时不出 standings。`totals.votes/voters` 改为只数实际计分的比较（同一配置或按模型时同一模型两件作品之间的票剔除），新增 `totals.tasks`；修正此前「按模型」有效比较偏多。
- 测试：questions 增领域创建/通过/audit/bootstrap/榜单参数；platform 增领域与形式叠加、非法组合；blind-pool 增同配置票不计入 totals；admin 旧断言补 `tasks: 1`。最终全量 `npm test` 213/213、`npm run check` 81/0，本轮文件 diff --check 通过。未连接生产、未迁移本地或线上业务库、未部署。api-contract 已同步（3.1、3.10、3.14、v29）。
- 期间工作区有另一会话的未提交改动（auth/capture/moderation 等与红队加固相关，以及 admin、deploy、部分测试），本轮未改这些文件；提交时须分开。
- 上线顺序（均未执行，需用户授权）：① 数据仓提交并发布含 `domains` 的数据包；② 后台与 Gallery 的 `datapack.json` 改 pin 到新包；③ 后台部署后自动执行 v29 迁移（只加列、幂等，社区题旧数据为 `[]`）；④ Gallery 构建发布。前端对缺 `domains` 的包和旧后台都能降级（不显示领域分组、领域榜提示后端不支持），所以 ③④ 顺序可以互换。
- 已上线社区题目没有领域，需管理员在后台补（通过时可修正领域）；或另行写一次性脚本，本轮未做。


## 审核流程统一与按面决定（2026-10-02，本地提交，未推送）

- 三名 GPT-6.1 Sol / medium 子代理并行完成 Gallery 合入、后端按面核验与浏览器验收。纳入已完成的管理台审核整理：admin 待处理为题目 / 内容 / 作品，已处理不计数，馆藏不进审核队列；内容独立弹窗、示例就地处理、登记信息先保存再提交决定、同队列下一件。修正 reviewed 缺本面时间却因开关已开启被算作已展示的问题。
- v30 在 works 追加 reviewed_gallery_at / reviewed_arena_at；已核验和存疑旧行按 COALESCE(reviewed_at, updated_at) 回填两面，未核验保持 null。review 与单件/批量 face-settings 只记录明确指定的面，娱乐开关不记录；管理员投稿视图输出 reviewed，馆藏不输出。不改变内容 409、核验档位/服务商、存疑原因及 bootstrap 计数契约。
- 为保持迁移序号，提交中保留已有 v29 questions.domains 迁移作为结构依赖；其余题目领域和排行榜功能未纳入本轮。server/library、api-contract、admin 测试、platform 测试与 HANDOFF 的既有其他改动通过 HEAD + 本轮差异合成暂存版本，仍保留在工作区。
- 当前混合工作区 check 81/0、test 215/215；独立导出的暂存源码 check 81/0、test 207/207；diff --check 通过。新增回归核对单面核验、明确关闭保留状态、娱乐开关不记录和旧行回填；旧 schema 夹具只作必要字段调整。
- 隔离真实后端 + 合成数据浏览器跑通 Gallery 审核、375 宽、竞技场待作品到未进盲测，以及开启但未审核本面的回归。Gallery console 0；管理台合成作品 iframe 因验收服务未提供作品域路由产生资源 404，无页面 JS 异常。未验收真实作品执行、生产账号、自动审核、SMTP 或截图服务；临时服务已关闭。证据在相邻 Gallery output/playwright/review-redesign-current/。
- 本轮仅本地提交，未推送、部署、操作业务库或私有配置；其他会话的领域、邮件及内容加固等改动保留。归档：[review-pipeline](docs/archive/2026-10-02-review-pipeline-wsnxxxs.md)。
- 补充：bootstrap `review.unverified` 改为与 Gallery 核验队列同口径——内容已放行、题目已公开、未存疑且展览馆尚无面决定（`reviewed_gallery_at` 为空）的投稿，含已在竞技场核验的投稿；排除已收录投稿。此前只数 status=unverified，进审核页前后角标不一致。api-contract 同步，admin 测试新增「竞技场先核验仍计入、展览馆决定后移出」。check 81/0、test 216/216。

## 本轮：红队报告核对与上传内容加固（2026-10-02，本地提交，未推送、未部署）

- 背景：用户提供的 2026-10-01 红队报告。核对结论、四项代码改动与服务器步骤见对话；服务器/DNS/Nginx 由站长按 `docs/deploy.md` 第 7 节执行，本轮未连接生产。
- 公开需人工决定：新增 `library.publicContent`，即内容放行 + 馆藏或 `status≠unverified` 或 `moderation.source=human`。公开作品源、`visibleTo`（公开列表、评论/表情）、`canRead`（媒体）、截图来源与 `scene` 均改用它；Luna 通过或 legacy 的未核验投稿只在作者/管理员预览中可见。
- 枚举：注册先校验验证码，再判断用户名、保留名和邮箱占用；注册发码遇到已绑定邮箱时返回相同响应并发注册提醒（`purpose: registered`）；绑定的 409 移到限流与 Turnstile 之后。
- 审核加固：截图隐藏 webdriver/HeadlessChrome，加 3.5 秒后滚动+点击的约 12 秒延迟截图与全部 frame 文字，送审 5 张图 4 段文字；全部脚本静态信号命中即 approved→review；CSP 的 jsdelivr 限为 `/npm/`；`CAPTURE_SANDBOX=1` 开 Chromium 沙盒（需非 root）；`CONTENT_RECHECK_HOURS`（默认 24）定期复查文字与 CDN 响应哈希，变化后重新送审，不通过即撤下。基线在 `.data/media/<id>/baseline.json`，无迁移。
- 验证（Windows Node 24.16.0）：在由「HEAD + 本轮改动」检出的干净工作树中，`npm run check` 81 文件 0 错，`npm test` 215/215 通过（0 fail/cancel/skip），`git diff --check` 通过。共享工作区里 `admin.test.mjs:255` 的 `totals.tasks` 失败来自他人未提交的 `server/arena.mjs`，与本轮无关。未做真实 Chrome 截图与真实 Luna 调用，按部署文档 7.7 节在线上验收。
- 他人改动：本轮期间工作区出现非本轮的未提交改动（admin/admin.css、admin/admin.js、server/app.mjs、arena.mjs、catalog.mjs、categories.mjs、db.mjs、questions.mjs、test/questions.test.mjs），未改动，属另一会话（wsnxxxs / Codex），本轮提交只含本轮文件与段落。
- 待决：SPF 写法取决于验证码 SMTP 服务商与发件域；举报入口需与前端一起另开一轮；作品独立注册域名暂不做。

## 本轮：盲评池资格、作品分与每日代表作（2026-10-02 Brisbane，本地提交，未推送未部署）

- 用户后续授权本地提交，仍不推送、不部署；不自动维护生产数据。本轮只改本仓相关源码、测试、API 契约与本页，不改数据包、数据仓或 Gallery。初始工作区干净，无他人遗留源码改动。
- 非文字盲评资格共用 `library.isEligible`：已核验、内容放行、竞技场开关开启、单轮且无人工介入；配对、计票、poolStats 一起生效。馆藏没有覆盖记录时仍默认竞技场关闭。历史 agent 读取为 single-turn，新写 agent 仍 400；后台显示已开关但生成信息不合格的状态。文字题维持原有行为；社区文字题只有 templates 没有 kind，同样排除本轮作品分、代表作与维护。
- 生成信息仅保留 generationMode / humanIntervention；三个停用字段的任何请求类型均忽略，单独 PATCH/meta 成功空操作；SQL 参数同步删去，不读写旧列，数据库列与 CHECK 不改。作品/导出/管理员/送审/新快照/新审计不输出；旧快照及结构化历史审计在读取时剥离，原记录不改写。后台表单与详情同步精简。
- 配对按 promptVariant + 配置分组，禁止长短版跨组；配置强度、冷启动权重、同区间配对与均匀抽样保持原算法。按题新增作品 Bradley–Terry：先计算原配置 logit 强度，再以 N(配置强度, 0.5²) 先验拟合作品，同配置作品之间的票计入作品分；内部返回 id / score / interval / games，超过 200 条目走原 worker。
- v28（排在远端娱乐池 v26、v27 之后）只追加幂等建表 featured_picks / featured_refreshes，不回填历史作品。代表作跨档位按 catalog.modelKey 分组，封面取全题；至少 5 场，按 score - interval，挑战者比当天重算的旧当选者至少高 40 分才替换。每日按服务器时区自然日最多重算一次（空结果也记录），bootstrap 懒触发后台计算并先返回旧结果；重启保留，当选作品不合格时读取立即移除。契约新增 bootstrap.featured，缺少题目/模型由前端兜底。
- 手动 CLI：`npm run arena-backfill -- --db .data/platform.db --dist .datapack/current [--exclude task/id,...]` 默认只读演练、不迁移。`--apply` 必须另带新备份路径与 actor，停服后手动运行，VACUUM INTO 备份，作品修改与逐件 arena-backfill audit 同事务；显式多轮/人工介入保留原声明，排除参数不修改该作品，文字题不碰。保留 show_gallery 与校准，执行后重启服务清空排行榜/作品分缓存，poolStats 无缓存；进程内调用在提交后可用 invalidate 回调。没有启动回填入口。
- 验证 Windows Node 24.16.0：最终 `npm run check` 79 文件 / 0 错，`npm test` 194/194（0 fail/cancel/skip），git diff --check 通过。额外对比 Git HEAD 的原算法：80 组确定性数据的原始 fit 与配置榜行逐项完全一致。新增测试覆盖资格与 agent、忽略停用字段/旧值保留/历史审计裁剪、长短版、分层先验与同配置票、worker、门槛/保守分/40 分边界、每日固定含空结果/跨重启/即时剔除、bootstrap、维护演练/排除/apply/备份/事务回滚。初轮 171/184，旧夹具缺声明及旧停用字段 400 断言导致失败，按新契约更新后通过；新增夹具初轮的 NOT NULL 与开关默认值断言也已修正。
- 对实际本地 `.data/platform.db` 已仅演练：schema v13，当前 `.datapack/current` 为旧 `92f8ab99…`（5 题 / 83 件），不是本轮背景的 182 件新包。将开启馆藏 83 件（boeing-787 3、chinese-architecture 36、denza-z 1、mechanical-keyboard 17、miniature-railway-town 26）；补齐投稿 0、显式非标准 0。全部 83 件旧包作品都缺生成声明，开关开启也要等配套新包才合格；三个待决定的重复 ZIP 均 present=false，命令仍单列。旧库须另行手动升级到至少 v19 才能 apply，CLI 不自动升级。本轮未 apply、未迁移本地业务库，库文件演练前后 SHA-256 均 `40cf07c52bfaa52b334ef341456f970787f6dc701ffe18ad3c572cb5056dbd70`。
- 证据在忽略目录 output：`blind-pool-check.log`、`blind-pool-test-full.log`、`arena-backfill-local-dry-run.json`，早期失败日志也保留。未连接生产、未执行真实业务库 apply、未运行 Node 22 或浏览器视觉联调、未调用截图/Luna/邮件外部服务；apply 的证据仅来自测试临时数据库。完整 diff 和本地演练交用户审阅，三个重复 ZIP 是否排除尚待用户决定；本轮不写推送归档。
- 补修：后台竞技场状态列曾把文字题作品误标「不符合盲评条件」（前端未考虑文字题豁免）。管理员作品视图新增 `arena_eligible`（即 isEligible）与 `arena_generation_ok`（文字题恒真），后台改为读取这两个字段；资格判断仍只有服务端 `generationQualified` 一处。blind-pool 测试补文字题、多轮与合格作品三种断言。
- 提交前 rebase 到 origin/main（远端新增娱乐池开关、归属题目迁移、校准面板等 6 条）：db 迁移保留远端两条在前、featured 在后；setMeta 合并 task 归属与停用字段忽略；后台状态列合并盲评资格与「在娱乐池」提示；admin 测试夹具合并 arenaId/第二题与生成声明。

## 本轮：娱乐盲测池接线（2026-10-01，本地提交）

- 用户拍板「开接」（悬置 open 项「娱乐盲测接线」）。娱乐面此前复用 show_arena 选池；现独立为 show_entertainment 开关：娱乐池 = 老快照 262 件 ∪ 勾选的投稿作品，可与老作品对打，不进正式排名（BT 只认 source='arena'，兼容票 source='show1' 天然隔离）。
- v26 幂等迁移：works + work_overrides 各加 show_entertainment（DEFAULT 0），并把既有资格件（verified + show_arena=1 + 内容 legacy/approved + 未收录未删）回填为 1——线上现状不回退，之后可单独关。馆藏作品不参加娱乐面（liveWorks 只收投稿行，与老快照对打）。
- library：flagsOf/adminWork 输出 show_entertainment；setFaceSettings/batch 白名单加该键，curated 传 true → 400「娱乐面仅对投稿作品开放」。show1compat liveWorks SQL 换 show_entertainment=1。admin：投稿审核对话框灰占位激活为真开关（curated 审核框文案改「馆藏作品不参加娱乐面」），作品行池列显示「在娱乐池」，开关走既有 face-settings 端点与保存动效。
- 测试 194/194、check 76/0：新增 admin 用例（默认不进池/curated 400/开关后进 /api/works 花名册/关掉即移除）；show1compat 三用例换语义（夹具/撤下改 entertainment）；provenance v25 与 schema-cleanup v18 期望行补新列；editorial 用例基线 prompts 在存点评后重抓（兼容面 prompts 现带点评权重——既有行为，fixture 加 arenaId 后显现）。
- 浏览器+curl 双验收：勾选 → toast「娱乐盲测已开启」→ 行内「在娱乐池」→ 兼容面 262→263 含投稿件。验收 fixture（admin-e2e.mjs）题加 arenaId 901/902（不与老快照 001-008 冲突）。坑：SPA 同 hash goto 不重载文档，旧 JS 缓存致假象「开关不在」，reload() 才真刷。

## 本轮：Harness 下拉答疑 + 登录后目录空 bug 修复（2026-10-01，本地提交，未推送未部署）

- 用户问 Harness 下拉会不会有选项/手填。结论：选项来自数据包 data.json 的 harnesses 登记表（线上包 14 个：Claude Code/Codex/Gemini CLI/Cursor/Trae/Qoder/Kimi Code/KimiCode Desktop/官方网页App对话/API脚本/Arena/Antigravity/Zcode/DeepSeek），选「其他（手动填写）」弹手填框+相似名提示，功能一直都在；验收环境空是因为假包没登记。
- 顺手抓到并修掉一个真 bug（admin/admin.js loadCatalog）：登录前渲染作品页会以游客身份拉 /data.json → 404 → 缓存空目录 {tasks:[],models:[]}，登录后 boot() 的 if(state.data) return 跳过重拉 → 本次会话所有模型/Harness/题目下拉一直空，直到手动强刷。修法：失败路径置 state.data=null 允许登录后重试（正常路径缓存不变）。浏览器复现登录→编辑对话框验证：10 个 Harness 选项齐全、其他→手填框出现、手填 Trae CN 保存 toast「信息已更新」。193/193、check 76/0。
- 验收环境（bridge-demo/admin-e2e.mjs）data.json 已补 harnesses（10 项 listed:true）+providers 二值——注意 filter 只认 listed:true，真包都带。演示用投稿测试件每轮重启后重传。

## 本轮：验收反馈三件套——墨绿主题+圆角、归属题目迁移（2026-10-01，本地提交，未推送未部署）

- 用户对比老后台（Show1 老栈本地拉起验收，admin.html 已临时恢复 d871c75^ 版本供对比）后三条反馈：①要老后台那样的圆角 ②新后台亮绿太多 ③要能编辑作品全部归属信息。
- 视觉：亮色主题 accent 从荧光黄绿 #d9fb51 改墨绿 #3f6b4c（accent-ink/soft/text/focus 同步，注释注明"老后台墨绿"）；校准对话框圆角 16px、预览台 14px（对齐老版 work-calibration 的 16px 纸感卡）。暗色主题未动。
- 功能：setMeta 新增 task 字段（admin-only）——改归属题目时校验目标为活题（catalog 或社区题），单事务内迁移 works.task_id + votes/matches/comments/reactions 的 task_id 引用 + audit 记「归属题目 old → new」；editDialog 首项加「归属题目」下拉（数据包题+社区题），带「改归属会连历史投票、评论、表情一起搬过去」提示，未变不发该字段。作者侧仍不可改题（403）。模型/档位/Harness/服务商/生成信息编辑此前已有，本轮只是归位到完整。
- 测试：admin.test 新增改归属用例（票/评/表情随迁、目标题 400、audit 文案），fixture data.json 加第二题；193/193、check 76/0。验收环境已重启（bridge-demo/admin-e2e.mjs，含投稿测试件 up-jl4a80rt 可试改归属）。
- 线上注意：老后台对比栈（Show1 npm run dev，vite 5173+api 3000，ADMIN_OWNER=admin）还在跑，admin.html 工作区是临时老版（备份 /tmp/admin-redirect.html.bak），用户验完要还原。

## 本轮：竞技场作品管理复刻 · 期B 校准面板（2026-10-01，本地提交，未推送未部署）

- 用户拍板「B做一下 这个是最重要的」。重写 admin calibrationDialog：纯数字表单 → 可视化校准面板（预览+滑杆+拖拽+抓视角）。列表搜索/筛选朋友已做过，本轮补票数。
- 后端三处：①adminService.works 每件作品带 votes（votes 表 a/b 两侧出现次数聚合，skip 不计）；②POST /api/admin/works/:task/:id/preview 发 1 小时 p 键（library.previewOrigin 现成），内容服务器 p 分支 entry 补 'index.html' 兜底 + previewByKey 改 library.work() 使 curated 作品也能预览；③无新迁移。
- 前端 admin.js：calibrationDialog 重写——16:9 取景台（framedCanvas 同款公式：contain×zoom+比例偏移，与 Show1 lib/work-framing.ts 口径一致）、iframe 实时预览（p 键 + ?aob=bridge&face=当前系统面）、拖动改 offset（±1 clamp）、缩放/偏移滑杆与数字联动、画框宽高+720/960/1200/1600 预设、「取景模式/视角模式」切换（视角模式 dragLayer pointer-events:none 让指针穿透进作品拖 3D，合并老版两个对话框）、抓取当前视角（postMessage {aob:'get-camera'}→回包回填 6 数字+自动勾选）、保存/清空沿用 setFaceCalibration。模块级 calibrationCapture+window message 分发，onClose 清理。adminWorkRow 作品列加「· N 票」。
- 浏览器端到端验收（bridge-demo/admin-e2e.mjs：真平台+真 admin+three.js curated 作品）：登录→竞技场取景→视角模式拖 3D→抓取 (4.739,0,-1.595)→保存→重开面板值还原→开 arena 开关建对局→对局侧 HTML 内嵌 __AOB_SAVED__ 同值 + createMatch calibration 下发 framing。192/192 测试、check 76/0。
- 修的坑：①submit 读滑杆参数当数字框（num('zoom') null 崩，改 framing 取 draft.framing 内存值，camera 仍读 DOM）；②undici fetch 吞自定义 Host 头（诊断对局键假 404，native http 才可信——bridge.test 教训重演）；③合成拖拽要先把 iframe scrollIntoView（对话框超高可滚，作品可能滚出视口）。
- 未做：推送、部署、Show1 前端消费 calibration（期C，朋友活跃区）。演示台 fusion/bridge-demo/（8787/8788 演示 + admin-e2e 8790/8791 验收脚本）保留。

## 本轮：竞技场作品管理复刻 · 期A 后端桥（2026-10-01，本地提交，未推送未部署）

- 用户拍板复刻融合前竞技场的作品校准体验（方案 fusion/竞技场作品管理复刻方案-v1.md，期A=后端桥+探针+对局下发）。老实现：Show1/server/work-bridge.js（视角桥，Show1 决策 102）+ 就绪探针（决策 096）；竞技场前端 page.tsx/work-capture.tsx 至今仍在监听 `aob:work-ready`。
- 新增 `server/bridge.mjs`：桥运行时逐位移植（OrbitControls 登记：UMD defineProperty 拦 `window.THREE`；importmap ESM 改写映射经 `/__aob__/` 虚拟路由转发，转发模块同时转命名与默认导出）。因作品已迁独立内容源，抓视角从同源直读 iframe 窗口改为 postMessage 握手：`{aob:'get-camera'}` → `{aob:'camera', camera}`。camera 校验照旧 position/target 各三有限数。
- `server/content.mjs`：HTML 注入泛化为多脚本头（原 withScript → withHeadTags）。`m` 令牌 = fold + 就绪探针 + 有存档竞技场视角时桥恢复（不抓取）；`w`/`p` 令牌无校准仍原样伺服，有视角则恢复（arena 优先回退 gallery），`?aob=bridge` 注入 `__AOB_CAPTURE__`（`?face=` 选起步面）。`/__aob__/` 虚拟路由：three.mjs 仅 https、ad 路由校验 base（https 或同源路径，拒 `..`/反斜杠/虚拟前缀自身）。
- `library.calibrationOf(work, face)`：统一读取有效分面校准（curated→work_overrides，upload→trial/calibration_arena），curated 缺 taskId/id 时返回 null（测试桩形状防御）。`POST /api/arena/matches` 响应新增 `calibration.a/.b`（仅 framing；camera 由内容服务器页内恢复，不下发）。契约文档 §3.8/§3.12 已同步。
- 验证：npm run check 76 文件 0 错；npm test **191/191**（新增 test/bridge.test.mjs 7 项：importmap 改写/虚拟路由校验/标签次序/camera 校验/内容服务器按键型注入集成）。platform.test 两处对局响应形状断言随契约更新加 calibration 键。注意：node fetch（undici）会忽略自定义 Host 头，内容服务器测试须用 node:http。
- 未做：推送、部署、前端消费（期B 后台校准面板、期C Show1 应用 framing——朋友的活跃区，动手前先打招呼）。无数据库迁移。
## 上传档位与服务商必填（2026-10-01，本地实现并提交）

- 新投稿（普通、题目示例、管理员直传、收件箱登记）强制非空 effort 和 official/unofficial providerId。PATCH/meta 禁止显式清空，省略键保持旧记录；通过核验前补齐两项，标记存疑和退回流程保留。新写 generationMode 仅 single-turn/multi-turn，历史 agent 在省略字段时保留；数据库迁移、存量行与投票快照未改。后台表单同步必填及两项生成方式。仅更新受新契约影响的原有 fixture，在既有 provenance 测试补缺失/空白/清空/agent 400 断言。
- check 74/0、test 184/184（0 fail/cancel/skip）；跨仓真实隔离 integration smoke 通过；git diff --check 通过。早期测试因旧 fixture 省略新必填字段失败，补齐声明后全量通过。未操作生产或业务库，未调用真实 SMTP、截图服务、Luna。
- 忽略的 output/submission-options-test*.log 与定向测试日志保留；无其它未提交改动。
- 本轮未推送、部署或切换生产 pin；详见 [本轮归档](docs/archive/2026-10-01-submission-options-wsnxxxs.md)。


## 本轮：四仓最新状态整理与部署（2026-10-01 Brisbane，功能与数据已部署）

- 用户授权整理、合并、提交、推送及部署四仓，并确认 Gallery 的 11 个既有未提交文件一并提交部署。此前轮次的“不部署、不切换 pin”不适用于本轮。按指定 GPT-6.1 Sol medium 分工，提交身份为 GitHub 核对的 wsnxxxs / noreply；不强推、不覆盖他人有效远端修改。
- 主站主题分支已快进进入上游与 fork 的 main（功能基线 `72c7f10`），保留 Atmeplz 原提交并删除已合入的远端主题分支。Gallery `e23d9a5` 已推送并通过 CI；数据源码 `997676d` 发布的不可变包为 `ba442b61d39e7b2892143ac8a27dcf9aa2607de6`（20 题 / 182 件），数据仓文档后继 `c14bb30` 已推送并通过 CI，消费者固定内容包，不追随文档发布。
- 部署前已调查线上后端 `2448803`：155 个 tracked 文件除 CRLF / LF 外与已合入提交一致，没有未知补丁。线上 Gallery 的入口与媒体缓存补丁已完整进入 main，最终 LF 构建保留两项修改。四仓无开放 PR；旧 worktree 的历史输出与依赖链接保留。
- 2026-10-01T10:37:25Z 已部署后端 `23574fbf02bd56f2e0318e827ae8a05c11b36812`，生产 Node 22.23.2 的 check / test 184/184 通过，数据库升至 v25，立即切换前后业务表计数一致，integrity_check 为 ok。备份和证据在 `/root/aob-final-release-20261001/`，一致性数据库及旧代码在其 `backup/`；服务与审核 tunnel active，capture / contentModeration / autoModeration 均开启，环境与 Nginx 未改。
- 2026-10-01T11:26:56.467257Z（Brisbane 21:26:56）已切换 Gallery、Show1 和新数据：Gallery `e23d9a5`，Show1 功能基线 `72c7f10`；后端和 Gallery pin 同为 `ba442b61`。2366 个数据文件与 Git 规范字节、Gallery 2417 文件、Show1 820 文件均逐项 SHA256 / 精确文件集合通过；总入口 1 文件与规范产物相同，无需切换。Gallery 与 API 的 catalogDigest 同为 `ee927cc83ceb774170a86e33bfa6b66453a8c50957329eb4f01a0584b2311ae3`，20 题 / 182 件，schema 1 / sourceDirty false。
- 公网三个首页 200；浏览器 Gallery 182 份、Show1 纸面首页 / 登录注册入口 / 25 题提示词库与动画封面、总入口两站链接正常，console error 0。Gallery / API 的来源标记、build-info、posters 均 404。数据库 v25 / integrity ok；users 27、works 268、votes 0、questions 5、comments 16、reactions 56、matches 3 保持。未创建生产测试账号、投稿或投票，未触发外部 Luna 付费调用；viewport override 未生效，实际 609px 页面无横向溢出，未宣称完成精确移动端验收。
- 本轮收尾提交仅更新 pin、交接和部署文档，功能基线仍为 `23574fb`。正式源码与收尾 main 对齐后，完整运行 SHA 以 `.server-version` / 公网 bootstrap 和 `/root/aob-final-release-20261001/final-server-version` 为准；静态产物仍对应上述功能提交。旧 `.datapack/versions/39a2fa4…`、Gallery / Show1 的 `.prev` 及历史 `.prev.bak-*` 均保留。完整验证、备份和回退边界见 [latest-release](docs/archive/2026-10-01-latest-release-wsnxxxs.md)。下方“未部署”等是早期轮次记录，已由本节覆盖。

## 本轮：上传审核链路收口与移除 Harness 版本（2026-10-01 Brisbane，实现与验证完成，未部署）

- 用户最初要求仅本地实现，现已明确把数据仓配套纳入本轮，数据仓单独一条 commit，再与后端修改一起推送远端；不部署、不切换消费者 pin。已按指定 GPT-6.1 Sol medium 分工；GitHub `/user` 核对负责人为 wsnxxxs（269096463），提交使用对应 noreply 身份。本轮不新增迁移，不清空 `harness_version` 存量值，只停止读写和输出，保留已发布迁移及数据库列。
- 已实现：截图启动实际探测并打印能力状态，导入/启动失败后冷却五分钟由新作品重试，视口失败用新 context 再试一次；`site.autoModeration` 随开关、密钥与当前截图能力变化。作者作品和题目只见 status / at、拒绝时 reason；管理员保持完整审核结果。`review.unverified` 只算内容已放行的未核验作品，`review.content` 只算 review，pending / rejected 不计入。人工通过理由选填，空白保存「人工复核通过」，通过/拒绝/重试保留审计与 arena 刷新；后台禁用未放行内容的核验按钮并提示，版本表单与展示已删除。
- 用户最终指定：管理员直传与收件箱 `publish:true` 等同人工内容审核，登记时记录 approved / human、管理员名、「管理员上传」及时间，写 `content-review` 审计后核验 verified，不送 Luna（仍可生成截图）。仅登记收件箱照常自动审核。内容未放行的 409 检查只在普通 `POST /api/works/:task/:id/review` API。此前暂定未验证登记方案已被此规则替代。
- Harness 版本在上传、PATCH、review/meta、inbox 均忽略（含旧空串、非空及其它类型），不再出现在作品 DTO、catalog 作品、arena 身份、收录导出或送审文字中；版本单独 PATCH/meta 为成功空操作。测试覆盖旧数据库值不变、旧数据包/快照读取剥离、忽略版本不触发重新审核、作者裁剪、队列计数、三种未放行状态 409、人工理由默认及审计、管理员两路径审核开启时一步发布且不送 Luna、示例内容先通过后随题目通过自动公开。契约及部署文档已同步。
- 验证环境 Windows Node 24.16.0：`npm run check` 74 文件 / 0 错；最终 `npm test` 连续两轮 183/183（0 失败、取消、跳过），`git diff --check` 通过。首轮 182/184：新增截图测试的测试器反序列化错误（六项断言均通过），以及既有安全测试随机端口被 fetch 拒绝；第二轮 183/184 仅剩前者。统一捕获截图夹具常规日志后完整测试通过；安全定向 4/4 通过，未修改无关安全测试。SQLite/邮件/relay 故障日志为既有故障注入断言输出。
- 实际 `server/index.mjs` 用系统临时目录、隔离库和随机监听端口验证 CAPTURE=0、CAPTURE=1 且本检出缺 Playwright：均只有一条能力日志并正常启动，临时进程及目录已清理。未安装组件、未跑真实 Chrome/外部 Luna、生产 Node 22 或 Gallery/后台浏览器联调；未操作生产、本地业务库、后端数据包或消费者 pin。用户已授权本轮提交和推送，归档及源码一起纳入每仓一条英文提交；最终版本及远端检查结果以 Git / Actions 为准。
- 后续收口：`review.unverified` 再要求不传 viewer 的 `catalog.task(work.taskId)` 可查到公开题目，待审题目的已放行示例不计入，题目通过后自动计入。已确认 catalog 的 viewer 缺省为 null，社区题目经 questions.get 仅公开 legacy / approved 且未删除记录；回归同时断言待审题目仅管理员 viewer 可查到。新增测试先复现旧计数 1 ≠ 0，修复后 `npm run check` 74/0、`npm test` 184/184（0 失败、取消、跳过）、`git diff --check` 通过，契约同步；仍未提交、推送或部署。
- 数据仓配套已同轮完成：intake/provenance 忽略旧 Harness 版本，收录记录、README 来源说明和新构建不再输出；无需改原作或存量 manifest/task（实际无该字段）。data check 30/0、test 16/16、完整 build:data 182 件 / 20 题、check:intake 0 错 / 9 条既有提示；字段计数为 0，77 官方 / 1 非官方 / 104 未填保持。当前后端直接只读该新包验证 20 题 / 182 件及两项 providers 通过，不替换后端 dist 或 pin。data 独立一条 commit，与本仓一起按用户授权推送 main；既有 data CI 会发布不可变数据包，消费者不自动切换。完整归档：[upload-moderation-harness](docs/archive/2026-10-01-upload-moderation-harness-wsnxxxs.md)。

## 服务商二值联调与推送收尾（2026-10-01 Brisbane，未部署）

- 用户授权完成 Gallery 前端提交、隔离联调、文档与三个仓库的推送。保留后端功能提交 bd7744e 和数据仓功能提交 0f68eca，本轮后端仅补交接与归档，使用 wsnxxxs 的 GitHub noreply 身份提交并推送 origin/main；最终提交号与 Node 22 CI 结果见 Git / Actions。
- 当前后端代码在独立数据库（v25）与 Gallery 浏览器联调通过：非官方上传；作者编辑为官方、清空、非官方；管理员把官方改非官方并通过审核。五次写请求均 200，仅 providerId，无 providerOther/providerName；公开 bootstrap 两项 providers、作品二值/null 且无 providerName。
- provider=unofficial 榜单成功，filters 回显、1 票 / 1 人 / 2 配置正确。真实跨仓 integration smoke 通过；Gallery 当前源码 check 43/0、test 14/14，匹配的 182 件本地包严格 intake 0 错 / 9 条既有提示。后端源码未变，沿用上一轮 check 73/0、test 175/175、来源定向 7/7。
- 没有部署、写生产库、更新消费者 pin 或替换后端 dist。Gallery 当前固定 121 件包严格 intake 仍因旧海报指纹产生 121 错 / 4 提示；部署前应选择已验证的匹配数据包。先完成后端 v25 迁移，再启用 Gallery 二值写入与榜单筛选。归档：[provider-binary-integration](docs/archive/2026-10-01-provider-binary-integration-wsnxxxs.md)。下方未推送/未联调是原实现轮次状态。

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

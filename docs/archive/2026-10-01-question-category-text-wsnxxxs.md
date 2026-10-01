# 2026-10-01 · 题目分类与文本投稿 · wsnxxxs

- 负责人：wsnxxxs ｜ 执行 AI：Codex；数据、文本与测试子任务使用用户指定 GPT-6.1 Sol medium

## 本轮目标

配合 Gallery 的固定单选分类与补充标签，按分类约束提交格式，支持文学题文本草稿；清理私有数据仓库的重复分类标签。用户当轮指令授权功能完成后用英文简单句本地提交，不包含推送或部署。

## 改动

- 只在 MIGRATIONS 末尾追加 v23，可空 category 与幂等回填，保留已有分类。数据包原 category 保持，缺少非空 templates 按文学 text / 其它 static+vite 推断。
- 建题两条路径都要求有效 category；tags 缺省为空数组，沿用原标签规范与大小写去重，丢弃与分类同名的标签。templates 必须符合分类；公开、作者和管理员 DTO 返回 category 与 templates。
- 审核通过可补或改分类，缺分类返回中文 400；拒绝忽略分类。改分类后不兼容的格式重置默认值，question-review detail 记录 category / templates 的 from、to。既有分类榜单按新增平台分类正常归集。
- 文本只接受单个 UTF-8 txt/md/markdown，uploadBytes 与 200000 Unicode 字符上限。安全 Markdown 子集只生成后端自己的标签，原 HTML、链接和图片语法转义/保留为文本，不加载外部资源。纯文本保留段落换行。保存 index.html 与原字节 original.<扩展名>；生成页面采用衬线正文、适中行宽与系统深浅色，继续经过现有试加载、审核、截图和核验流程。行内代码只支持一或两个反引号，围栏代码正常支持，避免长未闭合反引号带来的慢解析。
- 新增 categories.mjs 与 text.mjs，改动问题、数据库、catalog、library、入口路由、相关测试及契约文档；没有 npm 依赖或前端修改。
- data 子代理清空 15 道纯分类 tags；其余 5 道内容标签保留，空数组已有兼容，无需改校验代码。data 提交 a2f8f95：Remove tags that repeat question categories.

## 验证

- 本地 Windows Node 24.16.0：npm run check 72 文件 / 0 错；最终 npm test 167/167，0 失败/取消/跳过，约 9.3 秒；git diff --check 通过。
- 覆盖迁移优先级、幂等与保留分类；缺/非法分类及格式不匹配；空标签与同类标签丢弃；审核补/改分类、审计、兼容格式保留、不兼容重置、拒绝忽略分类；bootstrap/me/admin DTO。
- 文学真实 API 测试覆盖 Markdown 草稿、带示例建题、普通文本作品提交、私有/草稿预览、安全 HTML 转义及原件读取；ZIP 与无效 UTF-8 经草稿接口拒绝。单测覆盖文本格式、安全 Markdown 子集、txt 段落换行、二进制/扩展名/字数上限，以及长未闭合反引号。
- 数据包缺失或空 templates 时文学推断为 text，拒绝 HTML；通过核验且开启 arena 的平台文学作品进入文学分榜，静态网页分榜排除该作品。
- 测试中的 sample insert failed / question audit failed 为现有事务回滚故障注入的预期日志，所有相关断言通过。
- data：check 28/0，test 16/16，intake 121 件 / 0 错 / 4 既有提示，完整 build:data 20 题 / 121 件；生成 tags 与源逐题一致，生成物未提交。

## 明确没做

未修改 Gallery 或后台前端，未推送、部署、修改生产库或消费者数据 pin；未手改 dist/.data 等生成物。未运行生产 Node 22、浏览器视觉验收、真实 Luna 内容审核或截图服务，原因是本轮采用本地后端自动测试验证接口和文件通路。

## 遗留物

后端及 data 各一条本地提交。消费者目前仍使用原固定数据包；data 构建产物属忽略的本地生成物，未发布为新的不可变数据包。

## 下一步建议

按既有发布流程将 Gallery 分类表单、后端 v23 与新的不可变数据包配套发布。后端 catalog 观察发布目录 realpath / 版本变化，无需为本轮单独改缓存或手改已发布包。

## 补充（2026-10-01）

- 与 Gallery 本地联调后，文本投稿去掉无意义的 README 检查项（`server/inspect.mjs`），`test/text.test.mjs` 断言不再出现；check 72/0、test 167/167。联调范围与未验证项见 Gallery 归档 `2026-10-01-question-categories-wsnxxxs-2.md`。

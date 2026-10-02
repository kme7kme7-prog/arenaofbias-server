# 2026-10-02 · 审核流程统一与按面决定 · wsnxxxs

- 负责人：wsnxxxs ｜ 执行 AI：Codex；三名 GPT-6.1 Sol / medium 子代理。

## 本轮目标与范围

完成用户提供的任务 B，配合 Gallery 任务 A 与已完成的管理台审核整理。后端仅纳入 admin 审核界面、db/library 按面记录、必要 schema 夹具与回归、API 契约和本轮记录。

## 改动与决策

v30 追加 works.reviewed_gallery_at / reviewed_arena_at，已 verified/questioned 行按 COALESCE(reviewed_at, updated_at) 回填，unverified 保持 null。显式 show_gallery/show_arena 的核验与单件、批量开关记录对应时间；娱乐开关不记录，馆藏不输出 reviewed。保留内容 409、核验档位/服务商、存疑原因、bootstrap 计数口径。管理台待处理分组、独立内容弹窗、登记信息先保存、就地示例、队列接续及娱乐开关修复随本轮保存；核验时间判定优先于已开启的展示开关。

既有 v29 questions.domains 迁移为序号依赖必须位于 v30 前，故仅纳入此结构依赖；其余领域功能、内容加固与邮件等改动不纳入。混合文件的暂存版本由 HEAD 与本轮精确差异合成。用户已要求每轮修改后英文简单句提交；使用 wsnxxxs noreply，两仓分别本地提交。

## 验证

- 当前混合工作区：check 81/0、test 215/215；独立导出暂存源码：check 81/0、test 207/207；diff --check 通过。
- 回归覆盖单面通过、关闭另一面不改 status、娱乐开关不记录、馆藏不输出、旧行回填与迁移重入；旧 schema 夹具只调整必需字段与两列 null 预期。
- 浏览器使用当前真实隔离后端与合成数据，跑通 Gallery 核验和 Arena 仅展览馆核验→待作品→暂不进盲测→未进盲测；已开启但无本面时间的投稿也进入待作品，再关闭后转未进盲测。桌面与 375 宽截图目检，Gallery console 0。
- 管理台 iframe 资源 404 来自验收服务未提供作品域路由，无页面 JS 异常；不代表真实作品执行验收。

## 明确没做

未推送、部署、操作业务库、修改私有配置、发送真实邮件或调用真实自动审核/截图服务。浏览器使用混合工作区，不是独立提交快照；源码暂存快照已单独执行 check/test。未对全部作品执行与生产账号重新验收。

## 遗留物与下一步

他人未提交领域、内容安全和邮件等修改原样保留。修改前快照、候选、日志与导出位于相邻 Gallery 忽略目录 output/review-redesign/current-round/backend/ 与 backend-staged/；浏览器证据在 output/playwright/review-redesign-current/，临时服务和浏览器已关闭。后续领域会话应保留已提交 v29，不重写迁移顺序；正式发布另行授权。

# 2026-10-06 · 内容摘要锁定、归属按当前信息 · wsnxxxs

## 2026-10-08 提交补记

- 用户另行授权将本轮现有实现、HANDOFF 和本归档单独本地提交，负责人 wsnxxxs（GitHub noreply 邮箱），英文一句话提交信息；不 push、不部署。
- 提交前本机复验 check108/0、test320/320、git diff --check 通过，与下述历史记录一致。本次未重跑 Linux 和生产副本门禁；历史“没有 commit”描述的是 2026-10-06 当轮状态。
- 推理类别另轮处理且完成后不提交。上线先部署归属计分、后部署推理；部署前重新采集最新一致副本，重跑五项门禁，部署和类别迁移须另行授权。

- 负责人：wsnxxxs ｜ 执行 AI：Codex（GPT-6）。用户要求本轮不commit、push、部署或修改生产数据。

## 本轮目标

投票只固定作品ID和内容摘要；排行榜及来源筛选按同内容作品当前信息计分，显式人工更正优先。最终按用户确认的五条门禁复核。

## 改动

- arena归属解析改为显式人工更正、同ID+同digest当前作品、快照。数据包入口页和上传digest同规则，忽略taskId匹配；换题票回查留在原题的对手。重新计算effort/model/config键。
- 新人工更正增加manual:true。历史审计区分三种自动原因，包含c1fe9a5早期上传自动逻辑；其余显式逐票更正保留最高优先级。历史correction/快照/审计不删不改，无数据库迁移。
- 移除library及投票时自动逐票更正，移除废弃reconcile:attribution工具；correct:vote保留。包display modelId成为实际归属。已登记榜单名称/厂商取注册表；未登记取当前pool、最新票、最早sample。来源筛选现查，核对现有缓存失效路径。
- Show1在输入聚合层使用相同归属；新票存digest，旧缺digest票仍取快照，Elo/radar方法不变。补必要回归，改写依赖自动写correction的旧断言。

## 验证

- Windows和WSL Ubuntu，Node24.16.0：最终check108/0、test320/320；git diff --check通过。覆盖上传编辑/审核、换题再改模型、不同内容保留快照、包同digest登记和不同digest回退、来源筛选、同配置作品隔离、下架和人工优先级。
- 最新一致副本：2026-10-06 23:32:29 Brisbane / 13:32:29 UTC，以生产只读SQLite连接backup到远程内存后输出SQL；不在生产落临时库，不停服/改业务数据。5305票、732作品、185用户、5760matches、2751审计，v40，integrity ok、外键0。本地恢复并核对。
- 旧代码取实际生产23e389507124b06da86dd56bc69c97b84390039f运行文件，与HEAD仅换行差；包bfaf4f3e6e13b82c25049cba02ad466c8c10076b的2288内容文件SHA256匹配，来源说明另存忽略证据。
- 新旧config有效票5107/参与者140完全一致，model5017/140完全一致；逐票集合一致。0模型/配置键迁移，106配置比较次数均不变。485侧字段变化全部同ID+同digest，11组逐项原因见报告。143侧显式人工更正全部不变，包括滕王阁GPT-6.1 Sol Max6侧。
- 排行差异只有5条config/3条model名称或厂商：两组Qwen厂商变Alibaba；MiniMax M3.1变MiniMax M3.1 Flash Preview。全部分数/比较次数不变。Windows/Linux完整副本回放输出完全一致；Linux挂载盘慢速尝试中止，最终本地临时目录回放通过。
- 10-04旧副本仅参考，后续发布不得用它放行。用户已接受归属转移引发Bradley–Terry全榜重拟合；判定不再以分数联动为异常。

## 明确没做

没有commit、push、部署、生产业务写入、重启服务、修改Gallery/原作/数据包pin/库结构；没有生产登录/投票或浏览器全交互验收。本仓无build/check:intake脚本。

## 遗留物

忽略output/content-attribution-20261006/final-review/保留只读快照、实际旧源码、完整逐侧/逐组报告、Windows/Linux回放及check/test日志；含私有数据，不入提交。Linux临时回放目录/tmp/aob-content-attribution-iTckKk保留。不无差别清理旧证据。

## 下一步建议

本地实现及本次最新副本复核完成。实际部署仍须另获授权；部署前必须重新采集当时最新生产一致副本、旧运行代码及正式包，重跑：票数/参与者一致、逐侧同ID+digest及原因、未迁移配置games不变、模型榜允许原因、既有人工更正保持。任一失败先停下报告；不得因本次通过跳过后续新库/新包/新代码门禁。

# 2026-10-16 · Curated frontend ranking API · Atmeplz

- 负责人：Atmeplz ｜ 执行 AI：Codex；无子代理。

## 本轮目标

按用户确认的36题重算精选榜，排除未收录/暂定模型，配合Gallery实时读取并按授权提交、推送和上线。

## 改动

公开leaderboard接收board=frontend，固定名单独立定义；范围/来源/计分单位进入缓存，投票与作品变化沿用现有失效机制。模型级资格过滤rows/unranked并连续编号，配置榜复用模型资格；保留有效对手比较及旧榜行为，更新API契约，新增3项回归。提交号由本归档所属提交确定。

## 决策

资格按同36题、同来源条件重算的模型榜，不使用全量综合榜；只认Gallery models及别名，不把猜型号modelPool视作收录。模型少于30次比较暂定，不能上榜；合格模型的单配置可暂定。无schema迁移或npm依赖。

## 验证

源码check124/0、357/357；以现场runtime为基线仅应用3文件功能改动的候选也check124/0、357/357。Linux候选与线上API验收将在push main后的发布阶段运行，完成前不提前记为成功。最终证据和备份位置记录在工作区父级HANDOFF及私有curated-release-20261016目录。

## 明确没做

不覆盖现场其他补丁，不改生产业务数据、Nginx、数据包或作品；生产SQLite备份仅留VPS受限目录，不上传GitHub。

## 遗留物

本轮相关源文件和交接统一提交；本地快照与发布工具为私有忽略文件，其他仓库不改。

## 下一步建议

仅在确认目标提交位于上游main后增量部署app、arena、curated-boards，保留现场library/questions和其余运行文件；失败回滚代码，不回退新业务数据。

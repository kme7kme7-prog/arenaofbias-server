# 2026-10-17 · 公开排行榜十分钟快照（本地完成，未发布）

- 范围与人员：用户要求Gallery排行榜十分钟计算一次。主代理独立实现，未使用子代理；基于最新main。无新增依赖、无数据库迁移或生产业务写入。

## 改动与已定行为

- 新`server/leaderboard-cache.mjs`为公开结果提供600秒窗口，按需生成，合并同键在途计算；期限从成功完成开始，失败可重试，过期条目在读取时清理。清除期间的旧计算不能重新写入新缓存。
- `arena.leaderboardSnapshot`按包版本、题目/题型/领域/精选范围、model/config与来源筛选建立独立快照；公开`GET /api/leaderboard`改用此方法。增加`refreshIntervalSeconds:600`与`nextUpdateAt`，保留原`updatedAt`实际计算时间；各账号读取相同公开结果，不含私人字段。
- 新投票只使内部实时缓存失效，不影响公开十分钟快照。默认`arena.invalidate()`仍清除公开快照，保留审核、撤下和归属更正失效行为；换包自然换键。内部盲评抽样、作品推荐与totals继续使用原实时路径。
- API契约已更新。增加缓存并发/期限/失败/失效回归；两处旧HTTP生命周期断言按新需求改为「公开票数暂不变、内部已计票、管理变更后公开更新」，其余计票及权限检查保持。

## 验证

- 本机check126文件/0错误、完整test359/359。Mac使用`TMPDIR=/private/tmp`避免既有/var路径规范化夹具差异。
- VPS候选以现场源码为基线，仅替换app接线、arena和新增cache模块；保留arena-only及社区提示词版本等现场功能。配最新主线测试在Node22.23.2上check126/0、test359/359。初次隔离测试因缺datapack.json导致清包CLI失败，增加无凭据占位pin后完整重跑通过；没有修改测试来掩盖这个环境问题。
- Gallery check78/0、test51/51、local-source build176件/76site、严格intake0错/8既有提示。完整本地页面与新API用合成票核对范围隔离、相同响应、更新时间与中英切换；没有生产投票、刷新发布或真实十分钟墙钟验收，精确期限由可控时钟测试覆盖。

## 未发布与遗留物

- 尚未commit、push、部署、重启服务或安装新模块。生产运行文件摘要和MainPID/NRestarts0保持。
- VPS原有四运行文件含主线外差异，不能整仓覆盖；已准备保留差异的候选，但本轮没有将历史功能并入main。发布仍需遵循提交授权与现场核对规则。
- 私有候选与测试日志在VPS原root检查目录的`leaderboard-candidate/`及`leaderboard-linux-*.log`；业务库仅存在先前root私有检查副本，未下载本机。占位pin、测试数据和运行配置不入库。
- 本仓待提交文件为三运行文件、两项既有测试、新缓存测试、API契约与交接归档；Gallery页面改动在独立仓。后续获授权时每仓一条英文提交，不提前宣称上线。

## 发布授权补记

- 用户后续明确回复「授权提交、推送并上线」，此前未授权描述为当时状态。当前认证GitHub身份wsnxxxs / 269096463+wsnxxxs@users.noreply.github.com，按每仓一条英文提交推送main后增量发布。
- 已完成源码和保留现场差异的Linux候选验证；发布前备份SQLite及目标文件，保留生产数据、配置和其他功能。此补记在提交前写入，实际提交号、备份及公网验证结果存Gallery忽略目录output/leaderboard-ten-minute-20261017/release/。

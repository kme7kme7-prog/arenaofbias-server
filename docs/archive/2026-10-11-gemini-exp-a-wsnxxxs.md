# 2026-10-11 · Gemini exp-a 数据包消费 · wsnxxxs

- 人员与范围：负责人wsnxxxs，执行AI Codex；本仓仅消费固定数据包pin，模型注册表由私有数据仓维护，Gallery发布目录。
- 本轮目标：让新增Gemini 4.x（灰度） - exp-a选项可用于收录。
- 改动：datapack.json固定到已验证新包，正式ID gemini-4.x-exp-a，Google品牌及两个别名；原灰度模型保持。无运行代码/schema修改，线上运行版本a86b24ca保持。更新根交接及本归档，各涉及仓各一条英文提交，不push源码main。
- 决策：新旧灰度独立；只读查询没有同名自填作品，无需业务数据库改名。原包2287资源字节保持，不重复编译无变化作品；无停服切换验证目录。
- 验证：Windows check115/0、test332/332；2288包文件SHA/Git blob通过，2287资源与旧生产逐字节相同。后台正式名称及两个别名→新ID，旧名→原ID；公网bootstrap指向新包、Gallery目录字节一致、check:deployment包兼容/CORS通过，完整2353Gallery文件仅data.json变化。service active/running/NRestarts0。Gallery检查/测试/构建/CI收录检查及共用表单双宽目视通过，详见其同轮归档。
- 明确没做：无业务数据库写入、无运行源码发布，未生产登录/保存投稿/投票，未跑Linux全套单测或全部作品互动。
- 遗留物：忽略output/gemini-exp-a-test.log；Gallery/output/gemini-exp-a-20261011/保留发布证据。服务器/root/aob-gemini-exp-a-20261011/backup/保留旧pin、包路径和Gallery目录；旧包未清理，无未提交业务文件。
- 下一步建议：无待确认事项。

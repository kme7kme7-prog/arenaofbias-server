# 2026-10-11 · Gemini exp-a 撤回 · wsnxxxs

- 人员与范围：负责人wsnxxxs，执行AI Codex；数据仓只撤回gallery.json中新增模型及README计数，Gallery验证消费目录，后台只回退datapack.json消费pin。
- 本轮目标：按用户指示删除刚新增的Gemini 4.x（灰度） - exp-a。
- 改动与决策：删gemini-4.x-exp-a和两个别名；原Gemini灰度保持。数据gallery.json/README与新增前完全一致，生产只读复核无作品引用新ID；无业务数据库改动。消费新增前已验证固定包，不另发新包；源码各仓一条英文提交，不push。
- 验证：数据check33/0、test9/9、严格intake176件/0错/8既有提示；Gallery check68/0、test33/33、build176件/70site、CI intake0错/8既有提示；后台check115/0、test332/332。线上包2288文件逐SHA、2287资源字节保持；Gallery完整2353文件仅data.json变化，公网目录与构建字节一致、bootstrap包正确、check:deployment兼容/CORS通过。后台新名称和别名返回无登记、原灰度保持原ID；service active/running/NRestarts0，无停服。共用表单确认新选项不存在、旧选项保留，桌面/390宽无横溢、手机截图目视、控制台0错误/警告。
- 明确没做：未生产登录/保存投稿/投票、未验全部作品互动/真机；模型注册状态恢复此前验证状态，无资源变化，未重复完整build:data或Linux全套单测。初次本地安装尝试重写既有不可变缓存被工具拒绝，改为校验并复用；首次生产校验脚本重复读取同一资源清单导致迟缓，在激活前中止，改为只读取一次，最终核对和发布通过。
- 遗留物：Gallery/output/remove-gemini-exp-a-20261011/保存验证、发布日志，output/playwright/remove-gemini-exp-a-*保存手机截图；临时预览和浏览器已关闭。服务器/root/aob-remove-gemini-exp-a-20261011/backup/保留撤回前pin/包路径/目录；旧包和前轮记录保留，无未提交业务文件。
- 下一步建议：无待确认事项。

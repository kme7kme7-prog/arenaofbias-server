# 2026-10-06 · Dots3-Note-Preview 联合发布与改登记 · wsnxxxs

- 负责人：wsnxxxs ｜ 执行 AI：Codex（GPT-6）；用户已授权提交、推送、部署和指定线上登记修改。

## 本轮目标

消费Dots3新登记产物，把指定投稿与其6次比较并入dots3-note，不改变模型ID、有效比较数或原票。

## 改动

- pin提交e9f32826e495eecb0019c0ae746fec81a0439933推送并上线；目标包bfaf4f3e6e13b82c25049cba02ad466c8c10076b、源d0fa56be9412bb788a8683527d003a52258013d0。
- 保持现有27fa2f7别名代码和v40；Gallery固定源码dbea8e7、资产5ad2894c7118400476fe77ae与后端连续切换。
- 以shadow经library.setMeta登记little-red-riding-hood/up-n2x66q0t为dots3-note；脚本显式DATA_DIR/DIST_DIR/CONTENT_MODERATION=0、capture:false，调用后arena.invalidate，已登记时跳过，保证重复执行不再新增meta审计。

## 验证

- 本地/Linux check109/0、test318/318；Gallery check64/0、test29/29、生产build176件/68site、严格intake0错/8既有提示。
- 公网和版本文件初始27fa2f7一致、目标已在origin/main，无删除/改名旧源码。私有包从Git不可变tag导出、禁用换行转换，2288文件逐blob验证再安装并记录真实正式来源；共用客户端未改。
- 新包4文件差异、0删除，本地试应用与服务器整树SHA通过。所有SSH标准输入上传两端SHA一致；固定Git archive暂存通过Linux检查；Gallery全量manifest与精确文件集合通过，version最后发布。
- 首次副本验证读到进程旧缓存，定位脚本漏invalidate并修复；全新副本最终验证首次编辑1件、6侧更正、7审计，重跑三项0。正式先停服并VACUUM INTO一致快照，再执行和重跑，结果相同。
- 有效比较维护前后4945相同；5232条票除a/b_correction逐列相同，6侧更正；718件作品除目标model_id/model_other/model_vendor/updated_at逐列相同，原审计相同、新增7条。integrity_check=ok、foreign_key_check=0行、user_version=40，active/running、ExecMainStatus0、NRestarts0。
- 公网bootstrap新SHA/包正确；旧x:dots3-note-preview消失，新dots3-note为Dots3-Note-Preview/rednote hilab、6比较/1作品。Gallery check:deployment和浏览器搜索目检通过，脚本警告/错误0；普通用户继续投票时公网总数会增加。

## 明确没做

未改游戏、原作、模型ID、Nginx或凭据。未进行生产登录、邮件、投稿、新增有效票、全交互、真机或旧标签页恢复验收；没有回滚数据库或清理旧包。

## 遗留物

服务器/root/aob-dots3-release-20261006/backup/保留旧源码、版本、current指针、Gallery、platform.db、before-deploy.db、before-registration.db；其他/root同轮目录保留演练、脚本和校验。Gallery忽略output/dots3-release-20261006/保留本地证据和失败尝试。凭据未落盘，其他会话文件未动。

## 下一步建议

本轮目标已完成；保留备份和旧数据版本以供回退及旧对局读取。

# 2026-10-10 · 上传空闲等待调整 · wsnxxxs

- 负责人：wsnxxxs｜执行 AI：Codex 主代理。
- 目标：按用户要求取消上传60秒断开，由Gallery提供小字提醒。
- 改动：新增deploy/nginx/upload-timeout.conf并记录API HTTPS include位置，client_body_timeout=1d，即24小时请求体空闲等待；0不是关闭该定时器的开关。其他站点、上传大小上限、后台运行模块、版本标记、数据包和业务数据不变。
- 发布：现场bootstrap与.server-version同为7c5ce104，fetch后确认该功能提交已在origin/main；不替换其运行模块。API配置修改前摘要门禁通过、备份后加入include，nginx -t成功才reload。Gallery完整2353文件仅三项改变，保留线上连接修复和媒体。备份/root/aob-upload-patience-20261010T063751Z/backup，安装1.907秒。
- 验证：npm run check 115文件/0错误，npm test 332/332；HTTP/1.1及HTTP/2匿名上传暂停70秒后继续，分别70.112/70.084秒正常401及Gallery跨域头。后台active/NRestarts0、Nginx active。前端check/test/build/intake、公网五文件摘要与check:deployment通过；桌面提醒12.5px灰色。没有后台build/intake命令，未测实际登录投稿、试加载、手机或最终提交。
- 决策：取消60秒空闲断开，改为24小时；不宣称完全无限等待。无待批准变更。
- 遗留物：本轮证据在Gallery忽略output/upload-patience-20261010/，生产备份保留。后台一条英文提交，不push；没有后台生成物或凭据入库。

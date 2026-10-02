# 2026-10-03 · Gallery 内置作品 CSP 修复 · wsnxxxs

- 负责人：wsnxxxs；执行 AI：Codex。用户要求修复线上 Claude 黑洞作品 iframe 拒绝连接。

## 改动

- 基于 origin/main 2915a49 独立工作区，只保存 read-zones.conf 的 host map 改名及三个作品路径 `frame-ancestors 'self'` 例外，以及 docs/deploy.md 对应说明。
- 线上 read-zones.conf 的 SHA-256 为 e1e5258fcb2efbb16a81adcb8b1b6d59fe068beaaf846d200effbaf42dc1ee01，与 origin/main 文件 CRLF 版本完全一致；此前线上修复未提交，后续发布恢复了旧配置。
- 提交并推送后仅部署该配置文件。配置应从包含本修复的主分支消费，避免再次部署旧版本覆盖。主工作区他人的审核、厂商、数据库与测试改动保持原样。

## 验证

- 独立候选：npm run check 87 文件 / 0 错，npm test 247/247，git diff --check 通过。
- 修改前公网目标作品与 Gemini、两个辅助载入页均 200，但含 frame-ancestors 'none'；Chrome 已复现。
- 推送时正式 nginx -t、reload 与修复后浏览器验证尚待执行，结果完成后追加。
- 无前端/数据构建变化，未执行 Gallery build/intake；未修改作品、数据库或部署其他后端功能。

## 遗留物

- 独立工作区保留该修复；主工作区未提交内容不纳入。生产上线结果以随后 HANDOFF 记录为准。

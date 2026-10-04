# 2026-10-04 · 题目参考图 · wsnxxxs

- 负责人：wsnxxxs ｜ 执行 AI：Codex 主代理与三名 GPT-6.1 Sol / high 子代理

## 本轮目标

按 Gallery 现有增量契约实现后端题目参考图，保留 API v2、追加数据库 v39，并用真实接口完成本地前端联调。用户明确不授权提交、推送或部署。

## 改动

- server/references.mjs：JPEG / PNG / WebP 文件头与容器检查、扩展名匹配、无损移除元数据、尺寸 / 清理后 bytes / SHA-256、临时上传、有序绑定、权限、24 小时清理和题目删除。只用 Node 内置模块；保留必要的 JPEG Adobe 色彩转换标记及透明度 / 动画像素块，不生成可选缩略图，不改变像素尺寸。
- server/db.mjs：只在 MIGRATIONS 末尾追加幂等 v39，新增 questions.reference_credit 与 reference_uploads 表和两项索引；已发布 v1–v38 原样。
- server/questions.mjs：创建及示例回调、高级管理员编辑、审计、公开作品锁定、DTO、删除 / 拒绝规则。来源限 80 个 Unicode 字符，说明限 40；文件名遵循契约 Unicode 正则并验证实际扩展名，id / name 均不能重复。
- server/app.mjs / config.mjs：bootstrap 限制 8 张 / 5 MiB，上传登录与邮箱门禁、drafts 限流、版本提示、媒体 GET / HEAD / OPTIONS、前端 CORS、immutable 缓存、inline 文件名与 nosniff。review 增量输出高级管理员题目清单，普通管理员为空，权限不扩充。
- 数据包参考图不复制、不保存非空后台覆盖，DTO 留空供前端回退。普通元数据编辑不再自动冻结包 prompt，既有显式覆盖保留。docs/api-contract.md 同步契约；新增三份测试及图片 fixture，既有角色迁移测试读取当前 MIGRATIONS.length。

## 验证

- npm run check：91 文件 / 0 错。最终 npm test：278 / 278，通过、无失败 / 取消 / 跳过。git diff --check 通过。
- 新增 16 项测试覆盖：三格式元数据移除与压缩字节保持、扩展名伪造、大小 / 过期、他人或他题 id、数量 / 文件名 / Unicode 说明与来源、顺序 / 改名 / 编辑锁定、审计、拒绝保留 / 删除、DTO、私密 GET / HEAD、CORS / 预检、v38→v39 保存旧行与幂等、事务失败回滚、示例提交。
- 合成真实 HTTP 数据包由 a 版本刷新至 b，新【参考图】提示词进入 bootstrap 与 admin/questions，普通标题覆盖保留；假包图片实际存在，但后台 reference_uploads 与存储文件集合不变。当前本地正式包腾势 Z 仍是旧工作区措辞，不宣称新版已经消费；真实 pin 未改。
- Browser 使用 Gallery 已有 dist 与包、真实后端、隔离数据库，Gallery localhost:4422 / API localhost:4423 跨源。参考原 mock harness 另写本仓忽略输出里的 real-harness.mjs，无参考图接口 mock：上传五张 JPEG、提交题目、审核卡片实际加载、编辑顺序 / 文件名 / 说明、公开、题面与大图显示通过，图片维持 2000×1333。
- 浏览器点击全部下载实际保存 ZIP，5 个文件的名称 / 顺序、CRC、字节数和 SHA-256 与服务端清理后的图片逐件一致（1,752,585 bytes）。事件监听等待超时，随后发现实际文件已在 Downloads 落盘并校验通过；不将监听工具超时称为产品失败。未捕获页面脚本 error / warn。
- 首次完整测试发生于并行测试文件落盘期间，272 项仅 ../image.png 原始名称额外断言失败；随机 id 存储不使用该名字作为路径，移除不在契约内的防御断言后通过。随后新增图片测试 / 包刷新等完成，最终结果以上述 278 项为准。

## 明确没做

未 commit / push / deploy，未接触生产数据库，未修改真实数据包、pin、数据仓、Gallery 前端、另一前端或其他轮次材料。未生成缩略图或接入可选自动图片内容审核，题目仍人工审核。未做完整图片解码、Safari / Firefox、真机、全部作品交互、生产账号 / SMTP / CAPTCHA 验收。

本仓无 build / check:intake 脚本，未执行这两项；联调用已有 Gallery 构建，未重新构建前端。测试成功不表示上述未执行项通过。

## 遗留物

本轮服务已关闭。忽略目录 output/reference-images-20261004 保留 real-harness.mjs、隔离 db-*、tests-final.log、db-evidence.json、zip-evidence.json、browser-references.zip 与 review / public / lightbox 截图。实际浏览器下载文件保留在用户 Downloads，仅本轮副本复制到 output；不清理他人文件或其他服务。Gallery 原 mock harness 未改。

开工已有 HANDOFF、datapack.json、四份已修改他轮归档和两份未跟踪归档原样保留，只在 HANDOFF 顶部追加本轮记录。

## 下一步建议

新版腾势 Z 题面与数据包参考图由数据仓发布流程交付后再更新消费者包；正式发布需要另行授权，使用固定源码并备份数据库后执行 v39。现有显式 prompt 覆盖应在发布前逐题确认，不自动删除覆盖值。

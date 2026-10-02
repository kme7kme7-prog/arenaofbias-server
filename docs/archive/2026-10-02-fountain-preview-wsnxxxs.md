# 2026-10-02 · 喷泉小模型与本机封面替换 · wsnxxxs

- 负责人：wsnxxxs ｜ 执行 AI：Codex，GPT-6.1 Sol / high 子代理实现预览

## 本轮目标

用户暂停 VPS WebGPU 处理，明确要求简化后的 3D 喷泉小模型，本机截图后替换错误封面。

## 改动

新增 `scripts/fountain-preview/index.html` / README：固定 Three.js 0.169.0，WebGL2 渲染、OrbitControls、GLTFExporter，无服务 npm 依赖。石池、水盘、中央水柱、弧形喷流和少量庭园构成小模型，支持旋转、复位和 GLB 导出；截图模式标注“简化模型预览”。本机拍桌面 1440×900、手机 390×844，原子替换投稿 up-ccnksbcp 的 first.jpg / mobile.jpg，保留原 captures 映射和 root:root / 0644。

## 验证

- inline module `node --check`、diff 检查通过，三个固定 CDN 地址 HTTP 200，本机两档最终画面完整，console error/warn 为 0。首次手机 resize 后立即拍图发生裁切，重新加载并核对画布尺寸后重新拍摄，未采用初次错误图。
- GLB 下载实际成功；等待 download 事件超时引起工具会话重置后，按本次导出的已知文件名找到生成文件并复制校验。829632 bytes、140 meshes / 141 nodes / 11 materials，glTF 2.0 header / 长度通过，无外部 buffer。
- 替换前核对原图 hash 和生产版本 83e43fe072a0280d86c76379d9964bd4a32eb4bd，备份后替换；公网两图 GET 与本机 SHA-256 完全相同、响应 no-store，生产 active。
- 新桌面 hash：`49f63db3fd7114c8b20b2738b08f6dd13b09d5340b46821bea7ce52bc120231c`；新手机 hash：`ff10bac7472c9cc20dc6cd9d27f30dbe1f3b4b68cadb20bcc433c5c97358ee63`。
- 本轮为独立浏览器预览和静态媒体改动，未执行无关的后台全量测试。

## 明确没做

没有修改投稿源文件、模型声明、馆藏数据包、数据库、截图等待或正式服务配置；没有处理 VPS WebGPU、部署其他本地代码或 push。封面明示简化模型预览，原作品继续作为正式投稿内容。

## 遗留物

忽略目录 `output/fountain-local-20261002/` 保存 GLB、参考图、简化两档截图、两张已发布图和上传脚本，不提交生成物。用户 Downloads 中已有 classical-garden-fountain.glb。root 私有 `/root/aob-fountain-preview-20261002-01a0fb12/` 保存原图、元数据、新图和替换脚本；旧桌面 hash `d6a607c9dcb482c097db89f7f5bca749278abb1abbe290ab17b95f242ac779df`，旧手机 `713167eb1da8c23e500594f261ff01df8311dbed069819e16ef173ed64e5323d`。需要恢复时按原文件名原子替换媒体并保持记录中的 owner/mode，无需恢复数据库。

## 下一步建议

模型可独立复用。以后重截此投稿时明确使用简化预览，避免重新用 VPS WebGPU 错误画面覆盖封面。其他服务和数据包待部署改动仍按原版本门禁处理。

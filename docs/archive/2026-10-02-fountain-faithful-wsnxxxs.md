# 2026-10-02 · 喷泉原作提取纠正 · wsnxxxs

- 负责人：wsnxxxs ｜ 执行 AI：Codex，GPT-6.1 Sol / high 子代理负责原作提取预览

## 本轮目标

用户指出手工重建的喷泉与库内小模型适配不同。本轮将其改为原作场景提取，使用同一 `.sbox` 管线，本机截图并纠正线上封面。

## 改动

替换 `scripts/fountain-preview/index.html` / README，新增仅环回监听的 Node 内置模块 `serve.mjs`。复用 data 的 `importArchitecture` / `packPreview` 与 Gallery 的 `readModel` / `result-previews`，保留原主体几何、世界变换、材质、纹理和庭院布局。提取副本读取原生 WebGPU 水滴位置、波高，按原 WGSL 生成静态水流；每四粒子稳定抽取一粒，不增大粒子或透明度。保留原生水层无深度测试的行为。最终包边界包含真实有限地面与四面围墙。

原作 HTML 只在忽略的副本加捕获接口和 GPU COPY_SRC；未经修改的备份与公网原作 SHA-256 均为 `83dc19d5667369026535f51a0996c5ad6a3c0e4cbe6a77bd003006b5898b0936`。模型静态化，不包含原作动态交互。

## 验证

- 本机提取成功，最终 16084 个真实水滴。`.sbox` 2348700 bytes（约 2.24 MiB）、v2、13 meshes / 13 geometries / 13 materials / 5 内嵌纹理，gzip、有限边界和纹理内嵌检查通过；模型 hash `8eb37494566cf512445a9897d13b89419817bc34fed7ff41c7bba29d46a000b1`。
- 使用 Gallery loader 重新加载已保存包，WebGL 桌面/手机渲染成功，console error/warn 0。最终两图在 DOM ready=true、画布实际 1440×900 / 390×844 后拍摄；一次过早拍摄的加载图没有上传，已覆写。修复静态水面被原水盘挡住、边界裁掉围墙后重新提取重拍；最后逐图核对原作。
- inline module、serve.mjs、Python 替换脚本语法检查及 diff 检查通过。没有新增服务 npm 依赖，未执行无关后台全量测试。
- 公网部署门禁和现场版本均为本人前轮记录的 `83e43fe072a0280d86c76379d9964bd4a32eb4bd`。仅原子替换 `up-ccnksbcp` 的 first.jpg / mobile.jpg，保留 captures 映射和 root:root / 0644。公网 GET 与本机两图逐字节 hash 一致、no-store；原作 hash 未变，service active。
- 桌面 hash `1949b27987933385853685248a9bf08153cc3f693328adb1e083c27b76dcbc39`；手机 `eee2b207da14a13ea2400e5d8b52743af790055d048cd7b65e7087c1ccafaca4`。

## 明确没做

未修改业务库、投稿来源声明、原作源码、馆藏数据包、截图等待或生产服务配置；未处理 VPS WebGPU、发布其他本地待部署提交或 push。新 `.sbox` 为本机交付文件，本轮公网替换的是两张封面。

## 遗留物

本轮原作备份、提取副本、`.sbox`、最终本机/公网图、模型及公网验收 JSON 位于忽略的 `output/fountain-faithful-20261002/`。替换前的手工重建封面与 owner/mode/hash 位于 root 私有 `/root/aob-fountain-faithful-20261002-01a0fb12/`；更早错误封面备份仍保留。旧手工 GLB 是上一轮的错误产物，本轮以原作提取包替代，不删除用户已下载文件。

只提交本轮预览工具和交接/归档，保留另轮 `bc040b8` 及未提交的 game/Gallery 会话调查交接；后者不会随本轮提交。

## 下一步建议

以后该作品封面采用原作提取包本机取图；等待 DOM 明确完成并核对画布尺寸。正式集成投稿交互小模型仍需按平台既有资源入口设计单独处理，不能仅替换媒体就宣称已写入馆藏模型。

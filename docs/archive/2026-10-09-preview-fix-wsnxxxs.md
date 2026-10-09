# 2026-10-09 · 预览复查修复 · wsnxxxs

- 负责人：wsnxxxs ｜ 执行 AI：Codex，三名 GPT-6 Luna Max 子 agent。
- 范围：预览制作工具和经审查的公开投稿媒体，不改业务服务器、数据库schema、原作、canonical截图或私有数据仓。

## 本轮目标

修复已确认的预览主体、材质、取景及过早截图问题，让模型与截图沿用同一源版本和制作流程；消费端减少默认模型请求。

## 改动

- scripts/bake-upload-media.mjs按task/id配方组合现有模型和截图baker，支持经验证capture-dir或真实默认页面自然capture-pages；1440×900、GET/HEAD-only、主文档SHA与本地源一致、按配方等待，无点击。合并两种模式时sourceDigest必须一致，输出标准模型/海报与720/q0.86 JPEG。没有新增npm依赖。
- scripts/bake-upload-previews.mjs尊重明确截图配方；窄范围材质override克隆源材质保留map，仅调整透明/深度属性；现有fallback保留显式opacity、roughness、metalness和depthWrite参数。
- scripts/upload-preview-adaptations.mjs合并审查成功的配方；分帧楼阁/山瀑等待20秒，787选真实飞机根并校准朝向，工地网保留原贴图，其他模型保留世界坐标的主体。16件GPU水面/光照、12件静态主体/表现不合适的模型及6件真实截图采用截图模式。新测试验证精确task/id、公共verified条件与模式选择。
- 安装42投稿预览：8模型/34截图，全部42都有真实截图。JPEG共1,949,436B、最大79,043B；8模型13,076,916B，其中1个4,214,098B仍大于3MiB，未为凑尺寸删主体。

## 决策

不把Shader/GPU水面替换为伪造静态体，不修改原作、点击人工开始页或重建缺失几何。69项清单42修复/18无明显问题/8需核实/1原作键帽缺失，后9项状态如实保留。Gallery按用户请求只加载一张卡，31个大模型不再自动首屏传输；未改私有包。

## 验证

- Windows Node check115文件/0错、test332/332；新增精确配方选择测试通过。HTTP夹具在脱sandbox环境完整通过，未改无关测试。本轮未跑Linux全量；生产88运行文件SHA逐项匹配提交内容。
- 统一工具混合模型/截图、16截图批次、真实Edge自动截图实跑；媒体与原作摘要一致。其他14候选实际Gallery333×185/160×128渲染检查；最终8模型与当前公网自然20秒原画面对照。6+5+8+7件当前Edge取证零页面/GET错误，慢山城75秒；16近期作品复用此前已验证的自然画面。
- Gallery check68/0、test33/33、build176件/70site、严格intake0错/8既有提示；公网42 DTO、58媒体SHA及5消费文件SHA通过，API部署兼容/CORS通过。公网反馈题桌面/390宽目视及工地、山城补测无横溢；实际首封面完整contain，只有一张eager/high。精确维港模型偏好初始0模型，悬停仅1ready且海报/canvas同框，切回截图canvas0、视口图片解码及淡入通过；两787海报在模型模式完整显示，折叠件通过实际+1件展开。控制台/页面错误及真实写请求为0。早期报告包含本地包先绘制与错误题名匹配，最终以维港、787及补测记录为准；不声称所有API卡ID完全一致或全部原作互动通过。
- 安装前一致DB备份integrity ok/外键0；完整2353Gallery文件、88运行源码、89组原截图摘要核对，源入口逐件匹配。生产DB v41/integrity ok/外键0，服务收尾active/running/NRestarts0；安装切换2.17秒。data.json/runtime-config.js不变。

## 明确没做

未写数据库业务记录、迁移schema、改源或canonical first/mobile；未改另一前端、私有数据包、Nginx，未push。未验证全部原作互动、管理员写流程或真机；原作/证据待核9项未冒称修复。

## 遗留物

本轮各仓一条英文提交，后台版本标记收尾同步。忽略证据output/preview-fix-20261009/，Gallery汇总review.json/review.md；生产备份/root/aob-preview-fix-20261009/backup/。旧备份与output保持。

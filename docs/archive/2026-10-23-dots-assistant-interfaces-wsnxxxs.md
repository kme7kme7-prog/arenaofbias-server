# 2026-10-23 · dots 管理助手与三个接口 · wsnxxxs

- 负责人：wsnxxxs ｜ 执行 AI：Codex 与同模型子代理

## 本轮目标

整理混合dots分支，独立高级管理员账号，优先落地隔离重截图、实际.sbox回读、人工复核流转；用户已授权提交推送与上线。

## 改动

真实 merge 整理 PR #24（队列外已有图片/源附件）与 #25（投稿封面、独立 WebP 海报），保留两支 ancestry 和性能修复。修正多材质网格 groups 以本地材质槽校验，单材质 Box groups 保持可用；审计只记录海报文件名和尺寸，不记录图片 Buffer。

为原令牌显式增加 admin:read/admin:write 并绑定新建独立高级管理员 dots。默认新令牌仍只有 moderation，原七项作品权限独立；没有 HTTP 自我扩权或通用转发。角色/令牌/绑定版本在正文后、异步 JSON 发送前和私密文件打开后重新校验；换绑、撤权、降级立即使旧请求失效。

新增异步隔离重截图：先取源版本，再提交作品、版本、桌面/手机尺寸和有界等待，返回 202/jobId；查询状态、分阶段错误和私有 JPEG 下载。复用现有安全 worker；源树异步分块哈希，状态轮询只核轻量元数据。单作在途去重、60 秒冷却、8 待执行/100 保留、1 小时保留/15 分钟截止，重启不重放。产物不自动修改原作、media/captures、封面、审核或公开状态。环境不可用单列，不当作作品拒绝依据。

新增当前 dots .sbox 原文件回读，works:read/attachment/no-store/源与 manifest/hash/path 校验，不二次 HTTP gzip。转人工与误拒绝重开须 reason+完整状态 version/CAS，只转 human review，审计保留原决定，不自动公开、截图或模型审核。

## 验证

本机与保留现场补丁的 Linux Node22.23.4 均 check166/0、527/527，0失败/取消/跳过。私有一致库副本49→51迁移、旧运行代码重开51与完整只读DTO/旧投影47项通过；不启动平台队列/维护。原生HTTP在途撤权/换绑/降级/删除、压缩成功/失败/identity、手工流转CAS/审计回归通过。真实沙箱worker HTTP5项及消费端7项通过。

最终公网 https://api.arenaofbias.icu 使用临时三scope Bearer、同dots actor，创建唯一隔离任务，实得800×600与360×640 JPEG；原完整work行、原文件树和原截图字节SHA逐项不变，审核状态版本不变。任务状态 succeeded；临时令牌finally撤销、活跃令牌数恢复，无Cookie/session或人工审核写入。任务表/私有产物、令牌/绑定审计是本次验收操作记录；没有用随机真实作品执行handoff/reopen。生产未找到可用的当前 dots 模型，未为验收覆盖预览；临时 SQLite 真实 HTTP 已验证上传→实际保存 gzip 字节→下载 SHA 闭环。

公开gzip/304、原及新私密匿名401、非法选择器400、可信CORS与非可信预检403通过；非可信GET无ACAO。schema51/quick_check ok/外键0，3服务active，84运行文件与候选SHA一致；捕获的Gallery顶层及vendor73文件、Game1720文件及固定数据包指纹相同。

## 明确没做

未提供服务端3D真实场景提取/导出任务；单纯重截图不会生成模型。没有任意URL/JS/shell/SQL/密钥或服务重启HTTP入口。未关闭浏览器沙箱/CSP/代理限制，未改Nginx/CDN、原作、模型注册、数据包、冻结引擎/i5/协调器或成绩。Gallery/Arena/Data本轮无源码更改，不制造空提交。没有声称覆盖所有可能安全问题。

## 遗留物

先部署PR24已有资产，Linux486/486与现有288691B图片回读通过，原七scope即可直接用。最终只增量14运行文件、三方保留现场补丁；版本后缀dots-assistant.5f57fc72a2db，重启2.38秒。账号dots为独立新高级管理员，原Bearertoken未重置；原其他令牌、scope和模式不变。没有生成/输出/保存明文账号密码，也无新浏览器session。

一致备份/root/aob-dots-assistant-20261023/backend-backup（前一资产发布备份在assets-release/backend-backup）。代码回退恢复对应文件、版本和systemd版本配置，保留新增50/51结构与当前业务SQLite，禁止旧库覆盖新业务。权限可先withdraw admin:write，或assistant-unbind；整令牌revoke关闭全部能力。

## 下一步建议

按[接口文档](../dots-admin-api.md)通过caps发现实际路由，截图先取source version再建任务，下载验收后再决定是否另用原captures:write发布。服务端3D提取如需实现，应另建保留隔离的真实场景导出任务。

本轮一条英文功能提交，wsnxxxs noreply身份；两次merge保留原PR历史。实际提交SHA、PR合并与CI状态以父工作区私有.local/dots-assistant-20261023/commit-push.json及final-github-state.json为准。未提交私有运行证据、日志、截图、数据库或令牌。

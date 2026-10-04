# 2026-10-05 · 漏洞核查补丁 · wsnxxxs

- 负责人：wsnxxxs ｜ 执行 AI：GPT-6 / Codex Desktop。

## 本轮目标

核实用户提供的漏洞报告，修复真实代码缺口。竞猜部分用户明确要求先搁置，未改 guess 代码。

## 改动与决定

验证码校验/绑定/重置增加独立每 IP 30 次/分钟额度；登录在挑战通过之后占密码计算并发；TRUST_PROXY 安全兼容 loopback、拒绝不支持的值；Turnstile 半配置失败关闭。相机消息验证当前窗口与源，发送用明确目标源，向量限制为三元有限数值；后台主题脚本外置并取消脚本 unsafe-inline。作品内容错误页转义并统一 HSTS。统计只收已知页面/已存在题目路径，完整目录端点明确拒绝不支持的分页参数。API 契约同步，新增尚未部署的 SSH 密钥认证模板。

没有按报告添加 reactions 三列 UNIQUE：Gallery 支持多贴纸，Show1 单槽切换已有 BEGIN IMMEDIATE；没有改注销用户历史票、公开后台登录入口、既有 Origin 防线或私有数据。无数据库迁移，无新增依赖。

## 验证

- check 96/0、test 302/302、diff --check 通过。
- 隔离真实 3D 后台预览与相机抓取通过，取景截图目检；错误 origin/窗口消息被拒绝，正确消息正常。未保存取景参数。
- Gallery check/test/build/intake 通过，游戏 lint/typecheck/build:check 通过。详见 Gallery 同名归档的逐项 49 条表。
- 初轮复用 auth 桶触发邮箱流程测试共享额度，改为独立 codes 桶后完整测试通过。

## 明确没做

未 push、未部署、未对生产发邮件/投票/并发攻击。生产 TRUST_PROXY、sshd 有效配置、系统包和云商归属无凭据核查；SSH/DNS 操作需运维通道。报告中 SSH 密码认证和旧 banner 只做无凭据握手，根域 SPF/DMARC 缺失只做 DNS 读取。

## 遗留物与下一步

完整测试日志留在忽略 `output/security-review-20261005-tests.log`；临时服务/数据库由 Gallery harness 管理，无生产数据改动。上线后才能验收线上修复。SSH 模板须先验证独立密钥通道、保留原会话，检查有效配置与语法再 reload；不得直接关闭唯一登录通道。

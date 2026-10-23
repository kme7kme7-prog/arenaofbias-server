# dots 高级管理员助手 API

该入口使用原 dots Bearer 令牌，另需显式授予 `admin:read` / `admin:write` 并绑定真实高级管理员账号。新建令牌默认仍只有 `moderation`；原七项作品处理权限独立保留，不自动扩大。

## 启用与撤回

先备份当前业务库与运行代码。由运维以服务账号和既有 `DATA_DIR` 运行：

```sh
node scripts/moderation-token.mjs assistant-create <token-id> dots
node scripts/moderation-token.mjs grant <token-id> admin:read
node scripts/moderation-token.mjs grant <token-id> admin:write
node scripts/moderation-token.mjs assistant <token-id>
```

`assistant-create` 在同一事务新建独立高级管理员账号并绑定令牌。用户名经过与普通账号相同的规范化；已存在则 409，不提升既有账号、不修改密码、不自动换名字。需要换名时运维明确使用 `dots-assistant` 等新名字。强随机密码只在进程内存中用于 scrypt 哈希，不输出、不存明文、不创建 Cookie/session。命令只输出 token id 和安全绑定信息；不会输出 Bearer 明文。创建失败整体回滚；给已吊销令牌创建或绑定会失败。

```sh
node scripts/moderation-token.mjs withdraw <token-id> admin:write
node scripts/moderation-token.mjs assistant-unbind <token-id>
node scripts/moderation-token.mjs revoke <token-id>
```

撤回 `admin:write` 仅关闭本节的新管理写操作；原 `meta:write`、封面、截图等独立 scope 不受影响。解绑同时关闭新管理读写，不删除助手账号或作品。整令牌吊销关闭全部能力。将绑定账号降为非高级管理员或删除该账号，也会使管理读写失效。重新绑定现有高级管理员只可由运维执行 `assistant-bind <token-id> <actor-id>`，不提供 HTTP 自我绑定或扩权接口。

## 鉴权、能力发现与发送边界

```http
GET /api/dots/admin/caps
Authorization: Bearer <既有令牌>
```

`caps` 需要 `admin:read`，返回：

```json
{
  "actor": { "id": "助手账号id", "name": "dots", "role": "admin", "level": 3 },
  "scopes": ["moderation", "admin:read", "admin:write"],
  "routes": [{ "method": "GET", "path": "/api/dots/admin/caps", "scope": "admin:read", "successStatus": 200, "jsonBodyBytes": 0 }],
  "jsonBodyBytes": 65536,
  "recapture": { "supported": true, "source": "/api/dots/admin/recaptures/source", "create": "/api/dots/admin/recaptures", "publish": false, "message": "异步隔离任务；现有图片 GET 不触发重截图，产物默认私有" }
}
```

`routes` 由实际注册清单生成，列出全部可调用 method/path、scope、成功状态码和 JSON 大小上限。普通 JSON 上限 65536 字节，猜模型追加上限 8192 字节；`jsonBodyBytes:0` 的操作不接受正文。`DELETE works` 的正文可省略，其他 JSON 操作须带 `Content-Type: application/json`。未知路径 404、错方法 405；不接受目标 URL、handler 名或任意 API 转发。GET 同时支持 HEAD。

- 缺失、无效或吊销令牌：401；缺 scope：403 `scope_required`；未绑定：403 `admin_binding_required`；绑定账号已降级：403 `admin_actor_disabled`；在途换绑：403 `admin_binding_changed`。
- 每次请求均读取当前 token / scope / 绑定 / 账号角色。JSON 正文读完、执行业务写入前再查一次；发送私密 JSON 前再查一次，涵盖压缩成功、压缩失败回退和不压缩。绑定版本使用随机标记，同账号解绑再绑也不能复活旧请求。
- 全部管理响应 `Cache-Control:no-store`。管理员请求无需 Cookie 或 Origin；Cookie 无法打开 dots API，Bearer 仍不能打开 `/api/dots/` 以外接口。原 Cookie 管理端仍保留同源检查。
- 复用 `DOTS_API=off`、`DOTS_DISABLED_SCOPES` 开关及每 token 总限流。所有新管理 POST/PATCH/PUT/DELETE 都另计 `DOTS_WRITES_PER_MIN`，默认 30；读操作不消耗该写额度。原业务限额仍生效。

## 路由清单

以下路径相对 `/api/dots/admin`。参数、排序、分页、审核状态和响应 DTO 沿用对应原管理接口；优先使用分页面板和单件详情。

| scope | 方法和路径 | 用途 |
|---|---|---|
| admin:read | `GET /review?panel=...&page=...&pageSize=...` | 审核分页面板；无参数旧完整投影也保留 |
| admin:read | `GET /works`、`GET /works/:task/:id` | 作品列表/单件管理详情 |
| admin:read | `GET /questions`、`GET /questions/:id` | 题目列表/详情；目录优先用 review 的 catalog 面板 |
| admin:read | `GET /users?page=...&pageSize=...` | 成员分页；不返回凭据或完整邮箱 |
| admin:read | `GET /moderation-mode` | 审核模式、覆盖和超时 |
| admin:read | `GET /works/:task/:id/cover-history`、`.../preview-history` | 封面/预览历史 |
| admin:read | `GET /tasks/:id/editorial`、`GET /traffic`、`GET /inbox/works` | 运营配置、访问统计、已注册收件箱作品 |
| admin:read | `GET /changelog`、`GET /curated` | 更新日志、精选配置 |
| admin:read | `GET /qualification`、`GET /qualification/works?taskId=...` | 资格设置/题对及给定题目的可用作品 |
| admin:read | `GET /vote-risk/summary`、`.../choices`、`.../model-voters` | 原风控只读投影 |
| admin:read | `GET /guess/stats`、`GET /guess/models` | 猜模型统计与资料 |
| admin:write | `POST /questions`、`POST /questions/:id/meta` | 创建、编辑题目 |
| admin:write | `POST /questions/:id/moderation`、`POST /questions/batch-moderation` | 题目审核；批量最多 50 |
| admin:write | `DELETE /questions/:id` | 删除题目；已有票仍 409 |
| admin:write | `POST /works/:task/:id/meta` | 原管理员声明、归属题目等校验 |
| admin:write | `POST /works/:task/:id/moderation`、`.../review` | 人工内容审核、来源核验；两阶段含义保持 |
| admin:write | `POST /works/:task/:id/moderation/retry` | 原重新审核入口，会改变审核流程；不是纯重截图 |
| admin:write | `POST /works/:task/:id/face-settings`、`.../calibration`、`.../preview` | 门面、校准、短期安全预览地址 |
| admin:write | `POST /works/batch-inbox`、`.../batch-face-settings`、`.../batch-moderation`、`.../batch-review` | 原批量校验及上限 |
| admin:write | `DELETE /works/:task/:id` | 下架；按原正文可显式 void/purge，不自动增加任何选项 |
| admin:write | `POST /works/:task/:id/cover/rollback`、`.../preview/rollback` | 原高级管理员历史回滚 |
| admin:write | `POST /tasks/:id/editorial`、`POST /users/:id/role` | 运营编辑、成员级别；仍不能改自己的角色 |
| admin:write | `POST /announcements` | 发布公告；现有业务没有公告编辑/删除 |
| admin:write | `POST /changelog`、`POST /changelog/:id`、`DELETE /changelog/:id` | 原更新日志增改删 |
| admin:write | `POST /moderation-mode` | 设置审核模式并触发原 sweep；不修改环境文件 |
| admin:write | `POST /curated/sections`、`PATCH /curated/sections/:id`、`PUT /curated/sections/order`、`DELETE /curated/sections/:id`、`PUT /curated/questions` | 精选配置，保留 revision 冲突保护 |
| admin:write | `PUT /qualification/settings`、`POST /qualification/pairs`、`PATCH /qualification/pairs/:id`、`DELETE /qualification/pairs/:id` | 资格配置，原快照/版本/校验保持 |
| admin:write | `POST /vote-risk/votes/void`、`.../restore` | 原有限作用域作废/恢复，理由/记录保持 |
| admin:write | `POST /guess/models` | 受校验的增量模型追加，固定数据文件、容量及次日生效规则保持 |

例如管理员作品 meta：`POST /api/dots/admin/works/<task>/<id>/meta`，JSON 沿原管理员契约；原 `PATCH /api/dots/works/.../meta` 仍是另一条仅声明字段白名单接口。内容通过不会自动等于来源核验，核验/门面门禁不放宽。

## 图片、原件与尚未提供的能力

已有截图立即通过 `works:read` 的 `GET /api/dots/works/:task/:id` 返回 `images` 清单，再 GET 清单 URL。包内文件也走原 `works:read` attachment 流；都直接读取已有文件，不 enqueue。封面、截图、小模型及独立海报继续走各自原 scope，详见 [作品处理 API](dots-moderation-api.md)。

### 异步隔离重截图

1. `GET /api/dots/admin/recaptures/source?task=<task>&id=<id>`（admin:read），只支持活跃上传作品，返回 `version`、默认尺寸/等待和上限。不接受额外/重复参数。version 是当前源文件内容及标识的 opaque SHA，不暴露磁盘路径或内容密钥。
2. `POST /api/dots/admin/recaptures`（admin:write）提交 `{task,id,version,desktop?,mobile?,wait?}`，立即返回 202 任务 DTO，不等待浏览器。默认 desktop 1440×900、mobile 390×844、`wait:{load:"load",settleMs:3500}`；desktop 范围 640–1920 × 480–1440，mobile 320–600 × 480–1200，均整数；等待仅 `load|domcontentloaded` 和 0–10000ms，未知字段拒绝。
3. `GET /api/dots/admin/recaptures/:jobId`（admin:read）读取同 token、同助手、同绑定版本任务。状态 `queued|running|waiting-service|succeeded|partial|failed`，含 `error:{code,stage}` 及已完成 `images[{slot,url,width,height,bytes}]`。未知/他人/旧绑定/过期 404。已完成产物在撤回 admin:write 后仍可用保留的 admin:read 读取；正在执行的写任务则会在下一授权检查失败。
4. `GET /api/dots/admin/recaptures/:jobId/images/:slot`（admin:read）下载 `first|mobile` 已完成 JPEG，attachment/no-store/sandbox。实际打开文件后发送前再次验证当前管理员和源版本。产物在私有任务目录，**不自动覆盖 media、captures、封面、审核或原作**。

源树上限 4096 项、128 MiB；哈希采用异步文件 API 和 64 KiB 分块并让出事件循环，状态轮询不读原作 bytes。任务持久化、默认保留 1 小时，15 分钟截止；同作品单在途、重复同 owner+版本+参数复用任务，60 秒冷却，最多 8 个待执行、100 个保留任务。重启前 queued/running 任务记 `service_restarted`，不自动重放。队列真正执行前与完成后重新核当前 token/写 scope/助手/绑定版本和源版本；失效结果不可下载。

只复用既有隔离 capture worker；不提供任意 URL、JS、选择器、shell 或关闭沙箱/CSP/网络限制的参数。`environment_unavailable` / `capture_disabled` / `waiting-service` 属环境/服务状态，不能作为作品有问题或拒绝投稿的证据。页面渲染/取景错误单独标注阶段，仍不产生审核决定。用户云环境浏览器启动失败同样不代表作品失败。

### 实际小模型文件回读

`GET|HEAD /api/dots/works/:task/:id/preview/model` 使用已有 `works:read`。只读当前 dots 上传、清洗后实际保存的 `.sbox`；无 query，返回 gzip 原文件字节（不做 HTTP 二次压缩），`Content-Type:application/octet-stream`、attachment、no-store/nosniff/sandbox。`X-Preview-Version` 为当前 manifest 版本，`X-Preview-SHA256` 为实际保存 gzip 文件 SHA。缺失、过期源、旧 manifest、人工烘焙、hash/路径不符 404；不会生成模型，也不把截图当作 3D 提取结果。发送前再次确认当前 scope、manifest、文件和源。

### 转人工与误拒绝重开

先 `GET /api/dots/admin/works/:task/:id/moderation/state`（admin:read）取得 `{task,id,version,moderation}`。随后以 admin:write 调用：

- `POST .../moderation/handoff`：仅 pending/review，用于材料不足、疑似或无法完成的作品。
- `POST .../moderation/reopen`：仅 rejected，用于误打回后重新人工复核。

两者都必须提交 `{version,reason}`，reason 1–500 字，未知字段拒绝；当前 version 不同 409。使用 task/id/完整原 moderation 的条件更新，只写 `status:review,source:human` 和新的理由/审核人/版本，不带 dots route、不调用模型或截图，不变来源核验和门面，不直接公开。旧决定完整保存在 `content-handoff` / `content-reopen` 审计的 before/after 中，原审计不会删除。旧自动或 dots 结果再到达会失去 CAS，不能覆盖新的人工队列。后续通过/拒绝仍走原人工业务校验。

仍没有任意浏览器启动、shell、SQL、`.env`、密钥、任意文件、服务重启、HTTP 令牌管理、原始 inbox 文件或二进制上传入口。

## 审计与回滚

绑定助手是真实用户，作品/题目归属外键有效。业务审计 `actor_id` 是助手账号 id，`actor_name` 为 `dots:<token-label>`；token 审计新增 `actor_id`，保留 token id/label、method/path 模板动作、对象、结果，JSON reason 只记字段名。CLI 创建/换绑/解绑记录业务审计，不记录随机密码、Bearer 明文或原始上传正文。

v50 只追加 `moderation_token_admins` 绑定表及 `moderation_token_audit.actor_id`，v51 追加私有 `recapture_jobs` 表/索引，不重写现有 token/scopes/作品/题目。回退代码时保留最新业务库及新增表/列；可先 withdraw 管理 scopes 或解绑。删除、purge 等原业务动作可能清理文件，代码回滚不会恢复已删文件，仍需正常备份；助手接口不会隐式执行 purge。

# 2026-10-21 · 公开作品浏览器私有缓存 · kme7kme7-prog

- 负责人：kme7kme7-prog。

## 本轮目标

减少公开作品大 HTML 被同一浏览器反复完整下载，同时保留即时撤下和私看/正式盲测边界。

## 改动

- 新增 content-cache.mjs，最终字节弱 ETag、304/HEAD；普通文件流式指纹，异步读取后重新检查公开门禁。
- content.mjs 只对当前公开 w/c 开启 private/no-cache/max-age=0/must-revalidate；内容、注入或校准变化返回新 200；撤下优先 410/no-store。
- d/p/m/e、可信外壳仍 no-store，无 ETag；通用哈希运行时代码缓存策略不变。同步更新 API 契约。

## 验证

- 本地语法 154/0，定点 13/13，全量低并发 442/442，0 失败/取消/跳过，diff 空白检查通过。
- Tabbit 实际双层沙盒：公开 w/c HTML 首次 200、重开 304；父页刷新后仍 304；撤下 410；作品及校准更新 200；私看、正式盲测重复打开均 no-store。页面脚本错误 0，未增加 allow-same-origin。
- Windows 原有可信 shell 换行/CSP 哈希问题仅在本地忽略目录运行副本规范 LF，未改 tracked shell 或降低安全策略。
- 发布前核对 origin/main ff83853，线上 content.mjs 与基线一致，schema 49，无活动好友房。VPS 独立副本使用实际生产 server 模块组合，语法与定点 13/13 通过；记录 80 个保护文件指纹，备份已准备。部署及公网结果将写入父 Show1 `.local/content-revalidation-20261021/`；以 completion.json 为完成依据。

## 明确没做

- 不缓存私密/草稿/正式盲测/考试作品；不启用共享 CDN 缓存或离线/过期复用。
- 原始代码方案不修改作品源文件、数据包、数据库、依赖、CSP、沙盒或前端。随后另行获准的 Nginx/CDN 验收见下节，不能将早期代码范围当作最终线上配置记录。
- 不把本地 fixture 的撤下测试冒充生产真实作品修改；首次访问与所有资源命中不作保证。实际 opaque frame 的独立脚本仍可能全量请求。

## 遗留物

- 独立 detached worktree 与本地证据在父 Show1 `.local/content-revalidation-20261021/`。
- VPS 发布目录 `/root/aob-content-cache-20261021/`；代码回滚须检查目标哈希，保留后续变更。部署结果及回滚说明记录在该目录及本地 report.md。

## 下一步建议

先解决 CDN 条件头未透传；在公网和真实浏览器均验收 304 后，再观察重复下载与出口流量。大内嵌 GIF 的尺寸与独立资源治理留待另行授权。

## 发布及额外获准的代理验收

- `699601fb91f589c6164b7c39dcd82dfe759ba2cb` 已推 main，仅两个运行文件上线。安装前后公开 2137 作品/98 题，schema 49；重启 5.035 秒，80 个既有运行文件中 79 个无关文件保持不变。独立 VPS 实际模块组合定点 13/13 通过，未改生产作品或数据。
- 全局 Nginx 代理缓存继承会吞条件头。用户解释后明确批准备份、作品域单行 `proxy_cache off;`、nginx -t 与平滑 reload。操作后直连 HTTPS 304，未重启后端；配置备份与代码备份同在 `/root/aob-content-cache-20261021/before/`。
- 用户再批准仅公开 `/c/[wc]<32hex>/` 的 CDN 回源头规则，不改时长/权限/计费，无效撤回。规则匹配 HOST w.arenaofbias.icu、公开路径正则、GET/HEAD；静态自定义诊断头可达源站，但实际 If-None-Match 的大小写变量均为空，标准及自定义头转发均不能恢复。已删除本轮新规则，刷新控制台确认 0 条，最终抓包无诊断头；没有新增后端自定义头后门、固定验证器或强缓存规则。
- 最终公网 w/c 首次及条件请求均 200，分别重传 1567/2680 字节探针；真实 Tabbit 重开携带 ETag 但仍两次 200。故源站缓存逻辑已上线，公网节流目标未通过，不将规则发布等同于修复。私密无效键 410/no-store/无 ETag，可信外壳 no-store；脚本错误 0，内层仍 opaque。
- 最终 81 文件指纹符合清单，服务 active/PID 18076，schema 49；公开题目 98、作品自然增至 2138；门户/竞技场/展览馆/API 均 200。生产版本字符串保留原现场值，本次增量代码以 manifest/installed 指纹为准。
- 父 Show1 本地 `report.md`、`completion.json` 记录部分完成状态；`edgeone-support.md` 为脱敏客服诊断材料，未代用户发送。没有执行线上真实作品撤下测试，没有对全部 CDN 节点/运营商做普遍性结论。

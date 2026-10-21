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
- 不修改作品源文件、数据包、数据库、依赖、CSP、沙盒、Nginx、CDN 或前端。
- 不把本地 fixture 的撤下测试冒充生产真实作品修改；首次访问与所有资源命中不作保证。实际 opaque frame 的独立脚本仍可能全量请求。

## 遗留物

- 独立 detached worktree 与本地证据在父 Show1 `.local/content-revalidation-20261021/`。
- VPS 发布目录 `/root/aob-content-cache-20261021/`；代码回滚须检查目标哈希，保留后续变更。部署结果及回滚说明记录在该目录及本地 report.md。

## 下一步建议

观察公开 HTML 304 占比和实际出口流量；大内嵌 GIF 的尺寸与独立资源治理留待另行授权。

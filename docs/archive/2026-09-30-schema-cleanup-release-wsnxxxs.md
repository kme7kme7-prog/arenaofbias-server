# 2026-09-30 · schema-cleanup-release · wsnxxxs

- 负责人：wsnxxxs ｜ 执行 AI：Codex desktop

## 本轮目标

按用户复核通过的顺序发布数据包、推送后端修复和 pin，然后备份并部署 v18。

## 改动

- 普通快进推送 data `ef10cdd9ab28dfe52a60a5a072a3cd10ae422ab3`；发布 workflow 36668329887 成功，不可变 tag `datapack/ef10cdd9ab28dfe52a60a5a072a3cd10ae422ab3` 指向 `2cb2a5b265e8bda8c8069a4b498f1046d825acee`。
- 普通快进推送 server 至 `8c5a8eb7973b2b4b9cc26a6e6d0381e1d4445ddc`，CI 36669211087 成功。本轮仅更新 datapack.json pin 和发布记录；不修改用户已经复核的实现。

## 验证

- 部署前线上代码与 `338bb3f3befcf0a76293018072c00e5d8a7d8b8a` 逐份一致；公网版本与现场文件相同，无未记录补丁。
- 新包来自已发布不可变产物，sourceCommit 为 ef10cdd、sourceDirty:false；3 个旧模型名称和厂商与备份一致，展示列表仍为 32 项。
- 服务器新代码语法检查、118/118 测试通过。差异包 4 个变化文件、0 删除，目标完整树 SHA-256 为 `a858c52f95b7106b3b31b7b65614654f5a79c0409871d3d0aeb994d2d10a66f7`。
- 服务器最新快照隔离迁移 v16→v18：作品 267、投票 622、用户 27；所有表保留，历史投票/更正/对局和既有审计逐行核对通过，完整性与外键通过，45 个被引用模型 ID 可解析，手填厂商非空 0 行。
- 本记录随 pin 在实际切换前提交；最终生产核验以服务器备份目录中的 verification.json、http-verification.json 及公网 bootstrap 为准，不能把演练结果当作生产验收。

## 明确没做

不修复用户确认不阻塞上线的 setMeta vendor 和备注长度问题；不改作品文件、不清理旧数据包、不调整 systemd 凭据或 Nginx。

## 遗留物

- 服务器回滚与验收目录：`/root/arenaofbias-predeploy-20260930T042530Z`。切换前停服务后另存最终 platform.db，保留旧代码和数据包链接。
- 服务器隔离检出：`/root/arenaofbias-schema-deploy-20260930`；本机差异包验证目录：`C:\Users\Ryan\AppData\Local\Temp\arenaofbias-schema-deploy-cedfe02200dd4e18b578411361552514`。均为本轮临时材料，不入库。

## 下一步建议

确认 pin 提交的 CI 通过后，停写并备份最终库，部署 main 上该提交、激活新包、启动服务触发迁移，核验公网与本机 API、v18 完整性和业务数据；失败时同时恢复旧代码、数据库和包链接。

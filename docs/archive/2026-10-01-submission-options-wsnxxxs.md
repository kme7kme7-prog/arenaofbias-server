# 2026-10-01 · 上传档位与服务商必填 · wsnxxxs

- 负责人：wsnxxxs（GitHub API 核对 id 269096463）｜执行 AI：Codex

## 本轮目标

用户要求 Harness 不细分且扩充主流选项、生成方式仅一轮与多轮、Qwen 归 Alibaba、开放六个指定模型并核对名字/logo，推理档位及服务商必填。用户每轮修改后 commit 的指示授权本地提交，每仓一条英文简单句。

## 改动

新投稿（普通、题目示例、管理员直传、收件箱登记）强制非空 effort 和 official/unofficial providerId。PATCH/meta 禁止显式清空，省略键保持旧记录；通过核验前补齐两项，标记存疑和退回流程保留。新写 generationMode 仅 single-turn/multi-turn，历史 agent 在省略字段时保留；数据库迁移、存量行与投票快照未改。后台表单同步必填及两项生成方式。仅更新受新契约影响的原有 fixture，在既有 provenance 测试补缺失/空白/清空/agent 400 断言。 提交号见 Git。

## 验证

check 74/0、test 184/184（0 fail/cancel/skip）；跨仓真实隔离 integration smoke 通过；git diff --check 通过。早期测试因旧 fixture 省略新必填字段失败，补齐声明后全量通过。未操作生产或业务库，未调用真实 SMTP、截图服务、Luna。

## 明确没做

未推送、部署、更新生产消费者 pin；未回填或推断历史缺失档位、来源及 agent 轮数。

## 遗留物

忽略的 output/submission-options-test*.log 与定向测试日志保留；无其它未提交改动。

## 下一步建议

需要上线时配套发布数据包、Gallery 与后端，并选定匹配包。

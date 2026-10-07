# 2026-10-08 · 换题回查三票例外核验 · wsnxxxs

> 状态更新：用户已撤销三票例外。本记录仅保留当时核验历史，不再作为发布放行依据。最新错题规则及第四票门禁差异见[后续归档](2026-10-08-moved-question-ballots-wsnxxxs.md)。

- 负责人：wsnxxxs ｜ 执行 AI：Codex（GPT-6）。本轮只核验和文档，不 commit、push、部署或推理迁移。

## 本轮目标

按用户限定核验 up-pswy2p66 换题回查恢复的三张票；仅允许三票及其拟合联动作为计分例外，其余门禁继续执行。使用上一轮捕获的2026-10-08一致副本及实际旧运行代码50259ad，对比固定归属计分提交6446abb，不含未提交推理代码。未来部署前仍须重新采集当时最新副本，不能将本次结果长期作为放行依据。

## 改动

只追加HANDOFF记录及新建本归档，不改业务源码、schema、实际数据库或现有票。6446abb的第一父提交为a294567，第二父为现场及origin/main的50259ad；合入d3b669a/50259ad的Show1原文及HTML wrapper展示修复和测试，相对a294567仅两个文件82行增加/7行删除；没有额外业务变更，不含推理，未推送。

## 验证

### 逐票时间和题目

下表时间为Brisbane（UTC+10）。当前votes.task_id已被换题操作迁为chinese-architecture；投票时原题由双方身份/对局快照和pair_key重建，不把当前字段冒充当时字段。

| 票 ID | 投票时间 | 投票时原题 | 当前 votes.task_id | 对手 | 选择 |
|---|---|---|---|---|---|
| 208eee8c0dc7a2c4a4fbc199 | 2026-10-06 05:20:39.834 +10:00 | miniature-railway-town | chinese-architecture | up-7pcx710r | b |
| 9cdbd004df68f804ef9ae67c | 2026-10-06 22:19:33.357 +10:00 | miniature-railway-town | chinese-architecture | deepseek-v4-pro-high | tie |
| 5f94a4fa6fde49d6f3c72040 | 2026-10-06 23:42:57.162 +10:00 | miniature-railway-town | chinese-architecture | up-7pcx710r | tie |

换题审计2755发生于2026-10-06 23:43:32.376 +10:00，晚于三票：miniature-railway-town → chinese-architecture。library.moveVotes/moveMatches会迁移关联历史票/对局的task_id，保留身份快照及pair_key。旧代码找不到留在原题的对手；新代码按快照taskId回查恢复计分，不发生归属键迁移。

### 逐票资格

| 票 ID | 已登录 | 邮箱验证早于投票 | 非本人作品 | 无此前重复票 | 双方投票时同题 | 对局一致 |
|---|---|---|---|---|---|---|
| 208eee8c0dc7a2c4a4fbc199 | 通过 | 通过 | 通过 | 通过 | 通过 | 通过 |
| 9cdbd004df68f804ef9ae67c | 通过 | 通过 | 通过 | 通过 | 通过 | 通过 |
| 5f94a4fa6fde49d6f3c72040 | 通过 | 通过 | 通过 | 通过 | 通过 | 通过 |

资格证据：正式source=arena，票有非空user_id且与matches.user_id一致，用户创建及email_verified_at早于票时间；投票者与双方保存的ownerId均不同；按同用户同pair_key、同用户同一对workId双向组合查此前票均为0；双方票/对局快照的taskId同题、pair_key前缀同题，迁移审计晚于三票。对局决定与票选择一致。当前邮箱仅作为辅助，历史绑定判断使用早于投票的email_verified_at；没有公开邮箱、用户名或认证字段。

### 限定例外后的门禁

- 配置有效票6321→6324，模型6212→6215，两个口径新增ID集合均精确等于这3票；无丢失票、无其他新增票，参与者均163→163，计分条目121/60、计分题50均不变。
- 仅在内存排除这3票，全部121配置、60模型的score、rank、games、wins、draws、losses、interval、voters、tasks均精确等于旧榜；包含三票的完整重放也精确复现此前新榜。没有删改数据库票来做此判定。
- 比较数变化仅GLM 5.3 Flash最高+3、DeepSeek V4 Pro High+1、GPT-5.5 XHigh+2；其他配置及模型比较数不变。分数/名次联动只来自这3票的Bradley–Terry重拟合，去掉例外后完全消失。
- 485侧字段变化全部同ID+digest，0模型/配置键迁移，143侧显式人工更正全部保持。每侧理由保存于私有exception-audit.json的sideReasons，下面汇总相同来源/字段原因。
- 榜单展示变化仅来自注册表（两组Qwen厂商及MiniMax显示名），没有其他模型榜变化；前轮逐项注册表判定没有失败。源一致副本完整SHA在本轮前后不变。

| 同ID+digest的当前字段来源及原因 | 侧数 |
|---|---:|
| Same ID + digest current package fields: vendor, providerId | 19 |
| Same ID + digest current package fields: providerId | 153 |
| Same ID + digest current upload fields: harnessId, providerId | 12 |
| Same ID + digest current upload fields: modelName, vendor | 6 |
| Same ID + digest current upload fields: modelName | 148 |
| Same ID + digest current package fields: harnessId, providerId | 26 |
| Same ID + digest current upload fields: vendor | 2 |
| Same ID + digest current package fields: harnessId | 107 |
| Same ID + digest current package fields: modelName | 12 |

### 所有受影响配置和模型

下表包含直接恢复计分、全榜拟合联动及注册表展示变化。旧=50259ad，新=6446abb；相同整数分数下的名次也可因原始拟合分数变化而交换。例外仅限三票及这些已验证的联动。

#### 配置榜

| 键 | 比较数（旧→新） | 分数（旧→新） | 名次（旧→新） | 理由 |
|---|---:|---:|---:|---|
| qwen-latest-series-invite-2609\|max | 66→66 | 1201→1201 | 8→8 | 注册表展示更新，计分不变 |
| qwen3.8-flash-next\|high | 82→82 | 1196→1196 | 10→10 | 注册表展示更新，计分不变 |
| claude-opus-5\|high | 29→29 | 1096→1097 | 23→23 | 仅三票引发重拟合/名次联动 |
| x:glm 5.3 flash x\|max | 4→4 | 1079→1080 | 29→29 | 仅三票引发重拟合/名次联动 |
| qwen3.8-flash-next\|xhigh | 181→181 | 1061→1061 | 41→41 | 注册表展示更新，计分不变 |
| mimo-v2.6-pro\|default | 261→261 | 1034→1033 | 50→50 | 仅三票引发重拟合/名次联动 |
| minimax-m3.1\|default | 257→257 | 1023→1023 | 52→51 | 仅三票引发重拟合/名次联动 |
| glm-5.3\|max | 198→198 | 1023→1023 | 53→52 | 仅三票引发重拟合/名次联动 |
| claude-opus-4.6\|max | 11→11 | 1022→1022 | 54→53 | 仅三票引发重拟合/名次联动 |
| deepseek-v4.1-flash\|high | 389→389 | 1019→1019 | 55→54 | 仅三票引发重拟合/名次联动 |
| hy4-preview\|high | 112→112 | 1016→1016 | 56→55 | 仅三票引发重拟合/名次联动 |
| glm-5.3-flash\|最高 | 58→61 | 1029→1014 | 51→56 | 恢复三票直接影响 |
| claude-opus-4.6\|default | 15→15 | 1012→1013 | 59→58 | 仅三票引发重拟合/名次联动 |
| glm-5.3\|high | 83→83 | 1012→1011 | 58→59 | 仅三票引发重拟合/名次联动 |
| deepseek-v4.1-flash\|default | 47→47 | 994→995 | 65→64 | 仅三票引发重拟合/名次联动 |
| gemini-3.8-flash\|high | 363→363 | 994→994 | 64→65 | 仅三票引发重拟合/名次联动 |
| minimax-m3.1\|max | 225→225 | 976→976 | 71→71 | 注册表展示更新，计分不变 |
| glm-5.3-flash\|high | 146→146 | 959→960 | 81→80 | 仅三票引发重拟合/名次联动 |
| qwen3.8-flash-next\|default | 4→4 | 960→960 | 80→81 | 仅三票引发重拟合/名次联动 |
| doubao-seed-evolving\|high | 22→22 | 957→956 | 82→82 | 仅三票引发重拟合/名次联动 |
| x:qwen3.8-flash-next-gsq-rco-iq3_xxs\|xhigh | 5→5 | 949→950 | 84→84 | 仅三票引发重拟合/名次联动 |
| muse-spark-1.3\|default | 5→5 | 938→938 | 87→86 | 仅三票引发重拟合/名次联动 |
| xing4.0-29b-a4b\|default | 5→5 | 938→938 | 88→87 | 仅三票引发重拟合/名次联动 |
| swe-2\|high | 67→67 | 938→937 | 86→88 | 仅三票引发重拟合/名次联动 |
| swe-2\|max | 56→56 | 922→921 | 93→93 | 仅三票引发重拟合/名次联动 |
| dots3-note\|default | 7→7 | 872→873 | 101→101 | 仅三票引发重拟合/名次联动 |
| deepseek-v4-pro\|high | 136→137 | 862→864 | 103→102 | 恢复三票直接影响 |
| gpt-5.6-terra\|max | 311→311 | 862→862 | 102→103 | 仅三票引发重拟合/名次联动 |
| gpt-6-luna\|low | 8→8 | 818→819 | 113→113 | 仅三票引发重拟合/名次联动 |
| gpt-5.5\|xhigh | 318→320 | 800→804 | 115→115 | 恢复三票直接影响 |
| seed-2.1-pro\|high | 67→67 | 788→789 | 116→116 | 仅三票引发重拟合/名次联动 |
| gemini-3.1-pro\|high | 77→77 | 767→768 | 117→117 | 仅三票引发重拟合/名次联动 |
| seed-2.1-pro-preview\|high | 8→8 | 690→691 | 120→120 | 仅三票引发重拟合/名次联动 |
| minimax-m3\|high | 28→28 | 656→657 | 121→121 | 仅三票引发重拟合/名次联动 |

#### 模型榜

| 键 | 比较数（旧→新） | 分数（旧→新） | 名次（旧→新） | 理由 |
|---|---:|---:|---:|---|
| qwen-latest-series-invite-2609 | 66→66 | 1211→1211 | 3→3 | 注册表展示更新，计分不变 |
| claude-opus-4.6 | 32→32 | 1111→1110 | 11→11 | 仅三票引发重拟合/名次联动 |
| qwen3.8-flash-next | 281→281 | 1102→1102 | 13→13 | 注册表展示更新，计分不变 |
| glm-5.3 | 281→281 | 1044→1043 | 21→21 | 仅三票引发重拟合/名次联动 |
| hy4-preview | 112→112 | 1036→1035 | 22→22 | 仅三票引发重拟合/名次联动 |
| minimax-m3.1 | 482→482 | 1024→1024 | 23→23 | 注册表展示更新，计分不变 |
| glm-5.3-flash | 577→580 | 1006→1005 | 29→29 | 恢复三票直接影响 |
| gemini-3.6-flash | 34→34 | 968→969 | 37→37 | 仅三票引发重拟合/名次联动 |
| deepseek-v4-pro | 190→191 | 944→944 | 40→40 | 恢复三票直接影响 |
| xing4.0-29b-a4b | 5→5 | 941→942 | 42→42 | 仅三票引发重拟合/名次联动 |
| swe-2 | 133→133 | 931→930 | 45→45 | 仅三票引发重拟合/名次联动 |
| gpt-5.5 | 318→320 | 830→833 | 56→56 | 恢复三票直接影响 |
| seed-2.1-pro-preview | 8→8 | 705→706 | 60→60 | 仅三票引发重拟合/名次联动 |

## 明确没做

没有commit/push、生产读取或写入、部署、推理迁移、Linux或浏览器/全交互验证；只在本地只读核验及内存重放。本轮不改业务代码，因此没有重复源码check/test；前轮合并后结果为check109/0、test323/323，不冒称本轮重跑。核验脚本通过，git diff --check通过。

## 遗留物

忽略output/reasoning-release-20261008/保留一致副本、实际旧源码、固定6446abb源码、完整逐票/485侧及计分重放结果；主核验脚本audit-exception.mjs，结果exception-audit.json，没有清理其他会话文件。

## 下一步建议

先汇报。推送、部署和推理迁移须另行授权；上线顺序仍为归属计分 → 后端推理及两题迁移 → Gallery。授权后重采最新一致副本，只允许以上3票例外，任何新增差异先停止，不因本次核验跳过未来门禁。

## 勘误（2026-10-08）

本归档的三票例外方案已经作废，由[错题作品历史票排除规则](2026-10-08-moved-question-ballots-wsnxxxs.md)取代。作品移出原题前收到的票保留但不计分；三票不再恢复。用户另确认5890a7cbbe284cb2b1abd3dd排除是纠正同ID不同digest作品误计，不是例外。正式部署前须重采最新一致副本，规则排除名单恰好为上述四票，其他门禁项照旧、任何其他差异停止。旧→新有效票净减一张，因为另外三票旧代码已经不计入。后端未来只部署一次（归属计分、错题票规则、推理代码），两题迁移及Gallery部署随后单独授权；本轮仅提交。

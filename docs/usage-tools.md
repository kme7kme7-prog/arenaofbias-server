# 产物体量与本地日志回填

两个工具只读、只向 stdout 输出 JSON，无 npm 依赖，不初始化服务、不迁移、不写库、不上传。生成用量与产物体量是不同概念，不能互相推断。

## 产物体量

```js
import { artifactStats } from '../server/artifact-stats.mjs';
artifactStats([{ path: 'src/main.js', content: 'const x = 1;\n' }]);
// {files, lines, bytes, tokens, tokenizer:'utf8-pretoken-4-v1', approximate:true}
artifactStats([{ path: 'original.txt', content: '你好，世界！' }], { kind: 'text' });
// {files:1, lines:1, bytes:18, chars:6}
```

`artifactStats(files, {kind='code'}={})` 接收可迭代的 `{path,content,generated?,vendor?}`。content 为 string 或 Uint8Array（包括 Buffer），不是字节长度数字。重复相对路径报错；路径可用反斜杠。空文件计一个文件、0 行；末尾换行不增加额外一行；CRLF/CR/LF 作为换行。bytes 保留原字节数，不按规范化换行后的大小计算。

文本题传 `kind:'text'`，仅原始 txt/md/markdown 文件计数；不计平台生成的 index.html。chars 为去掉空白后 Unicode 码点数（含标点、Markdown 标记；emoji 组合序列可能多个码点），不是英文单词数或渲染后的可见字数。代码题固定近似计数，`tokenizer` 和 `approximate:true` 必须和数字一起展示/存储。

规则：文本扩展名白名单；排除锁文件、依赖目录、vendor/third-party、dist/build/out/target 等构建目录、VCS/缓存、压缩/打包 JS/CSS、常见库文件、图片（含 SVG）、字体、source map、非法 UTF-8/二进制控制符。generated/vendor 标志用于排除已知非模型文件。未标记的第三方代码、HTML 内嵌库无法可靠识别；没有源码的构建产物不能反推体量。默认规则保守，可能排除模型自己压缩或与第三方框架同名的代码；普通 src/lib 目录不排除。完整固定规则见模块。

### 近似计数样本

`utf8-pretoken-4-v1` 将字母段、1–3 位数字段、标点段、空白段切开，对每段 UTF-8 字节数除以 4 向上取整再相加。没有 BPE 词表，不能冒称 o200k，也不代表任何模型计费 token。

本机 Node26.12 对自造/公共短句计算结果（2026-11-08）：

| 文本 | 近似 tokens | o200k_base |
| --- | ---: | --- |
| `Hello, world!` | 7 | 未测 |
| `你好，世界！` | 6 | 未测 |
| `const sum = (a, b) => a + b;` 加 LF | 23 | 未测 |
| `春风又绿江南岸，明月何时照我还。` | 14 | 未测 |

已检测本机 Python 存在 tiktoken，但其 o200k_base 词表缓存缺失。测量时禁用了网络读取，加载返回 `Local vocabulary cache missing; network forbidden`，没有安装或下载词表。因此无法给出与 o200k 的偏差数字或误差上限；短标点/空白片段的单独取整可能明显高估，跨语言偏差也可能不同。这一近似指标仅供统一长度比较，不用于计费、生成用量或精确 o200k 对比。

### 只读回填 CLI

```sh
node scripts/artifact-backfill.mjs --dist /local/datapack
node scripts/artifact-backfill.mjs --works /local/data/works --database /local/data/platform.db
node scripts/artifact-backfill.mjs --dist /local/datapack --works /local/data/works --database /local/data/platform.db > /local/report.json
```

输出 `{artifacts:[{taskId,id,origin:'datapack'|'upload',artifact}],warnings:[{id?,origin,reason}]}`。不写数据包、数据库或作品文件，文件重定向由调用者选择。数据包读取 data.json 的 tasks/results/scene；上传作品扫描 works/id 整个原始树，避免只看到 vite dist。数据库仅用 readOnly 模式获取作品任务、文本题类型与上传格式，排除已删除记录；不加载 createLibrary，避免清理、迁移等副作用。没有数据库时逐子目录扫描，缺少 taskId 且不能推断文本题，会输出警告。缺原始文本/缺目录的作品省略 artifact 并报告，不能把「源码不可得」存成零体量。内部符号链接不跟随；数据包场景不能越过数据包根。上传作品 id 必须是单个目录名（不能包含斜杠、反斜杠、. 或 ..），并以 realpath 检查实际根；异常 id/越界发警告后跳过，不读取根外文件。纯函数的空输入零体量与 CLI 的缺源码警告含义不同。

后续入库由服务端统一消费报告，建议以 `{taskId,id}` 对齐；脚本本身不提供写库开关。

## Claude Code 会话日志

```sh
node scripts/usage-from-logs.mjs --session SESSION_ID
node scripts/usage-from-logs.mjs --file /local/session.jsonl --session SESSION_ID
node scripts/usage-from-logs.mjs --root /local/claude/projects --from 2026-11-01T00:00:00Z --to 2026-11-02T00:00:00Z
```

默认根为 `~/.claude/projects`，递归读取 jsonl，不跟随目录符号链接。必须指定会话或时间范围，避免无条件扫描全部记录。时间边界含端点；结合 --session 时取交集。--file 可重复。只读不上传；stdout 不输出消息正文、工具参数、路径凭据。JSONL 解析失败只报行号，不回显出错内容。

输入记录使用顶层 sessionId/type/timestamp，以及 assistant 的 message.id/message.usage：input_tokens→input、cache_read_input_tokens→cacheRead、cache_creation_input_tokens→cacheWrite、output_tokens→output。Claude 的非缓存输入与缓存读/写分别累加，不从 input_tokens 再扣缓存。仅非负安全整数有效；缺失不补 0，明确返回的 0 保留。按 sessionId/message.model/message.id 去重，后者缺失依次使用 requestId、uuid；皆无时每行视为独立请求（无法可靠去重）。同回复多个内容块/流式快照，各字段取最大后只累加一次；没有 usage 的 assistant 不算请求。去重后逐字段检查每个请求的覆盖；任一请求缺该字段，整个模型分组省略该字段，并列在 incomplete 中，不把局部合计当完整总数。

--session 的完整单模型会话输出直接可粘贴的 `{input,cacheRead,cacheWrite,output,requests,durationSec?,source:'log'}`。有缺字段时输出 `{sessionId,model?,usage,incomplete:[字段名]}`；范围模式输出会话列表。同会话 message.model 不同时输出 `{sessionId,mixedModels:true,byModel:[{model?,usage,incomplete?}],durationSec?}`，不会输出合并的 usage。管理员需选择正确模型与来源，unknown 型号不猜测；混模会话的全会话耗时只列在顶层，不按模型重复分摊。没有匹配用量时 --session 报错，不输出假造的全零对象。durationSec 为所选日志最早时间戳至最后一个有 usage 的回复时间戳的墙钟跨度，不是 API 调用耗时和；至少需两个不同时间戳，否则省略。范围截断、日志缺头尾会使跨度不完整，录入前需核对；不依据 token 估算时间。

## Codex Desktop 会话（已核实格式）

```sh
node scripts/usage-from-logs.mjs --format codex --session SESSION_ID
node scripts/usage-from-logs.mjs --format codex --cwd /local/project --root ~/.codex
node scripts/usage-from-logs.mjs --format codex --cwd /local/project --root "$HOME/Library/Application Support/CindyGlobal/codex-home"
```

Codex 默认根为 `$CODEX_HOME`（未设置则 `~/.codex`），读取其 sessions/YYYY/MM/DD/rollout-*.jsonl，并在存在时读取 archived_sessions（包括已归档的放弃会话，避免漏报）。--root 直接指定 sessions 目录时只扫描该目录。--cwd 隐含 Codex 格式，匹配同目录及子目录，按主会话选择并递归包含其所有层 parent_thread_id 后代。时间范围按主会话第一个 task_started（缺时 session_meta 时间）选整个会话，不裁切累计快照。--session 直接选该会话及其后代；不能仅扫描所选 cwd 的文件，否则会漏掉别处工作目录的子代理。

首个 session_meta 定义该文件所属会话；fork 日志可能重放祖先 session_meta，后续 meta 不能改写所属会话。Desktop 也可能复用同一 id 先写一个无 token 的放弃 rollout、再写正式 rollout；无 token 的尝试单独列 skipped，不合入正式尝试的模型、用户消息和起止时间。有 token 的同 id rollout 以累计事件去重汇总。turn_context 的 model/effort 用于标注。只保留 token 数字、时间、型号、父子关系与消息计数；不保存正文或工具参数。用户消息计数来自 response_item/message/role=user，前缀去空白以 `<` 开始的环境注入不计。turns 是主会话 task_started 数，userMessages 或 turns 大于 1 时 multiTurn=true；两者均不叠加子代理的内部轮次。

每会话 token_count.info=null 忽略。无重置的单型号会话用最后非空累计 total_token_usage，不对快照累加；发生下降时按下述 epoch 规则处理。input=input_tokens-cached_input_tokens，cacheRead=cached_input_tokens；output 已含 reasoning_output_tokens，reasoning 单列但不重复相加。cache_write_input_tokens 明确0时省略 cacheWrite（已知0不标缺失）；字段在最终累计里缺失时省略并列入 incomplete。requests 是累计 total_tokens 相对前值增长的次数，重复快照不多算。

累计比较与字段覆盖分开维护：空/缺字段快照不会清除已知计数基线，因而「完整110 → 空对象 → 相同110」的 requests 仍为1；但最终快照缺失的字段仍省略并标 incomplete，不能回填旧数字。

任一已知原始累计字段下降时，按新 epoch 分段：上一段只计最终累计一次，新段从0开始；跨型号段仍减其段前累计。计数不取全局最大值，也不逐条快照求和。根记录新增 `counterReset:[{sessionId,snapshot,fields,before,after}]`：snapshot 为该会话按时间排序的 token_count 累计快照序号（从1起，包含空对象快照），before/after 是发生位置两侧的已知原始计数，fields 列出下降字段；子代理的重置也汇总到主记录。未检测到重置时省略此字段。

下降也可能来自陈旧事件或日志异常；这里的 epoch 是明确标注的处理规则，不证明真实计费发生重置。带 counterReset 的报告需管理员复核，不能无视告警直接录入。重置边界缺字段，无法确认其前后状态时，相关字段永久列入该模型 incomplete，即使后面又出现数字也不猜补；同一模型任一贡献段未知，整个字段省略。最终空/缺字段记录仍保持未知。

若 turn_context.model 在有消费的快照之间改变，按型号分段：各段末累计减段前累计，再按型号汇总，不能把整个累计归给最后一个型号；缺段前字段则不推算对应差值。没有 token 的上下文型号不触发混模。不同子代理型号也按型号分组。任一贡献段/会话的字段未知，则该模型整个字段省略并标 incomplete。

Codex 输出 `{sessions:[{sessionId,cwd?,model?,effort?,efforts?,userMessages,turns,multiTurn,subagentIds,subagents,usage?,incomplete?,incompleteSessions?,counterReset?,mixedModels?,byModel?,durationSec?}],skipped:[{sessionId,reason}]}`。单型号有 usage；混模仅 byModel，无合并 usage。没有 token 的会话跳过并报告；若主会话无 token 而后代有，则保留后代消费，并用 skipped/incompleteSessions 明示主会话缺失，不冒称完整生成用量。subagents 包含整棵后代树（也列出被跳过的后代 id），不是主会话数量。

durationSec 为主会话首个 task_started 至最后 task_complete 的秒数，保留毫秒精度，不相加子代理时长；后一轮尚在进行或已放弃、最后完成事件早于最新消费时省略，避免拿旧完成时间配新 token。混模型时只在顶层给出会话耗时，不假造逐模型耗时。effort 为主会话最后已知档位、efforts 列出其上下文档位；模型以有消费的分组为准。

Codex 支持按 Lead 核实的 Desktop 0.167.0-alpha.3.2 格式实现。回归只用自造夹具（含两层子代理、重放祖先 meta、空 info、放弃会话、混模、缺字段）。另经授权只读运行指定15个本地项目，机器比对结果仅保留索引与数字在 ignored `.usage-codex-comparison.log`，不保存/输出任何真实对话正文。

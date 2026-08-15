# anchored-pro — Anchored Pro (opencode-go)

> dsh-anchored-standard 的 **rc.6 + opencode-go（deepseek-v4-pro / pro-max）迁移版**：
> Pro 满血执行 —— **exact RL persona**（"You are a helpful software engineer
> assistant." 一字不改）× 官方 Minimal 真实工具对（`bash` +
> `str_replace_editor`）× 首轮 `reasoningEffort=max`。

## 与 anchored-flash 的区别

| | anchored-flash | **anchored-pro（本预设）** |
|---|---|---|
| 目标模型 | deepseek-v4-flash | **deepseek-v4-pro / pro-max** |
| persona | w7（neutral + 分类 + 回顾/收敛/反跑题/深度思考锚） | **exact RL spec 句**（`You are a helpful software engineer assistant.`，零附加） |
| 依据 | dsh-router-standard P11/P24：flash 最优 w7 | minimal 快照 = "the exact RL prompt and schemas"；附加/改写 persona 即落入训练分布间隙（见下） |
| 工具面 / 晋升 / 压缩纪元 | Minimal 对 → 发现工具 → 按需解锁 | **bash + str_replace_editor → 发现工具 → 按需解锁**（压缩后目录只增不减） |

> 为什么 anchored-flash「不行」：它对 pro 模型也会注入 w7 深度思考/回顾锚，
> 把 Pro 的轨迹拉离其 RL 分布。anchored-pro 默认只给 Pro 注入精确 spec 句，
> 其余全部交给低工具占比首轮与 Minimal 式引导。

### 为什么 persona 必须是精确 spec 句（重要）

社区与论文证据一致指向同一个结论：**V4 Pro 对首行 persona 文本高度过拟合，
只有 "You are a helpful software engineer assistant." 一字不改才是「满血」条件**。

1. **本地研究**（`dsh-router-standard` paper，本机 `dsh-routing-suite` 内有全文）：
   - DSH 官方 minimal preset 的快照测试自称发送的是 **"the exact RL prompt
     and schemas"** —— 这一句话 + 低工具占比首轮就是后训练条件本身；
   - **A1/A2 双吸引子理论**：spec（plan-first、集体语域 "We need"、read-first）
     与 react 都是训练局部最优；两者之间的混合提示词 = 训练从未采样的分布
     间隙 → 高熵、混轨、工具调用失稳、分数更低；
   - 实测：`minimal persona + bash/read → 2/2 minimal-like`；`paraphrased
     persona + 2 tools → 1 ambiguous + 1 standard-like`；`standard persona +
     2 tools → 2/2 ambiguous`。**persona 文本是主导变量，工具 schema 面是
     次要条件**（minimal persona + 6 文件工具仍 2/2 干净）。
2. **知乎**（question/2071773348753945432）：V4 Pro 正式版疑似**过拟合 DSH
   极简模式**——minimal 首轮工具占比低 → 模型关注 user prompt → 高效思维链；
   standard 25 工具 → 注意力被工具误导 → 垃圾思维链带偏后续全部轨迹。机制
   推测为 **attention sink / 首轮提示词偏差（first-prompt bias）**。
3. **X**（@GearOfProgram）：「Deepseek-V4-Pro-0813 后训练中和提示词
   "you are a ..."」——该版本后训练确实包含此开头提示词。

**这解释了此前全部症状**：旧版 w6c / w6c-pro-max（spec 句 + 分类指令/收敛锚）
= 训练从未采样的混合体 → 首行出现「Let me look at the files first.」（spec
语域本该是 "We need…"）、str_replace_editor 连败、edit read-first 连败。
**往 persona 里加任何「改进」都是反向操作**，本 preset 因此保持 persona 零
附加（read-first 等行为由 spec 吸引子天然恢复）。

> 工具面取舍：本 preset 当前默认复现官方 RL 双工具 schema：`bash` +
> `str_replace_editor`。若诊断证据显示后者在 opencode-go 上稳定造成工具失败，
> 才将 `bootstrapTools` 改为 `[bash, read, write, edit]`；不要在没有 wire-level
> 对照的情况下根据单次轨迹切换。

## 设计（与 anchored-flash 同构，rc.6 冷扫描迁移）

**失效机制**（原版 `ctx.on('session/event')` 驱动晋升在 rc.6 对 preset 平面
失效，已用真实包实证：scoped 监听器 0 次 / 宿主 1 次）→ 全部状态改为在
`system-prompt/assemble` 时**冷扫描持久日志 `session.events`** 推导：

- 晋升：`compaction/end` 边界之后（或无边界时）的首个 `tool/call` 或
  `assistant/message`（either 语义）；
- 解锁：扫描 `dev_tool_search` 的 `tool/call` 参数（resume 保留）；
- 压缩纪元：`compaction/end` 重置，需新晋升信号。
- 每次 assemble 全量扫描，无进程内 memo —— 不会过期。

**阶段**：

| 阶段 | 工具面 | persona / 上下文 |
|---|---|---|
| 未晋升（首轮） | **bash + str_replace_editor**（官方 Minimal 真实 RL 工具对） | **exact RL spec 句** + 剥离自动注入（AGENTS.md / skill catalog）+ 清空 contexts；`reasoningEffort: max` |
| 晋升后 | 引导对 + `dev_tool_search` / `skill_search` / `skill_load` + 显式解锁；压缩过的工作集**保留**（只增不减） | exact RL spec 句持续；一次性「指令文件存在」提示；恢复注入；`reasoningEffort` 回到宿主 settings（通常 max） |
| 压缩后 | 引导对 + 工作集（read/write/edit/glob/grep/todo/ask） | 直到新晋升信号；当前 preset 同样走 `max` |

- Flash 模型（`/flash/i`）自动退回 w7（兼容备用）；`config.proPersona` /
  `config.flashPersona` 可覆盖。Pro 默认即 anchored-standard 原版一句话方案
  （Project2 99 分）——**不要**给它追加锚（混合 persona = 分布间隙）。
- `bootstrapTools` 可配置：当前值为 `[bash, str_replace_editor]`，即官方 RL
  工具对；只有实测说明编辑器 schema 是触发变量时才改为文件工具回退集。
- 可选 `bootstrapReasoningEffort`：首轮/压缩回退阶段的 reasoning effort，
  `'off' | 'high' | 'max'`；`null`/`false` 禁用（完全跟随宿主）。插件本身在
  未配置时默认 `'high'`，但此 preset 的 `agent.cordis.yml` 显式选择 `'max'`。
  晋升后保留宿主 selection 的 effort；若 selection 漏值才用该配置兜底。
  opencode-go 的 `deepseek-v4-pro` 只支持 off/high/max 三档。
- 可选 `bootstrapMaxTokens`（opt-in）：经 `agent/request` waterfall 送达首轮
  请求、晋升后显式剥离。默认不设。
  ⚠️ reasoning 模型慎用：maxTokens 同时封顶「思维+答案」，思维中途截断会
  表现为「let me 碎片循环」——压链长请用 `bootstrapReasoningEffort`。
- 任一阶段工具缺失 → 降级全目录 + 一次性告警，绝不砸会话。
- 已知边界：spec persona 对 **fix 型任务满血**；build 型任务偏弱（paper 实测
  spec 6/10 vs react 10/10）。需要 build 满血时后续可加 router-standard 式
  外部路由（本次不做）。

## 安装

```sh
mkdir -p ~/.dsh/.agent-presets
cp -R preset ~/.dsh/.agent-presets/anchored-pro
```

重启 DSH，新会话选择 **Anchored Pro (opencode-go)**（推荐：配合
`agent-default-model` 设为 `opencode-go / deepseek-v4-pro / reasoningEffort: max`）。

## 测试

```sh
node preset/bootstrap.test.mjs       # 阶段推导 + persona 路由纯函数
node preset/bootstrap.smoke.test.mjs # apply() 阶段冒烟 + effort/maxTokens 相位控制
node verify/wire.test.mjs            # 本地代理、脱敏、SSE 解析、重放与矩阵离线测试
```

## Wire-Level Parity Diagnosis

`verify/` is source-only diagnostic tooling. It is not referenced by
`agent.cordis.yml`, so installing or restarting the preset does not activate
capture, logging, or any model-facing behavior change.

The required sequence is capture first, exact replay second, and controlled
field removal only after those two disagree. Do not use a plan-mode session:
plan-mode text is intentionally retained in the system prompt and is not a
valid test of the 46-character Minimal persona.

```sh
mkdir -p /tmp/anchored-pro-wire/captures /tmp/anchored-pro-wire/replays
node verify/wire-capture-proxy.mjs \
  --output /tmp/anchored-pro-wire/captures \
  --target-base https://opencode.ai
```

For one fresh, non-plan DSH first turn, temporarily route the normal
`https://opencode.ai/zen/go/v1` base through
`http://127.0.0.1:8787/zen/go/v1`. Keep the model, system prompt, tools,
effort, and user message unchanged. The proxy forwards the actual request to
the gateway and writes a private capture with credentials redacted. Capture
files still contain prompts and publicly streamed model text, so keep them out
of the repository and do not share them unreviewed.

For a source-controlled preset-aware headless capture, the included overlay
temporarily replaces only the stock headless runner. Its runner follows the
same Web factory order, installs model selection, then mounts `anchored-pro`
through `agentPresets.mount()`. It changes neither `settings.yaml` nor Web
configuration.

```sh
dsh --profile headless --patch verify/wire-headless.patch.yml \
  'Inspect the current repository, identify and read README.md, then report its title. Do not edit files.'
```

Verify the saved payload before treating this as a valid preset sample: its
first real task request must contain only the exact Minimal system persona and
the two bootstrap tools. Use the Web GUI as a second acceptance arm only when
Web-specific transport or application behavior is under investigation.

```sh
node verify/wire-replay.mjs \
  --capture /tmp/anchored-pro-wire/captures/CAPTURE.json \
  --output /tmp/anchored-pro-wire/replays \
  --dsh-credentials \
  --repeat 12

node verify/wire-report.mjs \
  /tmp/anchored-pro-wire/captures/CAPTURE.json \
  /tmp/anchored-pro-wire/replays/*.json
```

Only if the raw replay differs from DSH should a field be tested in isolation.
The example matrix covers header removal, `max_tokens`, effort, and tools; it
never invents a session ID. Edit it only with fields that actually appeared in
the capture, then start with a small repeat count because each row consumes
gateway quota.

```sh
node verify/wire-matrix.mjs \
  --capture /tmp/anchored-pro-wire/captures/CAPTURE.json \
  --matrix verify/wire-matrix.example.json \
  --output /tmp/anchored-pro-wire/replays \
  --dsh-credentials \
  --repeat 3
```

If the exact replay reproduces the same exposed `Let me...` reasoning register,
the evidence supports a gateway/model-routing conclusion rather than a preset
change. If one captured field isolates the difference, modify only the layer
that owns that field and rerun this procedure before changing persona or tool
policy.

## 回灌切断（本次升级核心）

opencode-go 网关经 pi-ai 适配层时，`deepseek-v4-pro` / `deepseek-v4-flash`
声明 `compat.requiresReasoningContentOnAssistantMessages: true` —— 历史上
**每一轮的思维链全文**会被作为 `reasoning_content` 回灌给模型。后果：

- 模型看到自己上一轮的 "Let me…" 长链，模仿并延续 → 语域逐轮漂移；
- 没装本 preset 的旧对话（混乱轨迹）也会回灌 → 污染智力。

**修复**（`@earendil-works/pi-ai/dist/api/openai-completions.js`，provider 级，
opencode-go 全覆盖）：

```js
if (nonEmptyThinkingBlocks.length > 0 && model.provider !== "opencode-go") {
```

- opencode-go 的 assistant 消息**不再回灌思维链文本**；
- `reasoning_content: ""` 空串仍发送（满足网关字段要求）；
- 思维链**仍存储并显示**在 UI（Think 块不变），只是不再喂回给模型；
- wire 实测：空串回灌 → "我们需要/We need/Let's" 语域稳定；全文回灌 →
  漂移为 "Let me…"；官方 API 从不回灌 → 满血语域。

> ⚠️ 这是对 npm 全局包（`@earendil-works/pi-ai`）的 patch，升级 dsh/pi-ai
> 会被覆盖，需重打；备份在 `openai-completions.js.bak-anchored-pro`。

## 致谢

基于 [xiaobright/dsh-anchored-standard](https://github.com/xiaobright/dsh-anchored-standard)
（MIT）与 [SheberDavid/v4-flash-godmode-opencode-go](https://github.com/SheberDavid/v4-flash-godmode-opencode-go)
的迁移手法（MIT）。

# anchored-pro — Anchored Pro (opencode-go)

> dsh-anchored-standard 的 **rc.6 + opencode-go（deepseek-v4-pro / pro-max）迁移版**：
> Pro 满血执行 —— Minimal 真实工具面锚定 × w6c Pro 标定 persona。

## 与 anchored-flash 的区别

| | anchored-flash | **anchored-pro（本预设）** |
|---|---|---|
| 目标模型 | deepseek-v4-flash | **deepseek-v4-pro / pro-max** |
| persona | w7（neutral + 分类 + 回顾/收敛/反跑题/深度思考锚） | **w6c（spec 句 + 分类指令）** |
| 依据 | dsh-router-standard P11/P24：flash 最优 w7 | P11/P24：**pro 最优 w6c；w7 的回顾/收敛锚对 Pro 有害** |
| 工具面 / 晋升 / 压缩纪元 | Minimal 对 → 发现工具 → 按需解锁 | **相同**（anchored-standard 在 V4 Pro 上实测标定） |

> 为什么 anchored-flash「不行」：它对 pro 模型也会注入 w7 深度思考/回顾锚，
> 把 Pro 的轨迹拉离其 RL 分布（P11 实测）。anchored-pro 默认只给 Pro 注入
> w6c 两句话，其余全部交给工具面锚定与 Minimal 式引导。

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
| 未晋升（首轮） | **Minimal 真实工具对**：持久 `bash` + `str_replace_editor`（issue #11：256000 下 5/5 锚定） | w6c + 剥离自动注入（AGENTS.md / skill catalog）+ 清空 contexts |
| 晋升后 | 引导对 + `dev_tool_search` / `skill_search` / `skill_load` + 显式解锁 | w6c 持续；一次性「指令文件存在」提示；恢复注入 |
| 压缩后 | 引导对 + 工作集（read/write/edit/glob/grep/todo/ask） | 直到新晋升信号 |

- Flash 模型（`/flash/i`）自动退回 w7（兼容备用）；`config.proPersona` /
  `config.flashPersona` 可覆盖；`MINIMAL_PERSONA`（anchored-standard 原版
  一句话方案，Project2 99 分）可作 `proPersona` 选用。
- 可选 `bootstrapMaxTokens`（opt-in）：经 `agent/request` waterfall 送达首轮
  请求、晋升后显式剥离。默认不设（Pro 在 256000 下 Minimal schema 即可锚定；
  rc.6 预构建包的 `prepareCall` 可能用 `adapterDefaults` 覆盖该值）。
- 任一阶段工具缺失 → 降级全目录 + 一次性告警，绝不砸会话。

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
node preset/bootstrap.smoke.test.mjs # apply() 阶段冒烟 + maxTokens cap
```

## 致谢

基于 [xiaobright/dsh-anchored-standard](https://github.com/xiaobright/dsh-anchored-standard)
（MIT）与 [SheberDavid/v4-flash-godmode-opencode-go](https://github.com/SheberDavid/v4-flash-godmode-opencode-go)
的迁移手法（MIT）。

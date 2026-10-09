# 进度记录

## 当前状态：已在 Aeoth 桌面应用（DSH 0.2.0-rc.2）安装并验证通过，等待重启窗口生效 preset

---

## 已完成

### 第 0 步：项目规范
- [x] `CLAUDE.md` — 文件组织规则、命名约定、关键 DSH API 约束

### 第 1 步：插件骨架 + API 验证
- [x] `package.json` — `dsh.bundle.patch`、`files` 含 patch、正确的 peerDependencies
- [x] `tsconfig.json`
- [x] `cordis.patch.yml`
- [x] `src/index.ts` — `name`/`inject`/`apply`/`Config`，含定时循环
- [x] **TypeScript 零错误** — API 形状验证通过

### 第 2 步：数据契约
- [x] `src/contracts.ts` — 工具名、技能名、审批节点、任务类型的单一事实源
- [x] `src/status.ts` — 内容状态与评论状态枚举，含约束函数

### 第 3 步：采集与日报（闭环核心）
- [x] `src/services/aihot.ts` — AIHOT 客户端（ETag 增量、429 退避、60次/分钟限流）
- [x] `src/services/briefing.ts` — 日报服务（组装、校验、渲染、状态机）
- [x] `src/tools/collect.ts` — `aihot_collect`/`aihot_hot_topics`/`aihot_daily`
- [x] `src/tools/briefing.ts` — `briefing_compose`/`briefing_validate`/`briefing_save`/`briefing_status`/`word_limit_check`
- [x] `src/tools/gate.ts` — `approval_request` 人工确认门
- [x] `src/schedule.ts` — 时区计算、触发判断（纯函数，无 cron 依赖）
- [x] `src/storage.ts` — 状态读写

### 第 4-5 步：76 个 Skills 全量
- [x] 七个分类目录共 76 个 `SKILL.md`
- [x] `scripts/gen-skills.mjs` — 生成脚本，含名称格式校验

### 第 6 步：六 Agent Preset（0.2 格式）
- [x] `presets/selfmedia/preset.patch.yml` — 一个 `@deepseek-ai/dsh-agent-preset` 行，
      `config.plugins` 内含编辑总监 persona（`prefix`/`suffix`）+ 六个 `dsh-tool-subagent` 委派行
      （`delegate_analyst` / `planner` / `copywriter` / `editor` / `visual` / `style`）
- [x] `package.json` 的 `dsh.bundle.patch` 改为数组，同时挂 `cordis.patch.yml` 与 preset patch
- [x] 0.1 格式的 `preset.yml` / `agent.cordis.yml` 保留为参考，运行时不再读取

### 第 7 步：文档
- [x] `CLAUDE.md` — 项目规范（含 0.2 preset 格式、Aeoth home 解析两条新约束）
- [x] `PROGRESS.md`（本文件）

---

## 本机安装与验证记录（2026-10-09）

### 安装方式
桌面应用自带的 plugin manager（不是外部 `dsh` CLI）：

```
plugin_manager install_bundle  target = /Users/changhao/Desktop/创作插件开发/dsh-plugin-selfmedia
```

结果：
- [x] profile `~/.aeoth/profiles/desktop` 记录 `"dsh-plugin-selfmedia": "link:/Users/changhao/Desktop/创作插件开发/dsh-plugin-selfmedia"`
- [x] bundle 列表追加 `dsh-plugin-selfmedia`
- [x] 插件行 `include:selfmedia` 状态 **active**（patchId `selfmedia`）
- [x] `link:` 安装 → 改代码 + `npm run build` 后无需重装

### 兼容门禁与豁免
桌面运行时是 `0.2.0-rc.2`，插件声明的 peer 是 `^0.1.2-rc.1`，被兼容门禁拒绝。当前采用
**精确版本豁免**（`compatibility.json` 里 `dsh-plugin-selfmedia@0.1.0` → `0.2.0-rc.2`，
已显式接受风险）。代码侧逐个核对过用到的 API 在 0.2.0-rc.2 中均存在且形状一致：

| 用到的 API | 0.2.0-rc.2 现状 |
|---|---|
| `defineTool({parameters:{…,required:true}, output:{schema,render}})` | 一致（`compilePropertyMap` 支持内联 required） |
| `ctx.tools.register(definition)` | 一致（`ToolRuntime`，服务名 `tools`） |
| `ctx.skills.registerProvider(create)` | 一致（`create` 同步返回带 `name` 的 provider） |
| `SkillCandidate` 校验（rank/name/provider/source） | 一致 |
| `ctx.web.fetch({url}, signal)` | 一致（`WebRuntime`，服务名 `web`） |
| `ctx.interval` | 一致（cordis-plugin-timer 1.1.6，两边同版本） |

**后续应改**：把 peer 写成多段范围 `"^0.1.2-rc.1 || ^0.2.0-rc.1"` 后重装，就能撤掉豁免。

### 验证清单
- [x] `dsh plugin add` 安装成功（9 个工具全部注册）
- [x] 76 个技能可被发现（`skill content-read` 返回包内 SKILL.md，rank 50 生效）
- [x] `aihot_hot_topics` 返回真实热点榜 10 条
- [x] `aihot_collect` 返回真实 24h 资讯（含摘要、来源、内容/评论状态标记）
- [x] `word_limit_check` 字数校验正常
- [ ] `selfmedia` preset 出现在 preset 列表 —— 需重启应用后确认
- [ ] 定时采集按 `08:30 Asia/Shanghai` 触发 —— 需一个自然日观察

### 本次修掉的缺陷
1. **状态目录解析错误**：`resolveHarnessHome()` 只读 `$DSH_HOME` 并回退 `~/.dsh`，而桌面
   运行时宿主进程不导出该变量，导致状态写到已废弃的 `~/.dsh/selfmedia`。
   已改为 Aeoth 优先级（显式配置 → `$AEOTH_HOME` → `$DSH_HOME` → `~/.aeoth`），并清理了
   误建的空目录。
2. **preset 格式过期**：0.1 的目录式 preset 在 0.2 不再被发现，已移植为声明式行。

---

## 下一步

### 必须
- [ ] 重启 Aeoth 桌面应用，确认 preset 列表出现「自媒体内容工作流」，并挂载跑一次六角色流程
- [ ] 重启后确认状态目录落在 `~/.aeoth/selfmedia`
- [ ] 把 `peerDependencies` 改成 `^0.1.2-rc.1 || ^0.2.0-rc.1`，重装后撤销版本豁免

### 可选
- [ ] 用 `npm pack` 产出的 tgz 覆盖安装，验证 `files` 字段在真实发布链路上够用
- [ ] 补 `docs/SKILL_CATALOG.md`
- [ ] 六个 delegate 行目前没有 `toolFilter.deny`，角色边界靠 persona 约束；若要硬隔离需枚举工具名

---

## 关键架构决策记录

| 决策 | 原因 |
|---|---|
| 六角色用单 preset + 6 个 tool-subagent 行 | DSH 子代理强制 join 父 preset，无 preset 参数 |
| preset 改为 `@deepseek-ai/dsh-agent-preset` 声明式行 | DSH 0.2 不再扫描目录式 preset |
| `selfmedia` 插件行只挂全局，不写进 preset | 全局行对 preset 内 agent 可见；重复挂载会让每个 preset 实例多起一个采集定时器 |
| `dsh.bundle.patch` 用数组 | 一个插件同时贡献 plugin 行与 preset 行 |
| `dsh-schedule` 不用，改用 `ctx.interval` | dsh-schedule 严格 agent-scoped，冷会话不投递 |
| skill rank = 50（不是官方的 600） | 数字小者优先，rank 50 让包内技能优先于用户目录（400/500） |
| `src/storage.ts` 用 `node:fs`，不用 `ctx.fs` | ctx.fs 有沙箱约束，状态目录在 harness home 非工作区 |
| 状态根按 Aeoth 优先级解析 | 桌面宿主进程没有 `$DSH_HOME`，回退 `~/.dsh` 会写错 home |
| 评论状态标 `not_collected` 而非空 | AIHOT 不提供评论，但状态字段是必填，留空会通过校验 |
| `fileURLToPath` 替代 `URL.pathname` | URL.pathname 在中文路径下百分号编码导致目录找不到 |

---

## 与指南的差异

指南存在以下错误，已按真实 API 实现：

| 指南写法 | 实际实现 |
|---|---|
| `parameters: { type:'object', properties:{}, required:[] }` | 扁平映射，每属性内联 `required: true` |
| `execute` 返回 `{content}` | `output: { schema, render }` + execute 返回规范值 |
| `ctx.tools.on('pre-execute', …)` | `ctx.on('tools/pre-execute', (exec, next) => …)` |
| peerDependencies `^0.1.0` | 运行时是 `0.2.0-rc.2`，应对齐实际安装版本 |
| 66 个技能 | 实际 76 个（与正文清单一致） |
| preset 用 `preset.yml` + `agent.cordis.yml` | DSH 0.2 用 `@deepseek-ai/dsh-agent-preset` 声明式行 |

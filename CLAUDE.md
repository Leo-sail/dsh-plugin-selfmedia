# dsh-plugin-selfmedia

## 项目规范

### 目录职责

```
src/              插件源码（TypeScript）
  contracts.ts    工具名与技能名的单一事实源，全项目唯一
  status.ts       内容状态与评论状态枚举
  storage.ts      $AEOTH_HOME/selfmedia 状态读写（用 node:fs，不用 ctx.fs）
  schedule.ts     定时规则：时区计算、触发判断（无 cron，纯函数）
  index.ts        插件入口：name/inject/apply/Config
  services/       AIHOT 客户端、日报服务（纯逻辑，不依赖 ctx）
  tools/          ctx.tools.register(defineTool(…)) 的注册函数
  skills/         SkillProvider 实现（rank: 50，低于用户目录优先级）

assets/skills/    76 个 SKILL.md，按 7 类分子目录
  common/         公共 7 个
  information-analysis/  情报分析 12 个
  topic-planning/ 内容策划 10 个
  writing/        文案创作 12 个
  copy-editing/   润色校对 8 个
  visual-design/  视觉美工 17 个
  style-advising/ 文风顾问 10 个

presets/selfmedia/
  preset.patch.yml  【生效】DSH 0.2 声明式 preset：一个 @deepseek-ai/dsh-agent-preset 行，
                     config.plugins 内含编辑总监 persona + 六个 delegate_* 委派工具行
  preset.yml        【0.1 格式，已废弃】旧 preset.yml 的元数据，留作参考，运行时不再读取
  agent.cordis.yml  【0.1 格式，已废弃】六角色行原稿，内容已全部并入 preset.patch.yml

schemas/          JSON Schema 文件（source-item, briefing-item, topic 等）
scripts/          gen-skills.mjs 技能生成脚本（开发用，不进 dist）
docs/             说明文档
```

### 文件放置规则

- **工具只在 `src/tools/` 里注册**，service 层不接触 ctx
- **contracts.ts 是唯一事实源**：新增工具名/技能名必须先加这里
- **技能 SKILL.md 通过 `scripts/gen-skills.mjs` 生成**，不手动创建单个文件
- **storage.ts 直接用 `node:fs/promises`**，ctx.fs 有沙箱约束，状态目录在 `$AEOTH_HOME` 下

### 命名规则

- Tool 名：`aihot_*` / `briefing_*` / `word_limit_*` / `approval_*`（snake_case，带前缀）
- Skill 名：kebab-case，全小写，必须通过 `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`
- TypeScript 接口：PascalCase；函数：camelCase；常量：UPPER_SNAKE

### 何时清理

- `scripts/gen-skills.mjs` 是开发工具，**不加入 `files` 字段**，不会发布到 npm
- `dist/` 由构建生成，不 commit
- `node_modules/` 不 commit

## 关键约束（来自实际 DSH API，与指南不同）

### 1. defineTool 的真实写法

```ts
ctx.tools.register(defineTool({
  name: 'tool_name',
  description: '…',
  parameters: {
    param: { type: 'string', required: true, description: '…' },  // 内联 required
  },
  output: {
    schema: { type: 'object', additionalProperties: false, properties: {…} },
    render: (_args, value) => [{ type: 'text', text: '…' }],
  },
  async execute(args, exec) { return value },
}))
```

### 2. SkillProvider rank 必须是 50

- `BUNDLED_SKILL_RANK` = 600，用户目录 = 400
- 数字**小者优先**，rank 50 让包内技能优先于用户目录同名技能

### 3. 六 Agent 实现机制

- DSH 子代理**强制** join 父代理的 preset，没有 `preset` 参数
- 分角色唯一途径：`dsh-tool-subagent` 的 `toolName` + `persona` + `toolFilter`
- preset 里挂 6 行 `dsh-tool-subagent`，各配独立 toolName（`delegate_analyst` 等）

### 4. 定时采集用 ctx.interval，不用 dsh-schedule

- `dsh-schedule` 严格 agent-scoped，冷会话不投递
- host-plane 定时必须用 `ctx.interval(callback, ms)`（cordis-plugin-timer）
- 没有 cron，日历规则在 `src/schedule.ts` 里自己算

### 5. peerDependencies 跟着实际运行时走

- 本机 Aeoth 桌面应用的运行时是 `0.2.0-rc.2`（旧的 npx `dsh` CLI 才是 `0.1.2-rc.1`）
- 兼容门禁**只**检查 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 前缀的 peer，`@deepseek-ai/cordis`、`schemastery` 不参与判断
- 声明 `^0.1.2-rc.1` 会让 0.2 运行时拒绝安装；跨版本兼容时写多段范围，如
  `"^0.1.2-rc.1 || ^0.2.0-rc.1"`（`dshmarket` 就是这么写的）
- 安装链路优先用桌面应用自带的 plugin manager，而不是外部 `dsh` CLI

### 6. preset 用声明式行，不用目录扫描

- DSH 0.2 删除了目录式 preset（`preset.yml` + `agent.cordis.yml`），改为一个
  `@deepseek-ai/dsh-agent-preset` 行，`config.plugins` 就是该 agent 的 standing composition
- `dsh.bundle.patch` 必须是**数组**才能同时挂 `cordis.patch.yml` 和 `presets/selfmedia/preset.patch.yml`
- persona 行用 `prefix` / `suffix`（`prefix` 必填），**没有 `text` 字段**
- 插件自身的行**不要**再写进 preset：全局行对 preset 内 agent 已可见，重复挂载会让每个
  preset 实例多起一个 host-plane 采集定时器
- 全局层注册的技能在 preset 内可见，所以 76 个技能不需要在 preset 里再挂一次

### 7. 状态目录必须落在 Aeoth home

- `@deepseek-ai/dsh-home-paths` 的优先级：显式配置 → `$AEOTH_HOME` → 旧 `$DSH_HOME` → `~/.aeoth`
- 桌面运行时宿主进程**不导出**这两个环境变量，只按 `DSH_HOME` 读并回退 `~/.dsh` 会把状态
  写到已废弃的旧 home（Aeoth 的 home 是 `~/.aeoth`）

## 验证流程

```bash
npm run typecheck   # 零错误才动手
npm run build       # 确认 dist/ 有产出
npm pack            # 确认 files 字段包含所有必要文件
```

安装到桌面应用（plugin manager 会跑 pnpm，profile 里记成 `link:`，改代码后无需重装）：

```
plugin_manager install_bundle  target = /绝对路径/dsh-plugin-selfmedia
```

## 文档同步规则

- 每次完成一个技能分组，更新 `docs/SKILL_CATALOG.md`
- 每次完成一个工具，更新 `PROGRESS.md`
- 架构变更先改 `CLAUDE.md`，再改代码

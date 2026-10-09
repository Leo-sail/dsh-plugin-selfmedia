# dsh-plugin-selfmedia

一个把 AI 资讯日报到内容发布整个链路打通的 [DSH](https://github.com/deepseek-ai/deepseek-harness) 插件。从 AIHOT 采集资讯开始，经过日报整理、选题确认、文章写作、润色校对、视觉美工，最终到公众号发布——每个环节对应一个专属角色，由一个编辑总监统一调度。

这个插件不会替你做决策。它在该停的地方停下来等你，在该记的地方记清楚，在该核实的地方真的去核实。

---

## 它在解决什么问题

手动做 AI 资讯内容的几个痛点：

- 每天的热门资讯太多，哪些值得做成内容、从哪个角度切入，很难快速判断
- 写文章时容易加入没有来源的内容，事后发现事实有误却找不到是哪里出了问题
- 评论区采集不到时，很容易把正文推断出来的读者关注点当成真实评论观点来写，这是实质性的不诚实
- 多篇文章下来，风格开始漂移，越写越不像自己写的

插件把这些问题变成规则和工具：状态码强制标注内容来源，用户关注点的来源标注（`[正文推断]` vs `[评论提取]`）在验证层强制执行，事实台账让每条事实都有据可查，风格档案记录你自己的写作习惯供每次写作参考。

---

## 快速开始

### 安装

```bash
dsh plugin --profile <你的 profile 名> add dsh-plugin-selfmedia
```

通常 profile 名是 `web` 或 `desktop`，不确定的话用 `dsh profile list` 查看。

安装完重启 DSH，切换到 **自媒体内容工作流** preset。

### 第一次采集

告诉编辑总监：

> 帮我采集今天的 AI 资讯

情报分析角色会调用 `aihot_collect`，处理资讯，返回一份结构化日报。每条资讯都标了内容状态（`partial` 表示只有摘要没有正文，不会假装拿到了全文）和评论状态。

### 选一个选题

看完日报，选你想展开的那条：

> 我想做第三条，关于那个模型发布的

内容策划角色接手，生成多个切入角度和评分，列出 Top 10 方向。它会在这里停下来等你确认——不会自己决定。

### 写文章

确认方向后，文案创作角色根据大纲和事实台账写初稿。初稿完成后触发事实对应检查，再交给润色校对和文风顾问。整个过程中，文章不会在你没看过的情况下发出去。

发布前有两个独立的确认节点：草稿保存、和正式发布。这两个不会合并成一次。

---

## 六个角色

| 工具名 | 角色 | 负责什么 |
|---|---|---|
| `delegate_analyst` | 情报分析 | 资讯采集、分类、去重、摘要生成、用户关注点提取、事实核查、日报组装 |
| `delegate_planner` | 内容策划 | 选题评分、角度生成、Top 10、大纲、论点结构、标题候选 |
| `delegate_copywriter` | 文案创作 | 初稿、改写（公众号/小红书/教程/视频脚本/清单）、事实核查 |
| `delegate_editor` | 润色校对 | 逻辑跳跃、冗余清理、去 AI 腔、语法、品牌语气、格式建议 |
| `delegate_visual` | 视觉美工 | 配图规划、提示词生成（英文）、公众号排版、移动端预览 |
| `delegate_style` | 文风顾问 | 多作者风格档案、风格建议、成稿文风审查、污染检查 |

---

## 76 个工作流技能

每个角色有一套对应的技能（Skill），通过 `skill` 工具按名字调用。技能是结构化的工作指南，带有前置条件检查和硬性规则。比如：

- `comment-analysis` 会拒绝执行，如果评论状态不是 `available` 或 `partial`
- `user-focus-extract` 要求标注来源，标错了会在 `briefing-validate` 里被拦截
- `fact-check` 不允许单一来源标 `confirmed`
- `word-limit-validator` 在检测到超限时会要求重写，不允许"稍微超一点就放过"

技能分七个大类：公共基础 7 个、情报分析 12 个、内容策划 10 个、文案创作 12 个、润色校对 8 个、视觉美工 17 个、文风顾问 10 个。

---

## 五个人工确认节点

这些节点是 `approval_request` 工具调用，不是提示词。流程会在这里真正停住，等你明确回复。

1. **日报配置首次设定** — 确认采集来源、分类、模板、发送时间
2. **Top 10 选题确认** — 用户选定一条后才进入创作链
3. **文章定稿前最终审查** — 结构、事实、逻辑都检查完
4. **公众号草稿保存前** — 再次确认标题、摘要、封面
5. **正式发布前** — 绝对不与草稿保存合并成一次

---

## 配置

默认开箱即用。如果需要调整，在你的 profile 的 `cordis.patch.yml` 里覆盖配置：

```yaml
- id: selfmedia
  name: dsh-plugin-selfmedia
  config:
    scheduleTime: "07:00"
    timeZone: Asia/Shanghai
    windowHours: 24
    maxItems: 30
    categories:
      - name: 模型发布
        max_items: 5
      - name: AI产品动态
        max_items: 8
      - name: 政策监管
        max_items: 3
```

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `stateRoot` | `$DSH_HOME/selfmedia` | 状态文件的存储位置 |
| `scheduleEnabled` | `true` | 关闭后不再自动采集 |
| `scheduleTime` | `08:30` | 每日采集时间，`HH:MM` 格式 |
| `timeZone` | `Asia/Shanghai` | 定时基准的 IANA 时区 |
| `windowHours` | `24` | 每次采集向前看多少小时 |
| `maxItems` | `50` | 每次采集条数上限 |
| `summaryLength` | `100` | 摘要目标字数 |

所有状态文件存在 `$DSH_HOME/selfmedia/` 下，包含日报、原始资讯、草稿、事实台账、风格档案和投递日志。全部是纯文本的 JSON 或 Markdown，可以直接阅读和编辑。

---

## 从源码安装

```bash
git clone https://github.com/leochang/dsh-plugin-selfmedia.git
cd dsh-plugin-selfmedia
npm install
npm run build
dsh plugin --profile <profile 名> add file:./
```

用 `file:` 方式安装后，修改代码执行 `npm run build` 即可生效，不需要重装。

---

## 技能开发

76 个技能文件由 `scripts/gen-skills.mjs` 生成，源内容在脚本里定义。修改技能内容后重新运行：

```bash
node scripts/gen-skills.mjs
```

技能名必须是全小写 kebab-case，格式要通过 `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`。DSH 对不合规的名字会直接报错而不是跳过。

---

## 关于数据和隐私

插件只向 `aihot.news` 发出采集请求（匿名只读，不需要 API Key）。所有状态数据（日报、草稿、风格档案）都存在本地 `$DSH_HOME/selfmedia/`，不会上传到任何地方。

---

## 协议

MIT — 详见 [LICENSE](LICENSE)。

## 作者

leochang · [leochang210@gmail.com](mailto:leochang210@gmail.com)

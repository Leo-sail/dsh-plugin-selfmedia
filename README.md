# dsh-plugin-selfmedia

A [DSH](https://github.com/deepseek-ai/deepseek-harness) plugin that turns the daily AI news grind into a structured content pipeline. Point it at your AIHOT feed, and you get a briefing agent, a topic planner, a writer, an editor, a visual designer, and a style advisor — all wired together under an editor-in-chief coordinator.

I built this after spending too much time manually reading through AI news, copy-pasting into docs, and losing track of which article backed which claim. The plugin doesn't automate your judgment; it gives each part of the process a proper home.

---

## What it does

**Daily briefing.** A background job collects from [aihot.news](https://aihot.news) at a scheduled time (default: 08:30 Asia/Shanghai). Every item gets an honest content status — `partial` if only the summary was available, not a fake `complete` — and an explicit note about whether comments were collected. The briefing only moves into the creation workflow when you explicitly pick a topic. It won't start drafting on its own.

**Six specialist agents.** One editor-in-chief coordinates five roles:

| Agent | What it handles |
|---|---|
| `delegate_analyst` | News reading, deduplication, summarisation, fact-checking, briefing assembly |
| `delegate_planner` | Topic scoring, angle generation, Top 10 selection, outlines, headlines |
| `delegate_copywriter` | First drafts, format rewrites (WeChat / Xiaohongshu / tutorial / video script), evidence checks |
| `delegate_editor` | Logic gaps, redundancy, AI-sounding phrases, grammar, brand voice |
| `delegate_visual` | Image briefs, prompt generation (English only — Chinese text in AI images is unreliable), WeChat layout |
| `delegate_style` | Per-author style profiles, contamination checks, style compliance review |

**76 workflow skills.** Structured guides the agents load by name — things like `comment-analysis` (which refuses to run unless you actually have comments), `user-focus-extract` (which requires you to label whether the "user focus" came from the article body or real reader comments), and `fact-check` (which won't mark something `confirmed` from a single source).

**Five mandatory approval gates.** The pipeline pauses and waits for a human at: initial briefing setup, topic selection, pre-publish review, draft save, and publish. These are tool calls, not just prompts — you can't accidentally skip them.

---

## Requirements

- DSH `^0.1.2-rc.1` or `^0.2.0-rc.1`
- Node.js 20+

---

## Installation

### Quick install (DSH plugin manager)

```bash
dsh plugin --profile <your-profile> add dsh-plugin-selfmedia
```

Replace `<your-profile>` with the profile name where you want the plugin — typically `web` or `desktop`.

### Install from source

If you want to modify the plugin or install it locally:

```bash
git clone https://github.com/leochang/dsh-plugin-selfmedia.git
cd dsh-plugin-selfmedia
npm install
npm run build
dsh plugin --profile <your-profile> add file:./
```

With a local `file:` install, running `npm run build` after any code change takes effect immediately — no reinstall needed.

### Verify the install

After installing, restart DSH and check that the plugin is active:

```bash
dsh plugin --profile <your-profile> list
```

You should see `dsh-plugin-selfmedia` in the output with status `active`.

---

## Getting started

### 1. Select the preset

In DSH, switch to the **自媒体内容工作流** preset. This activates the editor-in-chief and all six delegate agents.

### 2. Collect your first briefing

Ask the editor-in-chief:

> 帮我采集今天的 AI 资讯

The analyst agent calls `aihot_collect`, processes the results, and returns a structured briefing. Each item shows where the user focus came from (article inference vs. actual reader comments) and an honest content status.

### 3. Pick a topic

Read through the briefing and tell the editor which item you want to develop:

> 我想做第三条，关于 OpenAI 定价变化的那篇

The pipeline moves from `report_generated` to `topic_requested`. The planner generates angles and a Top 10 direction list, then pauses for you to confirm the one you want.

### 4. Create the article

Once you select a direction, the copywriter drafts based on the outline and the fact ledger the analyst built. After the draft, the editor reviews for logic, redundancy, AI phrasing, and grammar. The style advisor checks whether the result sounds like you.

Nothing publishes automatically. The pipeline stops at every decision point.

---

## Configuration

The plugin works out of the box. If you want to change the collection schedule, categories, or state directory, add a `config` block to the plugin's row in your profile's `cordis.patch.yml`:

```yaml
- id: selfmedia
  name: dsh-plugin-selfmedia
  config:
    scheduleTime: "07:00"
    timeZone: Asia/Tokyo
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

| Option | Default | Description |
|---|---|---|
| `stateRoot` | `$DSH_HOME/selfmedia` | Where briefings, drafts, and style profiles are stored |
| `scheduleEnabled` | `true` | Turn off to disable the background collection job |
| `scheduleTime` | `08:30` | When the daily collection runs, in `HH:MM` format |
| `timeZone` | `Asia/Shanghai` | IANA time zone for the schedule |
| `windowHours` | `24` | How far back each collection looks |
| `maxItems` | `50` | Items to fetch per collection |
| `summaryLength` | `100` | Target summary length in characters |

State files live at `$DSH_HOME/selfmedia/` — briefings, raw sources, drafts, evidence ledgers, style profiles, and a delivery log. Everything is plain JSON or Markdown, so you can read, diff, and edit it directly.

---

## Why the content and comment status fields exist

Every collected item carries two status codes: `content_status` and `comment_status`. This is deliberate.

AIHOT returns an index entry with a summary — not the full article. So a freshly collected item is `partial`, not `complete`. If you go fetch the original article, you can update it to `complete`. If you can't, it stays `partial`.

The comment status is separate because a `partial` article can have `available` comments and vice versa. More importantly: the `user-focus-extract` skill requires you to label whether the "user focus" line came from actual reader comments or was inferred from the article body. If comments weren't collected, the label must say `[正文推断]` — marking it as `[评论提取]` when no comments exist is blocked at the validation layer.

This matters because writing "readers are concerned about X" when you only read the article, not the comments, is a meaningful factual claim that could be wrong.

---

## State and privacy

The plugin stores state locally in `$DSH_HOME/selfmedia/`. Nothing is sent anywhere except the outbound requests to `aihot.news` for news collection. The AIHOT API is anonymous and read-only — no credentials required.

Style profiles (the author voice archives the style advisor builds) also live locally. They're never uploaded.

---

## Developing

```bash
npm run dev    # watch mode — rebuilds on every save
npm run build  # single build
npm run typecheck  # type-only check, no output
```

The 76 skill files in `assets/skills/` are generated by `scripts/gen-skills.mjs`. If you want to change skill content, edit the script and re-run it:

```bash
node scripts/gen-skills.mjs
```

Skill names must be lowercase kebab-case (`/^[a-z0-9]+(?:-[a-z0-9]+)*$/`). The DSH skill registry throws on an invalid name, so the script validates them before writing.

---

## License

MIT — see [LICENSE](LICENSE).

## Author

leochang · [leochang210@gmail.com](mailto:leochang210@gmail.com)

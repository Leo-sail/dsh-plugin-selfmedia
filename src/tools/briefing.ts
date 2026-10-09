/**
 * Briefing assembly and delivery tools.
 *
 * `briefing_compose` groups collected items into the configured categories and
 * writes the draft; `briefing_validate` is the gate that must pass before
 * delivery; `briefing_save` persists a delivered briefing and moves it to
 * `report_generated`, which deliberately does NOT start the creation flow.
 *
 * @module dsh-plugin-selfmedia/tools/briefing
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

import {
  TOOL_BRIEFING_COMPOSE,
  TOOL_BRIEFING_SAVE,
  TOOL_BRIEFING_STATUS,
  TOOL_BRIEFING_VALIDATE,
  TOOL_WORD_LIMIT_CHECK,
} from '../contracts.js'
import {
  computeStats,
  countChars,
  LIMITS,
  toBriefingItem,
  validateBriefing,
  type BriefingCategory,
  type BriefingDocument,
  type BriefingItem,
  type BriefingService,
} from '../services/briefing.js'

/** Dependencies the briefing tools close over. */
export interface BriefingDeps {
  readonly service: BriefingService
  /** Category order and per-category cap, from plugin config. */
  readonly categories: readonly { readonly name: string; readonly max_items: number }[]
  readonly summaryLength: number
}

/**
 * Register every briefing tool plus the word-limit gate.
 *
 * @param ctx - registrant context carrying the tool registry.
 * @param deps - the briefing service and category configuration.
 */
export function registerBriefingTools(ctx: Context, deps: BriefingDeps): void {
  ctx.tools.register(buildComposeTool(deps))
  ctx.tools.register(buildValidateTool(deps))
  ctx.tools.register(buildSaveTool(deps))
  ctx.tools.register(buildStatusTool(deps))
  ctx.tools.register(buildWordLimitTool())
}

/**
 * `briefing_compose` — assemble a briefing from collected items.
 *
 * @param deps - the briefing service and category configuration.
 * @returns the tool definition.
 */
function buildComposeTool(deps: BriefingDeps) {
  return defineTool({
    name: TOOL_BRIEFING_COMPOSE,
    description: `把采集到的资讯按配置的分类组装成日报草稿。写入 $DSH_HOME/selfmedia/briefings/<date>.json 与 .md，并把状态置为 report_generated。

用途：采集完成后生成日报。这是日报流程的最后一步，日报生成后不会自动进入创作流程。

前提：
- 传入的每条资讯必须已由情报分析完成摘要（≤${LIMITS.summary}字）、用户关注点（≤${LIMITS.userFocus}字，含来源标注）和关键词（1-3个）。未完成的字段会留空并由 briefing_validate 拒绝。
- 只传入本窗口内的新增资讯，重复内容应先由去重技能合并。

限制：不发送日报到任何会话，只写文件。发送由调用方决定。`,
    parameters: {
      date: {
        type: 'string',
        required: true,
        description: '日报日期，格式 YYYY-MM-DD。',
      },
      window_start: {
        type: 'string',
        required: true,
        description: '统计窗口起点，ISO 8601。',
      },
      window_end: {
        type: 'string',
        required: true,
        description: '统计窗口终点，ISO 8601。',
      },
      items: {
        type: 'array',
        required: true,
        description: '本窗口内的资讯，每条含 title、url、source、category、summary、user_focus、user_focus_source、keywords。',
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            source_id: { type: 'string' },
            category: { type: 'string', required: true },
            title: { type: 'string', required: true },
            url: { type: 'string', required: true },
            source: { type: 'string', required: true },
            published_at: { type: 'string' },
            summary: { type: 'string', required: true },
            user_focus: { type: 'string', required: true },
            user_focus_source: {
              type: 'string',
              required: true,
              enum: ['正文推断', '评论提取', '综合'],
            },
            keywords: {
              type: 'array',
              required: true,
              items: { type: 'string' },
            },
            content_status: {
              type: 'string',
              required: true,
              enum: ['complete', 'partial', 'not_available', 'permission_denied', 'not_found'],
            },
            comment_status: {
              type: 'string',
              required: true,
              enum: ['available', 'partial', 'not_available', 'permission_denied', 'not_collected'],
            },
          },
        },
      },
      cluster_count: {
        type: 'integer',
        description: '事件簇数量，用于统计。不传按 0 计。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          saved: { type: 'boolean', required: true },
          path: { type: 'string' },
          state: { type: 'string', required: true },
          total_count: { type: 'integer', required: true },
          category_stats: { type: 'string', required: true },
          markdown: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: [
            `日报草稿已生成，状态：${value.state}`,
            `写入：${value.path ?? '(未写入)'}`,
            `共 ${value.total_count} 条；分类：${value.category_stats}`,
            '',
            '注意：状态 report_generated 不会自动触发创作流程。需要创作时，用户必须明确选定选题。',
          ].join('\n'),
        },
      ],
    },
    async execute(args) {
      const byCategory = groupByCategory(args.items as readonly BriefingItem[], deps.categories)
      const items = byCategory.flatMap((category) => category.items)
      const document: BriefingDocument = {
        date: args.date,
        window_start: args.window_start,
        window_end: args.window_end,
        state: 'report_generated',
        categories: byCategory,
        stats: computeStats(items, args.cluster_count ?? 0),
      }
      const path = await deps.service.save(document)
      return {
        saved: true,
        path,
        state: 'report_generated' as const,
        total_count: document.stats.total_count,
        category_stats: Object.entries(document.stats.category_counts)
          .map(([name, count]) => `${name} ${count}`)
          .join('，'),
        markdown: deps.service.render(document),
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `组装日报 · ${args.date}`,
      kind: 'other',
      rawInput: { date: args.date, item_count: args.items.length },
    }),
  })
}

/**
 * `briefing_validate` — the pre-delivery gate.
 *
 * @param deps - the briefing service.
 * @returns the tool definition.
 */
function buildValidateTool(deps: BriefingDeps) {
  return defineTool({
    name: TOOL_BRIEFING_VALIDATE,
    description: `在日报发出前做最终校验。检查必填字段、字数上限、链接格式、内容与评论状态是否明确标记、用户关注点的来源标注是否与实际评论状态矛盾。

用途：briefing_compose 之后、交付之前必须调用。存在任何问题时不允许交付日报。

限制：只校验已写入磁盘的日报，不做修复。发现问题需回到情报分析修正后重新组装。`,
    parameters: {
      date: {
        type: 'string',
        required: true,
        description: '要校验的日报日期，格式 YYYY-MM-DD。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          found: { type: 'boolean', required: true },
          pass: { type: 'boolean', required: true },
          problem_count: { type: 'integer', required: true },
          problems: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                field: { type: 'string', required: true },
                item_index: { type: 'integer' },
                message: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: !value.found
            ? '找不到该日期的日报，无法校验。'
            : value.pass
              ? '日报校验通过，可以交付。'
              : `日报校验未通过，共 ${value.problem_count} 个问题：\n${value.problems
                  .map((problem) => `- [${problem.field}]${problem.item_index === undefined ? '' : ` 第${problem.item_index + 1}条`}：${problem.message}`)
                  .join('\n')}`,
        },
      ],
    },
    async execute(args) {
      const document = await deps.service.load(args.date)
      if (document === undefined) {
        return { found: false, pass: false, problem_count: 0, problems: [] }
      }
      const problems = validateBriefing(document)
      return {
        found: true,
        pass: problems.length === 0,
        problem_count: problems.length,
        problems: problems.map((problem) => ({
          field: problem.field,
          ...(problem.item_index === null ? {} : { item_index: problem.item_index }),
          message: problem.message,
        })),
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `校验日报 · ${args.date}`, kind: 'other' }),
  })
}

/**
 * `briefing_save` — persist a validated briefing as delivered.
 *
 * @param deps - the briefing service.
 * @returns the tool definition.
 */
function buildSaveTool(deps: BriefingDeps) {
  return defineTool({
    name: TOOL_BRIEFING_SAVE,
    description: `把校验通过的日报确认交付，追加一条投递记录到 delivery.jsonl，并保持状态为 report_generated。

用途：briefing_validate 通过后调用，确认这份日报已交付给用户。

前提：必须先通过 briefing_validate。本工具会重新校验一次，未通过则拒绝交付。

限制：不发送到任何会话，只落盘并记账。日报与创作流程严格分离 —— 交付日报不等于开始写文章。`,
    parameters: {
      date: {
        type: 'string',
        required: true,
        description: '要交付的日报日期，格式 YYYY-MM-DD。',
      },
      target_session: {
        type: 'string',
        description: '目标会话名，默认「资讯日报」。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          delivered: { type: 'boolean', required: true },
          reason: { type: 'string' },
          path: { type: 'string' },
          state: { type: 'string' },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: value.delivered
            ? `日报已交付。状态：${value.state ?? 'report_generated'}。下一步需要用户明确选定选题才会进入创作流程。`
            : `拒绝交付：${value.reason ?? '未知原因'}`,
        },
      ],
    },
    async execute(args) {
      const document = await deps.service.load(args.date)
      if (document === undefined) {
        return { delivered: false, reason: `找不到 ${args.date} 的日报` }
      }
      const problems = validateBriefing(document)
      if (problems.length > 0) {
        return { delivered: false, reason: `日报未通过校验，共 ${problems.length} 个问题` }
      }
      const path = await deps.service.save(document)
      return { delivered: true, path, state: 'report_generated' }
    },
    presentCall: (args) => ({ card: 'generic', title: `交付日报 · ${args.date}`, kind: 'other' }),
  })
}

/**
 * `briefing_status` — read the current briefing state.
 *
 * @param deps - the briefing service.
 * @returns the tool definition.
 */
function buildStatusTool(deps: BriefingDeps) {
  return defineTool({
    name: TOOL_BRIEFING_STATUS,
    description: `查询某天的日报状态，或把日报推进到创作流程。

用途：日报交付后，用户明确说"把第N条做成文章"时，先调本工具把状态推进到 topic_requested，再交给内容策划。

限制：这是唯一能离开 report_generated 状态的入口，且只在用户明确选定选题后调用。不猜用户意图。`,
    parameters: {
      date: {
        type: 'string',
        required: true,
        description: '日报日期，格式 YYYY-MM-DD。',
      },
      request_topic: {
        type: 'boolean',
        description: '置为 true 表示用户已明确选定选题，把状态推进到 topic_requested。默认 false，仅查询。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          found: { type: 'boolean', required: true },
          state: { type: 'string' },
          total_count: { type: 'integer' },
          path: { type: 'string' },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: !value.found
            ? '找不到该日期的日报。'
            : `日报状态：${value.state ?? '未知'}，共 ${value.total_count ?? 0} 条。${value.path === undefined ? '' : `\n${value.path}`}`,
        },
      ],
    },
    async execute(args) {
      if (args.request_topic === true) {
        const path = await deps.service.requestTopic(args.date)
        if (path === undefined) return { found: false }
        const document = await deps.service.load(args.date)
        return {
          found: true,
          state: document?.state ?? 'topic_requested',
          total_count: document?.stats.total_count ?? 0,
          path,
        }
      }
      const document = await deps.service.load(args.date)
      if (document === undefined) return { found: false }
      return { found: true, state: document.state, total_count: document.stats.total_count }
    },
    presentCall: (args) => ({ card: 'generic', title: `查询日报状态 · ${args.date}`, kind: 'other' }),
  })
}

/**
 * `word_limit_check` — enforce the character caps in code, not just in prose.
 *
 * The skills state the same limits, but an agent can miscount Chinese text. This
 * tool is the mechanical check that makes the cap real.
 *
 * @returns the tool definition.
 */
function buildWordLimitTool() {
  return defineTool({
    name: TOOL_WORD_LIMIT_CHECK,
    description: `校验一段文本是否超出对应字段的字数上限。按码点数计数，中文与 emoji 各算 1 字。

用途：摘要（≤${LIMITS.summary}字）、用户关注点（≤${LIMITS.userFocus}字）、推荐理由（≤${LIMITS.reason}字）、选题标题（≤${LIMITS.topicTitle}字）生成后立即调用。超限必须重写，不允许输出超限内容。

可用字段：summary / user_focus / reason / topic_title / keywords。选 keywords 时检查的是数量而非字数（1-3个）。`,
    parameters: {
      field: {
        type: 'string',
        required: true,
        enum: ['summary', 'user_focus', 'reason', 'topic_title', 'keywords'],
        description: '要套用的字段规则。',
      },
      text: {
        type: 'string',
        required: true,
        description: '待校验的文本。字段为 keywords 时传空格或顿号分隔的关键词列表。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pass: { type: 'boolean', required: true },
          field: { type: 'string', required: true },
          limit: { type: 'integer', required: true },
          actual: { type: 'integer', required: true },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: value.pass
            ? `通过：${value.field} 当前 ${value.actual}，上限 ${value.limit}。`
            : `未通过：${value.field} 当前 ${value.actual}，上限 ${value.limit}。${value.message ?? ''}`,
        },
      ],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      if (args.field === 'keywords') {
        const words = args.text
          .split(/[\s、,，|]+/)
          .map((word) => word.trim())
          .filter((word) => word.length > 0)
        const limit = LIMITS.keywords.max
        return {
          pass: words.length >= LIMITS.keywords.min && words.length <= limit,
          field: args.field,
          limit,
          actual: words.length,
          ...(words.length < LIMITS.keywords.min
            ? { message: `至少需要 ${LIMITS.keywords.min} 个关键词。` }
            : {}),
        }
      }
      const limit = FIELD_LIMITS[args.field]
      const actual = countChars(args.text)
      return {
        pass: actual <= limit,
        field: args.field,
        limit,
        actual,
        ...(actual > limit ? { message: `超出 ${actual - limit} 字，必须重写。` } : {}),
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `校验字数 · ${args.field}`,
      kind: 'other',
      rawInput: { field: args.field },
    }),
  })
}

/** Character cap per validated field. */
const FIELD_LIMITS = {
  summary: LIMITS.summary,
  user_focus: LIMITS.userFocus,
  reason: LIMITS.reason,
  topic_title: LIMITS.topicTitle,
} as const

/**
 * Group briefing items into the configured categories, preserving order and
 * enforcing each category's cap.
 *
 * Items whose category is not configured are collected into a trailing group
 * rather than dropped, so a mislabelled item is visible instead of silently
 * missing.
 *
 * @param items - every item the briefing should carry.
 * @param configured - category order and caps.
 * @returns the ordered category groups.
 */
function groupByCategory(
  items: readonly BriefingItem[],
  configured: readonly { readonly name: string; readonly max_items: number }[],
): BriefingCategory[] {
  const buckets = new Map<string, BriefingItem[]>()
  for (const item of items) {
    const bucket = buckets.get(item.category)
    if (bucket === undefined) buckets.set(item.category, [item])
    else bucket.push(item)
  }

  const groups: BriefingCategory[] = []
  for (const category of configured) {
    const bucket = buckets.get(category.name) ?? []
    groups.push({ name: category.name, items: bucket.slice(0, category.max_items) })
    buckets.delete(category.name)
  }
  for (const [name, bucket] of buckets) {
    groups.push({ name, items: bucket })
  }
  return groups
}

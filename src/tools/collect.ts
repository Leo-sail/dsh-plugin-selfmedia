/**
 * AIHOT collection tools.
 *
 * Three read-only tools over the news index. None of them fetches an article
 * body: AIHOT serves an index entry with a summary and outbound links, so a
 * caller that needs full text follows `links.original` itself and records the
 * resulting status honestly.
 *
 * @module dsh-plugin-selfmedia/tools/collect
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

import {
  TOOL_AIHOT_COLLECT,
  TOOL_AIHOT_DAILY,
  TOOL_AIHOT_HOT_TOPICS,
} from '../contracts.js'
import {
  AIHOT_CATEGORIES,
  AIHOT_MODES,
  AIHOT_SORTS,
  AIHOT_WINDOWS,
  type AihotCategory,
  type AihotClient,
  type AihotMode,
  type AihotSort,
  type AihotWindow,
  type CollectedItem,
} from '../services/aihot.js'

/** The collection surface the tools need, so a test can substitute a stub. */
export interface CollectDeps {
  readonly client: AihotClient
}

/**
 * Register every AIHOT collection tool.
 *
 * @param ctx - registrant context carrying the tool registry.
 * @param deps - the AIHOT client the tools call.
 */
export function registerCollectTools(ctx: Context, deps: CollectDeps): void {
  ctx.tools.register(buildCollectTool(deps))
  ctx.tools.register(buildHotTopicsTool(deps))
  ctx.tools.register(buildDailyTool(deps))
}

/**
 * `aihot_collect` — one page of the news index.
 *
 * @param deps - the AIHOT client.
 * @returns the tool definition.
 */
function buildCollectTool(deps: CollectDeps) {
  return defineTool({
    name: TOOL_AIHOT_COLLECT,
    description: `从 AIHOT (aihot.news) 采集 AI 资讯索引。返回指定时间窗口内的资讯条目，每条含标题、AI 摘要、来源媒体、原文发布时间、AIHOT 收录时间、分类、评分、是否精选和外链。

用途：需要了解今日 AI 资讯、准备日报素材、寻找创作选题时调用。这是采集入口，日报组装的输入来自它。

限制与前提：
- 不返回文章正文。AIHOT 是资讯索引，只有摘要。正文需自行访问 links.original 获取。
- 不返回评论。评论状态恒为 not_collected，禁止据此推断评论观点。
- 匿名只读，无需 API Key。单 IP 约 60 次/分钟，超出返回限速错误。
- 返回条目的 content_status 恒为 partial（有摘要）或 not_available（无摘要），这是如实标记，不是错误。`,
    parameters: {
      window: {
        type: 'string',
        required: true,
        enum: [...AIHOT_WINDOWS],
        description: '时间窗口。24h 为过去 24 小时，7d 为过去 7 天。',
      },
      mode: {
        type: 'string',
        enum: [...AIHOT_MODES],
        description: 'selected 只返回编辑精选，all 返回全部公开资讯。默认 selected。',
      },
      category: {
        type: 'string',
        enum: [...AIHOT_CATEGORIES],
        description: '按分类筛选。不传则返回全部分类。',
      },
      by: {
        type: 'string',
        enum: [...AIHOT_SORTS],
        description: 'timeline 按 AIHOT 收录时间排序，published 按原文发布时间排序。默认 timeline。',
      },
      q: {
        type: 'string',
        description: '关键词搜索，按字面匹配标题与摘要。不传则不做文本筛选。',
      },
      limit: {
        type: 'integer',
        description: '返回条数，1-100，默认 50。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          items: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                title: { type: 'string', required: true },
                summary: { type: 'string' },
                source: { type: 'string', required: true },
                published_at: { type: 'string' },
                discovered_at: { type: 'string' },
                category: { type: 'string' },
                score: { type: 'integer' },
                selected: { type: 'boolean', required: true },
                url: { type: 'string' },
                aihot_url: { type: 'string' },
                content_status: { type: 'string', required: true },
                comment_status: { type: 'string', required: true },
              },
            },
          },
          total: { type: 'integer', required: true },
          has_more: { type: 'boolean', required: true },
          window: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: renderCollectResult(value.window, value.items, value.total, value.has_more),
        },
      ],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const page = await deps.client.items(
        {
          window: args.window as AihotWindow,
          ...(args.mode === undefined ? {} : { mode: args.mode as AihotMode }),
          ...(args.category === undefined ? {} : { category: args.category as AihotCategory }),
          ...(args.by === undefined ? {} : { by: args.by as AihotSort }),
          ...(args.q === undefined ? {} : { q: args.q }),
          ...(args.limit === undefined ? {} : { limit: args.limit as number }),
        },
        exec.signal,
      )
      return {
        items: page.items.map(toWireItem),
        total: page.total,
        has_more: page.hasMore,
        window: args.window,
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `采集 AIHOT 资讯 · ${args.window}`,
      kind: 'other',
      rawInput: args,
    }),
  })
}

/**
 * `aihot_hot_topics` — the ranked hot list.
 *
 * @param deps - the AIHOT client.
 * @returns the tool definition.
 */
function buildHotTopicsTool(deps: CollectDeps) {
  return defineTool({
    name: TOOL_AIHOT_HOT_TOPICS,
    description: `获取 AIHOT 当前热点榜（Top 10）。每条含排名、标题、摘要，以及 links.story —— 站内事件聚合页的 publicId。

用途：判断今天最受关注的事件、为选题评分提供热度依据。

限制：links.story 的 publicId 只能从这里取得，无法自行构造。需要事件时间线时用该 publicId 调 /api/v1/stories/{publicId}。`,
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          topics: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                rank: { type: 'integer' },
                title: { type: 'string', required: true },
                summary: { type: 'string' },
                story_id: { type: 'string' },
                aihot_url: { type: 'string' },
              },
            },
          },
          count: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text:
            value.topics.length === 0
              ? 'AIHOT 当前没有热点榜数据。'
              : `AIHOT 热点榜（${value.count} 条）：\n${value.topics
                  .map((topic) => `${topic.rank ?? '-'}. ${topic.title}${topic.summary === undefined ? '' : `\n   ${topic.summary}`}`)
                  .join('\n')}`,
        },
      ],
    },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const topics = await deps.client.hotTopics(exec.signal)
      return {
        topics: topics.map((topic, index) => ({
          rank: topic.rank ?? index + 1,
          title: topic.title ?? '(无标题)',
          ...(topic.summary === null || topic.summary === undefined ? {} : { summary: topic.summary }),
          ...(topic.links?.story === undefined ? {} : { story_id: topic.links.story }),
          ...(topic.links?.aihot === undefined ? {} : { aihot_url: topic.links.aihot }),
        })),
        count: topics.length,
      }
    },
    presentCall: () => ({ card: 'generic', title: '获取 AIHOT 热点榜', kind: 'other' }),
  })
}

/**
 * `aihot_daily` — AIHOT's own daily digest.
 *
 * @param deps - the AIHOT client.
 * @returns the tool definition.
 */
function buildDailyTool(deps: CollectDeps) {
  return defineTool({
    name: TOOL_AIHOT_DAILY,
    description: `获取 AIHOT 官方日报（每日北京时间 08:00 发布）。不传日期取最新一期，传日期取指定那天。

用途：作为素材参考，了解 AIHOT 编辑部当天挑选了哪些事件。注意这是 AIHOT 的日报，不是本插件的日报 —— 本插件的日报由 briefing_compose 生成。

限制：指定日期没有发布日报时返回 has_digest 为 false。`,
    parameters: {
      date: {
        type: 'string',
        description: '日期，格式 YYYY-MM-DD。不传则取最新一期。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          has_digest: { type: 'boolean', required: true },
          date: { type: 'string' },
          digest_json: { type: 'string' },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: value.has_digest
            ? `AIHOT 日报${value.date === undefined ? '' : ` · ${value.date}`}：\n${value.digest_json ?? ''}`
            : `AIHOT 在指定日期没有发布日报。`,
        },
      ],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const body = await deps.client.daily(args.date, exec.signal)
      if (body === undefined || body === null) return { has_digest: false }
      return { has_digest: true, digest_json: JSON.stringify(body, null, 2) }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: args.date === undefined ? '获取 AIHOT 最新日报' : `获取 AIHOT 日报 · ${args.date}`,
      kind: 'other',
    }),
  })
}

/**
 * Project one collected item onto the tool's wire shape.
 *
 * `undefined` is preserved rather than stringified, so the model can tell an
 * absent field from an empty one.
 *
 * @param item - the normalised collected item.
 * @returns the wire-shape record.
 */
function toWireItem(item: CollectedItem) {
  return {
    id: item.id,
    title: item.title,
    ...(item.summary === null ? {} : { summary: item.summary }),
    source: item.source,
    ...(item.publishedAt === null ? {} : { published_at: item.publishedAt }),
    ...(item.discoveredAt === null ? {} : { discovered_at: item.discoveredAt }),
    ...(item.category === null ? {} : { category: item.category }),
    ...(item.score === null ? {} : { score: Math.round(item.score) }),
    selected: item.selected,
    ...(item.links.original === undefined ? {} : { url: item.links.original }),
    ...(item.links.aihot === undefined ? {} : { aihot_url: item.links.aihot }),
    content_status: item.content_status,
    comment_status: item.comment_status,
  }
}

/**
 * Render a collection page for the model.
 *
 * @param window - the requested window, echoed back.
 * @param items - the page's items.
 * @param total - the API's total count for the query.
 * @param hasMore - whether more pages exist.
 * @returns the model-facing text.
 */
function renderCollectResult(
  window: string,
  items: readonly { title: string; source: string; summary?: string; url?: string; content_status: string; comment_status: string }[],
  total: number,
  hasMore: boolean,
): string {
  if (items.length === 0) {
    return `AIHOT 在 ${window} 窗口内没有返回资讯。可能是该时段确实无新增，也可能是筛选条件过窄。`
  }
  const lines = items.map((item, index) => {
    const parts = [`${index + 1}. ${item.title}`, `   来源：${item.source}`]
    if (item.summary !== undefined) parts.push(`   摘要：${item.summary}`)
    if (item.url !== undefined) parts.push(`   原文：${item.url}`)
    parts.push(`   内容状态：${item.content_status} · 评论状态：${item.comment_status}`)
    return parts.join('\n')
  })
  return [
    `AIHOT ${window} 窗口，返回 ${items.length} 条（该查询共 ${total} 条${hasMore ? '，还有更多' : ''}）：`,
    '',
    ...lines,
    '',
    '注意：以上均为索引条目，未采集正文与评论。需要正文请访问原文链接。',
  ].join('\n')
}

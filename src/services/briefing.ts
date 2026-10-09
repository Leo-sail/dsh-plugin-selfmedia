/**
 * Briefing assembly, validation, and delivery state.
 *
 * A briefing is an independent information product, not the first step of an
 * article. Once delivered its state is `report_generated` and the pipeline
 * stops: nothing downstream runs until the user explicitly selects a topic,
 * which moves the state to `topic_requested`. The two flows never merge — a
 * scheduled collection that silently started drafting would be a bug.
 *
 * @module dsh-plugin-selfmedia/services/briefing
 */

import { join } from 'node:path'

import { appendJsonLine, readJsonFile, statePaths, writeJsonFile, writeTextFile, type StatePaths } from '../storage.js'
import { makeStatusPair, type CommentStatus, type ContentStatus } from '../status.js'
import type { CollectedItem } from './aihot.js'

/** Lifecycle of one day's briefing. */
export const BRIEFING_STATES = ['report_generated', 'topic_requested', 'topic_selected'] as const
export type BriefingState = (typeof BRIEFING_STATES)[number]

/** Field limits the validators enforce. Kept here so tools and skills agree. */
export const LIMITS = {
  /** Hard cap on a summary, in characters. */
  summary: 100,
  /** Hard cap on a user-focus line. */
  userFocus: 50,
  /** Hard cap on a topic's recommendation reason. */
  reason: 150,
  /** Hard cap on a topic's directional headline. */
  topicTitle: 30,
  /** Inclusive keyword count range. */
  keywords: { min: 1, max: 3 },
} as const

/** One item inside a briefing, with every required field present. */
export interface BriefingItem {
  readonly source_id: string
  readonly category: string
  readonly title: string
  readonly url: string
  readonly source: string
  readonly published_at: string | null
  readonly summary: string
  readonly user_focus: string
  readonly user_focus_source: '正文推断' | '评论提取' | '综合'
  readonly keywords: string[]
  readonly content_status: ContentStatus
  readonly comment_status: CommentStatus
}

/** One rule a briefing must satisfy before it may be delivered. */
export interface ValidationProblem {
  readonly field: string
  readonly item_index: number | null
  readonly message: string
}

/** One day's assembled briefing. */
export interface BriefingDocument {
  readonly date: string
  readonly window_start: string
  readonly window_end: string
  readonly state: BriefingState
  readonly categories: readonly BriefingCategory[]
  readonly stats: BriefingStats
}

/** A named group of items in the briefing body. */
export interface BriefingCategory {
  readonly name: string
  readonly items: readonly BriefingItem[]
}

/** Counts rendered in the briefing footer. */
export interface BriefingStats {
  readonly total_count: number
  readonly category_counts: Readonly<Record<string, number>>
  readonly cluster_count: number
  readonly comment_available_rate: number
  readonly content_complete_rate: number
}

/** One record in the append-only delivery log. */
export interface DeliveryRecord {
  readonly date: string
  readonly trigger: 'scheduled' | 'manual'
  readonly items_collected: number
  readonly items_new: number
  readonly items_deduplicated: number
  readonly delivery_status: 'success' | 'skipped_empty' | 'failed'
  readonly target_session: string
  readonly sent_at: string
}

/**
 * Briefing state holder for one plugin load.
 *
 * Holds the paths, the last assembled document, and the current state. The
 * document itself is persisted to disk as soon as it is composed, so a restart
 * never loses a generated briefing.
 */
export class BriefingService {
  readonly paths: StatePaths
  #document: BriefingDocument | undefined

  constructor(root: string) {
    this.paths = statePaths(root)
  }

  /** The most recently composed briefing, when one exists in memory. */
  get current(): BriefingDocument | undefined {
    return this.#document
  }

  /**
   * Persist one briefing and move the state to `report_generated`.
   *
   * @param document - the assembled briefing.
   * @returns the absolute path written.
   */
  async save(document: BriefingDocument): Promise<string> {
    const stored: BriefingDocument = { ...document, state: 'report_generated' }
    this.#document = stored
    const jsonPath = join(this.paths.briefings, `${document.date}.json`)
    await writeJsonFile(jsonPath, stored)
    await writeTextFile(join(this.paths.briefings, `${document.date}.md`), this.render(stored))
    await appendJsonLine(join(this.paths.deliveryLog, 'delivery.jsonl'), {
      date: document.date,
      trigger: 'scheduled',
      items_collected: document.stats.total_count,
      items_new: document.stats.total_count,
      items_deduplicated: 0,
      delivery_status: document.stats.total_count === 0 ? 'skipped_empty' : 'success',
      target_session: '资讯日报',
      sent_at: new Date().toISOString(),
    } satisfies DeliveryRecord)
    return jsonPath
  }

  /**
   * Load a briefing from disk by date.
   *
   * @param date - `YYYY-MM-DD`.
   * @returns the stored briefing, or `undefined` when that day has none.
   */
  async load(date: string): Promise<BriefingDocument | undefined> {
    return readJsonFile<BriefingDocument>(join(this.paths.briefings, `${date}.json`))
  }

  /**
   * Move the briefing into the creation flow.
   *
   * This is the only transition out of `report_generated`, and it happens only
   * on an explicit user instruction.
   *
   * @param date - the briefing's date.
   * @returns the persisted path, or `undefined` when no such briefing exists.
   */
  async requestTopic(date: string): Promise<string | undefined> {
    const existing = await this.load(date)
    if (existing === undefined) return undefined
    const next: BriefingDocument = { ...existing, state: 'topic_requested' }
    this.#document = next
    const path = join(this.paths.briefings, `${date}.json`)
    await writeJsonFile(path, next)
    return path
  }

  /**
   * Render a briefing as Markdown.
   *
   * @param document - the briefing to render.
   * @returns the Markdown body.
   */
  render(document: BriefingDocument): string {
    const lines: string[] = [
      `# 📅 AI资讯日报 · ${document.date}`,
      '',
      `统计时间：${document.window_start} — ${document.window_end}`,
      `共 ${document.stats.total_count} 条`,
      '',
    ]
    for (const category of document.categories) {
      if (category.items.length === 0) continue
      lines.push(`## ${category.name}`, '')
      category.items.forEach((item, index) => {
        lines.push(
          `### ${index + 1}. ${item.title}`,
          '',
          `- 链接： ${item.url}`,
          `- 来源： ${item.source} · ${item.published_at ?? '未知时间'}`,
          `- 摘要： ${item.summary}`,
          `- 用户关注点： ${item.user_focus}（${item.user_focus_source}）`,
          `- 关键词： ${item.keywords.join('、')}`,
          `- 内容状态： ${item.content_status}`,
          `- 评论状态： ${item.comment_status}`,
          '',
        )
      })
    }
    lines.push(
      '---',
      '',
      '## 📊 今日统计',
      '',
      `- 总资讯数：${document.stats.total_count}`,
      `- 各分类：${Object.entries(document.stats.category_counts).map(([k, v]) => `${k} ${v}`).join('，')}`,
      `- 事件簇：${document.stats.cluster_count} 个`,
      `- 评论可用率：${document.stats.comment_available_rate}%`,
      `- 内容完整率：${document.stats.content_complete_rate}%`,
      '',
    )
    return lines.join('\n')
  }
}

/**
 * Validate a briefing against the field rules.
 *
 * Returns every problem found rather than the first, so a caller can fix a
 * batch in one pass. An empty array means the briefing may be delivered.
 *
 * @param document - the briefing to check.
 * @returns one entry per violation, in document order.
 */
export function validateBriefing(document: BriefingDocument): ValidationProblem[] {
  const problems: ValidationProblem[] = []

  for (const category of document.categories) {
    category.items.forEach((item, index) => {
      const where = index

      if (countChars(item.title) === 0) {
        problems.push({ field: 'title', item_index: where, message: '标题不能为空' })
      }
      if (!/^https?:\/\//.test(item.url)) {
        problems.push({ field: 'url', item_index: where, message: `链接格式不正确：${item.url}` })
      }
      if (countChars(item.summary) > LIMITS.summary) {
        problems.push({
          field: 'summary',
          item_index: where,
          message: `摘要 ${countChars(item.summary)} 字，超出 ${LIMITS.summary} 字上限`,
        })
      }
      if (countChars(item.summary) === 0) {
        problems.push({ field: 'summary', item_index: where, message: '摘要不能为空' })
      }
      if (countChars(item.user_focus) > LIMITS.userFocus) {
        problems.push({
          field: 'user_focus',
          item_index: where,
          message: `用户关注点 ${countChars(item.user_focus)} 字，超出 ${LIMITS.userFocus} 字上限`,
        })
      }
      if (!item.user_focus.startsWith(`[${item.user_focus_source}]`) && !item.user_focus.includes(`（${item.user_focus_source}）`)) {
        problems.push({
          field: 'user_focus_source',
          item_index: where,
          message: `用户关注点必须标注来源 ${item.user_focus_source}`,
        })
      }
      if (item.keywords.length < LIMITS.keywords.min || item.keywords.length > LIMITS.keywords.max) {
        problems.push({
          field: 'keywords',
          item_index: where,
          message: `关键词 ${item.keywords.length} 个，应为 ${LIMITS.keywords.min}-${LIMITS.keywords.max} 个`,
        })
      }
      // The rule the whole status vocabulary exists for: comment text that was
      // never fetched cannot back a comment-sourced user-focus line.
      if (item.user_focus_source === '评论提取' && item.comment_status !== 'available' && item.comment_status !== 'partial') {
        problems.push({
          field: 'user_focus_source',
          item_index: where,
          message: `评论状态为 ${item.comment_status}，不得把用户关注点标注为评论提取`,
        })
      }
    })
  }

  return problems
}

/**
 * Count a string's characters the way the limits are meant.
 *
 * Counts code points, so an emoji or a CJK character costs one, and strips
 * surrounding whitespace first because trailing newlines are a formatting
 * artefact rather than content.
 *
 * @param text - the text to measure.
 * @returns the code-point count.
 */
export function countChars(text: string): number {
  return [...text.trim()].length
}

/**
 * Build the delivery statistics for one briefing.
 *
 * @param items - every item included in the briefing.
 * @param clusterCount - how many event clusters the items collapsed into.
 * @returns the computed statistics.
 */
export function computeStats(items: readonly BriefingItem[], clusterCount: number): BriefingStats {
  const categoryCounts: Record<string, number> = {}
  let commentAvailable = 0
  let contentComplete = 0

  for (const item of items) {
    categoryCounts[item.category] = (categoryCounts[item.category] ?? 0) + 1
    if (item.comment_status === 'available' || item.comment_status === 'partial') commentAvailable++
    if (item.content_status === 'complete') contentComplete++
  }

  const total = items.length
  return {
    total_count: total,
    category_counts: categoryCounts,
    cluster_count: clusterCount,
    comment_available_rate: total === 0 ? 0 : Math.round((commentAvailable / total) * 100),
    content_complete_rate: total === 0 ? 0 : Math.round((contentComplete / total) * 100),
  }
}

/**
 * Turn one collected item into a briefing item with honest placeholder text.
 *
 * Summaries and keywords are the analyst agent's job. When it has not run, the
 * placeholders must say so plainly rather than pass AIHOT's own blurb off as an
 * authored summary.
 *
 * @param item - the collected item.
 * @param category - the briefing category it belongs to.
 * @returns the briefing item, with summary and focus still pending.
 */
export function toBriefingItem(item: CollectedItem, category: string): BriefingItem {
  const status = makeStatusPair(
    item.content_status,
    item.comment_status,
    'AIHOT 只提供索引与摘要，正文与评论均未采集',
  )
  return {
    source_id: item.id,
    category,
    title: item.title,
    url: item.links.original ?? item.links.aihot ?? '',
    source: item.source,
    published_at: item.publishedAt,
    summary: item.summary ?? '',
    user_focus: '',
    user_focus_source: '正文推断',
    keywords: [],
    content_status: status.content_status,
    comment_status: status.comment_status,
  }
}

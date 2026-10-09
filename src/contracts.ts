/**
 * Single source of truth for every model-visible name this plugin publishes.
 *
 * Tool names are global on `ctx.tools`, so they carry a `selfmedia_` / `aihot_`
 * prefix to avoid colliding with other plugins. Skill names are kebab-case and
 * must match `/^[a-z0-9]+(?:-[a-z0-9]+)*$/` — the skill registry throws on a
 * violation rather than skipping the candidate.
 *
 * @module dsh-plugin-selfmedia/contracts
 */

/** Provider name for the bundled skill catalog. */
export const SKILL_PROVIDER_NAME = 'selfmedia'

/**
 * Rank of this package's skills inside the global layer.
 *
 * Lower rank wins a duplicate name. `BUNDLED_SKILL_RANK` is 600 and the user
 * roots are 400 (`$DSH_HOME/skills`) and 500 (`~/.agents/skills`), so copying
 * the bundled rank would let a user file silently shadow a packaged skill.
 * 50 keeps the packaged catalog authoritative for its own names.
 */
export const SKILL_RANK = 50

/** Collection tools — AIHOT adapter. */
export const TOOL_AIHOT_COLLECT = 'aihot_collect'
export const TOOL_AIHOT_HOT_TOPICS = 'aihot_hot_topics'
export const TOOL_AIHOT_DAILY = 'aihot_daily'

/** Briefing tools. */
export const TOOL_BRIEFING_COMPOSE = 'briefing_compose'
export const TOOL_BRIEFING_VALIDATE = 'briefing_validate'
export const TOOL_BRIEFING_SAVE = 'briefing_save'
export const TOOL_BRIEFING_STATUS = 'briefing_status'

/** Validation gate tools. */
export const TOOL_WORD_LIMIT_CHECK = 'word_limit_check'
export const TOOL_APPROVAL_REQUEST = 'approval_request'

/** Every tool this plugin registers, in registration order. */
export const ALL_TOOL_NAMES = [
  TOOL_AIHOT_COLLECT,
  TOOL_AIHOT_HOT_TOPICS,
  TOOL_AIHOT_DAILY,
  TOOL_BRIEFING_COMPOSE,
  TOOL_BRIEFING_VALIDATE,
  TOOL_BRIEFING_SAVE,
  TOOL_BRIEFING_STATUS,
  TOOL_WORD_LIMIT_CHECK,
  TOOL_APPROVAL_REQUEST,
] as const

/**
 * Human-approval checkpoints.
 *
 * Each one pauses the pipeline until the user answers. The editor-in-chief
 * agent treats these as hard stops; `approval_request` returns the prompt text
 * and the pipeline resumes only on an explicit user reply.
 */
export const APPROVAL_POINTS = {
  briefing_setup: '日报配置首次设定',
  topic_selected: 'Top 10 选题确认',
  final_draft: '文章定稿前最终审查',
  draft_save: '公众号草稿保存前',
  publish: '正式发布前',
} as const

export type ApprovalPoint = keyof typeof APPROVAL_POINTS

/** Task kinds the editor-in-chief routes on. */
export const TASK_KINDS = [
  'collect',
  'briefing',
  'topic',
  'write',
  'rewrite',
  'visual',
  'style',
  'publish',
] as const

export type TaskKind = (typeof TASK_KINDS)[number]

/**
 * Self-media content production pipeline for DSH.
 *
 * The plugin contributes three things and nothing else:
 *
 * 1. **Collection tools** — a read-only AIHOT client exposed as model-facing tools.
 * 2. **Briefing tools** — assembly, validation, and delivery of the daily digest,
 *    plus the word-limit and approval gates the skills rely on.
 * 3. **A skill catalog** — the workflow skills, published through the skill
 *    registry so agents discover them by name.
 *
 * Its recurring collection runs on the host plane through `ctx.interval`, not
 * through `dsh-schedule`: a scheduled reminder is agent-scoped and cannot fire
 * while every session is closed, which is exactly the case this job exists for.
 *
 * @module dsh-plugin-selfmedia
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { fileURLToPath } from 'node:url'
// Type-only imports: these packages exist to merge `web` and `interval` (among
// others) into Cordis's `Context` interface. The declarations are only visible
// once something imports the module, and a value import would add a runtime
// dependency on packages the host already provides — so they are imported for
// their types alone and erased at emit.
import type {} from '@deepseek-ai/dsh-web'
import type {} from '@deepseek-ai/cordis-plugin-timer'

import { AihotClient } from './services/aihot.js'
import { BriefingService } from './services/briefing.js'
import { createSkillProvider } from './skills/provider.js'
import { registerBriefingTools } from './tools/briefing.js'
import { registerCollectTools } from './tools/collect.js'
import { registerGateTools } from './tools/gate.js'
import {
  ensureStateDirs,
  readJsonFile,
  resolveHarnessHome,
  statePaths,
  writeJsonFile,
} from './storage.js'
import {
  isValidTimeZone,
  isDue,
  parseScheduleTime,
  windowStart,
  zonedDateKey,
} from './schedule.js'

/** Cordis plugin name; must match the id in `cordis.patch.yml`. */
export const name = 'selfmedia'

/** Services this plugin requires before it can register anything. */
export const inject = ['tools', 'skills', 'web', 'timer']

/** One briefing category: its display name and per-briefing cap. */
export interface BriefingCategoryConfig {
  readonly name: string
  readonly max_items: number
}

/** Plugin configuration. Every field has a working default. */
export interface Config {
  /** Overrides the self-media state root. Defaults to `$DSH_HOME/selfmedia`. */
  readonly stateRoot?: string
  /** AIHOT origin; overridden only to point at a mirror. */
  readonly aihotBaseUrl?: string
  /** Whether the host-plane collection loop runs at all. */
  readonly scheduleEnabled: boolean
  /** Local wall-clock time of the daily collection, as `HH:MM`. */
  readonly scheduleTime: string
  /** IANA zone the schedule time is interpreted in. */
  readonly timeZone: string
  /** How far back each collection reaches, in hours. */
  readonly windowHours: number
  /** Fixed tick cadence of the collection loop, in seconds. */
  readonly tickSeconds: number
  /** Category order and caps used when composing a briefing. */
  readonly categories: BriefingCategoryConfig[]
  /** Items requested from AIHOT per collection. */
  readonly maxItems: number
  /** Target summary length — 50 brief, 100 standard, 150 detailed. */
  readonly summaryLength: number
}

/**
 * Runtime schema for {@link Config}.
 *
 * Not annotated with `z<Config>`: the schema's own inference is stricter than
 * the interface (a defaulted field is optional at the schema level), and
 * asserting the wider type here would hide a real mismatch in the defaults.
 */
export const Config = z.object({
  stateRoot: z.string(),
  aihotBaseUrl: z.string().default('https://aihot.news'),
  scheduleEnabled: z.boolean().default(true),
  scheduleTime: z.string().default('08:30'),
  timeZone: z.string().default('Asia/Shanghai'),
  windowHours: z.number().default(24),
  tickSeconds: z.number().default(60),
  categories: z
    .array(
      z.object({
        name: z.string().required(),
        max_items: z.number().required(),
      }),
    )
    .default([
      { name: '模型发布', max_items: 5 },
      { name: 'AI产品动态', max_items: 8 },
      { name: '公司融资', max_items: 5 },
      { name: '研究论文', max_items: 5 },
      { name: '政策监管', max_items: 3 },
    ]),
  maxItems: z.number().default(50),
  summaryLength: z.number().default(100),
})

/**
 * Assemble the plugin.
 *
 * @param ctx - the registrant context.
 * @param config - validated plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const root = config.stateRoot?.trim()
  const stateRoot = root === undefined || root.length === 0
    ? `${resolveHarnessHome()}/selfmedia`
    : root

  if (!isValidTimeZone(config.timeZone)) {
    throw new Error(`selfmedia: unknown time zone ${JSON.stringify(config.timeZone)}`)
  }
  const schedule = parseScheduleTime(config.scheduleTime)

  const paths = statePaths(stateRoot)
  const briefing = new BriefingService(stateRoot)
  const aihot = new AihotClient(ctx.web, { baseUrl: config.aihotBaseUrl })

  registerCollectTools(ctx, { client: aihot })
  registerBriefingTools(ctx, {
    service: briefing,
    categories: config.categories,
    summaryLength: config.summaryLength,
  })
  registerGateTools(ctx)

  ctx.skills.registerProvider(() => createSkillProvider(skillsRoot()))

  ctx.effect(() => {
    void ensureStateDirs(paths).catch((error: unknown) => {
      ctx.logger.warn('selfmedia: could not create state directories: %s', String(error))
    })
    // The directory creation owns no resource to release; returning a disposer
    // would suggest an undo that does not exist and would invite deleting a
    // user's accumulated archive on unload.
    return () => {}
  }, 'selfmedia.state()')


  if (!config.scheduleEnabled) return

  const tickMs = Math.max(config.tickSeconds, 30) * 1000
  let lastCollectedDate: string | undefined
  let running = false

  // The effect owns the interval's disposer: the callback must RETURN it so the
  // timer is cleared when the plugin unloads or hot-reloads.
  ctx.effect(() => {
    return ctx.interval(() => {
      // A tick must never overlap a still-running collection, and a collection
      // must not repeat for a date it already served — `ctx.interval` keeps
      // ticking while the previous callback is still in flight.
      if (running) return
      const now = new Date()
      const dateKey = zonedDateKey(now, config.timeZone)
      if (dateKey === lastCollectedDate) return
      if (!isDue(now, config.timeZone, schedule.hour, schedule.minute)) return

      running = true
      void runScheduledCollection({
        aihot,
        briefing,
        paths,
        dateKey,
        now,
        windowHours: config.windowHours,
        maxItems: config.maxItems,
        categories: config.categories,
        timeZone: config.timeZone,
        onWarning: (message) => ctx.logger.warn('%s', message),
      })
        .then(() => {
          lastCollectedDate = dateKey
        })
        .catch((error: unknown) => {
          // Recording the date only on success means a failed collection is
          // retried on the next tick within the same minute window.
          ctx.logger.warn('selfmedia: scheduled collection failed: %s', String(error))
        })
        .finally(() => {
          running = false
        })
    }, tickMs)
  }, 'selfmedia.schedule()')
}

/**
 * Absolute path of the packaged skill catalog.
 *
 * `fileURLToPath` rather than `URL.pathname`: `pathname` leaves percent-encoding
 * in place, so an install path containing any non-ASCII character (a Chinese
 * directory name, a space, an accent) would resolve to a directory that does not
 * exist and silently publish an empty catalog.
 */
function skillsRoot(): string {
  return fileURLToPath(new URL('../assets/skills', import.meta.url))
}

/** Inputs for one scheduled run. */
interface ScheduledRun {
  readonly aihot: AihotClient
  readonly briefing: BriefingService
  readonly paths: ReturnType<typeof statePaths>
  readonly dateKey: string
  readonly now: Date
  readonly windowHours: number
  readonly maxItems: number
  readonly categories: readonly BriefingCategoryConfig[]
  readonly timeZone: string
  readonly onWarning: (message: string) => void
}

/**
 * Collect once and persist the raw items for the analyst to process.
 *
 * Deliberately stops at the raw stage. Summaries, user-focus lines, and keywords
 * are authored work that requires an agent, so the scheduled path writes the
 * raw collection and leaves the briefing to be composed when an agent runs. A
 * scheduled job that fabricated summaries would put invented text in front of
 * the user with no model involved.
 *
 * @param run - the run's client, targets, and schedule context.
 */
async function runScheduledCollection(run: ScheduledRun): Promise<void> {
  const start = windowStart(run.now, run.windowHours)
  const page = await run.aihot.items({ window: run.windowHours <= 24 ? '24h' : '7d', limit: run.maxItems })

  if (page.items.length === 0) {
    run.onWarning(`selfmedia: AIHOT returned no items for ${run.dateKey}; nothing written`)
    return
  }

  await writeJsonFile(`${run.paths.rawSources}/${run.dateKey}.json`, {
    date: run.dateKey,
    collected_at: run.now.toISOString(),
    window_start: start.toISOString(),
    window_end: run.now.toISOString(),
    time_zone: run.timeZone,
    items: page.items,
  })

  const previous = await readJsonFile<{ collected_at?: string }>(`${run.paths.rawSources}/${run.dateKey}.json`)
  if (previous === undefined) {
    run.onWarning(`selfmedia: raw collection for ${run.dateKey} was not persisted`)
  }
}

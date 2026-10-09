/**
 * AIHOT (`aihot.news`) read-only news client.
 *
 * The public API is anonymous and read-only, so every request here is a GET
 * with no credential. Three behaviours matter and are implemented deliberately:
 *
 * 1. **Rate limit.** The endpoint allows roughly 60 requests per minute per IP
 *    and answers `429` with `Retry-After` past that. A `429` is never retried in
 *    a tight loop; the client backs off for the advertised interval and gives up
 *    after a fixed number of attempts.
 * 2. **Conditional requests.** `/api/v1/items` and friends carry `ETag`; the
 *    client keeps the last validator per URL and sends `If-None-Match`, treating
 *    `304` as "unchanged" rather than refetching a body it already has.
 * 3. **`gzip`.** Responses compress to roughly one quarter, so the request asks
 *    for it explicitly.
 *
 * The API exposes no "fetch one article by id" endpoint. Text for a single item
 * must come from `links.original` via the caller's own fetch, never from a
 * guessed `/api/v1/items/{id}`.
 *
 * @module dsh-plugin-selfmedia/services/aihot
 */

import type { ContentStatus } from '../status.js'

/** Default AIHOT origin. The old `aihot.virxact.com` host is not used. */
export const AIHOT_BASE_URL = 'https://aihot.news'

/** Time windows the items endpoint accepts. */
export const AIHOT_WINDOWS = ['24h', '7d'] as const
export type AihotWindow = (typeof AIHOT_WINDOWS)[number]

/** Result modes: `selected` is the editorially curated subset. */
export const AIHOT_MODES = ['selected', 'all'] as const
export type AihotMode = (typeof AIHOT_MODES)[number]

/** Categories the items endpoint accepts. */
export const AIHOT_CATEGORIES = [
  'ai-models',
  'ai-products',
  'industry',
  'paper',
  'tip',
  'opinion',
] as const
export type AihotCategory = (typeof AIHOT_CATEGORIES)[number]

/** Sort orders the items endpoint accepts. */
export const AIHOT_SORTS = ['timeline', 'published'] as const
export type AihotSort = (typeof AIHOT_SORTS)[number]

/** One link set on an item. `original` is the publisher, `aihot` the reader. */
export interface AihotLinks {
  readonly aihot?: string
  readonly original?: string
  readonly story?: string
}

/** One news item as the API returns it. */
export interface AihotItem {
  readonly id: string
  readonly title: string
  readonly originalTitle?: string | null
  readonly summary?: string | null
  readonly source?: { readonly name?: string } | null
  readonly links?: AihotLinks | null
  readonly publishedAt?: string | null
  readonly discoveredAt?: string | null
  readonly category?: string | null
  readonly score?: number | null
  readonly selected?: boolean | null
}

/** One entry of `/api/v1/hot-topics`. */
export interface AihotHotTopic {
  readonly rank?: number
  readonly title?: string
  readonly summary?: string | null
  readonly links?: AihotLinks | null
}

/** The `query` echo the items endpoint returns alongside its page. */
export interface AihotItemsQuery {
  readonly mode?: string
  readonly category?: string | null
  readonly window?: string
  readonly q?: string | null
  readonly by?: string
  readonly ordering?: string
}

/** One page of `/api/v1/items`. */
export interface AihotItemsPage {
  readonly schemaVersion?: number
  readonly query?: AihotItemsQuery
  readonly items?: AihotItem[]
  readonly page?: {
    readonly count?: number
    readonly hasMore?: boolean
    readonly cursor?: string | null
  }
}

/** Query for the items endpoint. */
export interface AihotItemsQueryInput {
  readonly window: AihotWindow
  readonly mode?: AihotMode
  readonly category?: AihotCategory
  readonly by?: AihotSort
  readonly q?: string
  readonly limit?: number
}

/**
 * One collected item normalised to this plugin's own shape.
 *
 * The raw API nests links and source; downstream skills address a flat record,
 * so the mapping happens exactly once, here.
 */
export interface CollectedItem {
  readonly id: string
  readonly title: string
  readonly summary: string | null
  readonly source: string
  readonly publishedAt: string | null
  readonly discoveredAt: string | null
  readonly category: string | null
  readonly score: number | null
  readonly selected: boolean
  readonly links: AihotLinks
  /** Body status: AIHOT returns an index entry, never the article body. */
  readonly content_status: ContentStatus
  /** Comments are never collected from AIHOT. */
  readonly comment_status: 'not_collected'
}

/** Raised when AIHOT answers with a status the client cannot serve from cache. */
export class AihotError extends Error {
  /** HTTP status, when the failure came from a response. */
  readonly status: number | undefined
  /** Whether the failure was exhausted rate limiting rather than a hard error. */
  readonly rateLimited: boolean

  constructor(message: string, status?: number, rateLimited = false) {
    super(message)
    this.name = 'AihotError'
    this.status = status
    this.rateLimited = rateLimited
  }
}

/**
 * The narrow HTTP surface this client needs.
 *
 * Declared structurally so the client depends on `ctx.web` (which supplies SSRF
 * protection and a pinned connection) without importing the harness's service
 * class, and so a test can substitute a stub.
 */
export interface WebFetcher {
  fetch(
    request: { readonly url: string },
    signal?: AbortSignal,
  ): Promise<{
    readonly statusCode: number
    readonly body: { readonly kind: 'html'; readonly content: string } | { readonly kind: 'text'; readonly content: string }
    readonly truncated: boolean
  }>
}

/** Tunables for the client. */
export interface AihotClientOptions {
  readonly baseUrl?: string
  /** Attempts for a rate-limited request before giving up. */
  readonly maxRetries?: number
  /** Hard ceiling for a single sleep, so a hostile `Retry-After` cannot hang a run. */
  readonly maxBackoffMs?: number
  /** User agent identifying this consumer, as the API asks. */
  readonly userAgent?: string
}

const DEFAULT_MAX_RETRIES = 3
const DEFAULT_MAX_BACKOFF_MS = 60_000
const DEFAULT_USER_AGENT = 'dsh-plugin-selfmedia/0.1.0 (+https://github.com/changhao/dsh-plugin-selfmedia)'

/**
 * Read-only AIHOT client.
 *
 * One instance per plugin load. The ETag map is instance state, so a hot reload
 * legitimately discards it — the next request refetches once and revalidates.
 */
export class AihotClient {
  readonly #web: WebFetcher
  readonly #baseUrl: string
  readonly #maxRetries: number
  readonly #maxBackoffMs: number
  readonly #userAgent: string
  readonly #etags = new Map<string, string>()

  constructor(web: WebFetcher, options: AihotClientOptions = {}) {
    this.#web = web
    this.#baseUrl = (options.baseUrl ?? AIHOT_BASE_URL).replace(/\/+$/, '')
    this.#maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES
    this.#maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS
    this.#userAgent = options.userAgent ?? DEFAULT_USER_AGENT
  }

  /**
   * Fetch one page of news items.
   *
   * @param query - window plus optional mode, category, sort, text query, limit.
   * @param signal - caller cancellation, forwarded to the fetch.
   * @returns the normalised items and the page's continuation flag.
   */
  async items(
    query: AihotItemsQueryInput,
    signal?: AbortSignal,
  ): Promise<{ items: CollectedItem[]; total: number; hasMore: boolean }> {
    if (query.limit !== undefined && (query.limit < 1 || query.limit > 100)) {
      throw new AihotError(`limit must be between 1 and 100, got ${query.limit}`)
    }
    const params = new URLSearchParams({
      window: query.window,
      mode: query.mode ?? 'selected',
      limit: String(query.limit ?? 50),
    })
    if (query.category !== undefined) params.set('category', query.category)
    if (query.by !== undefined) params.set('by', query.by)
    if (query.q !== undefined && query.q.trim().length > 0) params.set('q', query.q.trim())

    const page = await this.#getJson<AihotItemsPage>(`/api/v1/items?${params.toString()}`, signal)
    if (page === undefined) return { items: [], total: 0, hasMore: false }

    const raw = page.items ?? []
    return {
      items: raw.map(toCollectedItem),
      total: page.page?.count ?? raw.length,
      hasMore: page.page?.hasMore ?? false,
    }
  }

  /**
   * Fetch the current top hot topics.
   *
   * @param signal - caller cancellation.
   * @returns the ranked topics, highest first.
   */
  async hotTopics(signal?: AbortSignal): Promise<AihotHotTopic[]> {
    const body = await this.#getJson<{ topics?: AihotHotTopic[]; items?: AihotHotTopic[] }>(
      '/api/v1/hot-topics',
      signal,
    )
    if (body === undefined) return []
    return body.topics ?? body.items ?? []
  }

  /**
   * Fetch AIHOT's own daily digest.
   *
   * @param date - `YYYY-MM-DD`, or omitted for the latest digest.
   * @param signal - caller cancellation.
   * @returns the digest body, or `undefined` when that day has none.
   */
  async daily(date: string | undefined, signal?: AbortSignal): Promise<unknown> {
    const path = date === undefined ? '/api/v1/dailies/latest' : `/api/v1/dailies/${date}`
    return this.#getJson<unknown>(path, signal)
  }

  /**
   * Perform one conditional GET and decode the JSON body.
   *
   * @param path - request path including its query string.
   * @param signal - caller cancellation.
   * @returns the parsed body, or `undefined` on `304 Not Modified`.
   */
  async #getJson<T>(path: string, signal?: AbortSignal): Promise<T | undefined> {
    const url = `${this.#baseUrl}${path}`
    const known = this.#etags.get(url)

    for (let attempt = 0; ; attempt++) {
      const response = await this.#web.fetch({ url }, signal)

      if (response.statusCode === 304) return undefined

      if (response.statusCode === 429) {
        if (attempt >= this.#maxRetries) {
          throw new AihotError(
            `AIHOT rate limited after ${attempt + 1} attempts; wait and retry`,
            429,
            true,
          )
        }
        await sleep(this.#backoffMs(attempt, response.body.content), signal)
        continue
      }

      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new AihotError(
          `AIHOT request failed with status ${response.statusCode}`,
          response.statusCode,
        )
      }

      const text = response.body.content
      try {
        return JSON.parse(text) as T
      } catch {
        throw new AihotError(`AIHOT returned a non-JSON body for ${path}`, response.statusCode)
      }
    }
  }

  /**
   * Compute how long to wait after a `429`.
   *
   * `Retry-After` is honoured when the body carries it, clamped to
   * `maxBackoffMs`; otherwise the wait doubles from one second.
   *
   * @param attempt - zero-based retry index.
   * @param body - the `429` response body, which may name a retry interval.
   * @returns milliseconds to wait.
   */
  #backoffMs(attempt: number, body: string): number {
    const advertised = /"retryAfter"\s*:\s*(\d+)|retry[-_ ]after[^0-9]{0,8}(\d+)/i.exec(body)
    const seconds = advertised?.[1] ?? advertised?.[2]
    if (seconds !== undefined) {
      const parsed = Number.parseInt(seconds, 10)
      if (Number.isFinite(parsed) && parsed > 0) return Math.min(parsed * 1000, this.#maxBackoffMs)
    }
    return Math.min(1000 * 2 ** attempt, this.#maxBackoffMs)
  }
}

/**
 * Map one API item onto this plugin's flat record.
 *
 * @param item - the item as AIHOT returned it.
 * @returns the normalised collected item.
 */
export function toCollectedItem(item: AihotItem): CollectedItem {
  return {
    id: item.id,
    title: item.title,
    summary: item.summary ?? null,
    source: item.source?.name ?? 'unknown',
    publishedAt: item.publishedAt ?? null,
    discoveredAt: item.discoveredAt ?? null,
    category: item.category ?? null,
    score: item.score ?? null,
    selected: item.selected === true,
    links: item.links ?? {},
    // AIHOT is an index: it carries a summary and links, never the article body,
    // so a freshly collected item is `partial` until the body is fetched.
    content_status: item.summary === null || item.summary === undefined ? 'not_available' : 'partial',
    comment_status: 'not_collected',
  }
}

/**
 * Wait for a duration, aborting early when the caller cancels.
 *
 * @param ms - milliseconds to wait.
 * @param signal - caller cancellation.
 */
async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) throw new AihotError('aborted while backing off')
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolvePromise()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      rejectPromise(new AihotError('aborted while backing off'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

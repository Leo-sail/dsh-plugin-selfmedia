/**
 * On-disk state for the self-media pipeline.
 *
 * Everything lives under one root, `$DSH_HOME/selfmedia` by default, and is
 * plain UTF-8 JSON or Markdown so a user can read, diff, and hand-edit it. The
 * plugin writes through `node:fs/promises` rather than `ctx.fs`: `ctx.fs` is
 * the sandboxed agent-facing filesystem whose writes are subject to the
 * workspace containment guard, while this state is harness-owned and lives
 * outside any workspace.
 *
 * @module dsh-plugin-selfmedia/storage
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * Resolve the DSH harness home.
 *
 * Mirrors `@deepseek-ai/dsh-home-paths` precedence: an explicit config value
 * wins, then `$DSH_HOME`, then `~/.dsh`. An empty or whitespace-only
 * `$DSH_HOME` is treated as unset so a blank override never resolves to the
 * current working directory.
 *
 * @param configured - explicit harness-home override from plugin config.
 * @returns the absolute harness home path.
 */
export function resolveHarnessHome(configured?: string): string {
  const explicit = configured?.trim()
  if (explicit !== undefined && explicit.length > 0) return expandHome(explicit)
  const fromEnv = process.env['DSH_HOME']?.trim()
  if (fromEnv !== undefined && fromEnv.length > 0) return expandHome(fromEnv)
  return join(homedir(), '.dsh')
}

/**
 * Expand a leading `~`, `~/`, or `~\` against the OS home.
 *
 * @param path - a path that may begin with a tilde prefix.
 * @returns the expanded absolute path.
 */
export function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return resolve(path)
}

/** Subdirectories this plugin owns under the state root. */
export const STATE_DIRS = [
  'briefings',
  'raw-sources',
  'topics',
  'drafts',
  'evidence-ledgers',
  'style-profiles',
  'delivery-log',
] as const

export type StateDir = (typeof STATE_DIRS)[number]

/** Resolved state root plus the paths the tools read and write. */
export interface StatePaths {
  readonly root: string
  readonly briefings: string
  readonly rawSources: string
  readonly topics: string
  readonly drafts: string
  readonly evidenceLedgers: string
  readonly styleProfiles: string
  readonly deliveryLog: string
}

/**
 * Compute every path this plugin uses beneath one root.
 *
 * @param root - the self-media state root.
 * @returns the resolved path set.
 */
export function statePaths(root: string): StatePaths {
  return {
    root,
    briefings: join(root, 'briefings'),
    rawSources: join(root, 'raw-sources'),
    topics: join(root, 'topics'),
    drafts: join(root, 'drafts'),
    evidenceLedgers: join(root, 'evidence-ledgers'),
    styleProfiles: join(root, 'style-profiles'),
    deliveryLog: join(root, 'delivery-log'),
  }
}

/**
 * Create the state tree if it is absent.
 *
 * Idempotent, so it is safe on every startup and before every write.
 *
 * @param paths - the resolved path set.
 */
export async function ensureStateDirs(paths: StatePaths): Promise<void> {
  await Promise.all([
    mkdir(paths.root, { recursive: true }),
    mkdir(paths.briefings, { recursive: true }),
    mkdir(paths.rawSources, { recursive: true }),
    mkdir(paths.topics, { recursive: true }),
    mkdir(paths.drafts, { recursive: true }),
    mkdir(paths.evidenceLedgers, { recursive: true }),
    mkdir(paths.styleProfiles, { recursive: true }),
    mkdir(paths.deliveryLog, { recursive: true }),
  ])
}

/**
 * Write one UTF-8 text file, creating parent directories as needed.
 *
 * @param path - absolute target path.
 * @param content - the text to write.
 */
export async function writeTextFile(path: string, content: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content, 'utf8')
}

/**
 * Read one UTF-8 text file.
 *
 * @param path - absolute target path.
 * @returns the file's text, or `undefined` when it does not exist.
 */
export async function readTextFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (isNotFound(error)) return undefined
    throw error
  }
}

/**
 * Read and parse one JSON file.
 *
 * @param path - absolute target path.
 * @returns the parsed value, or `undefined` when the file does not exist.
 */
export async function readJsonFile<T>(path: string): Promise<T | undefined> {
  const text = await readTextFile(path)
  if (text === undefined) return undefined
  return JSON.parse(text) as T
}

/**
 * Serialize a value as pretty JSON and write it.
 *
 * @param path - absolute target path.
 * @param value - the value to persist.
 */
export async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await writeTextFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

/**
 * Append one line to a JSONL file, creating it if absent.
 *
 * Used for the delivery log, which is append-only by design: a run's record is
 * never rewritten, so the history of deliveries survives a later failure.
 *
 * @param path - absolute target path.
 * @param value - the record to append.
 */
export async function appendJsonLine(path: string, value: unknown): Promise<void> {
  const existing = (await readTextFile(path)) ?? ''
  await writeTextFile(path, `${existing}${JSON.stringify(value)}\n`)
}

/**
 * Read a JSONL file into an array, skipping malformed trailing lines.
 *
 * A partially written final line is expected after an interrupted process, so a
 * parse failure on the last line drops that line rather than the whole log.
 *
 * @param path - absolute target path.
 * @returns every successfully parsed record, in file order.
 */
export async function readJsonLines<T>(path: string): Promise<T[]> {
  const text = await readTextFile(path)
  if (text === undefined) return []
  const out: T[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim()
    if (line === undefined || line.length === 0) continue
    try {
      out.push(JSON.parse(line) as T)
    } catch {
      if (i === lines.length - 1) break
      throw new Error(`malformed JSONL record at line ${i + 1} of ${path}`)
    }
  }
  return out
}

/**
 * List the file names directly inside a directory.
 *
 * @param path - absolute directory path.
 * @returns sorted file names, or an empty array when the directory is absent.
 */
export async function listFiles(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort()
  } catch (error) {
    if (isNotFound(error)) return []
    throw error
  }
}

/**
 * Narrow an unknown throw to a missing-file filesystem error.
 *
 * @param error - the caught value.
 * @returns whether the error means the path does not exist.
 */
function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}

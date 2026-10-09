/**
 * Bundled skill provider.
 *
 * Publishes this package's Markdown skills into `ctx.skills`. The provider
 * reads frontmatter from disk once per listing and defers each body until it is
 * actually requested, so loading the plugin does not read several dozen files.
 *
 * Rank matters here: lower wins a duplicate name inside the same layer, and the
 * user roots sit at 400 (`$DSH_HOME/skills`) and 500 (`~/.agents/skills`) while
 * the official bundled rank is 600. Copying 600 would let a user file silently
 * shadow a packaged skill, so this provider publishes at {@link SKILL_RANK}.
 *
 * @module dsh-plugin-selfmedia/skills/provider
 */

import type { SkillCandidate, SkillDefinition, SkillLookupOptions, SkillProvider } from '@deepseek-ai/dsh-skill'

import { SKILL_PROVIDER_NAME, SKILL_RANK } from '../contracts.js'
import { listFiles, readTextFile } from '../storage.js'

/** One discovered skill file, captured at listing time. */
interface SkillEntry {
  readonly name: string
  readonly description: string
  readonly whenToUse: string | undefined
  readonly modelInvocable: boolean
  readonly userInvocable: boolean
  readonly path: string
  readonly body: string
}

/**
 * A skill provider over a fixed directory of `SKILL.md` bundles.
 *
 * Discovery is one level deep and mirrors `dsh-skill-filesystem`: a skill is
 * either `<root>/<name>.md` or `<root>/<category>/<name>/SKILL.md`. The nested
 * form is what this package ships, since skills are grouped by the agent that
 * owns them.
 *
 * @param rootDir - absolute path of the skill root.
 * @returns the provider, ready for `ctx.skills.registerProvider`.
 */
export function createSkillProvider(rootDir: string): SkillProvider {
  let cached: SkillEntry[] | undefined

  const load = async (): Promise<SkillEntry[]> => {
    if (cached !== undefined) return cached
    cached = await discover(rootDir)
    return cached
  }

  return {
    name: SKILL_PROVIDER_NAME,
    async list(_options: SkillLookupOptions): Promise<readonly SkillCandidate[]> {
      const entries = await load()
      return entries.map((entry) => toCandidate(entry))
    },
    async get(candidate: SkillCandidate, _options: SkillLookupOptions): Promise<SkillDefinition | undefined> {
      const entries = await load()
      const entry = entries.find((candidateEntry) => candidateEntry.name === candidate.name)
      if (entry === undefined) return undefined
      return {
        name: entry.name,
        description: entry.description,
        ...(entry.whenToUse === undefined ? {} : { whenToUse: entry.whenToUse }),
        invocation: { modelInvocable: entry.modelInvocable, userInvocable: entry.userInvocable },
        provider: SKILL_PROVIDER_NAME,
        source: 'bundled',
        resourceBase: { kind: 'directory', path: entry.path.slice(0, entry.path.lastIndexOf('/')) },
        content: entry.body,
        path: entry.path,
      }
    },
  }
}

/**
 * Map one discovered entry onto a registry candidate.
 *
 * @param entry - the discovered skill.
 * @returns the candidate the registry ranks and advertises.
 */
function toCandidate(entry: SkillEntry): SkillCandidate {
  return {
    name: entry.name,
    description: entry.description,
    ...(entry.whenToUse === undefined ? {} : { whenToUse: entry.whenToUse }),
    invocation: { modelInvocable: entry.modelInvocable, userInvocable: entry.userInvocable },
    provider: SKILL_PROVIDER_NAME,
    source: 'bundled',
    resourceBase: { kind: 'directory', path: entry.path.slice(0, entry.path.lastIndexOf('/')) },
    rank: SKILL_RANK,
    locator: entry.path,
    path: entry.path,
  }
}

/**
 * Walk the skill root and parse every skill file.
 *
 * A file whose frontmatter lacks `name` or `description`, or whose name is not
 * kebab-case, is skipped with a warning: the registry throws on an invalid name,
 * and one malformed file must not take the whole catalog down.
 *
 * @param rootDir - absolute skill root.
 * @returns the discovered skills, sorted by name.
 */
async function discover(rootDir: string): Promise<SkillEntry[]> {
  const entries: SkillEntry[] = []
  const seen = new Set<string>()

  for (const top of await listDirs(rootDir)) {
    const nested = `${rootDir}/${top}`
    // `<root>/<category>/<name>/SKILL.md`
    for (const name of await listDirs(nested)) {
      const path = `${nested}/${name}/SKILL.md`
      const parsed = await parseSkillFile(path)
      if (parsed !== undefined && !seen.has(parsed.name)) {
        seen.add(parsed.name)
        entries.push(parsed)
      }
    }
    // `<root>/<category>.md`
    const flat = await parseSkillFile(`${rootDir}/${top}.md`)
    if (flat !== undefined && !seen.has(flat.name)) {
      seen.add(flat.name)
      entries.push(flat)
    }
  }

  return entries.sort((left, right) => left.name.localeCompare(right.name))
}

/**
 * List subdirectory names directly under a path.
 *
 * @param path - absolute directory path.
 * @returns sorted directory names, or an empty array when the path is absent.
 */
async function listDirs(path: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises')
  try {
    const found = await readdir(path, { withFileTypes: true })
    return found
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT') {
      return []
    }
    throw error
  }
}

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * Read and parse one `SKILL.md`.
 *
 * @param path - absolute file path.
 * @returns the parsed skill, or `undefined` when absent or invalid.
 */
async function parseSkillFile(path: string): Promise<SkillEntry | undefined> {
  const text = await readTextFile(path)
  if (text === undefined) return undefined

  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (match === null) {
    process.emitWarning(`[selfmedia] skill at ${path} has no frontmatter; skipped`)
    return undefined
  }
  const front = match[1] ?? ''
  const body = (match[2] ?? '').trim()
  const fields = parseFrontmatter(front)

  const name = fields['name']
  const description = fields['description']
  if (name === undefined || description === undefined || name.length === 0 || description.length === 0) {
    process.emitWarning(`[selfmedia] skill at ${path} needs both name and description; skipped`)
    return undefined
  }
  if (!SKILL_NAME.test(name)) {
    process.emitWarning(`[selfmedia] skill name ${JSON.stringify(name)} at ${path} is not kebab-case; skipped`)
    return undefined
  }

  const disableModel = fields['disable-model-invocation'] === 'true'
  const userInvocable = fields['user-invocable'] !== 'false'

  return {
    name,
    description,
    whenToUse: fields['whenToUse'] ?? fields['when-to-use'],
    modelInvocable: !disableModel,
    userInvocable,
    path,
    body,
  }
}

/**
 * Parse the flat `key: value` frontmatter subset these skills use.
 *
 * Only what the format needs: a key, a colon, and a value on the same line.
 * A nested or multi-line YAML construct is not supported and would surface as a
 * missing field, which is the honest failure for a malformed skill file.
 *
 * @param front - the text between the `---` fences.
 * @returns the parsed key/value pairs.
 */
function parseFrontmatter(front: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of front.split('\n')) {
    const separator = line.indexOf(':')
    if (separator <= 0) continue
    const key = line.slice(0, separator).trim()
    const rawValue = line.slice(separator + 1).trim()
    if (key.length === 0 || rawValue.length === 0) continue
    out[key] = stripQuotes(rawValue)
  }
  return out
}

/**
 * Remove one layer of matching surrounding quotes.
 *
 * @param value - the raw scalar.
 * @returns the unquoted scalar.
 */
function stripQuotes(value: string): string {
  const first = value[0]
  const last = value[value.length - 1]
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1)
  }
  return value
}

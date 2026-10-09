/**
 * The scheduled collection loop.
 *
 * DSH has no cron: `dsh-schedule` is agent-scoped and cannot serve an
 * unattended job, and `cordis-plugin-timer` offers only fixed intervals. A
 * "daily at 08:30 Asia/Shanghai" rule therefore has to be computed here — the
 * loop ticks at a coarse cadence and fires when the wall clock crosses the
 * configured time in the configured zone.
 *
 * The tick is deliberately coarse: re-arming a timer for the exact next instant
 * would drift across a laptop suspend, whereas comparing wall-clock minutes each
 * tick recovers naturally once the machine wakes.
 *
 * @module dsh-plugin-selfmedia/schedule
 */

/** The resolved wall-clock fields of one instant, in a target time zone. */
export interface ZonedClock {
  readonly year: number
  readonly month: number
  readonly day: number
  readonly hour: number
  readonly minute: number
}

/**
 * Read the wall clock in a specific IANA time zone.
 *
 * Uses `Intl.DateTimeFormat` rather than manual offset arithmetic so daylight
 * saving transitions are handled by the platform's zone database.
 *
 * @param instant - the moment to read.
 * @param timeZone - an IANA zone name, for example `Asia/Shanghai`.
 * @returns the zoned calendar fields.
 */
export function zonedClock(instant: Date, timeZone: string): ZonedClock {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  const parts = formatter.formatToParts(instant)
  const read = (type: string): number => {
    const found = parts.find((part) => part.type === type)
    return found === undefined ? 0 : Number.parseInt(found.value, 10)
  }
  // `hour12: false` can render midnight as hour 24 in some ICU builds.
  const hour = read('hour')
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: hour === 24 ? 0 : hour,
    minute: read('minute'),
  }
}

/**
 * Decide whether a collection should fire now.
 *
 * Fires when the current zoned minute equals the target minute. The caller
 * de-duplicates by date, so a tick that repeats within the same minute does not
 * collect twice.
 *
 * @param now - the current instant.
 * @param timeZone - the schedule's IANA zone.
 * @param hour - target hour, 0-23.
 * @param minute - target minute, 0-59.
 * @returns whether the target minute matches.
 */
export function isDue(now: Date, timeZone: string, hour: number, minute: number): boolean {
  const clock = zonedClock(now, timeZone)
  return clock.hour === hour && clock.minute === minute
}

/**
 * Format the zoned date of an instant as `YYYY-MM-DD`.
 *
 * This is the key the collection loop de-duplicates on, so a briefing is
 * generated at most once per local day.
 *
 * @param now - the current instant.
 * @param timeZone - the schedule's IANA zone.
 * @returns the local calendar date.
 */
export function zonedDateKey(now: Date, timeZone: string): string {
  const clock = zonedClock(now, timeZone)
  return `${clock.year}-${pad(clock.month)}-${pad(clock.day)}`
}

/**
 * Validate a `HH:MM` schedule string.
 *
 * @param value - the configured time.
 * @returns the parsed hour and minute.
 * @throws when the string is not a valid 24-hour time.
 */
export function parseScheduleTime(value: string): { hour: number; minute: number } {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (match === null) {
    throw new Error(`schedule time must look like "08:30", got ${JSON.stringify(value)}`)
  }
  const hour = Number.parseInt(match[1] ?? '', 10)
  const minute = Number.parseInt(match[2] ?? '', 10)
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error(`schedule time out of range: ${value}`)
  }
  return { hour, minute }
}

/**
 * Validate an IANA time-zone name by asking the platform to use it.
 *
 * @param timeZone - the candidate zone.
 * @returns whether the zone is usable.
 */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone })
    return true
  } catch {
    return false
  }
}

/**
 * Compute the inclusive start of a window ending now.
 *
 * @param now - the window's end.
 * @param hours - how many hours back the window reaches.
 * @returns the window start.
 */
export function windowStart(now: Date, hours: number): Date {
  return new Date(now.getTime() - hours * 60 * 60 * 1000)
}

/**
 * Left-pad a number to two digits.
 *
 * @param value - the number.
 * @returns the padded string.
 */
function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

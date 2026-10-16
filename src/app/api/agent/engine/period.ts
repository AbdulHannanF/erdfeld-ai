/** The period a question states, and whether a plan step looks at it.
 *
 *  A question that names years ("between 2020 and 2023", "the 2024 monsoon") fixes the period the
 *  evidence must come from. A step that reads a different period (or, with no dates, the latest
 *  imagery) cannot test it, however well it runs: it answers a different question. This is pure
 *  text and date arithmetic, so the plan check stays static.
 *
 *  Deliberately narrow: only explicit four-digit years are read. "Last September" or "this season"
 *  state no year here, so they never trigger the check (the prompt resolves those against today). */

import { DATE_KEYS } from './operation'

const DAY_MS = 86_400_000
/** What a time-bound step reads when it is given no dates: the latest imagery. */
export const RECENT_WINDOW_DAYS = 120
const FIRST_YEAR = 1980

export interface DateWindow { start: number; end: number }

const day = (t: number) => new Date(t).toISOString().slice(0, 10)

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?'
const monthIndex = (name: string) => MONTHS.findIndex((m) => m.startsWith(name.toLowerCase().slice(0, 3)))

/** Hull of the periods a question names, or null if it names none. A bare year is the whole year; "August 2023",
 *  "20 Aug 2023" and "Aug 20, 2023" name that month (a month is the finest grain the check judges). Years run from
 *  1980 up to the current year. */
export function statedPeriod(question: string, now: number): DateWindow | null {
  const thisYear = new Date(now).getUTCFullYear()
  const spans: DateWindow[] = []
  const okYear = (y: number) => y >= FIRST_YEAR && y <= thisYear
  const monthSpan = (y: number, m: number): DateWindow => ({ start: Date.UTC(y, m, 1), end: Date.UTC(y, m + 1, 0) })
  // Month + year, in the written orders: "February 2024", "20 Aug 2023", "Aug 20, 2023"
  const written = [
    new RegExp(`(?<![\\w])(?:\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?)?${MONTH_RE}\\s+(?:\\d{1,2}(?:st|nd|rd|th)?,?\\s+)?((?:19|20)\\d{2})(?!\\d)`, 'gi'),
  ]
  const covered: Array<[number, number]> = []
  for (const re of written) {
    for (const m of question.matchAll(re)) {
      const y = Number(m[2])
      const mi = monthIndex(m[1])
      if (mi < 0 || !okYear(y)) continue
      spans.push(monthSpan(y, mi))
      covered.push([m.index!, m.index! + m[0].length])
    }
  }
  // Bare years not already part of a month-year phrase
  for (const m of question.matchAll(/(?<![\d.,/-])((?:19|20)\d{2})(?![\d.,]?\d)/g)) {
    const at = m.index!
    if (covered.some(([s0, e0]) => at >= s0 && at < e0)) continue
    const y = Number(m[1])
    if (okYear(y)) spans.push({ start: Date.UTC(y, 0, 1), end: Date.UTC(y, 11, 31) })
  }
  if (spans.length === 0) return null
  return { start: Math.min(...spans.map((x) => x.start)), end: Math.max(...spans.map((x) => x.end)) }
}

/** Dates a result states for the data it actually used (the scenes picked, the window read), from its figures. */
export function usedDates(stats: Record<string, unknown> | undefined): Array<{ key: string; date: string }> {
  const out: Array<{ key: string; date: string }> = []
  for (const [key, v] of Object.entries(stats ?? {})) {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) continue
    if (/(^|_)(date|day|start|end)(_|$)|^(before|after)_/.test(key)) out.push({ key, date: v })
  }
  return out
}

/** The data a tool really used, when it falls outside the period the question states: a bracketing or "nearest clear
 *  scene" search can land weeks outside the dates asked for. Null when all of it is inside (or nothing is stated). */
export function periodDrift(question: string, stats: Record<string, unknown> | undefined, now: number): string | null {
  const period = statedPeriod(question, now)
  if (!period) return null
  const outside = usedDates(stats).filter(({ date }) => {
    const t = Date.parse(`${date}T00:00:00Z`)
    return t < period.start || t > period.end
  })
  if (outside.length === 0) return null
  return `the data used (${outside.map((o) => `${o.key} ${o.date}`).join(', ')}) lies outside the period the question states (${day(period.start)} to ${day(period.end)})`
}

/** The window a step reads: its explicit date arguments, else (for a time-bound operation) the
 *  latest imagery; null for a step that is not time-bound. */
export function stepWindow(args: Record<string, unknown>, timeBound: boolean, now: number): DateWindow | null {
  const times = DATE_KEYS
    .map((k) => args[k])
    .filter((v): v is string => typeof v === 'string' && /^\d{4}(-\d{2}-\d{2})?$/.test(v))
    .map((v) => Date.parse(v.length === 4 ? `${v}-01-01T00:00:00Z` : `${v}T00:00:00Z`))
    .filter((t) => !Number.isNaN(t))
  if (times.length) return { start: Math.min(...times), end: Math.max(...times) }
  return timeBound ? { start: now - RECENT_WINDOW_DAYS * DAY_MS, end: now } : null
}

/** A refusal reason when the step's window does not overlap the stated period, else null. */
export function periodMismatch(tool: string, args: Record<string, unknown>, timeBound: boolean, question: string, now: number): string | null {
  const period = statedPeriod(question, now)
  const win = period && stepWindow(args, timeBound, now)
  if (!period || !win) return null
  if (win.start <= period.end && win.end >= period.start) return null
  const explicit = DATE_KEYS.some((k) => typeof args[k] === 'string')
  return `${tool} reads ${explicit ? `${day(win.start)} to ${day(win.end)}` : 'the latest imagery (no dates given)'}, which does not overlap the period the question states (${day(period.start)} to ${day(period.end)}). Give it dates inside that period (\`before\`/\`after\`, \`date\` or \`start\`/\`end\`) or drop the step: it cannot test the question.`
}

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionMeasureInput } from 'claude-code'

import type { UsageLimit, UsageSnapshot } from '../types'

const usage = atom({ plugin: 'usage-panel', key: 'usage' } as const, null)
const lastResponseAt = atom({ plugin: 'usage-panel', key: 'lastResponseAt' } as const, null)

const TTL_MS: Record<string, number> = { '1h': 60 * 60_000, '5m': 5 * 60_000 }
const TICK_MS = 30_000

const LIMIT_NAMES: Record<string, string> = {
  five_hour: 'Session',
  seven_day: 'Weekly',
  spend_limit: 'Spend',
}
const LIMIT_ORDER = ['five_hour', 'seven_day', 'spend_limit']

const DAY = new Intl.DateTimeFormat('en-US', { day: 'numeric', month: 'short' })
const TIME = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' })

type Item = { key: string; label: string; percent?: number; note?: string }

// What the desktop app's get_usage tool answers: the account's limits as its
// usage card shows them, and this session's context as the side panel does.
type AppUsage = {
  plan?: { status: string; windows?: { label: string; percentUsed: number; resetsAt?: string }[] }
  context?: { status: string; tokensUsed?: number; contextWindow?: number; percentUsed?: number }
}

const APP_SERVER = 'ccd_session_mgmt'
const APP_TOOL = 'get_usage'

function snapshot(u: Omit<SessionMeasureInput, 'changed'>, compactWindow?: number): UsageSnapshot {
  const window = compactWindow ?? u.context.window
  const tokens = u.context.tokens
  return {
    contextTokens: tokens,
    contextWindow: window,
    contextPercent: tokens === undefined ? undefined : Math.round((tokens / window) * 100),
    limits: u.rateLimits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt })),
    costUsd: u.cost?.usd,
  }
}

// The side panel measures against the auto-compact window, not the model's limit.
async function compactWindow($: EngineInterface) {
  const { context } = await $.session.usage({ breakdown: 'summary' })
  return context.breakdown?.rawMaxTokens
}

async function refresh($: EngineInterface) {
  const next = snapshot(await $.session.usage(), await compactWindow($))
  await update($, usage, () => next)
}

function limitKind(label: string) {
  if (label.startsWith('5-hour')) return 'five_hour'
  if (label === 'Weekly · all models') return 'seven_day'
  return undefined
}

function fromApp(prev: UsageSnapshot | null, app: AppUsage): UsageSnapshot | null {
  const fresh: UsageLimit[] = []
  if (app.plan?.status === 'ok') {
    for (const w of app.plan.windows ?? []) {
      const kind = limitKind(w.label)
      if (kind) fresh.push({ kind, percentUsed: w.percentUsed, resetsAt: w.resetsAt })
    }
  }
  const ctx = app.context?.status === 'ok' ? app.context : undefined
  if (fresh.length === 0 && !ctx) return prev

  const kept = (prev?.limits ?? []).filter(l => !fresh.some(f => f.kind === l.kind))
  return {
    contextTokens: ctx?.tokensUsed ?? prev?.contextTokens,
    contextWindow: ctx?.contextWindow ?? prev?.contextWindow ?? 0,
    contextPercent: ctx?.percentUsed ?? prev?.contextPercent,
    limits: [...kept, ...fresh],
    costUsd: prev?.costUsd,
  }
}

// Plan limits are the account's, so other sessions move them too; the engine
// only hears of that with this session's next response. The desktop app reads
// them live. Resolves false where the app's server is not connected.
async function pollApp($: EngineInterface) {
  try {
    const { content, isError } = await $.mcp.call(APP_SERVER, APP_TOOL, {})
    const text = content.find(block => block.type === 'text')?.text
    if (isError || text === undefined) return false
    const app = JSON.parse(text) as AppUsage
    await update($, usage, prev => fromApp(prev, app))
    return true
  } catch {
    return false
  }
}

function colorFor(percent: number) {
  if (percent >= 90) return 'error'
  if (percent >= 70) return 'warning'
  return 'success'
}

function isSameDay(a: number, b: number) {
  return DAY.format(a) === DAY.format(b)
}

function resetNote(resetsAt: string | undefined, now: number) {
  if (!resetsAt) return undefined
  const at = Date.parse(resetsAt)
  if (!Number.isFinite(at)) return undefined
  if (at <= now) return '(resets now)'
  const day = isSameDay(at, now) ? '' : `${DAY.format(at)} `
  return `(resets ${day}at ${TIME.format(at)})`
}

function cacheItem(warmUntil: number | undefined, now: number): Item | undefined {
  if (warmUntil === undefined) return undefined
  const at = TIME.format(warmUntil)
  const ms = warmUntil - now
  if (ms <= 0) return { key: 'cache', label: 'Cache', note: `expired at ${at}` }
  const minutes = Math.floor(ms / 60_000)
  const left = minutes < 1 ? '<1m' : `${minutes}m`
  return { key: 'cache', label: 'Cache', note: `${left} left (until ${at})` }
}

async function warmUntil($: EngineInterface, ttlMs: number) {
  const at = await read($, lastResponseAt)
  return at === null ? undefined : at + ttlMs
}

function redraw($: EngineInterface) {
  $.ui.invalidate('ui.render')
}

export const register: Register = (on, options) => {
  const ttlMs = TTL_MS[String(options.cacheTtl)] ?? TTL_MS['1h']!

  let hasApp = true

  on('session.start', async ($, e, next) => {
    await refresh($)
    hasApp = await pollApp($)
    $.ui.status(undefined)
    $.clock.every(TICK_MS, () => {
      void (async () => {
        if (hasApp) hasApp = await pollApp($)
        redraw($)
      })()
    })

    return next(e)
  })

  // Each model response refreshes the cache: one that asks for a tool here,
  // the turn's last one at turn.complete. Subagents keep caches of their own.
  on('tool.call', async ($, e, next) => {
    if (e.agentId === undefined) {
      const at = await $.clock.now()
      await update($, lastResponseAt, () => at).catch(() => undefined)
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined && e.usage !== undefined) {
      const at = await $.clock.now()
      await update($, lastResponseAt, () => at).catch(() => undefined)
    }

    return done
  })

  on('session.measure', async ($, e, next) => {
    const next_ = snapshot(e, await compactWindow($).catch(() => undefined))
    await update($, usage, () => next_)

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }

    const u = await read($, usage)
    const now = await $.clock.now()
    const limits = [...(u?.limits ?? [])].sort(
      (a, b) => LIMIT_ORDER.indexOf(a.kind) - LIMIT_ORDER.indexOf(b.kind),
    )
    const cache = cacheItem(await warmUntil($, ttlMs), now)
    const items: Item[] = [
      ...(u?.contextPercent !== undefined
        ? [{ key: 'context', label: 'Context', percent: u.contextPercent }]
        : []),
      ...limits.map(l => ({
        key: `limit-${l.kind}`,
        label: LIMIT_NAMES[l.kind] ?? l.kind,
        percent: l.percentUsed,
        note: resetNote(l.resetsAt, now),
      })),
      ...(cache ? [cache] : []),
    ]

    if (items.length === 0) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box key="usage-band" flexWrap="wrap">
        {items.map((item, i) => (
          <Box key={item.key}>
            <Text dimColor>
              {i > 0 ? ' · ' : ''}
              {item.label}{' '}
            </Text>
            {item.percent !== undefined && (
              <Text color={colorFor(item.percent)}>{item.percent}%</Text>
            )}
            {item.note !== undefined && (
              <Text dimColor>
                {item.percent !== undefined ? ' ' : ''}
                {item.note}
              </Text>
            )}
          </Box>
        ))}
      </Box>
    )
  })
}

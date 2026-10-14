import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionMeasureInput } from 'claude-code'

import type { UsageSnapshot } from '../types'

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

  on('session.start', async ($, e, next) => {
    await refresh($)
    $.ui.status(undefined)
    $.clock.every(TICK_MS, () => redraw($))

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

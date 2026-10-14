import { expect, mock, test } from 'claude-code/testing'

const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 160,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const USAGE = {
  input_tokens: 10,
  output_tokens: 5,
  cache_read_input_tokens: 1000,
  cache_creation_input_tokens: 0,
  model: 'claude-opus-5-5',
}

const TURN = { answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer', usage: USAGE } as const

const NOW = new Date(2026, 9, 14, 21, 9).getTime()

for (const surface of ['terminal', 'desktop'] as const) {
  test(`band reads Context · Session · Weekly · Cache (${surface})`, async ($, on) => {
    mock.clock(on, { now: NOW })
    on('session.measure', (_$, e) => ({ changed: e.changed }))
    on('turn.complete', () => ({ text: '' }))
    on('session.usage', () => ({
      value: {
        startedAt: NOW,
        context: { tokens: 231_601, window: 1_000_000, percent: 23, breakdown: { rawMaxTokens: 400_000 } },
        rateLimits: [],
      },
    }) as never)

    await $.session.measure({
      context: { tokens: 231_601, window: 1_000_000, percent: 23 },
      rateLimits: [
        { kind: 'seven_day', percentUsed: 81, resetsAt: new Date(2026, 9, 19, 1, 0).toISOString() },
        { kind: 'five_hour', percentUsed: 36, resetsAt: new Date(2026, 9, 14, 23, 30).toISOString() },
      ],
      cost: { usd: 1.23 },
      changed: ['context', 'rateLimits', 'cost'],
    })
    await $.turn.complete(TURN)

    const ui = await $.ui.mount({ plugin: 'usage-panel', surface, ...BAND })
    expect((await ui.find({ key: 'usage-band' }))?.text).toBe(
      'Context 58% · Session 36% (resets at 23:30) · Weekly 81% (resets Oct 19 at 01:00) · Cache 60m left (until 22:09)',
    )
    expect(await ui.find({ type: 'Button' })).toBeUndefined()
    await ui.unmount()
  })
}

test('subagent turns do not start the cache countdown, and it says when it lapsed', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  on('turn.complete', () => ({ text: '' }))
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Box', props: { key: 'engine' } }))

  await $.turn.complete({ ...TURN, turnId: 'sub', agentId: 'a1' })
  const empty = await $.ui.mount({ plugin: 'usage-panel', surface: 'desktop', ...BAND })
  expect(await empty.find({ key: 'usage-band' })).toBeUndefined()
  await empty.unmount()

  await $.turn.complete(TURN)
  await clock.set(NOW + 61 * 60_000)
  const later = await $.ui.mount({ plugin: 'usage-panel', surface: 'desktop', ...BAND })
  expect((await later.find({ key: 'cache' }))?.text).toBe('Cache expired at 22:09')
  await later.unmount()
})

test('5-minute TTL from the mod settings', { options: { cacheTtl: '5m' } }, async ($, on) => {
  mock.clock(on, { now: NOW })
  on('turn.complete', () => ({ text: '' }))
  await $.turn.complete(TURN)

  const ui = await $.ui.mount({ plugin: 'usage-panel', surface: 'desktop', ...BAND })
  expect((await ui.find({ key: 'cache' }))?.text).toBe('Cache 5m left (until 21:14)')
  await ui.unmount()
})

const appUsage = (session: number, weekly: number, context: number) => ({
  plan: {
    status: 'ok',
    plan: 'Pro',
    windows: [
      { label: '5-hour limit', percentUsed: session, resetsAt: new Date(2026, 9, 14, 23, 30).toISOString() },
      { label: 'Weekly · all models', percentUsed: weekly, resetsAt: new Date(2026, 9, 19, 1, 0).toISOString() },
      { label: 'Weekly · Opus', percentUsed: 12 },
    ],
  },
  context: { session: 'self', status: 'ok', tokensUsed: 231_601, contextWindow: 400_000, percentUsed: context },
})

test('plan limits and context refresh from the app every 30 seconds', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  let answer = appUsage(36, 81, 58)
  const calls: string[] = []
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('ui.status', () => ({ value: undefined }))
  on('session.usage', () => ({
    value: { startedAt: NOW, context: { window: 1_000_000 }, rateLimits: [] },
  }) as never)
  on('mcp.call', (_$, e) => {
    calls.push(`${e.server}/${e.tool}`)
    return { value: { content: [{ type: 'text', text: JSON.stringify(answer) }], isError: false } }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'usage-panel', surface: 'desktop', ...BAND })
  expect((await ui.find({ key: 'usage-band' }))?.text).toBe(
    'Context 58% · Session 36% (resets at 23:30) · Weekly 81% (resets Oct 19 at 01:00)',
  )

  answer = appUsage(40, 82, 58)
  await clock.advance(30_000)
  expect((await ui.find({ key: 'limit-five_hour' }))?.text).toContain('Session 40%')
  expect((await ui.find({ key: 'limit-seven_day' }))?.text).toContain('Weekly 82%')
  expect(calls).toEqual(['ccd_session_mgmt/get_usage', 'ccd_session_mgmt/get_usage'])
  await ui.unmount()
})

test('without the app the band keeps the engine figures and stops asking', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  let calls = 0
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('ui.status', () => ({ value: undefined }))
  on('session.usage', () => ({
    value: {
      startedAt: NOW,
      context: { tokens: 100_000, window: 200_000, percent: 50 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 10 }],
    },
  }) as never)
  on('mcp.call', () => {
    calls += 1
    throw new Error('no such server')
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(90_000)
  const ui = await $.ui.mount({ plugin: 'usage-panel', surface: 'terminal', ...BAND })
  expect((await ui.find({ key: 'usage-band' }))?.text).toBe('Context 50% · Session 10%')
  expect(calls).toBe(1)
  await ui.unmount()
})

test('a tool call mid-turn moves the cache countdown, a subagent one does not', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  on('tool.call', () => ({ result: 'ok' }) as never)
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Box', props: { key: 'engine' } }))

  await $.tool.call({ tool: 'Read', file_path: '/tmp/a', agentId: 'a1' } as never)
  const none = await $.ui.mount({ plugin: 'usage-panel', surface: 'desktop', ...BAND })
  expect(await none.find({ key: 'cache' })).toBeUndefined()
  await none.unmount()

  await $.tool.call({ tool: 'Read', file_path: '/tmp/a' })
  await clock.advance(10 * 60_000)
  await $.tool.call({ tool: 'Read', file_path: '/tmp/b' })
  const ui = await $.ui.mount({ plugin: 'usage-panel', surface: 'desktop', ...BAND })
  expect((await ui.find({ key: 'cache' }))?.text).toBe('Cache 60m left (until 22:19)')
  await ui.unmount()
})

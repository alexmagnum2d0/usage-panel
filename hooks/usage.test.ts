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
      'Context 58% · Session 36% (сброс в 23:30) · Weekly 81% (сброс 19 окт. в 01:00) · Cache ещё 60м (до 22:09)',
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
  expect((await later.find({ key: 'cache' }))?.text).toBe('Cache истёк в 22:09')
  await later.unmount()
})

test('5-minute TTL from the mod settings', { options: { cacheTtl: '5m' } }, async ($, on) => {
  mock.clock(on, { now: NOW })
  on('turn.complete', () => ({ text: '' }))
  await $.turn.complete(TURN)

  const ui = await $.ui.mount({ plugin: 'usage-panel', surface: 'desktop', ...BAND })
  expect((await ui.find({ key: 'cache' }))?.text).toBe('Cache ещё 5м (до 21:14)')
  await ui.unmount()
})

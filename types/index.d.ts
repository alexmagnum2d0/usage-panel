export type UsageLimit = { kind: string; percentUsed: number; resetsAt?: string }

export type UsageSnapshot = {
  contextTokens?: number
  contextWindow: number
  contextPercent?: number
  limits: UsageLimit[]
  costUsd?: number
}

declare module 'claude-code' {
  interface PluginState {
    'usage-panel': {
      usage: UsageSnapshot | null
      lastResponseAt: number | null
    }
  }
}

# usage-panel

A Claude Code mod that keeps one line above the prompt with your context fill, plan limits and prompt-cache expiry:

```
Context 58% · Session 36% (сброс в 23:30) · Weekly 81% (сброс 19 окт. в 01:00) · Cache ещё 13м (до 22:09)
```

- **Context**: tokens in use against the auto-compact window, the same figure as the Context card in the desktop app.
- **Session / Weekly**: the 5-hour and weekly plan limits with their reset time (subscriptions only; a spend limit shows as **Spend**).
- **Cache**: when the prompt cache goes cold, counted from the last main-thread model response.

Percentages turn yellow from 70% and red from 90%. The line works in the terminal and in the Code tab of the Claude desktop app.

## Install

In a terminal, start `claude` and type:

```
/plugin install usage-panel --marketplace alexmagnum2d0/usage-panel
```

Answer `y` to add the marketplace, then pick the **user** scope. The mod then loads in every new session, including the desktop app's Code tab. The command itself is only available in a terminal session.

## Settings

| Option | Values | Default | What it does |
| --- | --- | --- | --- |
| Prompt cache TTL (`cacheTtl`) | `1h`, `5m` | `1h` | How long the prompt cache lives after the last response. Subscriptions get 1 hour; API keys and usage past the plan get 5 minutes. |

## Limitations

- The cache time is an estimate: the engine does not report when the cache actually expires.
- Labels and dates are in Russian.
- Built on the Claude Code mods API (early access, Claude Code 2.1.295); it may change between releases.

## Development

```
claude plugin validate .
claude plugin test .
```

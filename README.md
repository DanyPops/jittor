# Jittor

**Just-in-Time Token Optimization Router** for Pi.

Jittor measures token use, cost, provider budgets, model behavior, and context pressure. Those observations support optimization mechanisms such as routing, thinking reduction, throttling, recovery, and compaction analysis.

## Packages

- **[`packages/jittor`](packages/jittor)** — observation model, optimization policies, provider integrations, supervised Bun daemon, and CLI. `@danypops/jittor` on npm.
- **[`packages/pi-jittor`](packages/pi-jittor)** — Pi observation collection, usage/context views, and optimization controls over an authenticated loopback client. `@danypops/pi-jittor` on npm.

## Architecture

```text
Pi extension (packages/pi-jittor)
      ↓
authenticated loopback client
      ↓
Jittor daemon (packages/jittor): auth, dispatch, SQLite observation store
      ↓
observability: tokens, cost, context, budgets, model runs
      ↓
optimization: routing, model selection, recovery
      ↓
integrations: Codex, OpenRouter, Anthropic, Google Vertex AI
```

A supervised Bun daemon built on `@danypops/daemon-kit`: one process owns SQLite and provider polling; the extension is a thin authenticated client that applies model/thinking decisions.

## Development

This is a Bun workspace (`packages/*`) — one `bun install` at the repo root links `pi-jittor`'s dependency on `jittor` locally, no publish needed to develop both together.

```bash
bun install     # from the repo root
bun test        # runs every package's tests
bun run typecheck
```

See each package's own README for its CLI, service, and extension surface.

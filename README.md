# Jittor

**Just-in-Time Token Optimizing Router** for Pi.

Jittor observes provider budgets and per-turn usage, computes whether the current burn rate is sustainable, and applies a deterministic policy before each model request: continue, throttle, lower thinking, switch model, switch provider, or halt.

## Packages

- **[`packages/jittor`](packages/jittor)** — the supervised Bun daemon, router policy, provider telemetry adapters, and CLI. `@danypops/jittor` on npm.
- **[`packages/pi-jittor`](packages/pi-jittor)** — the Pi extension: routing enforcement, the integrated footer, settings TUI, usage/cost graphs, and benchmark panels, all through an authenticated loopback client to the daemon. `@danypops/pi-jittor` on npm.

## Architecture

```text
Pi extension (packages/pi-jittor)
      ↓
authenticated loopback client
      ↓
Jittor daemon (packages/jittor): auth, dispatch, SQLite metric store
      ↓
domain: routing policy, provider telemetry, benchmark ranking
      ↓
adapters: Codex, OpenRouter, Anthropic, Google Vertex AI
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

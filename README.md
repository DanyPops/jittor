# Jittor

**Just-in-Time Token Optimizing Router** for Pi.

Jittor observes provider budgets and per-turn usage, computes whether the current burn rate is sustainable, and applies a deterministic policy before each model request:

1. continue
2. throttle
3. lower thinking
4. switch model
5. switch provider
6. halt

Initial telemetry providers:

- ChatGPT-authenticated Codex subscription usage
- OpenRouter API key usage, response accounting, and model pricing

Jittor follows the Papyrus daemon architecture: a supervised Bun service owns SQLite and provider polling; the native Pi extension uses an authenticated loopback client and applies model/thinking decisions.

## Architecture

The initial service scaffold is split into domain, ports, and adapters:

- `src/domain/metric.ts` — normalized timestamped metric observations
- `src/ports/metric-store.ts` — storage boundary used by the application service
- `src/adapters/sqlite-metric-store.ts` — SQLite time-series adapter
- `src/service.ts` — authenticated operation registry
- `src/client.ts` — operation-typed loopback client
- `src/daemon.ts` — Bun composition root and maintenance loop

SQLite runs in WAL mode with versioned migrations, JSON validation, bounded queries, chronological indexes, pruning, and checkpoints. The database follows `XDG_DATA_HOME`; private authentication state follows `XDG_STATE_HOME`; the daemon handle follows `XDG_RUNTIME_DIR`.

Operations currently include `metrics.record`, `metrics.query`, `metrics.prune`, and `service.checkpoint`.

Provider adapters currently include official OpenRouter key/usage/model telemetry and an explicitly experimental Codex subscription adapter. The Codex adapter follows the pinned open-source CLI `/wham/usage` payload and `x-codex-*` response-header contracts, accepts additional metered limits, and fails closed on malformed windows or impossible percentages. File credentials must be explicitly configured and private (`0600`); Jittor reads only the access token and account ID, never refreshes credentials, and never logs or persists OAuth secrets.

The native Pi extension preflights input and every provider turn, applies model/thinking decisions, records response headers and finalized usage through the daemon, and blocks requests when required telemetry is unsafe. Its footer status shows the longest Codex window percentage, raw OpenRouter spend, and current policy action. Run `/jittor` for detailed burn pressure, freshness, route state, and confirmed pause/resume/override controls.

See [`docs/CALIBRATION.md`](docs/CALIBRATION.md) for thresholds, live dogfood results, scenario coverage, and safe rollback ordering.

```bash
bun test
bun x tsc --noEmit
bun run service:install
```

The systemd user unit binds only to `127.0.0.1`, discovers a 256-bit token without logging it, restarts on failure, and exposes authenticated health and operation endpoints.

See [`docs/PROVIDER_RESEARCH.md`](docs/PROVIDER_RESEARCH.md) for verified API boundaries and caveats.

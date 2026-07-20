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

Operations currently include `metrics.record`, `metrics.query`, `metrics.prune`, `context.assess`, and `service.checkpoint`.

Provider adapters currently include official OpenRouter key/usage/model telemetry and an explicitly experimental Codex subscription adapter. The Codex adapter follows the pinned open-source CLI `/wham/usage` payload and `x-codex-*` response-header contracts, accepts additional metered limits, and fails closed on malformed windows or impossible percentages. File credentials must be explicitly configured and private (`0600`); Jittor reads only the access token and account ID, never refreshes credentials, and never logs or persists OAuth secrets.

The native Pi extension preflights input and every provider turn, applies model/thinking decisions, records response headers and finalized usage through the daemon, and blocks requests when required telemetry is unsafe. It follows Pi's current authenticated model/provider and synchronizes Pi's available models before every decision, so unavailable catalog routes are never selected. Its responsive integrated footer groups repository and model identity with cumulative usage, a color-coded context-window bar, and current-provider budget telemetry. Codex shows the active model's bounded quota as a draining remaining-budget bar with reset and freshness information. OpenRouter uses the same drain semantics when its official key telemetry exposes a configured limit and remaining balance; keys without a limit remain honest text-only spend and never receive a fabricated denominator. During Pi compaction, the context bar drains as an animation and reports elapsed time. Unknown and stale telemetry are marked explicitly. Run `/jittor` for detailed burn pressure, freshness, route state, and confirmed emergency-halt/override controls.

Jittor currently registers no model-callable native tools, so Pi's native model `content` versus renderer `details` contract is explicitly not applicable. Daemon JSON, CLI `--json`, human CLI output, command notifications, panels, and the footer remain separate bounded channels. See [`docs/OUTPUT_CHANNELS.md`](docs/OUTPUT_CHANNELS.md) for the conformance matrix and the requirements that apply if a native tool is introduced later.

Blocking always has a daemon-independent escape hatch. `/jittor off` immediately enters persisted monitor-only mode and never blocks provider requests. The informational footer is independently controlled with `/jittor footer on` and `/jittor footer off`, so showing status never enables enforcement. `/jittor on` only enables enforcement after telemetry polling and available-route synchronization succeed. Every fail-closed error includes these recovery commands plus the daemon restart command.

### Opt-in Codex settled-turn recovery

Transient Codex recovery is securely off by default and controlled through the existing Jittor command surface:

```text
/jittor recovery status
/jittor recovery on
/jittor recovery off
/jittor recovery cancel
```

The on/off choice persists privately in `$XDG_CONFIG_HOME/jittor/extension.json` (or `~/.config/jittor/extension.json`). Status reports only enabled state, cooldown, bounded attempt/window counters, and the normalized failure class. `cancel` clears the current cooldown and attempt window without changing the persisted on/off choice.

Jittor observes finalized Codex assistant errors through Pi's public message lifecycle, classifies only bounded error metadata, and waits for `agent_settled` before acting. That boundary guarantees Pi's built-in retry, compaction retry, and queued follow-up work has finished. A transient concurrency, rate-limit, overload, or transport failure then schedules one hidden follow-up with Retry-After-aware capped jitter. Recovery is limited to three attempts per ten-minute window, never overlaps pending Pi messages, resets after success, and is canceled by human input or session shutdown. Quota, authentication, invalid-request, unknown, and aborted failures remain terminal. Raw provider payloads are never retained or injected.

### Settings

Run `/jittor settings` for one keyboard-navigable TUI covering routing enforcement, the informational footer, Codex recovery, and all four token-budget thresholds. It uses explicit ON/OFF and configured/not-configured labels, remains bounded on narrow terminals, confirms weaker enforcement and recovery changes, and applies enforcement enablement through the same readiness checks as `/jittor on`. Existing non-TUI commands remain available for automation.

### Usage graphs

Run `/jittor usage` for a colored Unicode cumulative token graph with X/Y axes, provider/model series, input/output/cache totals, refresh, and explicit **Hourly**, **Daily**, **Weekly**, and **Monthly** periods. Left/Right changes period and `r` refreshes. Usage is persisted by the daemon from finalized Pi assistant messages.

Token-budget thresholds are optional and must be configured by the user; Jittor never infers a token allowance from Codex or another provider's subscription percentage. Configure or clear one period with `/jittor usage budget <hourly|daily|weekly|monthly> <positive-tokens|off>`, and inspect all four with `/jittor usage budget`. A configured budget appears as a horizontal threshold on the cumulative graph with explicit remaining or **OVER BUDGET** state. These private settings persist in `$XDG_CONFIG_HOME/jittor/extension.json` (or `~/.config/jittor/extension.json`).

### Context pressure

Papyrus emits content-free prompt-injection observations through Pi's shared extension event bus. Jittor validates and records their exact Rule/Task character sizes, prompt share, fingerprint repetition, and explicitly estimated token size. Jittor also records completed, aborted, and unmatched Pi compactions with duration, reason, retry state, pre-compaction context usage, and bounded turns/injection/provider/cache usage since the previous compaction.

Run `/jittor context` for the in-session summary, or `jittor context [--since <epoch-ms>] [--until <epoch-ms>] [--json]` through the authenticated daemon client. The assessment reports bounded average/p95/max injection, Rule/Task mix, unchanged rate, compaction frequency/duration/reasons, and between-compaction provider/cache facts. Repeated prompt content is not labeled billed waste: provider-reported input/cache usage and an injection-disabled control are required before making cost or compaction-causality claims.

See [`docs/CALIBRATION.md`](docs/CALIBRATION.md) for thresholds and rollback, and [`docs/USAGE_PRIOR_ART.md`](docs/USAGE_PRIOR_ART.md) for the chart design research.

```bash
bun test
bun x tsc --noEmit
bun run service:install
```

The systemd user unit binds only to `127.0.0.1`, discovers a 256-bit token without logging it, restarts on failure, and exposes authenticated health and operation endpoints.

See [`docs/PROVIDER_RESEARCH.md`](docs/PROVIDER_RESEARCH.md) for verified API boundaries and caveats.

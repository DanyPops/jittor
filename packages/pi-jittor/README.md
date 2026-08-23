# @danypops/pi-jittor

The Pi extension for Jittor: token, cost, context, provider-budget, and model-run observation plus routing, recovery, and model-selection controls, over an authenticated loopback client to the [`@danypops/jittor`](../jittor) daemon. See the [repo root README](../../README.md) for the two-package overview.

## What it does

Records context composition, response headers, finalized usage, cost, and model-run behavior through the daemon; preflights provider turns and applies model/thinking decisions; blocks requests when required telemetry is unsafe. It follows Pi's current authenticated model/provider and re-syncs Pi's available models before every decision, so an unavailable catalog route is never selected. Route state is scoped per Pi session, so concurrent sessions can't clobber each other's active provider or footer budget.

The extension registers no model-callable tools — daemon JSON, CLI `--json`, human CLI output, notifications, panels, and the footer are separate bounded channels (see `@danypops/jittor`'s `docs/OUTPUT_CHANNELS.md`).

Blocking always has an escape hatch: `/jittor off` enters persisted monitor-only mode and never blocks; `/jittor footer on|off` controls the informational footer independently of enforcement; `/jittor on` only re-enables enforcement after telemetry/route-sync succeed.

## Footer

An integrated footer shows repository/model identity, cumulative usage, a color-coded context-window bar, and current-provider budget telemetry. Codex/OpenRouter/Anthropic each render a draining remaining-budget bar when the provider's own telemetry exposes a real limit; without one, spend stays honest text-only rather than a fabricated denominator. During Pi compaction the bar drains against a learned duration estimate (median of the last ≤20 completed compactions, needs ≥3 before trusting it) — never a fake timer, and it blinks in place until there's enough evidence. `jittor compaction estimate [--json]` inspects the estimate directly.

## `/jittor` — settings and status

`/jittor` (or `/jittor settings`) opens a keyboard-navigable TUI covering routing enforcement, the footer, Codex recovery, and the four token-budget thresholds. `/jittor status` shows the routing/pressure panel. `benchmarks`, `outcome`, `recovery`, `on`/`off`, `footer on`/`off`, and `context` remain available as direct subcommands for automation.

### Opt-in Codex settled-turn recovery

Off by default. `/jittor recovery on|off|status|cancel` — a transient Codex failure (rate-limit, overload, transport) schedules one hidden retry after Pi's own `agent_settled` boundary, Retry-After-aware, capped at 3 attempts per 10-minute window, canceled by human input or session shutdown. Quota/auth/invalid-request/unknown/aborted failures stay terminal; raw provider payloads are never retained. The on/off choice persists in `$XDG_CONFIG_HOME/jittor/extension.json`.

## `/usage` — token and cost graphs

A colored Unicode cumulative graph (Hourly/Daily/Weekly/Monthly/Quarterly) per provider/model; `/usage cost` shows aggregated USD spend on the same axes. `Tab`/arrows switch period, `v` toggles token/cost, `r` refreshes. Each active provider/model gets a stable color (a second bold-variant channel once identities exceed available hues) so a model's color stays fixed across periods, refreshes, and restarts. `/usage budget <period> <tokens|off>` sets an optional threshold, rendered as a horizontal line on the graph with remaining/**OVER BUDGET** state (token view only; Jittor never infers a budget from a provider's own subscription tier). See [`docs/USAGE_PRIOR_ART.md`](docs/USAGE_PRIOR_ART.md) for the chart design research.

## Cost per Papyrus task

Every token/cost metric already recorded on a finalized assistant message is tagged with the currently-focused Papyrus task (via the `papyrus.task-focus.v1` event bus, no new instrumentation) plus the provider/model/thinking level active at that moment. `jittor metrics cost-by-task --since <ms> --until <ms> [--json]` gives a bounded per-task cost/token breakdown. Spend with nothing focused reports as unattributed rather than folding into an invented task.

## Benchmark evidence panel

`/jittor benchmarks [coding|general] [research|planning|general]` shows a responsive model-recommendation panel over the daemon's benchmark ranking (see `@danypops/jittor`'s own README for ingestion sources). Labeled **ADVISORY** — Pi's extension API doesn't expose the real `/scoped-models` set, so this offers no direct selection action. `/jittor outcome accepted|rejected` attaches real outcome evidence to the latest completed run.

## `/context` — context window inspection

A tree-aware breakdown of the current context window: `/` search, `f` scope (all/active/historical), `m` size threshold, `g`/`G`/arrows navigate. Conservatively-mapped OpenAI-family models get exact `gpt-tokenizer` counts (marked `tokenizer-exact-text`); everything else stays `≈ char/4`. Assistant turns also show the provider's own authoritative aggregate request context (input + cache read + cache write) alongside individual item costs, with an explicit unattributed residual rather than proportional allocation. See [`../jittor/docs/TOKEN_MEASUREMENT.md`](../jittor/docs/TOKEN_MEASUREMENT.md) and [`../jittor/docs/CONTEXT_SNAPSHOTS.md`](../jittor/docs/CONTEXT_SNAPSHOTS.md).

`/jittor context` shows the in-session Papyrus prompt-injection / Pi compaction telemetry summary — see `@danypops/jittor`'s README for what's recorded.

## Development

```bash
bun test
bun x tsc --noEmit
```

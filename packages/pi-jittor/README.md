# @danypops/pi-jittor

The Pi extension for Jittor: routing enforcement, the integrated footer, settings TUI, usage/cost graphs, and benchmark panels, all through an authenticated loopback client to the [`@danypops/jittor`](../jittor) daemon. See the [repo root README](../../README.md) for the two-package overview.

## Behavior

The extension preflights input and every provider turn, applies model/thinking decisions, records response headers and finalized usage through the daemon, and blocks requests when required telemetry is unsafe. It follows Pi's current authenticated model/provider and synchronizes Pi's available models before every decision, so unavailable catalog routes are never selected. Mutable route state is scoped by Pi session, so concurrent sessions cannot replace each other's active provider or footer budget selection. Each session registers an opaque secret with the daemon at `session_start` (best-effort; a registration failure leaves that session unarmored rather than blocked) and presents it on every router-mutating call for the rest of its lifetime; an unregistered `session_id` continues to mutate exactly as before, so this is additive armor, not a breaking change for other callers of the same API. A configured required budget source still fails closed; a provider with no enforceable budget window continues explicitly monitor-only.

Its responsive integrated footer groups repository and model identity with cumulative usage, a color-coded context-window bar, and current-provider budget telemetry. Codex shows the active model's bounded quota as a draining remaining-budget bar with reset and freshness information. OpenRouter uses the same drain semantics when its official key telemetry exposes a configured limit and remaining balance; keys without a limit remain honest text-only spend and never receive a fabricated denominator. Anthropic shows the same drain semantics from its most-restrictive-in-effect token bucket, falling back to the request bucket when no token telemetry has been observed yet. During Pi compaction, the context bar drains from its captured fill against a learned median duration estimated from the last few completed compactions (bounded to the most recent 20 samples, requiring at least 3 before trusting it). It never renders a timer. Until enough evidence exists, the bar does not drain; it blinks in place at its captured fill. Run `jittor compaction estimate [--json]` (via the core CLI) to inspect the current estimate and its confidence directly. Unknown and stale telemetry are marked explicitly. Run `/jittor` for the consolidated Settings TUI (its default action), or `/jittor status` for detailed burn pressure, freshness, route state, and confirmed emergency-halt/override controls.

The extension currently registers no model-callable native tools, so Pi's native model `content` versus renderer `details` contract is explicitly not applicable. Daemon JSON, CLI `--json`, human CLI output, command notifications, panels, and the footer remain separate bounded channels. See the core package's [`docs/OUTPUT_CHANNELS.md`](../jittor/docs/OUTPUT_CHANNELS.md) for the conformance matrix and the requirements that apply if a native tool is introduced later.

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

The extension observes finalized Codex assistant errors through Pi's public message lifecycle, classifies only bounded error metadata, and waits for `agent_settled` before acting. That boundary guarantees Pi's built-in retry, compaction retry, and queued follow-up work has finished. A transient concurrency, rate-limit, overload, or transport failure then schedules one hidden follow-up with Retry-After-aware capped jitter. Recovery is limited to three attempts per ten-minute window, never overlaps pending Pi messages, resets after success, and is canceled by human input or session shutdown. Quota, authentication, invalid-request, unknown, and aborted failures remain terminal. Raw provider payloads are never retained or injected.

### Settings

`/jittor` is the settings and control command. Bare `/jittor` (or `/jittor settings`) opens one keyboard-navigable TUI covering routing enforcement, the informational footer, Codex recovery, and all four token-budget thresholds, with explicit ON/OFF and configured/not-configured labels, bounded rendering on narrow terminals, and confirmation for weaker enforcement/recovery changes. `/jittor status` shows the routing/pressure panel that used to be the bare command's default. Existing non-TUI subcommands (`benchmarks`, `outcome`, `recovery`, `on`/`off`, `footer on`/`off`, `context`) remain available for automation and are unchanged.

### Usage and cost graphs

`/usage` is its own top-level command, separate from `/jittor`. Bare `/usage` opens a colored Unicode cumulative graph with X/Y axes, per-provider/model series, and explicit **Hourly**, **Daily**, **Weekly**, **Monthly**, and **Quarterly** periods; `/usage cost` opens the same graph showing aggregated USD spend instead of tokens, reusing the `cost` metric already recorded content-free on every finalized Pi assistant message (no new instrumentation). Left/Right or Tab/Shift+Tab changes the time frame, `v` toggles between the token and cost views, and `r` refreshes.

The graph fetches metrics per distinct provider/model scope (`jittor metrics distinct-scopes`, bounded to 40 scopes, 250 rows each) rather than one flat "most recent rows" query. A flat query lets one heavy, long-running session monopolize the entire row budget with its own most recent activity, silently hiding every other provider from the chart no matter which time frame is selected, since the query would never reach back far enough in time to see anything else. Fetching per scope guarantees every active provider/model gets its own fair share of the query budget instead.

Series are colored with a categorical palette chosen to avoid this UI's own status colors ("success"/"warning"/"error" already mean something specific elsewhere in this panel, so reusing them for arbitrary model identity would make a model's bar segment look like a warning or a failure) and instead reuses the theme's syntax-highlighting roles. Once more series are active than there are hues, a series reuses a hue in bold rather than repeating an indistinguishable color. Multiple models active within the same cumulative time frame are rendered as one bar stacked by color, not separate bars.

Token-budget thresholds are optional and must be configured by the user; Jittor never infers a token allowance from Codex or another provider's subscription percentage. Configure or clear one period with `/usage budget <hourly|daily|weekly|monthly|quarterly> <positive-tokens|off>`, and inspect all of them with `/usage budget`. A configured budget appears as a horizontal threshold on the cumulative graph with explicit remaining or **OVER BUDGET** state; the cost view does not yet support a budget threshold. These private settings persist in `$XDG_CONFIG_HOME/jittor/extension.json` (or `~/.config/jittor/extension.json`).

See [`docs/USAGE_PRIOR_ART.md`](docs/USAGE_PRIOR_ART.md) for the chart design research.

### Cost per Papyrus task

The extension observes Papyrus's task-focus lifecycle in real time over a shared Pi extension event bus (`papyrus.task-focus.v1`) -- Papyrus never depends on Jittor, it only broadcasts which task is currently focused. Every token/cost metric already recorded on a finalized Pi assistant message is tagged with the currently focused task's id, and the provider/model/thinking level active at that moment, the instant it is recorded (no time-window estimation, no new instrumentation). A paused or cleared focus stops tagging; spend recorded with nothing focused is reported separately as unattributed, never dropped or folded into an invented task. Run `jittor metrics cost-by-task --since <ms> --until <ms> [--json]` (via the core CLI) for a bounded per-task breakdown of cost and input/output/cache tokens, broken down further by which provider/model/thinking combination each task actually spent on.

### Benchmark evidence panel

Run `/jittor benchmarks [coding|general] [research|planning|general]` (either order, either or both omitted) for the responsive recommendation panel over the core daemon's benchmark ranking operation (see `@danypops/jittor`'s README for ingestion sources). Because the released Pi extension API does not expose the exact `/scoped-models` set, the current adapter labels candidates `available-models`; the panel says **ADVISORY** and offers no selection action. Automatic route ordering is allowed only for `exact-session` authority and then narrows/reorders routes already present in the supplied candidate set. `/jittor outcome accepted` or `/jittor outcome rejected` attaches explicit outcome evidence to the latest completed local run; runtime completion alone is not treated as quality success.

### Context pressure

Run `/jittor context` for the in-session summary of Papyrus prompt-injection and Pi compaction telemetry; see `@danypops/jittor`'s README for what is recorded and the equivalent CLI command.

## Development

```bash
bun test
bun x tsc --noEmit
```

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
- Anthropic official per-response rate-limit headers (requests, tokens, input/output tokens, and optional Priority Tier buckets)
- Google Vertex AI classified failure pressure (quota/auth/invalid-request/overload/transport), since Vertex has no documented remaining-budget header or personal polling endpoint

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

Operations currently include bounded metric recording/query/pruning, benchmark refresh/status/query, context assessment, routing control, telemetry polling, and service checkpointing. Every operation is exposed through the authenticated typed client; benchmark operations also have CLI parity.

Provider adapters currently include official OpenRouter key/usage/model telemetry and an explicitly experimental Codex subscription adapter. The Codex adapter follows the pinned open-source CLI `/wham/usage` payload and `x-codex-*` response-header contracts, accepts additional metered limits, and fails closed on malformed windows or impossible percentages. File credentials must be explicitly configured and private (`0600`); Jittor reads only the access token and account ID, never refreshes credentials, and never logs or persists OAuth secrets. Anthropic has no personal-account polling endpoint (its Admin/Rate Limits API is documented as unavailable for individual accounts), so Jittor instead reads the official `anthropic-ratelimit-*` response headers Pi observes on every Messages API call and fails closed on schema drift the same way. Google Vertex AI has neither a personal polling endpoint nor a documented remaining-quota response header, so Jittor never fabricates a Vertex budget bar; it instead classifies Vertex's `google.rpc.Status` failure shape (quota, authentication, invalid-request, overload, transport, unknown) from Pi's bounded, content-free `errorMessage` and records only a bounded failure-count metric. Because no budget signal can ever exist for this provider, the footer's `budget` segment is omitted entirely for it rather than showing a permanent `?` placeholder that could never resolve; the `?` placeholder is reserved for providers that can report a budget but simply haven't yet (router not ready, or telemetry not observed on the first turn).

The third-party `anthropic-vertex` provider (Anthropic Claude models served through Google Vertex, e.g. via `@twogiants/pi-anthropic-vertex`) is tracked separately from both of the above: it reuses Pi's own Anthropic Messages stream implementation with Anthropic's official `@anthropic-ai/vertex-sdk` client, so its wire shape is Anthropic's, but its quota accounting is Google's. Jittor applies Google Vertex's failure classification to it (real-world reports confirm its 429s still carry GCP's own quota-exceeded shape even through Anthropic's own SDK) and, best-effort, also checks for genuine Anthropic rate-limit response headers on it, since it is unverified whether this specific passthrough ever forwards them. Either way, every metric is tagged `anthropic-vertex`, never blended into direct Anthropic's `anthropic` source or Pi's unrelated native `google-vertex` provider, since each represents a different account/quota pool. Its footer budget (labeled `vtok`/`vreq` when headers are observed) stays `null` (may still resolve) rather than `undefined` (provably impossible) until it's confirmed one way or the other.

The native Pi extension preflights input and every provider turn, applies model/thinking decisions, records response headers and finalized usage through the daemon, and blocks requests when required telemetry is unsafe. It follows Pi's current authenticated model/provider and synchronizes Pi's available models before every decision, so unavailable catalog routes are never selected. Its responsive integrated footer groups repository and model identity with cumulative usage, a color-coded context-window bar, and current-provider budget telemetry. Codex shows the active model's bounded quota as a draining remaining-budget bar with reset and freshness information. OpenRouter uses the same drain semantics when its official key telemetry exposes a configured limit and remaining balance; keys without a limit remain honest text-only spend and never receive a fabricated denominator. Anthropic shows the same drain semantics from its most-restrictive-in-effect token bucket, falling back to the request bucket when no token telemetry has been observed yet. During Pi compaction, the context bar drains against a learned median duration estimated from the last few completed compactions (bounded to the most recent 20 samples, requiring at least 3 before trusting it), in exact sync with a countdown ("compact ~Ns left") — never a count-up, never a fabricated total. Until enough evidence exists, the bar does not drain at all (there is no real rate to drain against) and no timer text is shown; the bar itself simply blinks in place at its starting fill once per render tick so compaction never looks stalled without claiming knowledge it doesn't have. Run `jittor compaction estimate [--json]` to inspect the current estimate and its confidence directly. Unknown and stale telemetry are marked explicitly. Run `/jittor` for the consolidated Settings TUI (its default action), or `/jittor status` for detailed burn pressure, freshness, route state, and confirmed emergency-halt/override controls.

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

`/jittor` is the settings and control command. Bare `/jittor` (or `/jittor settings`) opens one keyboard-navigable TUI covering routing enforcement, the informational footer, Codex recovery, and all four token-budget thresholds, with explicit ON/OFF and configured/not-configured labels, bounded rendering on narrow terminals, and confirmation for weaker enforcement/recovery changes. `/jittor status` shows the routing/pressure panel that used to be the bare command's default. Existing non-TUI subcommands (`benchmarks`, `outcome`, `recovery`, `on`/`off`, `footer on`/`off`, `context`) remain available for automation and are unchanged.

### Usage and cost graphs

`/usage` is its own top-level command, separate from `/jittor`. Bare `/usage` opens a colored Unicode cumulative graph with X/Y axes, per-provider/model series, and explicit **Hourly**, **Daily**, **Weekly**, **Monthly**, and **Quarterly** periods; `/usage cost` opens the same graph showing aggregated USD spend instead of tokens, reusing the `cost` metric already recorded content-free on every finalized Pi assistant message (no new instrumentation). Left/Right or Tab/Shift+Tab changes the time frame, `v` toggles between the token and cost views, and `r` refreshes.

The graph fetches metrics per distinct provider/model scope (`jittor metrics distinct-scopes`, bounded to 40 scopes, 250 rows each) rather than one flat "most recent rows" query. A flat query lets one heavy, long-running session monopolize the entire row budget with its own most recent activity, silently hiding every other provider from the chart no matter which time frame is selected, since the query would never reach back far enough in time to see anything else. Fetching per scope guarantees every active provider/model gets its own fair share of the query budget instead.

### Cost per Papyrus task

Jittor observes Papyrus's task-focus lifecycle in real time over a shared Pi extension event bus (`papyrus.task-focus.v1`) -- Papyrus never depends on Jittor, it only broadcasts which task is currently focused. Every token/cost metric Jittor already records on a finalized Pi assistant message is tagged with the currently focused task's id, and the provider/model/thinking level active at that moment, the instant it is recorded (no time-window estimation, no new instrumentation). A paused or cleared focus stops tagging; spend recorded with nothing focused is reported separately as unattributed, never dropped or folded into an invented task. Run `jittor metrics cost-by-task --since <ms> --until <ms> [--json]` for a bounded per-task breakdown of cost and input/output/cache tokens, broken down further by which provider/model/thinking combination each task actually spent on.

Series are colored with a categorical palette chosen to avoid this UI's own status colors ("success"/"warning"/"error" already mean something specific elsewhere in this panel, so reusing them for arbitrary model identity would make a model's bar segment look like a warning or a failure) and instead reuses the theme's syntax-highlighting roles, which are already tuned by theme authors to stay mutually distinguishable on screen — the same design problem as a categorical data palette. Once more series are active than there are hues, a series reuses a hue in bold rather than repeating an indistinguishable color. Multiple models active within the same cumulative time frame are rendered as one bar stacked by color, not separate bars.

Token-budget thresholds are optional and must be configured by the user; Jittor never infers a token allowance from Codex or another provider's subscription percentage. Configure or clear one period with `/usage budget <hourly|daily|weekly|monthly|quarterly> <positive-tokens|off>`, and inspect all of them with `/usage budget`. A configured budget appears as a horizontal threshold on the cumulative graph with explicit remaining or **OVER BUDGET** state; the cost view does not yet support a budget threshold. These private settings persist in `$XDG_CONFIG_HOME/jittor/extension.json` (or `~/.config/jittor/extension.json`).

### Benchmark evidence

Jittor can ingest bounded OpenRouter model metadata, p50 latency/throughput ordering, and Design Arena Elo rankings as provenance-bearing evidence without treating OpenRouter as model-scope authority. Enable online ingestion explicitly with `JITTOR_OPENROUTER_BENCHMARKS=1`; it is off by default. OpenRouter model metadata and operational ordering are public; Design Arena ingestion additionally uses `OPENROUTER_API_KEY` from the supervised service environment without retaining it. Snapshots preserve the upstream publisher, normalized model identities, immutable retrieval revisions, source URLs, confidence, license terms, and explicit freshness deadlines. A malformed or oversized refresh leaves the last complete snapshot visible and records only a payload-safe failure state.

Design Arena rates models across dozens of arena/category pairs (music, video, text-to-speech, ASCII art, ...); Jittor ingests only the bounded allowlist of categories (`codecategories`, `website`, `uicomponent`, `dataviz`, `svg`) that measure frontend/UI-generation skill relevant to routing a coding agent, tagged into one `design` domain distinct from `coding`. A model with no OpenRouter-reachable identity (proprietary platforms, image/video generators) is skipped rather than fabricated into unroutable evidence. Kept on the OpenRouter passthrough rather than migrated to a direct integration: Design Arena's own native API requires a manually reviewed application (1-2 business days), unlike Artificial Analysis's instant self-serve signup below.

Jittor also ingests LMArena's own official Hugging Face dataset (`lmarena-ai/leaderboard-dataset`, via the public `datasets-server.huggingface.co` API -- no credential required) for its Code Arena (`webdev`) and Agent Arena human-preference battles, and, when `ARTIFICIAL_ANALYSIS_API_KEY` is configured, Artificial Analysis's own direct API (replaces the former OpenRouter passthrough to the same publisher; adds a `math` domain and measured per-model latency the passthrough never exposed). LMArena's Bradley-Terry/IPS ratings aren't on the same scale as Artificial Analysis's 0-100 indices, so they're tagged under distinct `-arena`-suffixed dimensions (`quality-coding-arena`, `quality-type-planning-arena`) instead of blended into the same average -- stored and queryable on their own, not yet part of the default ranked "quality" score.

Use the authenticated CLI channels independently:

```text
jittor benchmarks status [--json]
jittor benchmarks refresh [--force] [--json]
jittor benchmarks list --source openrouter-models [--model provider/model] [--dimension name] [--limit 1..500] [--json]
```

Only complete snapshots are queryable. Query output reports both completeness and freshness. See [`docs/BENCHMARK_SOURCES.md`](docs/BENCHMARK_SOURCES.md) for source authority, provenance, conflict, and redistribution rules.

Jittor separately records content-free local model observations from Pi's public lifecycle: TTFT, wall latency, output throughput, token/cache/cost efficiency, provider retries, tool-loop counts, failures, and two independent classifications derived only from bounded tool names: domain (subject matter, e.g. `coding`) and type (activity, e.g. `research`, `planning`) -- a run can be domain=coding and type=research at once. Prompts, responses, tool arguments/results, credentials, and project paths are never retained. `/jittor outcome accepted` or `/jittor outcome rejected` attaches explicit outcome evidence to the latest completed local run; runtime completion alone is not treated as quality success. Robust aggregates report sample size, median, p90, median absolute deviation, recency, and confidence without merging local observations into external benchmark facts.

The ranking operation accepts an explicit bounded candidate set and never adds identities found only in evidence. It scores quality (both a domain-specific dimension, e.g. `quality-coding`, and a type-specific dimension, e.g. `quality-type-planning`, each optional and additive over the universal `quality-general` fallback), cost, latency, context, and local reliability with bounded user weights, budget-pressure adjustment, component confidence, freshness, provenance, and deterministic tie-breaking. Missing evidence remains unknown and lowers confidence. Run `/jittor benchmarks [coding|general] [research|planning|general]` (either order, either or both omitted) for the responsive recommendation panel. Because the released Pi extension API does not expose the exact `/scoped-models` set, the current adapter labels candidates `available-models`; the panel says **ADVISORY** and offers no selection action. Automatic route ordering is allowed only for `exact-session` authority and then narrows/reorders routes already present in the supplied candidate set.

### Context pressure

Papyrus emits content-free prompt-injection observations through Pi's shared extension event bus. Jittor validates and records their exact Rule/Task character sizes, prompt share, fingerprint repetition, and explicitly estimated token size. Jittor also records completed, aborted, and unmatched Pi compactions with duration, reason, retry state, pre-compaction context usage, and bounded turns/injection/provider/cache usage since the previous compaction.

Run `/jittor context` for the in-session summary, or `jittor context [--since <epoch-ms>] [--until <epoch-ms>] [--json]` through the authenticated daemon client. The assessment reports bounded average/p95/max injection, Rule/Task mix, unchanged rate, compaction frequency/duration/reasons, and between-compaction provider/cache facts. Repeated prompt content is not labeled billed waste: provider-reported input/cache usage and an injection-disabled control are required before making cost or compaction-causality claims.

### CLI operations

Every daemon operation is reachable from the CLI through the authenticated typed client only — no command reads the SQLite store or a provider adapter directly. Each command supports `--json` for stable machine output; without it, a purpose-built human presenter renders the same result, per [`docs/OUTPUT_CHANNELS.md`](docs/OUTPUT_CHANNELS.md).

```text
jittor metrics record --source <s> --scope <s> --metric <s> --value <number|null> --unit <unit> [--observed-at <ms>] [--attributes <json>] [--json]
jittor metrics query [--source <s>] [--scope <s>] [--metric <s>] [--since <ms>] [--until <ms>] [--limit <n>] [--order asc|desc] [--json]
jittor metrics prune --before <ms> [--json]
jittor metrics distinct-scopes --source <s> --since <ms> --until <ms> [--limit 1..40] [--json]
jittor metrics cost-by-task --since <ms> --until <ms> [--json]
jittor metrics prune --before <ms> [--force] [--json]  # force required if before is newer than 24h ago
jittor service checkpoint [--json]
jittor telemetry poll [--json]
jittor compaction estimate [--json]
jittor router status|decide|pause|resume|clear-override [--json]
jittor router override --route <provider/model@thinking> [--expires-at <ms>] [--json]
jittor router current-route --route <provider/model@thinking> [--json]
jittor router available-routes [--route <provider/model@thinking> ...] [--json]
jittor op <operation> [--input <json>]
```

`jittor op` is a raw escape hatch restricted to the daemon's own `EXPECTED_OPERATION_NAMES`; it rejects an unrecognized operation name before ever reaching the daemon rather than forwarding it blindly. Human-readable metric listings and router status are bounded (at most 50 metric rows and 20 telemetry sources are printed; `--json` output is bounded independently by the daemon's own query and response-size limits). No command prints the daemon bearer token, a provider API key, or an OAuth credential; a daemon-unavailable error stays actionable ("install or start jittor.service") without ever including the token used to reach it.

See [`docs/CALIBRATION.md`](docs/CALIBRATION.md) for thresholds and rollback, and [`docs/USAGE_PRIOR_ART.md`](docs/USAGE_PRIOR_ART.md) for the chart design research.

```bash
bun test
bun x tsc --noEmit
bun run service:install
```

The systemd user unit binds only to `127.0.0.1`, discovers a 256-bit token without logging it, restarts on failure, and exposes authenticated health and operation endpoints.

See [`docs/PROVIDER_RESEARCH.md`](docs/PROVIDER_RESEARCH.md) for verified API boundaries and caveats.

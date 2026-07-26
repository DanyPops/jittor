# @danypops/jittor

Supervised Bun daemon, router policy, provider telemetry adapters, and CLI for Jittor. See the [repo root README](../../README.md) for the two-package overview and [`@danypops/pi-jittor`](../pi-jittor) for the Pi extension that talks to this daemon.

## Architecture

- `src/domain/metric.ts` — normalized timestamped metric observations
- `src/ports/metric-store.ts` — storage boundary used by the application service
- `src/adapters/sqlite-metric-store.ts` — SQLite time-series adapter
- `src/service.ts` — authenticated operation registry
- `src/client.ts` — operation-typed loopback client
- `src/daemon.ts` — Bun composition root and maintenance loop
- `src/index.ts` — the package's public surface: everything `@danypops/pi-jittor` (or any other consumer) imports

SQLite runs in WAL mode with versioned migrations, JSON validation, bounded queries, chronological indexes, pruning, and checkpoints. The database follows `XDG_DATA_HOME`; private authentication state follows `XDG_STATE_HOME`; the daemon handle follows `XDG_RUNTIME_DIR`.

Operations currently include bounded metric recording/query/pruning, benchmark refresh/status/query, context assessment, routing control, telemetry polling, and service checkpointing. Every operation is exposed through the authenticated typed client; benchmark operations also have CLI parity.

## Provider telemetry

- ChatGPT-authenticated Codex subscription usage
- OpenRouter API key usage, response accounting, and model pricing
- Anthropic official per-response rate-limit headers (requests, tokens, input/output tokens, and optional Priority Tier buckets)
- Google Vertex AI classified failure pressure (quota/auth/invalid-request/overload/transport), since Vertex has no documented remaining-budget header or personal polling endpoint

Provider adapters currently include official OpenRouter key/usage/model telemetry and an explicitly experimental Codex subscription adapter. The Codex adapter follows the pinned open-source CLI `/wham/usage` payload and `x-codex-*` response-header contracts, accepts additional metered limits, and fails closed on malformed windows or impossible percentages. File credentials must be explicitly configured and private (`0600`); Jittor reads only the access token and account ID, never refreshes credentials, and never logs or persists OAuth secrets. Anthropic has no personal-account polling endpoint (its Admin/Rate Limits API is documented as unavailable for individual accounts), so Jittor instead reads the official `anthropic-ratelimit-*` response headers Pi observes on every Messages API call and fails closed on schema drift the same way. Google Vertex AI has neither a personal polling endpoint nor a documented remaining-quota response header, so Jittor never fabricates a Vertex budget bar; it instead classifies Vertex's `google.rpc.Status` failure shape (quota, authentication, invalid-request, overload, transport, unknown) from Pi's bounded, content-free `errorMessage` and records only a bounded failure-count metric.

The third-party `anthropic-vertex` provider (Anthropic Claude models served through Google Vertex, e.g. via `@twogiants/pi-anthropic-vertex`) is tracked separately from both of the above: it reuses Pi's own Anthropic Messages stream implementation with Anthropic's official `@anthropic-ai/vertex-sdk` client, so its wire shape is Anthropic's, but its quota accounting is Google's. Jittor applies Google Vertex's failure classification to it (real-world reports confirm its 429s still carry GCP's own quota-exceeded shape even through Anthropic's own SDK) and, best-effort, also checks for genuine Anthropic rate-limit response headers on it, since it is unverified whether this specific passthrough ever forwards them. Either way, every metric is tagged `anthropic-vertex`, never blended into direct Anthropic's `anthropic` source or Pi's unrelated native `google-vertex` provider, since each represents a different account/quota pool.

Blocking always has a daemon-independent escape hatch: `/jittor off` (in the extension) immediately enters persisted monitor-only mode and never blocks provider requests, regardless of daemon state.

## Benchmark evidence

Jittor can ingest bounded OpenRouter model metadata, p50 latency/throughput ordering, and Design Arena Elo rankings as provenance-bearing evidence without treating OpenRouter as model-scope authority. Enable online ingestion explicitly with `JITTOR_OPENROUTER_BENCHMARKS=1`; it is off by default. OpenRouter model metadata and operational ordering are public; Design Arena ingestion additionally uses `OPENROUTER_API_KEY` from the supervised service environment without retaining it. Snapshots preserve the upstream publisher, normalized model identities, immutable retrieval revisions, source URLs, confidence, license terms, and explicit freshness deadlines. A malformed or oversized refresh leaves the last complete snapshot visible and records only a payload-safe failure state.

Design Arena rates models across dozens of arena/category pairs (music, video, text-to-speech, ASCII art, ...); Jittor ingests only the bounded allowlist of categories (`codecategories`, `website`, `uicomponent`, `dataviz`, `svg`) that measure frontend/UI-generation skill relevant to routing a coding agent, tagged into one `design` domain distinct from `coding`. A model with no OpenRouter-reachable identity (proprietary platforms, image/video generators) is skipped rather than fabricated into unroutable evidence.

Jittor also ingests LMArena's own official Hugging Face dataset (`lmarena-ai/leaderboard-dataset`, via the public `datasets-server.huggingface.co` API -- no credential required) for its Code Arena (`webdev`) and Agent Arena human-preference battles, and, when `ARTIFICIAL_ANALYSIS_API_KEY` is configured, Artificial Analysis's own direct API (adds a `math` domain and measured per-model latency). LMArena's Bradley-Terry/IPS ratings aren't on the same scale as Artificial Analysis's 0-100 indices, so they're tagged under distinct `-arena`-suffixed dimensions instead of blended into the same average.

Use the authenticated CLI channels independently:

```text
jittor benchmarks status [--json]
jittor benchmarks refresh [--force] [--json]
jittor benchmarks list --source openrouter-models [--model provider/model] [--dimension name] [--limit 1..500] [--json]
```

Only complete snapshots are queryable. Query output reports both completeness and freshness. See [`docs/BENCHMARK_SOURCES.md`](docs/BENCHMARK_SOURCES.md) for source authority, provenance, conflict, and redistribution rules.

The ranking operation (`domain/model-ranking.ts`) accepts an explicit bounded candidate set and never adds identities found only in evidence. It scores quality (a domain-specific dimension, e.g. `quality-coding`, and a type-specific dimension, e.g. `quality-type-planning`, each optional and additive over the universal `quality-general` fallback), cost, latency, context, and local reliability with bounded user weights, budget-pressure adjustment, component confidence, freshness, provenance, and deterministic tie-breaking. Missing evidence remains unknown and lowers confidence.

Jittor separately records content-free local model observations from Pi's public lifecycle: TTFT, wall latency, output throughput, token/cache/cost efficiency, provider retries, tool-loop counts, failures, and two independent classifications derived only from bounded tool names: domain (subject matter, e.g. `coding`) and type (activity, e.g. `research`, `planning`). Prompts, responses, tool arguments/results, credentials, and project paths are never retained. Robust aggregates report sample size, median, p90, median absolute deviation, recency, and confidence without merging local observations into external benchmark facts.

## Context pressure

Papyrus emits content-free prompt-injection observations through Pi's shared extension event bus. Jittor validates and records their exact Rule/Task character sizes, prompt share, fingerprint repetition, and explicitly estimated token size. Jittor also records completed, aborted, and unmatched Pi compactions with duration, reason, retry state, pre-compaction context usage, and bounded turns/injection/provider/cache usage since the previous compaction.

`jittor context [--since <epoch-ms>] [--until <epoch-ms>] [--json]` reports bounded average/p95/max injection, Rule/Task mix, unchanged rate, compaction frequency/duration/reasons, and between-compaction provider/cache facts. Repeated prompt content is not labeled billed waste: provider-reported input/cache usage and an injection-disabled control are required before making cost or compaction-causality claims.

## CLI operations

Every daemon operation is reachable from the CLI through the authenticated typed client only — no command reads the SQLite store or a provider adapter directly. Each command supports `--json` for stable machine output; without it, a purpose-built human presenter renders the same result, per [`docs/OUTPUT_CHANNELS.md`](docs/OUTPUT_CHANNELS.md).

```text
jittor metrics record --source <s> --scope <s> --metric <s> --value <number|null> --unit <unit> [--observed-at <ms>] [--attributes <json>] [--json]
jittor metrics record-batch --observations <json-array, max 100> [--json]
jittor metrics query [--source <s>] [--scope <s>] [--metric <s>] [--since <ms>] [--until <ms>] [--limit <n>] [--order asc|desc] [--json]
jittor metrics prune --before <ms> [--force] [--json]  # force required if before is newer than 24h ago
jittor metrics distinct-scopes --source <s> --since <ms> --until <ms> [--limit 1..40] [--json]
jittor metrics cost-by-task --since <ms> --until <ms> [--json]
jittor service checkpoint [--json]
jittor telemetry poll [--json]
jittor compaction estimate [--json]
jittor session register --session-id <id> [--json]
jittor session release --session-id <id> [--session-secret <secret>] [--json]
jittor router status|decide|pause|resume|clear-override [--session-id <id>] [--session-secret <secret>] [--json]
jittor router override --route <provider/model@thinking> [--expires-at <ms>] [--session-id <id>] [--session-secret <secret>] [--json]
jittor router current-route --route <provider/model@thinking> [--session-id <id>] [--session-secret <secret>] [--json]
jittor router available-routes [--route <provider/model@thinking> ...] [--session-id <id>] [--session-secret <secret>] [--json]
jittor op <operation> [--input <json>]
```

`jittor op` is a raw escape hatch restricted to the daemon's own `EXPECTED_OPERATION_NAMES`; it rejects an unrecognized operation name before ever reaching the daemon rather than forwarding it blindly. Human-readable metric listings and router status are bounded (at most 50 metric rows and 20 telemetry sources are printed; `--json` output is bounded independently by the daemon's own query and response-size limits). No command prints the daemon bearer token, a provider API key, or an OAuth credential; a daemon-unavailable error stays actionable ("install or start jittor.service") without ever including the token used to reach it.

See [`docs/CALIBRATION.md`](docs/CALIBRATION.md) for routing thresholds and rollback, and [`docs/PROVIDER_RESEARCH.md`](docs/PROVIDER_RESEARCH.md) for verified provider API boundaries and caveats.

```bash
bun test
bun x tsc --noEmit
bun run service:install
```

The systemd user unit binds only to `127.0.0.1`, discovers a 256-bit token without logging it, restarts on failure, and exposes authenticated health and operation endpoints.

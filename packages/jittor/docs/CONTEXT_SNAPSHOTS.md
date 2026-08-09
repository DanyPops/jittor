# Content-free context snapshots and deltas

Jittor observes Pi's `before_provider_request` boundary to compare the structure of consecutive
provider requests. This is observability only: capture never modifies or delays the request, and a
capture/daemon failure cannot block provider delivery.

## Persisted contract

A snapshot contains only:

- bounded source categories (`base-prompt`, `tool-definitions`, `rules`, `skills`,
  `project-context`, `conversation-message`, `thinking`, `tool-call`, `tool-result`);
- non-negative token sizes, request positions, timestamps, and lifecycle state;
- opaque logical IDs and content fingerprints produced by keyed HMAC;
- provider/model identity and an honest truncation flag.

Snapshots are capped at 512 segments. Values are canonicalized only in memory with depth,
collection, node, and string bounds. Jittor never persists prompts, responses, tokenizer input,
tool arguments/results, images, shell commands, paths, credentials, or reversible/plain hashes.
Images retain structural identity with zero locally attributed tokens because image token cost is
provider/model-specific.

Pi's final payload supplies active request order. Its real `SessionManager` tree additionally marks
entries omitted by compaction as `compacted` and abandoned branches as `inactive`; historical
entries have no request position and therefore cannot inflate stable-prefix evidence.

## Delta semantics

For each logical segment, a delta reports `added`, `retained`, `changed`, `evicted`, `compacted`, or
`inactive`, plus source-level token growth. Equal repeated structures remain distinct logical
segments even when their content fingerprints are equal. A provider, model, or opaque session
change resets comparison rather than correlating incompatible request shapes.

`stablePrefixTokens` is the sum of unchanged leading active request segments, and
`firstChangedSegment` identifies the first structural divergence. This is correlation evidence for
request churn. It is **not proof of provider cache behavior, cache eligibility, cache hits, billing,
or causality**. Provider-reported usage remains authoritative at aggregate request scope.

## Operations

```text
jittor context delta --session-id <opaque-id> [--json]
jittor context snapshot --snapshot <content-free-json> [--json]
```

`context.snapshot` is a single-execution local write and is never transport-retried.
`context.delta` is a bounded read and may reconnect/retry once. Pi's `/context` view derives the
opaque session ID internally and displays stable-prefix size, first change, lifecycle counts,
source growth, truncation, and the cache-evidence caveat alongside its searchable context tree.

Snapshots and their deltas are committed atomically through `MetricStore.recordBatch()`. The latest
snapshot reloads from SQLite after daemon restart. A late stale capture remains queryable as
history but cannot replace a newer snapshot as the session's latest state.

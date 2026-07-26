# Jittor provider telemetry research

Verified 2026-07-18. Contracts marked **official** are documented provider APIs. Contracts marked **experimental** are implemented by an official open-source client but are not published as stable public APIs.

## Decision summary

| Source | Hot-path telemetry | Budget semantics | Stability |
|---|---|---|---|
| Codex subscription | `/backend-api/wham/usage`, Codex response headers, local Pi turn usage | Provider reports used percentage and reset time; absolute token allowance is not exposed | Experimental |
| OpenAI API key | Standard rate-limit headers and response usage | Exact token rate limits and API billing | Official, separate from subscription |
| OpenRouter | `/api/v1/key`, response `usage`, `/generation`, `/models` | Exact per-request tokens/cost; key limit when configured; otherwise Jittor budget required | Official |
| OpenRouter Analytics | `/api/v1/analytics/query` with management key | Historical aggregate spend/tokens | Official beta; not hot path |
| Anthropic | `anthropic-ratelimit-*`/`anthropic-priority-*` response headers on every Messages API call | Exact requests/tokens/input-tokens/output-tokens remaining-vs-limit per response; no personal polling endpoint (Admin API is unavailable for individual accounts) | Official |
| Google Vertex AI | No documented per-response rate-limit header or personal polling endpoint; errors carry a `google.rpc.Status` shape (`RESOURCE_EXHAUSTED`, `PERMISSION_DENIED`, `UNAVAILABLE`, ...) | No remaining-budget signal is available; Jittor classifies failure kind/transience only, as a bounded failure-count metric, never a fabricated fraction | No official hot-path budget telemetry exists |

## Codex subscription

### Officially documented behavior

OpenAI documents that:

- ChatGPT-authenticated Codex uses plan allowance rather than standard API billing.
- Usage depends on model, context, reasoning, tools, retrieval, and caching; prompt length alone is not a reliable estimate.
- Local messages and cloud chats can share a five-hour window and additional weekly limits may apply.
- Users can inspect remaining allowance in the Codex usage dashboard and with `/status` in Codex CLI.
- Switching to a smaller model is the recommended mitigation near limits.
- `~/.codex/auth.json` may contain plaintext OAuth credentials and must be treated as a password.
- The workspace Analytics API is for aggregated Business/Enterprise reporting and is not a personal real-time subscription-quota API.

There is no documented personal-plan API contract equivalent to the usage dashboard.

### Experimental contract used by official Codex CLI

The open-source `openai/codex` client calls:

```text
GET https://chatgpt.com/backend-api/wham/usage
Authorization: Bearer <ChatGPT OAuth access token>
ChatGPT-Account-Id: <account id>
```

For the alternate Codex API path style, its source constructs `/api/codex/usage`. The ChatGPT path above was live-probed successfully without logging credentials.

Observed response fields include:

- `plan_type`
- `rate_limit.primary_window` and `secondary_window`
- `used_percent`
- `limit_window_seconds`
- `reset_at`
- `credits.{has_credits, unlimited, balance}`
- `additional_rate_limits[]` with `metered_feature`, `limit_name`, and independent windows
- spend-control and rate-limit-reached metadata

The official CLI also parses rolling response headers:

```text
x-codex-primary-used-percent
x-codex-primary-window-minutes
x-codex-primary-reset-at
x-codex-secondary-used-percent
x-codex-secondary-window-minutes
x-codex-secondary-reset-at
x-codex-credits-has-credits
x-codex-credits-unlimited
x-codex-credits-balance
x-codex-<limit>-primary-used-percent
x-codex-<limit>-limit-name
```

It warns at 75%, 90%, and 95%, and offers a smaller-model switch around 90%. Jittor may use different configurable thresholds but should preserve hysteresis.

### What Codex does not expose

The subscription usage response does **not** expose an absolute token budget. Therefore Jittor must not label provider percentage as tokens. It will maintain two metrics:

1. **Provider budget pressure:** percentage consumed versus time remaining.
2. **Observed token velocity:** Pi assistant usage tokens per elapsed time, grouped by model and thinking level.

Over time Jittor can estimate tokens-per-budget-percent with an EWMA, but that estimate must retain confidence and sampling metadata because provider metering includes reasoning, tools, caching, and potentially non-Pi Codex usage.

### Credential and reliability rules

- Never persist or log OAuth/access/refresh tokens.
- File-based Codex auth is supported only when explicitly configured; keyring-backed auth needs a separate credential broker.
- Do not implement OAuth token refresh independently in v1. Codex owns credential refresh.
- Treat 401, missing fields, unknown schema, stale snapshots, and impossible reset times as telemetry failure.
- Poll no faster than once per minute unless response headers provide an update.
- The adapter is version-pinned and explicitly `experimental`; schema drift fails closed according to policy.

## OpenAI API-key mode is a separate source

Standard OpenAI API requests expose official token/request limit headers such as:

- `x-ratelimit-limit-tokens`
- `x-ratelimit-remaining-tokens`
- `x-ratelimit-reset-tokens`
- request and project-token equivalents

These are API organization/project limits, not ChatGPT subscription allowance. Jittor must never merge them into one budget window.

## OpenRouter

### Key and credit telemetry

Official endpoint:

```text
GET https://openrouter.ai/api/v1/key
Authorization: Bearer <OpenRouter key>
```

Useful fields:

- `limit`, `limit_reset`, `limit_remaining`
- `usage`, `usage_daily`, `usage_weekly`, `usage_monthly`
- BYOK usage variants
- `rate_limit`
- key capability flags including management/provisioning status

A live probe succeeded. The current key has no configured per-key limit, so `limit_remaining` is `null`; Jittor therefore needs user-defined daily/weekly/monthly budgets unless a key cap is configured.

Credit exhaustion produces HTTP 402. Rate limits produce 429 and may be OpenRouter-level or upstream-provider-level. Honor `Retry-After`; streaming errors may arrive as SSE error events after HTTP 200.

### Per-request accounting

Every OpenRouter response includes native-token accounting:

- prompt tokens
- completion tokens
- reasoning tokens
- cached read/write tokens when supported
- total `cost`
- upstream inference cost details

Streaming responses place usage in the last SSE event. A generation ID can later be queried through the `/generation` endpoint for audit/reconciliation.

This is Jittor's authoritative OpenRouter hot-path cost signal.

### Model catalog

Official endpoint:

```text
GET https://openrouter.ai/api/v1/models
```

A live probe returned 344 models. Model records include canonical ID, context length, pricing, conditional pricing overrides, supported parameters, reasoning support, top-provider details, expiration, and per-request limits.

Routing rules:

- Prefer canonical model IDs for deterministic budgets; `~...latest` aliases can change.
- Refresh catalog with TTL and retain the last known-good snapshot.
- Account for pricing overrides, cache pricing, reasoning, and request/tool surcharges.
- Filter candidates by required capabilities before sorting by cost.
- Provider-native fallbacks are useful for availability, but Jittor should record the actual served model/provider and cost.

### Analytics API

OpenRouter's beta Analytics API accepts management keys and can aggregate `total_usage`, token metrics, cache hit rate, reasoning tokens, model, API key, and generation dimensions. It is useful for calibration and audits, not pre-request routing. The API is beta: discover metadata dynamically, parse count metrics as number or string, and honor truncation metadata.

## Anthropic

### Official per-response rate-limit headers

Anthropic's Rate Limits API documentation states plainly that "the Admin API is unavailable for individual accounts," so there is no personal polling endpoint equivalent to OpenRouter's `/key` or even Codex's experimental `/wham/usage`. What Anthropic does document, on every Messages API response, is a fixed set of headers:

```text
retry-after
anthropic-ratelimit-requests-limit / -remaining / -reset
anthropic-ratelimit-tokens-limit / -remaining / -reset
anthropic-ratelimit-input-tokens-limit / -remaining / -reset
anthropic-ratelimit-output-tokens-limit / -remaining / -reset
anthropic-priority-input-tokens-limit / -remaining / -reset   (Priority Tier only)
anthropic-priority-output-tokens-limit / -remaining / -reset  (Priority Tier only)
```

`-reset` values are RFC 3339 timestamps. Anthropic's docs also state the `tokens` bucket headers always reflect "the most restrictive limit currently in effect," so Jittor treats `tokens` as the primary budget signal and falls back to `requests` only when no token telemetry has been observed. Jittor observes these headers from Pi's own `after_provider_response` event (the same mechanism used for Codex's `x-codex-*` headers) rather than daemon-side polling, because there is no standalone endpoint to poll. Schema drift (non-numeric limits, non-RFC-3339 resets, `remaining > limit`) fails closed with a user-visible notice, matching the Codex header-parsing contract.

## Google Vertex AI

### No official hot-path budget telemetry

Unlike Anthropic and OpenRouter, Vertex does not document a per-response rate-limit or remaining-quota header for `generateContent`/Messages-compatible calls. Quota is configured and reported at the Google Cloud project/region level (Service Usage / Quota APIs, Cloud Console "Quotas & System Limits"), which is an account-configuration surface, not a response header Jittor could read before a request is throttled — the same class of limitation Amazon Bedrock has (see Papyrus doc `jittor-provider-survey-which-additional-apis-to-support-0wma`, Tier 2). Failures instead surface as a `google.rpc.Status` shape, `{error: {code, message, status, details[]}}`, with `status` one of the canonical gRPC codes (`RESOURCE_EXHAUSTED`, `PERMISSION_DENIED`, `UNAUTHENTICATED`, `UNAVAILABLE`, `DEADLINE_EXCEEDED`, `INVALID_ARGUMENT`, ...), sometimes with a `google.rpc.RetryInfo.retryDelay` or `google.rpc.QuotaFailure` detail.

Jittor therefore does not fabricate a remaining-budget bar for Vertex from the response path alone. It classifies the bounded, content-free `errorMessage` string Pi already exposes for every provider (the same source `classifyCodexFailure` reads) into a failure kind and transience, and records only a bounded failure-count metric (`source: "google-vertex", scope: "failure", metric: <kind>, unit: "count"`) — never a `ratio` metric implying a known remaining fraction. This is an honest degradation: Jittor surfaces *that* and *what kind of* capacity/auth/request pressure Pi is seeing, without claiming to know how much budget remains.

### A real hot(ish)-path signal exists once quota moves to individual per-user GCP projects

The "no telemetry" conclusion above is specific to a *shared* GCP project, where Google has nothing to key a per-user signal on. Several organizations are migrating Vertex/Claude-on-Vertex access from one shared project to one GCP project per individual user specifically so usage/cost can be attributed per person — and that migration changes the honest answer, because Cloud Billing budgets support **project-scoped access** without any Cloud Billing account IAM role: `resourcemanager.projects.get` + `billing.resourcebudgets.read`/`billing.resourceCosts.get` on the project alone are enough (verified against `docs.cloud.google.com/billing/docs/how-to/budget-api-access-control` and `.../billing/docs/how-to/budgets`, fetched 2026-07-23) — matching a "passwordless/keyless", ADC-only individual-project auth model with no static service-account key.

Two API surfaces matter here, and they answer different questions:

- **`billingAccounts.budgets.get`/`.list`** (REST, project-scoped per above) returns only the budget's *policy* — its cap (`amount`), alert `thresholdRules`, and filters. It does **not** return current spend. Resolving which billing account owns a given project first requires `projects.getBillingInfo` (`cloudbilling.googleapis.com`, also just `resourcemanager.projects.get`/Project Viewer).
- **Cloud Billing's own programmatic budget notifications**, delivered over Pub/Sub, are the real signal: Google's docs state notifications are "sent to the Pub/Sub topic **multiple times per day** with the current status of your budget" (not only on threshold crossings), each message carrying real dollar figures — `costAmount`, `budgetAmount`, `costIntervalStart`, `currencyCode`, and (only once actually exceeded) `alertThresholdExceeded`/`forecastThresholdExceeded` (schema verified against `docs.cloud.google.com/billing/docs/how-to/budgets-programmatic-notifications#notification-format` and the worked fixture in `.../billing/docs/how-to/listen-to-notifications`, fetched 2026-07-23). Since Jittor is a local, loopback-only daemon with no public inbound endpoint, it **pulls** (never pushes) this topic via a Pub/Sub pull subscription (`pubsub.googleapis.com/v1/{subscription}:pull`), authenticated the same ADC way.

This is still not a fully real-time signal, and the docs are explicit about both caveats Jittor must preserve rather than paper over: (1) "Budgets use estimated Cloud Billing data which is subject to change until your invoice is finalized", and (2) "Pub/Sub only provides at-least-once delivery. You might receive a message multiple times, and messages might arrive out of order." Jittor's `GoogleVertexBudgetTelemetryAdapter` (`src/providers/google-vertex-budget.ts`) selects the freshest pulled message by its own Pub/Sub `publishTime`, fails closed (throws) on any message that doesn't match the documented schema, and reports this signal at a lower confidence (`0.6`, vs. `0.8` for Codex's header-derived windows) than a per-response header would earn. `spend`/`cap` are recorded as real USD metrics and their `spend-fraction` ratio is left unclamped (so a genuine over-cap soft-quota period stays visible); only the policy-facing `BudgetWindow.usedFraction` is clamped to `1.0`, since a known-to-be-≥100% real number floored to the window's documented `[0,1]` invariant is not the same thing as fabricating one from nothing.

Setting this up requires one-time configuration outside Jittor for each individual project: create a Pub/Sub topic, connect it to the project's budget (Project Owner/Editor role, plus Pub/Sub Admin on whichever project holds the topic), and create a pull subscription on it. Jittor only consumes the subscription; it does not provision any of this GCP-side configuration itself.

## Normalized Jittor model

```ts
interface BudgetWindow {
  source: "codex-subscription" | "openai-api" | "openrouter" | "jittor";
  scope: string;
  usedFraction: number | null;
  usedAmount: number | null;
  limitAmount: number | null;
  unit: "provider-percent" | "usd" | "tokens" | "requests";
  windowSeconds: number | null;
  resetsAt: number | null;
  observedAt: number;
  freshness: "fresh" | "stale" | "failed";
  confidence: number;
}
```

For a resettable window:

```text
observed burn     = delta(used) / delta(time)
sustainable burn = remaining / max(reset_at - now, minimum_horizon)
pressure          = observed burn / sustainable burn
```

Token velocity and cost velocity are tracked separately per provider/model/thinking route. Decisions must include their input snapshot IDs and a human-readable explanation.

## Pi enforcement points

Verified Pi APIs support:

- `input`: preflight and return `{action: "handled"}` for a hard stop before the agent starts.
- `turn_start`: re-evaluate before each model/tool loop turn.
- `pi.setModel(model)`: switch provider/model after resolving it through `ctx.modelRegistry`.
- `pi.setThinkingLevel(level)`: lower reasoning effort, clamped to model support.
- `after_provider_response`: observe status and provider headers before streaming.
- `message_end`: record finalized assistant token/cost usage.
- `ctx.abort()`: stop an active agent operation if a mid-run hard threshold is crossed.

The Pi extension is an actuator and event collector. Policy, provider polling, history, and decisions live in the supervised Jittor daemon.

## Initial policy ladder

The policy engine is deterministic and configured by route tiers:

1. `continue`
2. `throttle(delayMs)`
3. `lower-thinking(level)`
4. `switch-model(provider, model, thinking)`
5. `switch-provider(provider, model, thinking)`
6. `halt(reason)`

Required safeguards: hysteresis, cooldown, maximum delay, minimum telemetry freshness, explicit capability checks, route availability/auth checks, and no automatic retry of non-idempotent requests.

## Sources

### OpenAI / Codex

- https://learn.chatgpt.com/docs/pricing#what-are-the-usage-limits-for-my-plan
- https://developers.openai.com/codex/auth
- https://developers.openai.com/codex/enterprise/analytics-api
- https://developers.openai.com/api/docs/guides/rate-limits
- https://github.com/openai/codex/blob/312caf176a8fd3a5897a3d1fd3ed0a283bd1b5ac/codex-rs/backend-client/src/client/rate_limit_resets.rs
- https://github.com/openai/codex/blob/312caf176a8fd3a5897a3d1fd3ed0a283bd1b5ac/codex-rs/codex-api/src/rate_limits.rs
- https://github.com/openai/codex/blob/312caf176a8fd3a5897a3d1fd3ed0a283bd1b5ac/codex-rs/tui/src/chatwidget/rate_limits.rs

### OpenRouter

- https://openrouter.ai/docs/api/reference/limits
- https://openrouter.ai/docs/cookbook/administration/usage-accounting
- https://openrouter.ai/docs/cookbook/administration/analytics-cost-control
- https://openrouter.ai/docs/guides/overview/models

### Anthropic

- https://platform.claude.com/docs/en/api/rate-limits (fetched 2026-07-21)
- https://platform.claude.com/docs/en/manage-claude/rate-limits-api ("The Admin API is unavailable for individual accounts")

### Google Vertex AI

- Google Cloud/Gemini API 429 `RESOURCE_EXHAUSTED` error reports and `google.rpc.Status`/`QuotaFailure`/`RetryInfo` detail shapes, cross-checked across multiple live incident reports (fetched 2026-07-21); no official Vertex response header for remaining quota was found
- Amazon Bedrock documents the same account-level-quota-not-header pattern as a cross-check on the general "cloud-vendor AI quota lives at the account/project layer, not a response header" shape
- https://docs.cloud.google.com/billing/docs/how-to/budget-api-access-control (project-scoped `GetBudget`/`ListBudgets` permissions, fetched 2026-07-23)
- https://docs.cloud.google.com/billing/docs/how-to/budgets ("Project-scoped billing permissions" / single-project access section, fetched 2026-07-23)
- https://docs.cloud.google.com/billing/docs/reference/rest/v1/projects/getBillingInfo (fetched 2026-07-23)
- https://docs.cloud.google.com/billing/docs/how-to/budgets-programmatic-notifications#notification-format (fetched 2026-07-23)
- https://docs.cloud.google.com/billing/docs/how-to/listen-to-notifications (worked notification fixture used verbatim in `test/google-vertex-budget.test.ts`, fetched 2026-07-23)
- https://docs.cloud.google.com/billing/docs/reference/budget/rest/v1/billingAccounts.budgets (Budget resource schema — confirms no current-spend field, fetched 2026-07-23)

### Pi

- Pi extension lifecycle and model APIs: local `docs/extensions.md`
- Pi model/provider configuration: local `docs/models.md`

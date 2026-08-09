# Provenance-bearing model catalog

Jittor can ingest the open-source [models.dev](https://models.dev) provider catalog from
`https://models.dev/api.json`. Network access is off by default. Set
`JITTOR_MODELS_DEV_CATALOG=1`, then run `jittor catalog refresh`; an optional
`JITTOR_MODELS_DEV_CATALOG_URL` is intended for a trusted mirror or loopback integration test.

The direct translator preserves provider serving identity, aliases, context/input/output limits,
modalities, capabilities, lifecycle status, input/output/reasoning/cache prices, over-200k prices,
and context price tiers. A bounded response is validated as one complete snapshot. Its SHA-256
content revision, source URL, retrieval time, freshness deadline, and upstream MIT license are
stored. The complete marker is published last, so malformed, partial, oversized, timed-out, or
offline refreshes cannot replace the last complete snapshot.

Catalog prices are USD per million tokens and remain metadata estimates. Provider-reported usage
and cost are authoritative for actual billing. Provider serving entries override base-model
metadata in models.dev itself. Explicit query-time local overrides then win over catalog fields;
every resolved field reports `models-dev-provider` or `user-override` authority. Aliases are matched
only inside the selected provider, so a shared model name never merges provider quota pools or
serving variants.

Commands:

```text
jittor catalog status [--json]
jittor catalog refresh [--force] [--json]
jittor catalog list [--provider <id>] [--model <id>] [--limit <n>] [--json]
```

Local limit/price overrides are available on `catalog list` through `--context-tokens`,
`--input-tokens`, `--output-tokens`, `--input-price`, and `--output-price`.

## Source and redistribution

models.dev is Copyright (c) 2025 models.dev and distributed under the MIT License. Jittor stores only
translated metadata plus its source/provenance; redistributors must retain the upstream copyright
and permission notice when the license requires it. See the upstream repository for the complete
license and contribution history.

OpenRouter's model endpoint remains useful operational marketplace metadata for OpenRouter-specific
availability and pricing. It is not used as a base-model authority and cannot replace models.dev's
cross-provider serving catalog. Conversely, models.dev metadata does not override live OpenRouter
account/response telemetry. The two sources retain distinct provenance and authority.

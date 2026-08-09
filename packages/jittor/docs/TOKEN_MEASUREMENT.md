# Token measurement provenance

Jittor treats token counts as measurements with explicit scope and provenance. A number is not enough: provider request usage, a provider count API, exact tokenization of one text value, and `char/4` structural estimates have different authority and must not be blended or relabeled.

## Stable measurement shape

`TokenMeasurement` contains only bounded metadata:

- `tokens`: a non-negative safe integer.
- `scope`: `request-context`, `request-input`, `response-output`, `cache-read`, `cache-write`, `context-item`, or `unattributed-residual`.
- `provenance`: `provider-reported`, `provider-count-api`, `tokenizer-exact-text`, or `structural-estimate`.
- `method`: a bounded counter identity such as `pi-assistant-usage`, `gpt-tokenizer:o200k_base`, or `char/4`.
- Optional provider/model identity, present together.

Raw text, prompts, responses, tool arguments/results, paths, credentials, and tokenizer input are not valid fields and fail strict validation.

## Authority and reconciliation

Provider-reported request totals remain the runtime authority. Exact local tokenization applies only to the supplied text; it does not include provider message envelopes, chat templates, tool schemas, images, cache-control serialization, or provider-side rewrites.

`reconcileRequestTokens()` therefore keeps three distinct facts:

1. The unchanged provider aggregate.
2. The sum of locally attributed items.
3. An explicit unattributed residual, plus any estimate overshoot.

The residual is never distributed across individual items. Until a complete request snapshot can be counted safely, an assistant turn's provider aggregate is represented with zero attributed items and the complete request count as its visible residual.

## OpenAI-family local adapter

`loadOpenAiTextTokenCounter(provider, model)` conservatively maps known OpenAI-family model identities to `cl100k_base`, `o200k_base`, or `o200k_harmony`. It returns `null` for an unknown provider/model instead of guessing. OpenRouter identities are supported only when the model is explicitly under `openai/`.

The BPE tables are dynamically loaded only when `/context` requests exact text attribution. Importing Jittor's public API does not load them or increase daemon startup memory. Pi falls back to a visibly marked `char/4` measurement if loading or mapping fails.

## TypeScript module evaluation

Measured under Bun 1.3.14 on 2026-08-09 with a 1,232,000-byte corpus repeated for 20 encodes. The corpus mixed TypeScript, prose, Unicode scripts/emoji, and high-entropy hexadecimal text. Results are environment-specific engineering evidence, not universal performance claims.

| Module | Version/license | Representative o200k throughput | Package/cold-load trade-off | Decision |
|---|---|---:|---|---|
| `gpt-tokenizer` | 3.4.0, MIT | 27.51 MB/s | About 53.1 MB npm unpacked. Standalone o200k load measured ~0.26 s / 176 MB RSS. Jittor public-index import remains ~0.02 s / 52 MB RSS; lazy GPT-5 counter load measured ~0.37 s / 185 MB RSS. | Selected for the first adapter, dynamically and one encoding at a time. |
| `js-tiktoken` | 1.0.21, MIT | 4.95 MB/s | About 22.4 MB npm unpacked; measured ~0.02 s / 53 MB RSS cold import. Lower startup/memory, materially slower on this corpus. | Retained as prior art/fallback candidate, not a production dependency. |
| `@huggingface/tokenizers` | 0.1.3, Apache-2.0 | Not benchmarked without a model tokenizer configuration | About 301 KB npm unpacked, excluding model `tokenizer.json` and `tokenizer_config.json`. Broad open-model support, but configuration provenance/download bounds and regex compatibility must be handled per model. | Deferred to a bounded open-model/catalog integration. |

Both tested OpenAI implementations produced 6,160,000 tokens across the 20 corpus iterations. The benchmark used encoding-level APIs, not chat/request encoding, because Jittor labels this capability exact for text only.

## Test layers

- Domain tests validate strict serialization, provenance, fallback, residuals, overshoot, Unicode, and model mapping.
- Adapter tests execute real `gpt-tokenizer` encodings.
- Context integration tests attach measurements to the real hierarchy while preserving legacy `estimatedTokens` compatibility.
- `pi-tui-harness` runs the context viewport through a real headless VT implementation.
- `pi-process-harness` starts a real isolated Pi process, faux provider, and Jittor daemon, then verifies provider-reported token provenance through SQLite and the authenticated CLI without retaining prompt/response content.

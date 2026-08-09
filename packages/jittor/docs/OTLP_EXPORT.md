# Content-free OTLP export

Jittor can asynchronously export observations to any OTLP/HTTP JSON metrics collector. It is off by
default and has no Phoenix, Langfuse, or other backend dependency.

Configure one standard OpenTelemetry endpoint variable:

```text
OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=https://collector.example/v1/metrics
# or OTEL_EXPORTER_OTLP_ENDPOINT=https://collector.example/
OTEL_EXPORTER_OTLP_HEADERS=authorization=Bearer%20...
```

`OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` is exact. The generic endpoint receives `v1/metrics`.
Endpoints and headers exist only at the concrete transport boundary; status, errors, local metrics,
and logs never contain them. Plain HTTP is accepted only for loopback collectors.

```text
jittor export status [--json]
jittor export flush [--json]
```

Status reports enabled/disabled state, queue depth, exported/dropped counts, failed batches, last
success/failure timestamps, and the pinned convention revision. It never reports endpoint or
credential data.

## Semantic mapping

The mapping is pinned to OpenTelemetry GenAI semantic-conventions commit
`46d43c8949afb53765a202e89f4534eeb75ca3fa` with core semantic conventions `v1.44.0`. GenAI
conventions are still Development and currently have no schema URL, so Jittor reports this complete
pin as `genai@46d43...+core-v1.44.0` and isolates names in one mapper.

- input/output tokens → `gen_ai.client.token.usage` with `gen_ai.token.type`
- latency → `gen_ai.client.operation.duration`
- TTFT → `gen_ai.client.operation.time_to_first_chunk`
- provider/model/operation/thinking → current `gen_ai.*` attributes
- readily available opaque session correlation → `gen_ai.conversation.id`
- cache/reasoning tokens and output throughput → `jittor.gen_ai.*`
- compaction, context, budget, and routing facts → bounded `jittor.*` metrics/attributes
- failures → low-cardinality `error.type`; raw provider errors are never exported

The standard token metric allows only input/output token types, so cache and reasoning observations
stay distinct under Jittor's namespace rather than inventing non-standard values for
`gen_ai.token.type`. Provider-reported values retain their local authority; export does not
re-tokenize content.

## Privacy and failure isolation

The mapper is an allowlist. It has no configuration switch for content and cannot emit
`gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.system_instructions`, prompt variables,
tool definitions, prompts, responses, tool arguments/results, shell commands, file paths,
credentials, environment values, or raw provider errors.

Local SQLite persistence completes before an observation is enqueued. Export is detached from Pi's
provider lifecycle. The in-memory queue, batch, interval, timeout, and one-retry policy are bounded;
backpressure drops and counts the oldest item. Collector failure only increments credential-safe
health counters and cannot change local persistence or routing. Shutdown performs a bounded final
flush; a restart intentionally starts with an empty queue while SQLite remains authoritative.

Generic OpenTelemetry Collector, Phoenix OTLP ingestion, and Langfuse OTLP ingestion can consume the
same endpoint shape when configured by their own documentation. Jittor neither detects nor couples
to those products.

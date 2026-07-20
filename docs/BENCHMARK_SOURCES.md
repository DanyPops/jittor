# Benchmark evidence sources

Jittor treats benchmark metadata as evidence, not as an unrestricted model catalog. A model is eligible only when it is present in Pi's current scoped-model set; no external source may expand that scope.

## Authority tiers

1. Pi runtime scope and local Jittor observations.
2. Creator APIs and model cards for identity, availability, capabilities, pricing, and terms.
3. OpenRouter metadata for its own catalog, pricing, architecture, p50 latency/throughput ordering, and popularity. The authenticated OpenRouter benchmark endpoint retains Artificial Analysis as the upstream publisher rather than relabeling it as OpenRouter quality evidence.
4. Reproducible independent suites such as SWE-bench Verified, Terminal-Bench, LiveCodeBench, and Aider Polyglot.
5. Versioned operational measurements and preference datasets.

Provider quality claims remain provider claims. OSINT is discovery-only unless corroborated by an accepted source.

## Required provenance

Every accepted observation identifies:

- the exact provider/model/version and any explicit alias mapping;
- one evidence dimension and unit;
- publisher, source type, canonical URL, and immutable revision when available;
- publication and retrieval timestamps;
- benchmark dataset, harness, agent, prompting/edit format, effort, trials, and workload when applicable;
- confidence and license/redistribution status.

Missing evidence is unknown and reduces confidence; it is never converted to a zero score. Scores from incompatible dataset revisions, harnesses, agents, workloads, or effort settings are not merged.

## Freshness and failure

Mutable availability is short-lived, operational observations refresh hourly, price/capability metadata refreshes daily, and immutable benchmark runs do not expire. OpenRouter p50 operational evidence is stored as server-side rank because the Models API exposes ordering but not fabricated latency/throughput values. Fetches and retained observations are bounded. Schema drift or refresh failure preserves the last valid snapshot, marks its freshness honestly, and never replaces it with partially parsed data.

Raw evidence with unknown or restrictive redistribution terms is not republished. Derived facts retain their citation and terms.

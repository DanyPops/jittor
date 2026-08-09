# Compaction effectiveness and regrowth

Jittor treats compaction as an observed intervention, not as proof that information was lost or that
provider caching improved. Pi's public compaction lifecycle supplies the mechanism, reason,
completion/abort/retry state, duration, and pre-compaction token estimate. The first subsequent
content-free provider snapshot supplies the post-compaction structural token estimate.

Every pre/post/summary/regrowth token value carries explicit provenance. Current Pi-native summary
and provider-payload structure values are `structural-estimate`; provider-reported request totals
remain separate and authoritative for billing. A completed compaction without a subsequent snapshot
remains a duration observation and does not fabricate effectiveness.

`compaction-effectiveness` records the reduction ratio, pre/post token sizes, mechanism
(`pi-native`, `provider-side`, or `extension`), provider/model, and summary size. Regrowth emits each
50%, 80%, and 100% milestone once with turns and elapsed time. Interval attributes also retain only
bounded counts for tool classes, retries/failures, cache reads/writes, and explicit accepted/rejected
outcomes. Tool arguments, results, commands, paths, prompts, responses, and summaries are never
persisted.

`jittor context` and `/jittor context` aggregate these observations by period and mechanism. Missing
samples remain unknown. Repeated tool-class activity is a content-free proxy only; it is never
labeled waste or information loss without explicit outcome/control evidence.

## External mechanisms

External compactors such as `pi-mega-compact` should emit the same capability inputs through an
extension boundary: call `begin()` with `mechanism: "extension"`, record completion with summary
measurement provenance, and pass the first final provider-request snapshot to
`observeContextSnapshot()`. Provider-side compaction uses `mechanism: "provider-side"`. Core Jittor
has no dependency on either implementation and does not invoke or control a compactor.

Capture and daemon-write failures are isolated from provider delivery. An extension/daemon restart
may leave a completed duration without a correlated post snapshot; Jittor reports the missing
sample rather than correlating across an uncertain lifecycle boundary.

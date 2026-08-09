# Historical Pi usage backfill

Jittor can populate usage and cost charts from Pi's supported v1-v3 JSONL session format. The
import boundary is separate from live extension collection and is local-only: it performs no
network requests and never writes to Pi sessions.

```text
jittor backfill status [--json]
jittor backfill dry-run [--json]
jittor backfill run [--json]
jittor backfill cancel [--json]
```

The source defaults to `$HOME/.pi/agent/sessions`; `JITTOR_PI_SESSIONS_DIR` selects a different
supported Pi session root. Scans are bounded by file count, per-file and total bytes, entries,
records, and elapsed time. A truncated or canceled run reports that state and can safely be resumed
by running it again.

Only assistant, compaction, and branch-summary usage objects are translated. Persisted facts are:
timestamp, provider/model/thinking identity, input/output/cache-read/cache-write tokens,
provider-reported total cost, and a SHA-256 opaque identity derived from the high-entropy session
identity plus entry identity. Prompts, responses, summaries, tool arguments/results, commands,
paths, session names, credentials, and raw session/entry IDs are discarded before the daemon store
boundary.

Each opaque identity is claimed in the same SQLite transaction as its five usage/cost observations.
Repeated, concurrent, moved-directory, and restart imports are therefore idempotent. A matching
live observation at the same provider/model/timestamp and values is recognized before insertion,
so imported history does not double-count live collection. Imported rows retain `imported: true`;
they otherwise use the same `pi` source, provider/model scope, metric names, and provider-reported
token provenance as live rows, so existing charts work without a second query path.

Import status and the last bounded cursor/progress result survive daemon restart. A stale `running`
flag is never trusted after restart. Database recreation intentionally loses both metrics and import
identities; rerunning the import repopulates the new database deterministically.

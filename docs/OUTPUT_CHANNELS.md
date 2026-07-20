# Output-channel contracts

Jittor does **not** register model-callable Pi tools. Pi's native `AgentToolResult.content` and `AgentToolResult.details` split is therefore explicitly **not applicable** to the current Jittor extension. Jittor contributes commands, panels, a footer, lifecycle hooks, and authenticated daemon operations only.

`test/output-channels.test.ts` enforces this classification. Adding any `registerTool(...)` call requires a new versioned, bounded model-content and renderer-details contract before release.

## Independent channels

| Channel | Consumer | Contract |
|---|---|---|
| Daemon operation JSON | authenticated clients | Typed operation DTOs. Requests are capped at 1 MiB; serialized responses are capped at 4 MiB. Oversized responses fail with `{ "error": "response too large" }`. |
| CLI `--json` | scripts and agents | Stable daemon DTO JSON. It does not contain human labels or parse TUI output. |
| Human CLI output | terminal users | Purpose-built presenters such as `formatContextAssessment`; never parsed to recover machine state. |
| `/jittor` command notifications | Pi users outside an interactive panel | Bounded textual projections of the same application state. |
| Interactive panels | Pi TUI | Width-aware themed views with bounded telemetry rows and usage-series legends. Panels consume daemon DTOs, not CLI text. |
| Integrated footer | Pi TUI | One width-bounded informational line. It remains independent from routing enforcement. |
| Lifecycle/event hooks | Pi runtime | Typed control and telemetry events; they are not presentation output. |

## Data safety

- Metric identity fields and serialized attributes are bounded at ingress.
- Credential-shaped attribute keys are rejected before persistence.
- Provider adapters retain normalized telemetry only; raw OAuth tokens, API keys, response bodies, prompts, and project paths are excluded.
- Human panels omit provider error payloads and sanitize external identity fields before rendering.
- Status panels show at most 20 telemetry sources.
- Usage panels show at most 20 provider/model legend rows and explicitly report omitted series.
- Existing metric queries retain their row limits; the daemon response-byte cap is an independent final boundary.

## Failure semantics

Daemon operations return stable HTTP/JSON errors. The CLI maps operation failures to stderr and a non-zero exit code. Command and TUI adapters present actionable human messages without converting failures into machine-success DTOs. Since there are no native tools, native Pi tool-error rendering is not part of Jittor's current surface.

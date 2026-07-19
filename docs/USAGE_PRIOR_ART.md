# Token-usage TUI prior art

Research performed before implementing Jittor's `/usage` frontend.

## Local agent implementations

### Claude Code

`~/Repositories/claude/src/components/Stats.tsx` contains the strongest terminal chart precedent:

- `generateTokenChart()` renders daily model-token series with an eight-row `asciichart` plot.
- Width adapts to the terminal and is capped near 52 columns.
- The top three models receive distinct theme colors.
- The X axis places three or four date labels at even positions.
- The Y axis abbreviates values as `k` and `M`.

`~/Repositories/claude/src/utils/heatmap.ts` adds a GitHub-style activity view using percentile-derived `░▒▓█` intensity. `src/components/design-system/ProgressBar.tsx` uses eighth-cell Unicode blocks (`▏▎▍▌▋▊▉█`) for fractional precision.

Useful decisions: adaptive width, short axes, bounded series count, theme colors, Unicode partial cells. The Jittor requirement is a histogram rather than Claude's line chart, so only the layout and scaling ideas are reused.

### OpenCode

`~/Repositories/opencode/packages/stats/core/src/domain/home.ts` keeps usage projection in the domain layer. It defines explicit ranges (`1D`, `1W`, `2W`, `1M`, `2M`, `3M`, `YTD`, `ALL`), computes date windows, creates deterministic buckets, and formats range-appropriate labels.

Useful decision: range/window/bucket projection is separate from rendering and data access.

### Codex

`~/Repositories/codex` exposes turn-level `last` and `total` token usage plus account rate-limit snapshots. Its TUI focuses on compact totals and quota state; no reusable historical token histogram was found.

Useful decision: finalized turn usage is the durable accounting point. Jittor already records Pi assistant usage on `message_end`.

### Cline

Cline tracks accumulated input/output/cache/cost values and presents context/cost in its status area. Its local CLI sources did not contain a historical terminal histogram comparable to the requested chart.

Useful decision: preserve input, output, cache-read, and cache-write categories rather than collapsing accounting at ingestion.

## Pi extensions

Registry and package-source review covered:

- `@pi-vault/pi-usage@0.6.0`: polished framed/tabbed dashboard, Today/This Week/Last Week/All Time tables, live provider quotas, width-safe theme adapters. It has no historical vertical token histogram.
- `@sreetej510/pi-usage@0.1.20`: `/usage` provider quota reports, cache, retries, statusline, and 20-cell `█░` quota bars.
- `@narumitw/pi-codex-usage@0.20.0`: Codex 5-hour/weekly quota bars and compact statusline.
- `@alexanderfortin/pi-token-usage@0.3.0`: session-file aggregation and table/export overlay, but no chart.

Useful decisions: native `registerCommand`, `ctx.ui.custom`, width-bounded rendering, theme-derived colors, keyboard refresh/range navigation, and daemon/cache-backed data rather than synchronous file scans in render.

## OpenRouter visual reference

OpenRouter's authenticated web dashboard is not distributed as reusable terminal source. Its relevant visual grammar is a compact time-bucket histogram with colored model/provider series, readable axes, totals, and a legend. Jittor reproduces that grammar with Unicode blocks rather than copying web implementation details.

## Jittor design

Jittor combines the best applicable patterns:

1. Pure domain projection in `src/domain/usage.ts`.
2. Explicit `24h`, `7d`, `30d`, and `90d` windows.
3. Provider/model-preserving series and input/output/cache totals.
4. Vertically scaled, colored, stacked Unicode bars with fractional top blocks.
5. Width-safe X/Y axes and provider/model legend.
6. Native `/usage` panel with Left/Right range switching and refresh.
7. Data access only through authenticated daemon `metrics.query`; the extension never opens SQLite or reads provider credentials.

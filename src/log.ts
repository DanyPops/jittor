/**
 * Structured daemon logging, now backed by `@danypops/daemon-kit/logging` (pino) instead of a
 * hand-rolled `console.error(JSON.stringify(...))` -- daemon-kit's own module doc explains why:
 * level ordering/filtering/child-scoping is exactly the kind of thing worth one shared,
 * dependency-backed implementation instead of four independent hand-rolled ones. One deliberate,
 * disclosed shape change from jittor's old bespoke format: the event name is now pino's `msg`
 * field rather than a separate `event` field, matching daemon-kit's shared convention across all
 * four daemons. `component`/`level`/`timestamp` and credential-safety (callers still must pass
 * only bounded, non-sensitive fields) are unchanged.
 */
import { createLogger, type LogLevel as DaemonKitLogLevel, type Logger } from "@danypops/daemon-kit/logging";

export type LogLevel = Extract<DaemonKitLogLevel, "info" | "warn" | "error">;

/**
 * Also passed directly as `StartDaemonOptions.logger` so daemon-kit's own maintenance-task
 * failure logging shares this same sink/shape. `destination` is pinned to `console.error` rather
 * than daemon-kit's own default (a raw fd 2 write via `pino.destination(2)`, which bypasses
 * `console.error` entirely) so existing tooling/tests that intercept `console.error` keep working.
 */
export const logger: Logger = createLogger("jittor-daemon", {
	destination: { write: (chunk: string) => { console.error(chunk.replace(/\n$/, "")); return true; } },
});

/** Credential-safe structured daemon event. Callers must pass bounded, non-sensitive fields. */
export function logEvent(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
	logger[level](event, fields);
}

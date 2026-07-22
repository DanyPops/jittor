/**
 * Minimal structured daemon logging, matching papyrus/src/log.ts's shape.
 * Exists because the periodic maintenance/poll timers fired off
 * `void somePromise()` with no .catch at all -- a rejection there is an
 * unhandled promise rejection, which Bun does not swallow silently: it
 * crashes the process. Verified directly (`process.on("unhandledRejection")`
 * never even ran; Bun printed the error and exited).
 */
export type LogLevel = "info" | "warn" | "error";

/** Credential-safe structured daemon event. Callers must pass bounded, non-sensitive fields. */
export function logEvent(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
	console.error(JSON.stringify({ timestamp: new Date().toISOString(), level, component: "jittor-daemon", event, ...fields }));
}

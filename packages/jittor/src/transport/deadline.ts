export interface DeadlineOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
}

export const TELEMETRY_REQUEST_TIMEOUT_MS = 10_000;

/** Bounds the whole operation (including response bodies), even for a transport that ignores abort. */
export async function withDeadline<T>(
	run: (signal: AbortSignal) => Promise<T>,
	{ signal: parent, timeoutMs = TELEMETRY_REQUEST_TIMEOUT_MS }: DeadlineOptions = {},
): Promise<T> {
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("deadline must be a positive finite duration");
	const controller = new AbortController();
	const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
	signal.throwIfAborted();
	const timer = setTimeout(() => controller.abort(new DOMException("Jittor request timed out", "TimeoutError")), timeoutMs);
	timer.unref?.();
	let onAbort: () => void = () => {};
	const aborted = new Promise<never>((_resolve, reject) => {
		onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([
			Promise.resolve().then(() => {
				signal.throwIfAborted();
				return run(signal);
			}),
			aborted,
		]);
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", onAbort);
	}
}

import {
	CODEX_ERROR_MESSAGE_LIMIT,
	CODEX_RETRY_AFTER_MAX_MS,
	MILLISECONDS_PER_SECOND,
} from "../constants.ts";

export type CodexFailureKind =
	| "concurrency"
	| "rate-limit"
	| "overload"
	| "transport"
	| "quota"
	| "authentication"
	| "invalid-request"
	| "unknown";

export interface CodexFailure {
	kind: CodexFailureKind;
	transient: boolean;
	code?: string;
	source?: string;
	message?: string;
	retryAfterMs?: number;
}

export interface CodexFailureMetadata {
	status?: number;
	retryAfter?: string;
}

export interface CodexRecoveryOptions {
	baseDelayMs: number;
	maxDelayMs: number;
	maxAttempts: number;
	attemptWindowMs: number;
	jitterRatio: number;
}

export type CodexRecoveryPlan =
	| { action: "schedule"; attempt: number; delayMs: number; failureKind: CodexFailureKind }
	| { action: "wait"; reason: string }
	| { action: "exhausted"; reason: string };

export interface CodexRecoveryAttempt {
	attempt: number;
	failureKind: CodexFailureKind;
}

export class CodexRecoveryPolicy {
	private pendingFailure: CodexFailure | undefined;
	private attempts = 0;
	private windowStartedAt: number | undefined;
	private lastFailureKind: CodexFailureKind | undefined;

	constructor(
		private readonly options: CodexRecoveryOptions,
		private readonly random: () => number = Math.random,
	) {
		if (!Number.isFinite(options.baseDelayMs) || options.baseDelayMs < 0) throw new Error("baseDelayMs must be non-negative");
		if (!Number.isFinite(options.maxDelayMs) || options.maxDelayMs < options.baseDelayMs) throw new Error("maxDelayMs must be at least baseDelayMs");
		if (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1) throw new Error("maxAttempts must be a positive integer");
		if (!Number.isFinite(options.attemptWindowMs) || options.attemptWindowMs <= 0) throw new Error("attemptWindowMs must be positive");
		if (!Number.isFinite(options.jitterRatio) || options.jitterRatio < 0 || options.jitterRatio > 1) throw new Error("jitterRatio must be between 0 and 1");
	}

	observeFailure(failure: CodexFailure, now: number): void {
		this.normalizeWindow(now);
		this.pendingFailure = failure.transient ? failure : undefined;
		this.lastFailureKind = failure.transient ? failure.kind : undefined;
	}

	observeSuccess(): void {
		this.cancel();
	}

	cancel(): void {
		this.pendingFailure = undefined;
		this.attempts = 0;
		this.windowStartedAt = undefined;
		this.lastFailureKind = undefined;
	}

	abandonFailure(): void {
		this.pendingFailure = undefined;
	}

	plan(now: number): CodexRecoveryPlan {
		this.normalizeWindow(now);
		if (!this.pendingFailure) return { action: "wait", reason: "no transient Codex failure is pending" };
		if (this.attempts >= this.options.maxAttempts) {
			return { action: "exhausted", reason: `${this.options.maxAttempts} recovery attempts reached within ${this.options.attemptWindowMs}ms` };
		}
		const base = this.pendingFailure.retryAfterMs
			?? this.options.baseDelayMs * (2 ** this.attempts);
		const sample = this.random();
		const unit = Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : 0;
		const multiplier = 1 + ((unit * 2) - 1) * this.options.jitterRatio;
		const jittered = Math.max(0, Math.round(base * multiplier));
		const delayMs = this.pendingFailure.retryAfterMs === undefined ? jittered : Math.max(base, jittered);
		return {
			action: "schedule",
			attempt: this.attempts + 1,
			delayMs: Math.min(this.options.maxDelayMs, delayMs),
			failureKind: this.pendingFailure.kind,
		};
	}

	recordAttempt(now: number): CodexRecoveryAttempt | undefined {
		this.normalizeWindow(now);
		if (!this.pendingFailure || this.attempts >= this.options.maxAttempts) return undefined;
		if (this.windowStartedAt === undefined) this.windowStartedAt = now;
		this.attempts += 1;
		const attempt = { attempt: this.attempts, failureKind: this.pendingFailure.kind };
		this.pendingFailure = undefined;
		return attempt;
	}

	state(now?: number): { attempts: number; pending: boolean; lastFailureKind?: CodexFailureKind; windowStartedAt?: number } {
		if (now !== undefined) this.normalizeWindow(now);
		return {
			attempts: this.attempts,
			pending: this.pendingFailure !== undefined,
			...(this.lastFailureKind ? { lastFailureKind: this.lastFailureKind } : {}),
			...(this.windowStartedAt !== undefined ? { windowStartedAt: this.windowStartedAt } : {}),
		};
	}

	private normalizeWindow(now: number): void {
		if (this.windowStartedAt !== undefined && now - this.windowStartedAt >= this.options.attemptWindowMs) {
			this.attempts = 0;
			this.windowStartedAt = undefined;
			if (!this.pendingFailure) this.lastFailureKind = undefined;
		}
	}
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function firstString(...values: unknown[]): string | undefined {
	for (const value of values) {
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

function retryAfterMs(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const seconds = Number(value.trim());
	if (!Number.isFinite(seconds) || seconds < 0) return undefined;
	return Math.min(CODEX_RETRY_AFTER_MAX_MS, Math.round(seconds * MILLISECONDS_PER_SECOND));
}

function matches(value: string, patterns: readonly string[]): boolean {
	return patterns.some((pattern) => value.includes(pattern));
}

export function classifyCodexFailure(value: unknown, metadata: CodexFailureMetadata = {}): CodexFailure {
	const root = asRecord(value);
	const detail = asRecord(root?.["detail"]);
	const nestedError = asRecord(root?.["error"]);
	const code = firstString(detail?.["code"], detail?.["error_code"], nestedError?.["code"], root?.["code"]);
	const source = firstString(detail?.["source"], nestedError?.["source"], root?.["source"]);
	const rawMessage = firstString(
		detail?.["message"],
		typeof root?.["error"] === "string" ? root["error"] : undefined,
		nestedError?.["message"],
		root?.["message"],
		typeof value === "string" ? value : undefined,
	);
	const message = rawMessage?.slice(0, CODEX_ERROR_MESSAGE_LIMIT);
	const evidence = [code, source, message].filter(Boolean).join(" ").toLowerCase();
	const base = {
		...(code ? { code } : {}),
		...(source ? { source } : {}),
		...(message ? { message } : {}),
		...(retryAfterMs(metadata.retryAfter) !== undefined ? { retryAfterMs: retryAfterMs(metadata.retryAfter) } : {}),
	};

	if (matches(evidence, ["insufficient_quota", "quota exceeded", "out of credits", "billing"])) {
		return { kind: "quota", transient: false, ...base };
	}
	if (metadata.status === 401 || metadata.status === 403 || matches(evidence, ["invalid_api_key", "authentication", "unauthorized", "permission_denied"])) {
		return { kind: "authentication", transient: false, ...base };
	}
	if (matches(evidence, ["invalid_prompt", "invalid_request", "context_length_exceeded"]) || metadata.status === 400 || metadata.status === 422) {
		return { kind: "invalid-request", transient: false, ...base };
	}
	if (matches(evidence, ["concurrency_limit", "too many concurrent requests", "throttled"])) {
		return { kind: "concurrency", transient: true, ...base };
	}
	if (matches(evidence, ["server_is_overloaded", "slow_down", "service unavailable", "overloaded"]) || (metadata.status !== undefined && metadata.status >= 500 && metadata.status <= 599)) {
		return { kind: "overload", transient: true, ...base };
	}
	if (metadata.status === 429 || matches(evidence, ["rate_limit_exceeded", "rate limit", "too many requests"])) {
		return { kind: "rate-limit", transient: true, ...base };
	}
	if (matches(evidence, ["timeout", "timed out", "network", "connection", "websocket", "fetch failed"])) {
		return { kind: "transport", transient: true, ...base };
	}
	return { kind: "unknown", transient: false, ...base };
}

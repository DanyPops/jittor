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

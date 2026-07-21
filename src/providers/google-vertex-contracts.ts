import type { MetricObservation } from "../domain/metric.ts";
import { MILLISECONDS_PER_MINUTE, MILLISECONDS_PER_SECOND } from "../constants.ts";

/**
 * Google Vertex AI has no documented per-response rate-limit or remaining-quota header, and no
 * personal polling endpoint Jittor could daemon-poll: quota lives in AWS/GCP-style account-level
 * Service Usage configuration, and errors surface as a `google.rpc.Status` shape
 * (`{error: {code, message, status, details[]}}`, `status` one of the canonical gRPC codes such as
 * `RESOURCE_EXHAUSTED`, `PERMISSION_DENIED`, `UNAVAILABLE`) rather than a header Jittor can read
 * before a request fails (verified against Google Cloud/Gemini API error reports fetched
 * 2026-07-21; no `x-goog-quota-*` or equivalent response header is documented for Vertex
 * generateContent). Jittor therefore does not fabricate a remaining-budget bar for this provider.
 * What it can honestly observe is classified failure pressure: how often and what kind of
 * capacity/auth/request failures Pi is seeing, from the same bounded, content-free
 * `errorMessage` string Pi already exposes for every provider (see classifyCodexFailure for the
 * established pattern this mirrors).
 */
export type GoogleVertexFailureKind =
	| "quota"
	| "authentication"
	| "invalid-request"
	| "overload"
	| "transport"
	| "unknown";

export interface GoogleVertexFailure {
	kind: GoogleVertexFailureKind;
	transient: boolean;
	status?: string;
	code?: number;
	message?: string;
	retryAfterMs?: number;
}

export interface GoogleVertexFailureMetadata {
	status?: number;
	retryAfter?: string;
}

const GOOGLE_VERTEX_ERROR_MESSAGE_LIMIT = 160;
const GOOGLE_VERTEX_RETRY_AFTER_MAX_MS = 5 * MILLISECONDS_PER_MINUTE;

function matches(value: string, patterns: readonly string[]): boolean {
	return patterns.some((pattern) => value.includes(pattern));
}

function retryAfterMs(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const seconds = Number(value.trim().replace(/s$/i, ""));
	if (!Number.isFinite(seconds) || seconds < 0) return undefined;
	return Math.min(GOOGLE_VERTEX_RETRY_AFTER_MAX_MS, Math.round(seconds * MILLISECONDS_PER_SECOND));
}

/** Extracts a `google.rpc.RetryInfo.retryDelay` (e.g. `"16s"`) if the stringified error embeds one. */
function embeddedRetryDelay(evidence: string): string | undefined {
	const match = evidence.match(/"retrydelay"\s*:\s*"(\d+(?:\.\d+)?s)"/);
	return match?.[1];
}

export function classifyGoogleVertexFailure(value: unknown, metadata: GoogleVertexFailureMetadata = {}): GoogleVertexFailure {
	const rawMessage = typeof value === "string" ? value : undefined;
	const message = rawMessage?.slice(0, GOOGLE_VERTEX_ERROR_MESSAGE_LIMIT);
	const evidence = (rawMessage ?? "").toLowerCase();
	const retry = retryAfterMs(metadata.retryAfter) ?? retryAfterMs(embeddedRetryDelay(evidence));
	const base = {
		...(message ? { message } : {}),
		...(metadata.status !== undefined ? { code: metadata.status } : {}),
		...(retry !== undefined ? { retryAfterMs: retry } : {}),
	};

	if (matches(evidence, ["resource_exhausted", "quota"]) || metadata.status === 429) {
		return { kind: "quota", transient: true, status: "RESOURCE_EXHAUSTED", ...base };
	}
	if (matches(evidence, ["unauthenticated", "permission_denied"]) || metadata.status === 401 || metadata.status === 403) {
		return { kind: "authentication", transient: false, status: matches(evidence, ["unauthenticated"]) ? "UNAUTHENTICATED" : "PERMISSION_DENIED", ...base };
	}
	if (matches(evidence, ["invalid_argument", "failed_precondition", "out_of_range"]) || metadata.status === 400 || metadata.status === 422) {
		return { kind: "invalid-request", transient: false, status: "INVALID_ARGUMENT", ...base };
	}
	if (matches(evidence, ["unavailable", "internal", "aborted"]) || (metadata.status !== undefined && metadata.status >= 500 && metadata.status <= 599)) {
		return { kind: "overload", transient: true, status: "UNAVAILABLE", ...base };
	}
	if (matches(evidence, ["deadline_exceeded", "timeout", "timed out", "network", "connection", "fetch failed", "cancelled"])) {
		return { kind: "transport", transient: true, status: "DEADLINE_EXCEEDED", ...base };
	}
	return { kind: "unknown", transient: false, ...base };
}

/** A bounded failure-count observation; never a fabricated remaining-budget fraction. */
export function googleVertexFailureMetrics(failure: GoogleVertexFailure, observedAt: number): MetricObservation[] {
	return [{
		source: "google-vertex",
		scope: "failure",
		metric: failure.kind,
		value: 1,
		unit: "count",
		observedAt,
		attributes: {
			transient: failure.transient,
			...(failure.status ? { status: failure.status } : {}),
			...(failure.code !== undefined ? { code: failure.code } : {}),
		},
	}];
}

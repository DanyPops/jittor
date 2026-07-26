import { describe, expect, it } from "bun:test";
import { classifyGoogleVertexFailure, googleVertexFailureMetrics } from "../src/providers/google-vertex-contracts.ts";

describe("Google Vertex failure classification", () => {
	it("classifies canonical google.rpc.Status codes embedded in the bounded error message", () => {
		expect(classifyGoogleVertexFailure("429 RESOURCE_EXHAUSTED. Quota exceeded for quota metric", { status: 429 }))
			.toMatchObject({ kind: "quota", transient: true, status: "RESOURCE_EXHAUSTED" });
		expect(classifyGoogleVertexFailure("401 UNAUTHENTICATED. API keys are not supported", { status: 401 }))
			.toMatchObject({ kind: "authentication", transient: false, status: "UNAUTHENTICATED" });
		expect(classifyGoogleVertexFailure("403 PERMISSION_DENIED", { status: 403 }))
			.toMatchObject({ kind: "authentication", transient: false, status: "PERMISSION_DENIED" });
		expect(classifyGoogleVertexFailure("400 INVALID_ARGUMENT: request payload size", { status: 400 }))
			.toMatchObject({ kind: "invalid-request", transient: false, status: "INVALID_ARGUMENT" });
		expect(classifyGoogleVertexFailure("503 UNAVAILABLE. The service is currently unavailable", { status: 503 }))
			.toMatchObject({ kind: "overload", transient: true, status: "UNAVAILABLE" });
		expect(classifyGoogleVertexFailure("DEADLINE_EXCEEDED: request timed out"))
			.toMatchObject({ kind: "transport", transient: true, status: "DEADLINE_EXCEEDED" });
	});

	it("falls back to bare HTTP status when the message has no recognizable status keyword", () => {
		expect(classifyGoogleVertexFailure("something went wrong", { status: 429 })).toMatchObject({ kind: "quota", transient: true });
		expect(classifyGoogleVertexFailure("something went wrong", { status: 500 })).toMatchObject({ kind: "overload", transient: true });
		expect(classifyGoogleVertexFailure(undefined)).toEqual({ kind: "unknown", transient: false });
	});

	it("extracts an embedded google.rpc.RetryInfo retryDelay without retaining the rest of the payload", () => {
		const failure = classifyGoogleVertexFailure(
			'429 RESOURCE_EXHAUSTED {"error":{"details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"16s"}]}}',
			{ status: 429 },
		);
		expect(failure).toMatchObject({ kind: "quota", transient: true, retryAfterMs: 16_000 });
		expect(failure.message?.length).toBeLessThanOrEqual(160);
	});

	it("prefers an explicit metadata retry-after header over an embedded retryDelay", () => {
		const failure = classifyGoogleVertexFailure("429 RESOURCE_EXHAUSTED", { status: 429, retryAfter: "5" });
		expect(failure.retryAfterMs).toBe(5_000);
	});

	it("emits a bounded failure-count metric, never a fabricated remaining-budget fraction", () => {
		const failure = classifyGoogleVertexFailure("429 RESOURCE_EXHAUSTED", { status: 429 });
		const metrics = googleVertexFailureMetrics(failure, 1_700_000_000_000);
		expect(metrics).toEqual([{
			source: "google-vertex", scope: "failure", metric: "quota", value: 1, unit: "count", observedAt: 1_700_000_000_000,
			attributes: { transient: true, status: "RESOURCE_EXHAUSTED", code: 429 },
		}]);
		expect(metrics.some((metric) => metric.unit === "ratio")).toBe(false);
	});

	it("tags the failure-count metric with the given source, so anthropic-vertex and google-vertex never blend", () => {
		const failure = classifyGoogleVertexFailure("429 RESOURCE_EXHAUSTED", { status: 429 });
		const metrics = googleVertexFailureMetrics(failure, 1_700_000_000_000, "anthropic-vertex");
		expect(metrics).toEqual([{
			source: "anthropic-vertex", scope: "failure", metric: "quota", value: 1, unit: "count", observedAt: 1_700_000_000_000,
			attributes: { transient: true, status: "RESOURCE_EXHAUSTED", code: 429 },
		}]);
	});
});

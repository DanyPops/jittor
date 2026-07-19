import { describe, expect, it } from "bun:test";
import { classifyCodexFailure } from "../src/domain/codex-recovery.ts";

describe("Codex failure classification", () => {
	it("recognizes the structured concurrency throttle without retaining the raw payload", () => {
		const failure = classifyCodexFailure({
			error: "Too many concurrent requests",
			detail: {
				code: "throttled",
				error_code: "throttled",
				message: "Too many concurrent requests",
				type: "throttled",
				source: "concurrency_limit",
			},
		});

		expect(failure).toEqual({
			kind: "concurrency",
			transient: true,
			code: "throttled",
			source: "concurrency_limit",
			message: "Too many concurrent requests",
		});
		expect(JSON.stringify(failure)).not.toContain("error_code");
	});

	it("separates retryable rate and overload errors from terminal quota and auth errors", () => {
		expect(classifyCodexFailure({ error: { code: "rate_limit_exceeded", message: "try again" } }, { status: 429 })).toMatchObject({ kind: "rate-limit", transient: true });
		expect(classifyCodexFailure({ error: { code: "server_is_overloaded" } }, { status: 503 })).toMatchObject({ kind: "overload", transient: true });
		expect(classifyCodexFailure({ error: { code: "insufficient_quota" } }, { status: 429 })).toMatchObject({ kind: "quota", transient: false });
		expect(classifyCodexFailure({ error: { code: "invalid_api_key" } }, { status: 401 })).toMatchObject({ kind: "authentication", transient: false });
		expect(classifyCodexFailure({ error: { code: "invalid_prompt" } }, { status: 400 })).toMatchObject({ kind: "invalid-request", transient: false });
	});

	it("parses bounded Retry-After values and treats malformed payloads as unknown", () => {
		expect(classifyCodexFailure("timeout", { retryAfter: "12" })).toMatchObject({ kind: "transport", transient: true, retryAfterMs: 12_000 });
		expect(classifyCodexFailure(null, { retryAfter: "999999" })).toEqual({ kind: "unknown", transient: false, retryAfterMs: 300_000 });
		expect(classifyCodexFailure({ detail: { message: 42 } })).toEqual({ kind: "unknown", transient: false });
	});
});

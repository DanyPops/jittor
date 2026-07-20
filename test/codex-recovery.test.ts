import { describe, expect, it } from "bun:test";
import { CodexRecoveryPolicy, classifyCodexFailure } from "../src/domain/codex-recovery.ts";

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

describe("Codex settled-turn recovery policy", () => {
	const options = {
		baseDelayMs: 2_000,
		maxDelayMs: 300_000,
		maxAttempts: 3,
		attemptWindowMs: 600_000,
		jitterRatio: 0.2,
	};

	it("honors Retry-After, applies bounded jitter, and keeps one pending failure", () => {
		const policy = new CodexRecoveryPolicy(options, () => 0.5);
		policy.observeFailure({ kind: "concurrency", transient: true, retryAfterMs: 12_000 }, 1_000);
		policy.observeFailure({ kind: "concurrency", transient: true, retryAfterMs: 12_000 }, 1_100);

		expect(policy.plan(1_100)).toEqual({ action: "schedule", attempt: 1, delayMs: 12_000, failureKind: "concurrency" });
		expect(policy.recordAttempt(13_100)).toEqual({ attempt: 1, failureKind: "concurrency" });
		expect(policy.plan(13_100)).toEqual({ action: "wait", reason: "no transient Codex failure is pending" });

		const lowJitter = new CodexRecoveryPolicy(options, () => 0);
		lowJitter.observeFailure({ kind: "rate-limit", transient: true, retryAfterMs: 12_000 }, 0);
		expect(lowJitter.plan(0)).toMatchObject({ delayMs: 12_000 });

		const highJitter = new CodexRecoveryPolicy(options, () => 1);
		highJitter.observeFailure({ kind: "overload", transient: true, retryAfterMs: 299_000 }, 0);
		expect(highJitter.plan(0)).toEqual({ action: "schedule", attempt: 1, delayMs: 300_000, failureKind: "overload" });
	});

	it("enforces attempt and window ceilings, then resets after success or expiry", () => {
		const policy = new CodexRecoveryPolicy(options, () => 0.5);
		for (let attempt = 1; attempt <= 3; attempt++) {
			policy.observeFailure({ kind: "transport", transient: true }, attempt * 1_000);
			expect(policy.plan(attempt * 1_000)).toMatchObject({ action: "schedule", attempt });
			policy.recordAttempt(attempt * 1_000);
		}
		policy.observeFailure({ kind: "transport", transient: true }, 4_000);
		expect(policy.plan(4_000)).toEqual({ action: "exhausted", reason: "3 recovery attempts reached within 600000ms" });

		policy.observeSuccess();
		expect(policy.state()).toEqual({ attempts: 0, pending: false });
		policy.observeFailure({ kind: "transport", transient: true }, 5_000);
		expect(policy.plan(5_000)).toMatchObject({ action: "schedule", attempt: 1 });
		policy.recordAttempt(5_000);
		policy.observeFailure({ kind: "transport", transient: true }, 605_001);
		expect(policy.plan(605_001)).toMatchObject({ action: "schedule", attempt: 1 });
	});

	it("never schedules terminal, unknown, or canceled failures", () => {
		const policy = new CodexRecoveryPolicy(options, () => 0.5);
		policy.observeFailure({ kind: "quota", transient: false }, 0);
		expect(policy.plan(0)).toEqual({ action: "wait", reason: "no transient Codex failure is pending" });
		policy.observeFailure({ kind: "concurrency", transient: true }, 1);
		policy.cancel();
		expect(policy.plan(1)).toEqual({ action: "wait", reason: "no transient Codex failure is pending" });
	});
});

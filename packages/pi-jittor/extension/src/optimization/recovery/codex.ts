import {
	CODEX_RECOVERY_ATTEMPT_WINDOW_MS,
	CODEX_RECOVERY_BASE_DELAY_MS,
	CODEX_RECOVERY_JITTER_RATIO,
	CODEX_RECOVERY_MAX_ATTEMPTS,
	CODEX_RECOVERY_MAX_DELAY_MS,
	type CodexFailureKind,
	type CodexFailureMetadata,
	CodexRecoveryPolicy,
	classifyCodexFailure,
	MILLISECONDS_PER_MINUTE,
	MILLISECONDS_PER_SECOND,
} from "@danypops/jittor";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { headerValue } from "../../observability/http-headers.ts";
import type { CodexRecoveryControl } from "../../settings.ts";

export interface CodexRecoveryRuntime {
	now(): number;
	random(): number;
	setTimeout(callback: () => void | Promise<void>, delayMs: number): unknown;
	clearTimeout(handle: unknown): void;
}

export const SYSTEM_RECOVERY_RUNTIME: CodexRecoveryRuntime = {
	now: Date.now,
	random: Math.random,
	setTimeout(callback, delayMs) {
		return setTimeout(() => {
			void callback();
		}, delayMs);
	},
	clearTimeout(handle) {
		clearTimeout(handle as ReturnType<typeof setTimeout>);
	},
};

/**
 * Codex's settled-turn hidden-retry recovery, as its own capability: tracks the most recent
 * Codex response (status/retry-after) across the current turn, classifies a finalized failure,
 * and schedules at most one bounded, jittered follow-up once Pi's own turn has genuinely
 * settled. Fully self-contained -- the only external dependencies are Pi's own message-send API,
 * the persisted on/off control, and a runtime the tests can fake (timers, randomness, clock).
 */
export class CodexRecoveryCapability {
	private readonly policy: CodexRecoveryPolicy;
	private lastResponse: CodexFailureMetadata = {};
	private timer: unknown;
	private cooldown: { until: number; attempt: number; failureKind: CodexFailureKind } | undefined;

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly control: CodexRecoveryControl,
		private readonly runtime: CodexRecoveryRuntime,
	) {
		this.policy = new CodexRecoveryPolicy(
			{
				baseDelayMs: CODEX_RECOVERY_BASE_DELAY_MS,
				maxDelayMs: CODEX_RECOVERY_MAX_DELAY_MS,
				maxAttempts: CODEX_RECOVERY_MAX_ATTEMPTS,
				attemptWindowMs: CODEX_RECOVERY_ATTEMPT_WINDOW_MS,
				jitterRatio: CODEX_RECOVERY_JITTER_RATIO,
			},
			runtime.random,
		);
	}

	/** Clears the tracked response at the start of every new turn, before any Codex response for it has arrived. */
	resetTurn(): void {
		this.lastResponse = {};
	}

	notifyResponse(status: number, headers: Record<string, string>): void {
		this.lastResponse = { status, ...(headerValue(headers, "retry-after") ? { retryAfter: headerValue(headers, "retry-after") } : {}) };
	}

	notifyMessageEnd(stopReason: string, errorMessage: string | undefined): void {
		if (stopReason === "error") {
			const failure = classifyCodexFailure(errorMessage, this.lastResponse);
			if (this.control.isCodexRecoveryEnabled() && failure.transient) this.policy.observeFailure(failure, this.runtime.now());
			else this.cancel(true);
		} else if (stopReason !== "aborted") {
			this.cancel(true);
		}
		this.lastResponse = {};
	}

	cancel(resetPolicy: boolean): void {
		if (this.timer !== undefined) this.runtime.clearTimeout(this.timer);
		this.timer = undefined;
		this.cooldown = undefined;
		if (resetPolicy) this.policy.cancel();
	}

	statusText(): string {
		const now = this.runtime.now();
		const state = this.policy.state(now);
		const enabled = this.control.isCodexRecoveryEnabled();
		const attempt = this.cooldown?.attempt ?? (state.pending ? state.attempts + 1 : state.attempts);
		const phase = this.cooldown
			? `cooldown ${Math.ceil(Math.max(0, this.cooldown.until - now) / MILLISECONDS_PER_SECOND)}s`
			: state.pending
				? "pending"
				: state.attempts >= CODEX_RECOVERY_MAX_ATTEMPTS
					? "exhausted"
					: state.attempts > 0
						? "waiting"
						: "idle";
		const failureKind = this.cooldown?.failureKind ?? state.lastFailureKind;
		return [
			`Codex recovery: ${enabled ? "on" : "off"}`,
			phase,
			`attempt ${attempt}/${CODEX_RECOVERY_MAX_ATTEMPTS}`,
			`window ${CODEX_RECOVERY_ATTEMPT_WINDOW_MS / MILLISECONDS_PER_MINUTE}m`,
			...(failureKind ? [failureKind] : []),
		].join(" · ");
	}

	scheduleIfIdle(ctx: ExtensionContext): void {
		if (!this.control.isCodexRecoveryEnabled() || this.timer !== undefined || !ctx.isIdle() || ctx.hasPendingMessages()) return;
		const plan = this.policy.plan(this.runtime.now());
		if (plan.action === "exhausted") {
			this.policy.abandonFailure();
			if (ctx.hasUI) ctx.ui.notify(`Jittor Codex recovery stopped: ${plan.reason}.`, "warning");
			return;
		}
		if (plan.action !== "schedule") return;
		this.cooldown = { until: this.runtime.now() + plan.delayMs, attempt: plan.attempt, failureKind: plan.failureKind };
		this.timer = this.runtime.setTimeout(async () => {
			this.timer = undefined;
			this.cooldown = undefined;
			if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
			const attempt = this.policy.recordAttempt(this.runtime.now());
			if (!attempt) return;
			this.pi.sendMessage(
				{
					customType: "jittor-codex-recovery",
					content: `Retry the previous Codex request after a transient ${attempt.failureKind} failure. Automatic recovery attempt ${attempt.attempt} of ${CODEX_RECOVERY_MAX_ATTEMPTS}.`,
					display: false,
					details: { attempt: attempt.attempt, failureKind: attempt.failureKind },
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		}, plan.delayMs);
	}
}

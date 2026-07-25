import { classifyTaskFromTools, modelRunMetrics, type ModelRunObservation } from "../../../src/domain/model-observation.ts";
import type { MetricObservation } from "../../../src/domain/metric.ts";

export interface ActiveLocalModelRun {
	runId: string;
	startedAt: number;
	firstTokenAt: number | null;
	providerResponses: number;
	toolNames: string[];
	toolCalls: number;
	toolFailures: number;
}

/**
 * Content-free local model observations derived only from Pi's public lifecycle: TTFT, wall
 * latency, tool-loop counts and failures, and a bounded tool-name list used only to derive
 * domain/type classification -- never prompts, responses, tool arguments/results, or project
 * paths. Owns the one in-flight run plus the most recently completed one (for `/jittor outcome`).
 */
export class LocalRunTelemetry {
	private active: ActiveLocalModelRun | undefined;
	private lastCompleted: ModelRunObservation | undefined;
	private sequence = 0;

	beginTurn(timestamp: number): void {
		this.active = {
			runId: `local-${timestamp}-${++this.sequence}`,
			startedAt: timestamp,
			firstTokenAt: null,
			providerResponses: 0,
			toolNames: [],
			toolCalls: 0,
			toolFailures: 0,
		};
	}

	discardTurn(): void {
		this.active = undefined;
	}

	onMessageUpdate(assistantMessageEventType: string): void {
		if (!this.active || this.active.firstTokenAt !== null) return;
		if (["text_delta", "thinking_delta", "toolcall_delta"].includes(assistantMessageEventType)) this.active.firstTokenAt = Date.now();
	}

	onToolExecutionEnd(toolName: string, isError: boolean): void {
		if (!this.active) return;
		this.active.toolCalls += 1;
		if (isError) this.active.toolFailures += 1;
		if (this.active.toolNames.length < 100) this.active.toolNames.push(toolName);
	}

	onProviderResponse(): void {
		if (this.active) this.active.providerResponses += 1;
	}

	/** Finalizes the active run against a completed assistant turn_end message, returning metrics to record (empty if the message shape doesn't match a completed assistant turn). */
	completeTurn(message: unknown, thinkingLevel: string): MetricObservation[] {
		const active = this.active;
		this.active = undefined;
		if (!active || typeof message !== "object" || message === null || Array.isArray(message)) return [];
		const value = message as Record<string, unknown>;
		if (value["role"] !== "assistant" || typeof value["provider"] !== "string" || typeof value["model"] !== "string") return [];
		const usage = typeof value["usage"] === "object" && value["usage"] !== null ? value["usage"] as Record<string, unknown> : {};
		const amount = (name: string): number => typeof usage[name] === "number" && Number.isFinite(usage[name]) ? usage[name] as number : 0;
		const cost = typeof usage["cost"] === "object" && usage["cost"] !== null && typeof (usage["cost"] as Record<string, unknown>)["total"] === "number"
			? (usage["cost"] as Record<string, number>)["total"] ?? 0 : 0;
		const stopReason = ["stop", "length", "toolUse", "error", "aborted"].includes(String(value["stopReason"]))
			? value["stopReason"] as ModelRunObservation["stopReason"] : "unknown";
		const completedAt = Math.max(Date.now(), active.firstTokenAt ?? active.startedAt, active.startedAt);
		this.lastCompleted = {
			runId: active.runId,
			provider: value["provider"],
			model: value["model"],
			thinking: thinkingLevel,
			...classifyTaskFromTools(active.toolNames),
			startedAt: active.startedAt,
			firstTokenAt: active.firstTokenAt,
			completedAt,
			inputTokens: amount("input"),
			outputTokens: amount("output"),
			cacheReadTokens: amount("cacheRead"),
			cacheWriteTokens: amount("cacheWrite"),
			costUsd: Number.isFinite(cost) && cost >= 0 ? cost : 0,
			providerResponses: Math.max(1, active.providerResponses),
			toolCalls: active.toolCalls,
			toolFailures: active.toolFailures,
			stopReason,
			explicitOutcome: "unknown",
		};
		return modelRunMetrics(this.lastCompleted);
	}

	/** Builds the single outcome-accepted/outcome-accepted=0 metric for the most recently completed run, or null if none exists yet. */
	explicitOutcomeMetric(explicitOutcome: "accepted" | "rejected"): MetricObservation | null {
		if (!this.lastCompleted) return null;
		return modelRunMetrics({ ...this.lastCompleted, explicitOutcome }).find((metric) => metric.metric === "outcome-accepted") ?? null;
	}

	reset(): void {
		this.active = undefined;
		this.lastCompleted = undefined;
	}
}

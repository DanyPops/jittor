import type { BudgetWindow } from "../policy.ts";
import type { TelemetryBatch, TelemetrySource } from "../ports/telemetry-source.ts";
import { CodexSubscriptionTelemetryAdapter, loadCodexFileCredentials, type CodexRateLimitSnapshot, type CodexWindow, type CodexTransport } from "./codex.ts";
import { OpenRouterTelemetryAdapter, type OpenRouterTransport } from "./openrouter.ts";

function budgetWindow(
	limit: CodexRateLimitSnapshot,
	name: "primary" | "secondary",
	window: CodexWindow | null,
): BudgetWindow | null {
	if (!window || window.windowSeconds === null || window.resetsAt === null) return null;
	return {
		id: `${limit.limitId}:${name}@${limit.observedAt}`,
		source: "codex-subscription",
		scope: limit.limitId === "codex" ? `codex:${name}` : `${limit.limitId}:${name}`,
		usedFraction: window.usedPercent / 100,
		windowSeconds: window.windowSeconds,
		resetsAt: window.resetsAt * 1_000,
		observedAt: limit.observedAt,
		freshness: "fresh",
		confidence: 0.8,
	};
}

function windowsFromLimit(limit: CodexRateLimitSnapshot): BudgetWindow[] {
	return [budgetWindow(limit, "primary", limit.primary), budgetWindow(limit, "secondary", limit.secondary)]
		.filter((window): window is BudgetWindow => window !== null);
}

export class CodexTelemetrySource implements TelemetrySource {
	readonly id = "codex-subscription";
	readonly provider = "openai-codex";
	readonly required = true;

	constructor(
		private readonly authFile: string,
		private readonly transport: CodexTransport = fetch,
		private readonly clock: () => number = Date.now,
	) {}

	async poll(): Promise<TelemetryBatch> {
		const observedAt = this.clock();
		const adapter = new CodexSubscriptionTelemetryAdapter(loadCodexFileCredentials(this.authFile), this.transport);
		const snapshot = await adapter.readUsage(observedAt);
		return {
			observedAt,
			metrics: snapshot.metrics,
			windows: [snapshot.defaultLimit, ...snapshot.additionalLimits].flatMap(windowsFromLimit),
		};
	}
}

export class OpenRouterTelemetrySource implements TelemetrySource {
	readonly id = "openrouter";
	readonly provider = "openrouter";
	readonly required = false;

	constructor(
		private readonly apiKey: string,
		private readonly transport: OpenRouterTransport = fetch,
		private readonly clock: () => number = Date.now,
	) {}

	async poll(): Promise<TelemetryBatch> {
		const observedAt = this.clock();
		const snapshot = await new OpenRouterTelemetryAdapter(this.apiKey, this.transport).readKey(observedAt);
		return { observedAt, metrics: snapshot.metrics, windows: [] };
	}
}

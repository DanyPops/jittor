import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MetricObservation, StoredMetricObservation } from "../../src/domain/metric.ts";
import type { PolicyDecision, Route } from "../../src/policy.ts";
import type { RouterStatus } from "../../src/ports/router-controller.ts";
import { parseCodexRateLimitHeaders } from "../../src/providers/codex.ts";
import { callJittor } from "./service-client.ts";
import { formatFooterStatus, showJittorPanel } from "./tui.ts";

export { formatFooterStatus } from "./tui.ts";

const STATUS_KEY = "jittor";
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export interface JittorExtensionClient {
	call(operation: string, input: unknown): Promise<any>;
}

const daemonClient: JittorExtensionClient = {
	call: (operation, input) => callJittor(operation as Parameters<typeof callJittor>[0], input as never),
};

async function recordMetrics(client: JittorExtensionClient, metrics: MetricObservation[]): Promise<void> {
	for (const metric of metrics) await client.call("metrics.record", metric);
}

async function refreshFooter(client: JittorExtensionClient, ctx: ExtensionContext): Promise<void> {
	try {
		const [status, codex, openRouter] = await Promise.all([
			client.call("router.status", {}) as Promise<RouterStatus>,
			client.call("metrics.query", { source: "codex-subscription", metric: "used-fraction", limit: 100, order: "desc" }) as Promise<StoredMetricObservation[]>,
			client.call("metrics.query", { source: "openrouter", metric: "usage", limit: 10, order: "desc" }) as Promise<StoredMetricObservation[]>,
		]);
		ctx.ui.setStatus(STATUS_KEY, formatFooterStatus(status, [...codex, ...openRouter]));
	} catch {
		ctx.ui.setStatus(STATUS_KEY, "Jittor · unavailable");
	}
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
	if (milliseconds <= 0) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, milliseconds);
		signal?.addEventListener("abort", () => {
			clearTimeout(timer);
			reject(new Error("Jittor throttle cancelled"));
		}, { once: true });
	});
}

async function applyRoute(pi: ExtensionAPI, ctx: ExtensionContext, route: Route): Promise<boolean> {
	const model = ctx.modelRegistry.find(route.provider, route.model);
	if (!model) {
		ctx.ui.notify(`Jittor route unavailable: ${route.provider}/${route.model}`, "error");
		ctx.abort();
		return false;
	}
	if (!ctx.model || ctx.model.provider !== route.provider || ctx.model.id !== route.model) {
		if (!await pi.setModel(model)) {
			ctx.ui.notify(`Jittor route lacks authentication: ${route.provider}/${route.model}`, "error");
			ctx.abort();
			return false;
		}
	}
	if (THINKING_LEVELS.has(route.thinking)) pi.setThinkingLevel(route.thinking as Parameters<ExtensionAPI["setThinkingLevel"]>[0]);
	return true;
}

async function syncCurrentRoute(
	pi: ExtensionAPI,
	client: JittorExtensionClient,
	ctx: ExtensionContext,
	model = ctx.model,
	thinking = pi.getThinkingLevel(),
): Promise<void> {
	if (!model) return;
	await client.call("router.current_route", { provider: model.provider, model: model.id, thinking });
}

async function applyDecision(pi: ExtensionAPI, ctx: ExtensionContext, decision: PolicyDecision): Promise<boolean> {
	if (decision.action === "halt") {
		ctx.ui.notify(`Jittor halted: ${decision.reason}`, "warning");
		ctx.abort();
		return false;
	}
	if (decision.action === "throttle") await delay(decision.delayMs ?? 0, ctx.signal);
	if (decision.route && !await applyRoute(pi, ctx, decision.route)) return false;
	return true;
}

function assistantUsageMetrics(message: unknown, observedAt: number): MetricObservation[] {
	if (typeof message !== "object" || message === null || Array.isArray(message)) return [];
	const value = message as Record<string, unknown>;
	if (value["role"] !== "assistant" || typeof value["usage"] !== "object" || value["usage"] === null) return [];
	const usage = value["usage"] as Record<string, unknown>;
	const provider = typeof value["provider"] === "string" ? value["provider"] : "unknown";
	const model = typeof value["model"] === "string" ? value["model"] : "unknown";
	const scope = `${provider}:${model}`;
	const attributes = { provider, model };
	const metrics: MetricObservation[] = [];
	for (const [field, metric] of [["input", "input-tokens"], ["output", "output-tokens"], ["cacheRead", "cache-read-tokens"], ["cacheWrite", "cache-write-tokens"]] as const) {
		const amount = usage[field];
		if (typeof amount === "number" && Number.isFinite(amount)) metrics.push({ source: "pi", scope, metric, value: amount, unit: "tokens", observedAt, attributes });
	}
	const cost = typeof usage["cost"] === "object" && usage["cost"] !== null ? (usage["cost"] as Record<string, unknown>)["total"] : undefined;
	if (typeof cost === "number" && Number.isFinite(cost)) metrics.push({ source: "pi", scope, metric: "cost", value: cost, unit: "usd", observedAt, attributes });
	return metrics;
}

export function registerJittorExtension(pi: ExtensionAPI, client: JittorExtensionClient = daemonClient): void {
	pi.registerCommand("jittor", {
		description: "Inspect provider budgets and control Jittor routing",
		handler: async (_args, ctx) => { await showJittorPanel(ctx, client); },
	});

	pi.on("session_start", async (_event, ctx) => {
		try {
			await syncCurrentRoute(pi, client, ctx);
			await client.call("telemetry.poll", {});
		} catch { /* readiness remains fail-closed */ }
		await refreshFooter(client, ctx);
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return { action: "continue" as const };
		try {
			const next = await client.call("router.decide", {}) as PolicyDecision;
			if (next.action === "halt") {
				ctx.ui.notify(`Jittor blocked input: ${next.reason}`, "warning");
				return { action: "handled" as const };
			}
			return { action: "continue" as const };
		} catch {
			ctx.ui.notify("Jittor unavailable; blocking provider request", "error");
			return { action: "handled" as const };
		}
	});

	pi.on("model_select", async (event, ctx) => {
		await syncCurrentRoute(pi, client, ctx, event.model).catch(() => undefined);
	});

	pi.on("thinking_level_select", async (event, ctx) => {
		await syncCurrentRoute(pi, client, ctx, ctx.model, event.level).catch(() => undefined);
	});

	pi.on("turn_start", async (_event, ctx) => {
		try {
			await applyDecision(pi, ctx, await client.call("router.decide", {}) as PolicyDecision);
		} catch {
			ctx.ui.notify("Jittor unavailable; aborting turn", "error");
			ctx.abort();
		}
		await refreshFooter(client, ctx);
	});

	pi.on("after_provider_response", async (event, ctx) => {
		if (!Object.keys(event.headers).some((name) => name.toLowerCase().startsWith("x-codex-"))) return;
		try {
			const updates = parseCodexRateLimitHeaders(new Headers(event.headers), Date.now());
			await recordMetrics(client, updates.flatMap((update) => update.metrics));
		} catch {
			await client.call("router.pause", {}).catch(() => undefined);
			ctx.ui.notify("Jittor detected Codex telemetry schema drift; paused", "error");
			ctx.abort();
		}
		await refreshFooter(client, ctx);
	});

	pi.on("message_end", async (event, ctx) => {
		const metrics = assistantUsageMetrics(event.message, Date.now());
		if (metrics.length > 0) await recordMetrics(client, metrics).catch(() => undefined);
		await refreshFooter(client, ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => { ctx.ui.setStatus(STATUS_KEY, undefined); });
}

export default function jittorExtension(pi: ExtensionAPI): void {
	registerJittorExtension(pi);
}

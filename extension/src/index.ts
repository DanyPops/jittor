import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MAX_DYNAMIC_ROUTES } from "../../src/constants.ts";
import type { MetricObservation, StoredMetricObservation } from "../../src/domain/metric.ts";
import type { PolicyDecision, Route } from "../../src/policy.ts";
import type { RouterStatus } from "../../src/ports/router-controller.ts";
import { parseCodexRateLimitHeaders } from "../../src/providers/codex.ts";
import { installIntegratedFooter, type IntegratedFooterState } from "./footer.ts";
import { callJittor } from "./service-client.ts";
import { persistentEnforcementControl, type EnforcementControl } from "./settings.ts";
import { formatFooterStatus, showJittorPanel } from "./tui.ts";
import { showUsagePanel } from "./usage.ts";

export { formatFooterStatus } from "./tui.ts";

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const RECOVERY_GUIDANCE = "Run /jittor off to disable blocking, or restart the daemon with: systemctl --user restart jittor.service";

export interface JittorExtensionClient {
	call(operation: string, input: unknown): Promise<any>;
}

const daemonClient: JittorExtensionClient = {
	call: (operation, input) => callJittor(operation as Parameters<typeof callJittor>[0], input as never),
};

async function recordMetrics(client: JittorExtensionClient, metrics: MetricObservation[]): Promise<void> {
	for (const metric of metrics) await client.call("metrics.record", metric);
}

async function refreshFooter(client: JittorExtensionClient, state: IntegratedFooterState): Promise<void> {
	const status = await client.call("router.status", {}) as RouterStatus;
	const provider = status.currentRoute?.provider;
	const query = provider === "openai-codex"
		? { source: "codex-subscription", metric: "used-fraction", limit: 100, order: "desc" }
		: provider === "openrouter" ? { source: "openrouter", metric: "usage", limit: 10, order: "desc" } : null;
	const metrics = query ? await client.call("metrics.query", query) as StoredMetricObservation[] : [];
	state.providerUsage = formatFooterStatus(status, metrics);
	state.requestRender?.();
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

function routeModelAvailable(ctx: ExtensionContext, route: Route): boolean {
	return ctx.modelRegistry.getAvailable().some((model) => model.provider === route.provider && model.id === route.model);
}

async function applyRoute(pi: ExtensionAPI, ctx: ExtensionContext, route: Route): Promise<boolean> {
	if (!routeModelAvailable(ctx, route)) return false;
	const model = ctx.modelRegistry.find(route.provider, route.model);
	if (!model) return false;
	if (!ctx.model || ctx.model.provider !== route.provider || ctx.model.id !== route.model) {
		if (!await pi.setModel(model)) return false;
	}
	if (THINKING_LEVELS.has(route.thinking)) pi.setThinkingLevel(route.thinking as Parameters<ExtensionAPI["setThinkingLevel"]>[0]);
	return true;
}

interface PiRouteModel {
	provider: string;
	id: string;
	reasoning?: boolean;
	thinkingLevelMap?: Partial<Record<string, unknown>>;
	cost?: { input?: number; output?: number };
}

const THINKING_DESCENDING = ["max", "xhigh", "high", "medium", "low", "minimal", "off"] as const;

function supportsThinking(model: PiRouteModel, level: string): boolean {
	if (!model.reasoning) return level === "off";
	return model.thinkingLevelMap?.[level] !== null;
}

function modelCost(model: PiRouteModel): number {
	return (model.cost?.input ?? 0) + (model.cost?.output ?? 0);
}

export function routesFromPi(models: PiRouteModel[], current: PiRouteModel, thinking: string): Route[] {
	const sameProvider = models
		.filter((model) => model.provider === current.provider)
		.filter((model, index, rows) => rows.findIndex((candidate) => candidate.id === model.id) === index);
	if (!sameProvider.some((model) => model.id === current.id)) sameProvider.push(current);
	const routes: Route[] = [{ provider: current.provider, model: current.id, thinking }];
	const currentLevel = THINKING_DESCENDING.indexOf(thinking as typeof THINKING_DESCENDING[number]);
	const lowerLevels = THINKING_DESCENDING.slice(currentLevel >= 0 ? currentLevel + 1 : 0);
	for (const level of lowerLevels) {
		if (supportsThinking(current, level)) routes.push({ provider: current.provider, model: current.id, thinking: level });
	}
	const alternatives = sameProvider
		.filter((model) => model.id !== current.id)
		.sort((left, right) => modelCost(left) - modelCost(right) || left.id.localeCompare(right.id));
	for (const model of alternatives) {
		const level = [thinking, ...lowerLevels].find((candidate) => supportsThinking(model, candidate)) ?? "off";
		routes.push({ provider: model.provider, model: model.id, thinking: level });
		if (routes.length >= MAX_DYNAMIC_ROUTES) break;
	}
	return routes;
}

async function syncAvailableRoutes(pi: ExtensionAPI, client: JittorExtensionClient, ctx: ExtensionContext): Promise<void> {
	if (!ctx.model) { await client.call("router.available_routes", { routes: [] }); return; }
	const models = ctx.modelRegistry.getAvailable() as PiRouteModel[];
	const routes = routesFromPi(models, ctx.model as PiRouteModel, pi.getThinkingLevel());
	await client.call("router.available_routes", { routes });
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

function halt(ctx: ExtensionContext, reason: string): false {
	ctx.ui.notify(`${reason}. ${RECOVERY_GUIDANCE}.`, "warning");
	ctx.abort();
	return false;
}

async function applyDecision(
	pi: ExtensionAPI,
	client: JittorExtensionClient,
	ctx: ExtensionContext,
	decision: PolicyDecision,
	allowResync = true,
): Promise<boolean> {
	if (decision.action === "halt") return halt(ctx, `Jittor blocked this provider request: ${decision.reason}`);
	if (decision.action === "throttle") await delay(decision.delayMs ?? 0, ctx.signal);
	if (!decision.route || await applyRoute(pi, ctx, decision.route)) return true;
	if (allowResync) {
		await syncAvailableRoutes(pi, client, ctx);
		return applyDecision(pi, client, ctx, await client.call("router.decide", {}) as PolicyDecision, false);
	}
	return halt(ctx, `Jittor could not apply any authenticated Pi route after ${decision.route.provider}/${decision.route.model} became unavailable`);
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

export function registerJittorExtension(
	pi: ExtensionAPI,
	client: JittorExtensionClient = daemonClient,
	enforcement: EnforcementControl = persistentEnforcementControl(),
): void {
	const footerState: IntegratedFooterState = { providerUsage: "" };
	const disable = (ctx: ExtensionContext): void => {
		enforcement.setEnabled(false);
		footerState.providerUsage = "";
		ctx.ui.setStatus("jittor", undefined);
		ctx.ui.setFooter(undefined);
		ctx.ui.notify("Jittor enforcement is off (monitor-only); provider requests will not be blocked.", "warning");
	};
	const enable = async (ctx: ExtensionContext): Promise<void> => {
		try {
			await syncCurrentRoute(pi, client, ctx);
			await syncAvailableRoutes(pi, client, ctx);
			await client.call("telemetry.poll", {});
			const readinessDecision = await client.call("router.decide", {}) as PolicyDecision;
			if (readinessDecision.action === "halt") throw new Error(readinessDecision.reason);
			enforcement.setEnabled(true);
			installIntegratedFooter(ctx, footerState, () => pi.getThinkingLevel());
			await refreshFooter(client, footerState);
			ctx.ui.notify("Jittor enforcement enabled.", "info");
		} catch (error) {
			enforcement.setEnabled(false);
			ctx.ui.setFooter(undefined);
			const reason = error instanceof Error ? error.message : "readiness failed";
			ctx.ui.notify(`Jittor remains monitor-only: ${reason}. ${RECOVERY_GUIDANCE}.`, "error");
		}
	};

	pi.registerCommand("jittor", {
		description: "Inspect, enable, or disable Jittor routing",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action === "off" || action === "disable") { disable(ctx); return; }
			if (action === "on" || action === "enable") { await enable(ctx); return; }
			if (!enforcement.isEnabled()) {
				ctx.ui.notify("Jittor is monitor-only. Run /jittor on to re-enable blocking.", "info");
				return;
			}
			await showJittorPanel(ctx, client);
		},
	});
	pi.registerCommand("jittor-off", {
		description: "Emergency local bypass: disable Jittor blocking without daemon access",
		handler: async (_args, ctx) => { disable(ctx); },
	});
	pi.registerCommand("jittor-on", {
		description: "Enable Jittor only after telemetry and routes pass readiness",
		handler: async (_args, ctx) => { await enable(ctx); },
	});
	pi.registerCommand("usage", {
		description: "Show Jittor token usage over time",
		handler: async (_args, ctx) => { await showUsagePanel(ctx, client); },
	});

	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setStatus("jittor", undefined);
		if (!enforcement.isEnabled()) { ctx.ui.setFooter(undefined); return; }
		installIntegratedFooter(ctx, footerState, () => pi.getThinkingLevel());
		try {
			await syncCurrentRoute(pi, client, ctx);
			await syncAvailableRoutes(pi, client, ctx);
			await client.call("telemetry.poll", {});
			await refreshFooter(client, footerState);
		} catch {
			footerState.providerUsage = "";
		}
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension" || !enforcement.isEnabled()) return { action: "continue" as const };
		try {
			const next = await client.call("router.decide", {}) as PolicyDecision;
			if (next.action === "halt") {
				ctx.ui.notify(`Jittor blocked input: ${next.reason}. ${RECOVERY_GUIDANCE}.`, "warning");
				return { action: "handled" as const };
			}
			return { action: "continue" as const };
		} catch {
			ctx.ui.notify(`Jittor could not verify budget telemetry, so fail-closed enforcement blocked input. ${RECOVERY_GUIDANCE}.`, "error");
			return { action: "handled" as const };
		}
	});

	pi.on("model_select", async (event, ctx) => {
		if (!enforcement.isEnabled()) return;
		await syncCurrentRoute(pi, client, ctx, event.model).then(() => syncAvailableRoutes(pi, client, ctx)).catch(() => undefined);
		await refreshFooter(client, footerState).catch(() => undefined);
	});

	pi.on("thinking_level_select", async (event, ctx) => {
		if (!enforcement.isEnabled()) return;
		await syncCurrentRoute(pi, client, ctx, ctx.model, event.level).catch(() => undefined);
	});

	pi.on("turn_start", async (_event, ctx) => {
		if (!enforcement.isEnabled()) return;
		try {
			await syncCurrentRoute(pi, client, ctx);
			await syncAvailableRoutes(pi, client, ctx);
			await applyDecision(pi, client, ctx, await client.call("router.decide", {}) as PolicyDecision);
			await refreshFooter(client, footerState);
		} catch {
			halt(ctx, "Jittor could not verify or apply a safe route");
		}
	});

	pi.on("after_provider_response", async (event, ctx) => {
		if (!Object.keys(event.headers).some((name) => name.toLowerCase().startsWith("x-codex-"))) return;
		try {
			const updates = parseCodexRateLimitHeaders(new Headers(event.headers), Date.now());
			await recordMetrics(client, updates.flatMap((update) => update.metrics));
		} catch {
			if (enforcement.isEnabled()) ctx.ui.notify(`Jittor detected Codex telemetry schema drift. ${RECOVERY_GUIDANCE}.`, "error");
		}
		if (enforcement.isEnabled()) await refreshFooter(client, footerState).catch(() => undefined);
	});

	pi.on("message_end", async (event, _ctx) => {
		const metrics = assistantUsageMetrics(event.message, Date.now());
		if (metrics.length > 0) await recordMetrics(client, metrics).catch(() => undefined);
		if (enforcement.isEnabled()) await refreshFooter(client, footerState).catch(() => undefined);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setStatus("jittor", undefined);
		ctx.ui.setFooter(undefined);
	});
}

export default function jittorExtension(pi: ExtensionAPI): void {
	registerJittorExtension(pi);
}

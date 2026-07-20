import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	CODEX_RECOVERY_ATTEMPT_WINDOW_MS,
	CODEX_RECOVERY_BASE_DELAY_MS,
	CODEX_RECOVERY_JITTER_RATIO,
	CODEX_RECOVERY_MAX_ATTEMPTS,
	CODEX_RECOVERY_MAX_DELAY_MS,
	FOOTER_COMPACTION_RENDER_INTERVAL_MS,
	MAX_DYNAMIC_ROUTES,
	MILLISECONDS_PER_MINUTE,
	MILLISECONDS_PER_SECOND,
} from "../../src/constants.ts";
import { CodexRecoveryPolicy, classifyCodexFailure, type CodexFailureKind, type CodexFailureMetadata } from "../../src/domain/codex-recovery.ts";
import type { MetricObservation, StoredMetricObservation } from "../../src/domain/metric.ts";
import type { PolicyDecision, Route } from "../../src/policy.ts";
import type { RouterStatus } from "../../src/ports/router-controller.ts";
import { parseCodexRateLimitHeaders } from "../../src/providers/codex.ts";
import { installIntegratedFooter, type IntegratedFooterState } from "./footer.ts";
import { callJittor } from "./service-client.ts";
import { persistentEnforcementControl, type CodexRecoveryControl, type EnforcementControl } from "./settings.ts";
import { buildFooterBudget, formatFooterStatus, showJittorPanel } from "./tui.ts";
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

export interface CodexRecoveryRuntime {
	now(): number;
	random(): number;
	setTimeout(callback: () => void | Promise<void>, delayMs: number): unknown;
	clearTimeout(handle: unknown): void;
}

const SYSTEM_RECOVERY_RUNTIME: CodexRecoveryRuntime = {
	now: Date.now,
	random: Math.random,
	setTimeout(callback, delayMs) { return setTimeout(() => { void callback(); }, delayMs); },
	clearTimeout(handle) { clearTimeout(handle as ReturnType<typeof setTimeout>); },
};

function recoveryControl(enforcement: EnforcementControl): CodexRecoveryControl {
	const candidate = enforcement as EnforcementControl & Partial<CodexRecoveryControl>;
	const set = (candidate as Partial<CodexRecoveryControl>).setCodexRecoveryEnabled;
	return typeof candidate.isCodexRecoveryEnabled === "function" && typeof set === "function"
		? {
			isCodexRecoveryEnabled: () => candidate.isCodexRecoveryEnabled!(),
			setCodexRecoveryEnabled: (enabled) => set.call(candidate, enabled),
		}
		: { isCodexRecoveryEnabled: () => false, setCodexRecoveryEnabled() {} };
}

function header(headers: Record<string, string>, name: string): string | undefined {
	const expected = name.toLowerCase();
	return Object.entries(headers).find(([key]) => key.toLowerCase() === expected)?.[1];
}

async function recordMetrics(client: JittorExtensionClient, metrics: MetricObservation[]): Promise<void> {
	for (const metric of metrics) await client.call("metrics.record", metric);
}

async function refreshFooter(client: JittorExtensionClient, state: IntegratedFooterState): Promise<void> {
	const status = await client.call("router.status", {}) as RouterStatus;
	const provider = status.currentRoute?.provider;
	const query = provider === "openai-codex"
		? { source: "codex-subscription", metric: "used-fraction", limit: 100, order: "desc" }
		: provider === "openrouter" ? { source: "openrouter", limit: 20, order: "desc" } : null;
	const metrics = query ? await client.call("metrics.query", query) as StoredMetricObservation[] : [];
	state.providerBudget = buildFooterBudget(status, metrics);
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
	codexRecovery: CodexRecoveryControl = recoveryControl(enforcement),
	recoveryRuntime: CodexRecoveryRuntime = SYSTEM_RECOVERY_RUNTIME,
): void {
	const footerState: IntegratedFooterState = { providerBudget: null };
	const recoveryPolicy = new CodexRecoveryPolicy({
		baseDelayMs: CODEX_RECOVERY_BASE_DELAY_MS,
		maxDelayMs: CODEX_RECOVERY_MAX_DELAY_MS,
		maxAttempts: CODEX_RECOVERY_MAX_ATTEMPTS,
		attemptWindowMs: CODEX_RECOVERY_ATTEMPT_WINDOW_MS,
		jitterRatio: CODEX_RECOVERY_JITTER_RATIO,
	}, recoveryRuntime.random);
	let recoveryTimer: unknown;
	let recoveryCooldown: { until: number; attempt: number; failureKind: CodexFailureKind } | undefined;
	let lastCodexResponse: CodexFailureMetadata = {};
	const cancelRecovery = (resetPolicy: boolean): void => {
		if (recoveryTimer !== undefined) recoveryRuntime.clearTimeout(recoveryTimer);
		recoveryTimer = undefined;
		recoveryCooldown = undefined;
		if (resetPolicy) recoveryPolicy.cancel();
	};
	const recoveryStatusText = (): string => {
		const now = recoveryRuntime.now();
		const state = recoveryPolicy.state(now);
		const enabled = codexRecovery.isCodexRecoveryEnabled();
		const attempt = recoveryCooldown?.attempt ?? (state.pending ? state.attempts + 1 : state.attempts);
		const phase = recoveryCooldown
			? `cooldown ${Math.ceil(Math.max(0, recoveryCooldown.until - now) / MILLISECONDS_PER_SECOND)}s`
			: state.pending ? "pending"
				: state.attempts >= CODEX_RECOVERY_MAX_ATTEMPTS ? "exhausted"
					: state.attempts > 0 ? "waiting" : "idle";
		const failureKind = recoveryCooldown?.failureKind ?? state.lastFailureKind;
		return [
			`Codex recovery: ${enabled ? "on" : "off"}`,
			phase,
			`attempt ${attempt}/${CODEX_RECOVERY_MAX_ATTEMPTS}`,
			`window ${CODEX_RECOVERY_ATTEMPT_WINDOW_MS / MILLISECONDS_PER_MINUTE}m`,
			...(failureKind ? [failureKind] : []),
		].join(" · ");
	};
	const scheduleCodexRecovery = (ctx: ExtensionContext): void => {
		if (!codexRecovery.isCodexRecoveryEnabled() || recoveryTimer !== undefined || !ctx.isIdle() || ctx.hasPendingMessages()) return;
		const plan = recoveryPolicy.plan(recoveryRuntime.now());
		if (plan.action === "exhausted") {
			recoveryPolicy.abandonFailure();
			if (ctx.hasUI) ctx.ui.notify(`Jittor Codex recovery stopped: ${plan.reason}.`, "warning");
			return;
		}
		if (plan.action !== "schedule") return;
		recoveryCooldown = { until: recoveryRuntime.now() + plan.delayMs, attempt: plan.attempt, failureKind: plan.failureKind };
		recoveryTimer = recoveryRuntime.setTimeout(async () => {
			recoveryTimer = undefined;
			recoveryCooldown = undefined;
			if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
			const attempt = recoveryPolicy.recordAttempt(recoveryRuntime.now());
			if (!attempt) return;
			pi.sendMessage({
				customType: "jittor-codex-recovery",
				content: `Retry the previous Codex request after a transient ${attempt.failureKind} failure. Automatic recovery attempt ${attempt.attempt} of ${CODEX_RECOVERY_MAX_ATTEMPTS}.`,
				display: false,
				details: { attempt: attempt.attempt, failureKind: attempt.failureKind },
			}, { triggerTurn: true, deliverAs: "followUp" });
		}, plan.delayMs);
	};
	let compactionTimer: ReturnType<typeof setInterval> | undefined;
	const finishCompaction = (): void => {
		if (compactionTimer) clearInterval(compactionTimer);
		compactionTimer = undefined;
		footerState.compaction = undefined;
		footerState.requestRender?.();
	};
	const beginCompaction = (ctx: ExtensionContext, signal: AbortSignal): void => {
		finishCompaction();
		const usage = ctx.getContextUsage();
		footerState.compaction = {
			startedAt: Date.now(),
			initialFraction: usage?.percent === null || usage?.percent === undefined ? 1 : usage.percent / 100,
		};
		compactionTimer = setInterval(() => footerState.requestRender?.(), FOOTER_COMPACTION_RENDER_INTERVAL_MS);
		signal.addEventListener("abort", finishCompaction, { once: true });
		if (signal.aborted) finishCompaction();
		else footerState.requestRender?.();
	};
	const showFooter = (ctx: ExtensionContext): void => {
		if (enforcement.isFooterEnabled()) installIntegratedFooter(ctx, footerState, () => pi.getThinkingLevel());
		else ctx.ui.setFooter(undefined);
	};
	const disable = (ctx: ExtensionContext): void => {
		enforcement.setEnabled(false);
		ctx.ui.setStatus("jittor", undefined);
		showFooter(ctx);
		ctx.ui.notify("Jittor enforcement is off (monitor-only); the informational footer remains independent and provider requests will not be blocked.", "warning");
	};
	const enable = async (ctx: ExtensionContext): Promise<void> => {
		try {
			await syncCurrentRoute(pi, client, ctx);
			await syncAvailableRoutes(pi, client, ctx);
			await client.call("telemetry.poll", {});
			const readinessDecision = await client.call("router.decide", {}) as PolicyDecision;
			if (readinessDecision.action === "halt") throw new Error(readinessDecision.reason);
			enforcement.setEnabled(true);
			showFooter(ctx);
			await refreshFooter(client, footerState);
			ctx.ui.notify("Jittor enforcement enabled.", "info");
		} catch (error) {
			enforcement.setEnabled(false);
			showFooter(ctx);
			const reason = error instanceof Error ? error.message : "readiness failed";
			ctx.ui.notify(`Jittor remains monitor-only: ${reason}. ${RECOVERY_GUIDANCE}.`, "error");
		}
	};

	pi.registerCommand("jittor", {
		description: "Inspect or control Jittor routing, budgets, and usage",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action === "recovery" || action === "recovery status") {
				ctx.ui.notify(recoveryStatusText(), "info");
				return;
			}
			if (action === "recovery on" || action === "recovery enable") {
				codexRecovery.setCodexRecoveryEnabled(true);
				ctx.ui.notify("Jittor Codex recovery enabled; bounded retries begin only after transient failures fully settle.", "info");
				return;
			}
			if (action === "recovery off" || action === "recovery disable") {
				cancelRecovery(true);
				codexRecovery.setCodexRecoveryEnabled(false);
				ctx.ui.notify("Jittor Codex recovery disabled and pending recovery cleared.", "info");
				return;
			}
			if (action === "recovery cancel") {
				cancelRecovery(true);
				ctx.ui.notify(`Jittor Codex recovery cooldown and attempt window cleared; recovery remains ${codexRecovery.isCodexRecoveryEnabled() ? "on" : "off"}.`, "info");
				return;
			}
			if (action === "off" || action === "disable") { disable(ctx); return; }
			if (action === "on" || action === "enable") { await enable(ctx); return; }
			if (action === "footer off" || action === "footer disable") {
				enforcement.setFooterEnabled(false);
				ctx.ui.setFooter(undefined);
				ctx.ui.notify("Jittor footer disabled; routing enforcement is unchanged.", "info");
				return;
			}
			if (action === "footer on" || action === "footer enable") {
				enforcement.setFooterEnabled(true);
				showFooter(ctx);
				await refreshFooter(client, footerState).catch(() => undefined);
				ctx.ui.notify("Jittor informational footer enabled; routing enforcement is unchanged.", "info");
				return;
			}
			if (action === "usage") {
				await showUsagePanel(ctx, client);
				return;
			}
			if (!enforcement.isEnabled()) {
				ctx.ui.notify("Jittor is monitor-only. Run /jittor on to re-enable blocking.", "info");
				return;
			}
			await showJittorPanel(ctx, client);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		finishCompaction();
		cancelRecovery(true);
		lastCodexResponse = {};
		ctx.ui.setStatus("jittor", undefined);
		showFooter(ctx);
		try {
			await syncCurrentRoute(pi, client, ctx);
			await syncAvailableRoutes(pi, client, ctx);
			await client.call("telemetry.poll", {});
			await refreshFooter(client, footerState);
		} catch {
			footerState.providerBudget = null;
			footerState.requestRender?.();
		}
	});

	pi.on("session_before_compact", (event, ctx) => {
		beginCompaction(ctx, event.signal);
	});

	pi.on("session_compact", () => {
		finishCompaction();
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (footerState.compaction) finishCompaction();
		scheduleCodexRecovery(ctx);
		if (!enforcement.isFooterEnabled()) return;
		try {
			await syncCurrentRoute(pi, client, ctx);
			await syncAvailableRoutes(pi, client, ctx);
			await refreshFooter(client, footerState);
		} catch {
			footerState.providerBudget = null;
			footerState.requestRender?.();
		}
	});

	pi.on("input", async (event, ctx) => {
		if (event.source !== "extension") cancelRecovery(true);
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
		await syncCurrentRoute(pi, client, ctx, event.model).then(() => syncAvailableRoutes(pi, client, ctx)).catch(() => undefined);
		if (enforcement.isFooterEnabled()) await refreshFooter(client, footerState).catch(() => undefined);
	});

	pi.on("thinking_level_select", async (event, ctx) => {
		await syncCurrentRoute(pi, client, ctx, ctx.model, event.level).catch(() => undefined);
	});

	pi.on("turn_start", async (_event, ctx) => {
		lastCodexResponse = {};
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
		if (ctx.model?.provider === "openai-codex") {
			lastCodexResponse = { status: event.status, ...(header(event.headers, "retry-after") ? { retryAfter: header(event.headers, "retry-after") } : {}) };
		}
		if (!Object.keys(event.headers).some((name) => name.toLowerCase().startsWith("x-codex-"))) return;
		try {
			const updates = parseCodexRateLimitHeaders(new Headers(event.headers), Date.now());
			await recordMetrics(client, updates.flatMap((update) => update.metrics));
		} catch {
			if (enforcement.isEnabled()) ctx.ui.notify(`Jittor detected Codex telemetry schema drift. ${RECOVERY_GUIDANCE}.`, "error");
		}
		if (enforcement.isFooterEnabled()) await refreshFooter(client, footerState).catch(() => undefined);
	});

	pi.on("message_end", async (event, _ctx) => {
		if (event.message.role === "assistant" && event.message.provider === "openai-codex") {
			if (event.message.stopReason === "error") {
				const failure = classifyCodexFailure(event.message.errorMessage, lastCodexResponse);
				if (codexRecovery.isCodexRecoveryEnabled() && failure.transient) recoveryPolicy.observeFailure(failure, recoveryRuntime.now());
				else cancelRecovery(true);
			} else if (event.message.stopReason !== "aborted") {
				cancelRecovery(true);
			}
			lastCodexResponse = {};
		}
		const metrics = assistantUsageMetrics(event.message, Date.now());
		if (metrics.length > 0) await recordMetrics(client, metrics).catch(() => undefined);
		if (enforcement.isFooterEnabled()) await refreshFooter(client, footerState).catch(() => undefined);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		finishCompaction();
		cancelRecovery(true);
		lastCodexResponse = {};
		ctx.ui.setStatus("jittor", undefined);
		ctx.ui.setFooter(undefined);
	});
}

export default function jittorExtension(pi: ExtensionAPI): void {
	registerJittorExtension(pi);
}

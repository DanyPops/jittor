import type { ContextSegmentItem } from "@danypops/jittor";
import {
	applyTaskFocusEvent,
	CONTEXT_ESTIMATE_CHARACTERS_PER_TOKEN,
	CONTEXT_EVENT_DEDUP_LIMIT,
	CONTEXT_HUB_CONTRIBUTION_CHANNEL,
	CompactionTelemetry,
	type ContextAssessment,
	FOOTER_COMPACTION_RENDER_INTERVAL_MS,
	MAX_DYNAMIC_ROUTES,
	type MetricObservation,
	type ModelCandidate,
	type ModelTaskDomain,
	type ModelTaskType,
	PAPYRUS_CONTEXT_INJECTION_CHANNEL,
	PAPYRUS_TASK_FOCUS_CHANNEL,
	type PolicyDecision,
	papyrusContextMetric,
	type Route,
	type RouterStatus,
	type StoredMetricObservation,
	TASK_DOMAINS,
	TASK_TYPES,
	toolLedgerSegment,
	USAGE_PERIODS,
	type UsagePeriod,
	validatePapyrusContextInjection,
	validateTaskFocusEvent,
} from "@danypops/jittor";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { showBenchmarkPanel } from "./benchmark-tui.ts";
import { CodexRecoveryCapability, type CodexRecoveryRuntime, SYSTEM_RECOVERY_RUNTIME } from "./capabilities/codex-recovery.ts";
import { ContextHubCapability } from "./capabilities/context-hub.ts";
import { LocalRunTelemetry } from "./capabilities/local-run-telemetry.ts";
import { ProviderResponseTelemetry } from "./capabilities/provider-response-telemetry.ts";
import {
	basePromptSegment,
	buildBasePromptItems,
	buildMessageHistoryTree,
	composeContextBreakdown,
	messageHistorySegment,
	type SessionEntryLike,
	type SessionTreeNodeLike,
} from "./context-breakdown.ts";
import { showContextView } from "./context-view.ts";
import { type CompactionProgress, type IntegratedFooterState, installIntegratedFooter } from "./footer.ts";
import { callJittor } from "./service-client.ts";
import { cacheSessionSecret, forgetSessionSecret, sessionSecretField } from "./session-identity.ts";
import { type CodexRecoveryControl, type EnforcementControl, persistentEnforcementControl, type UsageBudgetControl } from "./settings.ts";
import { showSettingsPanel } from "./settings-tui.ts";
import { buildFooterBudget, providerBudgetMetricQuery, showJittorPanel } from "./tui.ts";
import { showUsagePanel } from "./usage.ts";

export type { CodexRecoveryRuntime } from "./capabilities/codex-recovery.ts";
export { formatFooterStatus } from "./tui.ts";

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const RECOVERY_GUIDANCE = "Run /jittor off to disable blocking, or restart the daemon with: systemctl --user restart jittor.service";

export interface JittorExtensionClient {
	call(operation: string, input: unknown): Promise<any>;
}

const daemonClient: JittorExtensionClient = {
	call: (operation, input) => callJittor(operation as Parameters<typeof callJittor>[0], input as never),
};

function usageBudgetControl(enforcement: EnforcementControl): UsageBudgetControl {
	const candidate = enforcement as EnforcementControl & Partial<UsageBudgetControl>;
	return typeof candidate.getUsageTokenBudget === "function" && typeof candidate.setUsageTokenBudget === "function"
		? {
				getUsageTokenBudget: (period) => candidate.getUsageTokenBudget!(period),
				setUsageTokenBudget: (period, tokens) => candidate.setUsageTokenBudget!(period, tokens),
			}
		: { getUsageTokenBudget: () => undefined, setUsageTokenBudget() {} };
}

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

async function recordMetrics(client: JittorExtensionClient, metrics: MetricObservation[]): Promise<void> {
	if (metrics.length === 0) return;
	// One atomic transaction rather than a per-metric RPC loop: a later observation in the same
	// event failing validation, or the connection dropping mid-loop, must not leave this event's
	// metrics partially persisted.
	await client.call("metrics.record_batch", { observations: metrics });
}

async function refreshFooter(client: JittorExtensionClient, state: IntegratedFooterState, sessionId: string): Promise<void> {
	const status = (await client.call("router.status", { session_id: sessionId })) as RouterStatus;
	const query = providerBudgetMetricQuery(status);
	const metrics = query ? ((await client.call("metrics.query", query)) as StoredMetricObservation[]) : [];
	state.providerBudget = buildFooterBudget(status, metrics);
	state.requestRender?.();
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
	if (milliseconds <= 0) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, milliseconds);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(new Error("Jittor throttle cancelled"));
			},
			{ once: true },
		);
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
		if (!(await pi.setModel(model))) return false;
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

export function benchmarkCandidatesFromPi(models: PiRouteModel[], thinking: string): ModelCandidate[] {
	const candidates: ModelCandidate[] = [];
	for (const model of models) {
		if (
			!model.provider ||
			!model.id ||
			candidates.some((candidate) => candidate.provider === model.provider && candidate.model === model.id)
		)
			continue;
		const level = supportsThinking(model, thinking) ? thinking : "off";
		candidates.push({ provider: model.provider, model: model.id, thinking: level });
		if (candidates.length >= MAX_DYNAMIC_ROUTES) break;
	}
	return candidates;
}

export function routesFromPi(models: PiRouteModel[], current: PiRouteModel, thinking: string): Route[] {
	const catalog = models
		.filter((model) => model.provider.length > 0 && model.id.length > 0)
		.filter(
			(model, index, rows) => rows.findIndex((candidate) => candidate.provider === model.provider && candidate.id === model.id) === index,
		);
	if (!catalog.some((model) => model.provider === current.provider && model.id === current.id)) catalog.push(current);
	const currentLevel = THINKING_DESCENDING.indexOf(thinking as (typeof THINKING_DESCENDING)[number]);
	const lowerLevels = THINKING_DESCENDING.slice(currentLevel >= 0 ? currentLevel + 1 : 0);
	const routes: Route[] = [];
	const add = (route: Route): void => {
		if (
			routes.length >= MAX_DYNAMIC_ROUTES ||
			routes.some(
				(candidate) => candidate.provider === route.provider && candidate.model === route.model && candidate.thinking === route.thinking,
			)
		)
			return;
		routes.push(route);
	};
	add({ provider: current.provider, model: current.id, thinking });
	for (const level of lowerLevels) {
		if (supportsThinking(current, level)) add({ provider: current.provider, model: current.id, thinking: level });
	}
	const alternatives = catalog
		.filter((model) => model.provider !== current.provider || model.id !== current.id)
		.sort((left, right) => {
			const providerPriority = Number(left.provider !== current.provider) - Number(right.provider !== current.provider);
			return (
				providerPriority ||
				modelCost(left) - modelCost(right) ||
				left.provider.localeCompare(right.provider) ||
				left.id.localeCompare(right.id)
			);
		});
	for (const model of alternatives) {
		const level = [thinking, ...lowerLevels].find((candidate) => supportsThinking(model, candidate)) ?? "off";
		add({ provider: model.provider, model: model.id, thinking: level });
	}
	return routes;
}

async function syncAvailableRoutes(pi: ExtensionAPI, client: JittorExtensionClient, ctx: ExtensionContext): Promise<void> {
	const session_id = ctx.sessionManager.getSessionId();
	const secret = sessionSecretField(session_id);
	if (!ctx.model) {
		await client.call("router.available_routes", { routes: [], session_id, ...secret });
		return;
	}
	const models = ctx.modelRegistry.getAvailable() as PiRouteModel[];
	const routes = routesFromPi(models, ctx.model as PiRouteModel, pi.getThinkingLevel());
	await client.call("router.available_routes", { routes, session_id, ...secret });
}

async function syncCurrentRoute(
	pi: ExtensionAPI,
	client: JittorExtensionClient,
	ctx: ExtensionContext,
	model = ctx.model,
	thinking = pi.getThinkingLevel(),
): Promise<void> {
	if (!model) return;
	const session_id = ctx.sessionManager.getSessionId();
	await client.call("router.current_route", {
		provider: model.provider,
		model: model.id,
		thinking,
		session_id,
		...sessionSecretField(session_id),
	});
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
	if (!decision.route || (await applyRoute(pi, ctx, decision.route))) return true;
	if (allowResync) {
		await syncAvailableRoutes(pi, client, ctx);
		return applyDecision(
			pi,
			client,
			ctx,
			(await client.call("router.decide", { session_id: ctx.sessionManager.getSessionId() })) as PolicyDecision,
			false,
		);
	}
	return halt(
		ctx,
		`Jittor could not apply any authenticated Pi route after ${decision.route.provider}/${decision.route.model} became unavailable`,
	);
}

/**
 * taskId, when a Papyrus task is focused, tags the metric for cost-per-task correlation. thinking
 * comes from pi.getThinkingLevel() at message_end time, not from the message itself -- AssistantMessage
 * has no thinking field of its own, and the level can't have changed mid-message.
 */
function assistantUsageMetrics(
	message: unknown,
	observedAt: number,
	taskId: string | null = null,
	thinking: string | null = null,
): MetricObservation[] {
	if (typeof message !== "object" || message === null || Array.isArray(message)) return [];
	const value = message as Record<string, unknown>;
	if (value.role !== "assistant" || typeof value.usage !== "object" || value.usage === null) return [];
	const usage = value.usage as Record<string, unknown>;
	const provider = typeof value.provider === "string" ? value.provider : "unknown";
	const model = typeof value.model === "string" ? value.model : "unknown";
	const scope = `${provider}:${model}`;
	const attributes = {
		provider,
		model,
		...(taskId === null ? {} : { taskId }),
		...(thinking === null || thinking.length === 0 ? {} : { thinking }),
	};
	const metrics: MetricObservation[] = [];
	for (const [field, metric] of [
		["input", "input-tokens"],
		["output", "output-tokens"],
		["cacheRead", "cache-read-tokens"],
		["cacheWrite", "cache-write-tokens"],
	] as const) {
		const amount = usage[field];
		if (typeof amount === "number" && Number.isFinite(amount))
			metrics.push({ source: "pi", scope, metric, value: amount, unit: "tokens", observedAt, attributes });
	}
	const cost = typeof usage.cost === "object" && usage.cost !== null ? (usage.cost as Record<string, unknown>).total : undefined;
	if (typeof cost === "number" && Number.isFinite(cost))
		metrics.push({ source: "pi", scope, metric: "cost", value: cost, unit: "usd", observedAt, attributes });
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
	const usageBudgets = usageBudgetControl(enforcement);
	let compactionTelemetry = new CompactionTelemetry();
	const localRunTelemetry = new LocalRunTelemetry();
	const providerResponseTelemetry = new ProviderResponseTelemetry();
	const codexRecoveryCapability = new CodexRecoveryCapability(pi, codexRecovery, recoveryRuntime);
	const contextHub = new ContextHubCapability();
	const stopContextHub = pi.events?.on?.(CONTEXT_HUB_CONTRIBUTION_CHANNEL, (payload) => contextHub.observe(payload));
	// Cached from the most recent before_agent_start observation: Pi's own base system prompt is
	// only ever visible transiently inside that hook's event, so /context reuses this rather than
	// going without it entirely. Measured as of THIS extension's own place in the before_agent_start
	// chain -- see buildBasePromptItems' own doc comment for the load-order caveat this implies.
	let lastObservedBasePromptTokens: number | null = null;
	let lastObservedBasePromptItems: ContextSegmentItem[] = [];
	const contextObservations = new Set<string>();
	const stopPapyrusContext = pi.events?.on?.(PAPYRUS_CONTEXT_INJECTION_CHANNEL, (payload) => {
		try {
			const observation = validatePapyrusContextInjection(payload);
			const observationKey = `${observation.producerId}:${observation.sequence}`;
			if (contextObservations.has(observationKey)) return;
			contextObservations.add(observationKey);
			if (contextObservations.size > CONTEXT_EVENT_DEDUP_LIMIT) contextObservations.delete(contextObservations.values().next().value!);
			compactionTelemetry.observeInjection(observation.injected.characters, observation.estimatedTokens);
			void recordMetrics(client, [papyrusContextMetric(observation)]).catch(() => undefined);
		} catch {
			// Reject malformed or stale cross-extension observations without retaining payloads.
		}
	});
	// Real-time cost-per-task correlation: Jittor observes Papyrus's task-focus broadcasts (Papyrus
	// never depends on Jittor) and tags newly recorded token/cost metrics with the currently focused
	// task id. Scoped to this Pi session: a focus change in a different concurrent session must not
	// affect this one's attribution.
	let currentSessionId: string | undefined;
	let focusedTaskId: string | null = null;
	const stopPapyrusTaskFocus = pi.events?.on?.(PAPYRUS_TASK_FOCUS_CHANNEL, (payload) => {
		try {
			const event = validateTaskFocusEvent(payload);
			if (event.sessionId !== undefined && event.sessionId !== currentSessionId) return;
			focusedTaskId = applyTaskFocusEvent(event);
		} catch {
			// Reject malformed or stale cross-extension events without retaining payloads or crashing the extension.
		}
	});
	const cancelRecovery = (resetPolicy: boolean): void => codexRecoveryCapability.cancel(resetPolicy);
	const recoveryStatusText = (): string => codexRecoveryCapability.statusText();
	const scheduleCodexRecovery = (ctx: ExtensionContext): void => codexRecoveryCapability.scheduleIfIdle(ctx);
	let compactionTimer: ReturnType<typeof setInterval> | undefined;
	const finishCompactionUi = (): void => {
		if (compactionTimer) clearInterval(compactionTimer);
		compactionTimer = undefined;
		footerState.compaction = undefined;
		footerState.requestRender?.();
	};
	const beginCompactionUi = (ctx: ExtensionContext, signal: AbortSignal): void => {
		finishCompactionUi();
		const usage = ctx.getContextUsage();
		const compaction: CompactionProgress = {
			startedAt: Date.now(),
			initialFraction: usage?.percent === null || usage?.percent === undefined ? 1 : usage.percent / 100,
			estimatedMs: null,
			confidence: "cold-start",
		};
		footerState.compaction = compaction;
		// Non-blocking: compaction UI starts immediately as cold-start; if a learned estimate resolves
		// before this compaction finishes (and this is still the active compaction, not a later one),
		// upgrade the same progress object in place so the drain bar and status text switch to "learned".
		void client
			.call("compaction.estimate", {})
			.then((estimate) => {
				if (footerState.compaction !== compaction || estimate.confidence !== "learned" || estimate.ms === null) return;
				footerState.compaction = { ...compaction, estimatedMs: estimate.ms, confidence: "learned" };
				footerState.requestRender?.();
			})
			.catch(() => undefined);
		compactionTimer = setInterval(() => footerState.requestRender?.(), FOOTER_COMPACTION_RENDER_INTERVAL_MS);
		signal.addEventListener("abort", finishCompactionUi, { once: true });
		if (signal.aborted) finishCompactionUi();
		else footerState.requestRender?.();
	};
	const showFooter = (ctx: ExtensionContext): void => {
		if (enforcement.isFooterEnabled()) installIntegratedFooter(ctx, footerState, () => pi.getThinkingLevel());
		else ctx.ui.setFooter(undefined);
	};
	const disable = async (ctx: ExtensionContext): Promise<void> => {
		await enforcement.setEnabled(false);
		ctx.ui.setStatus("jittor", undefined);
		showFooter(ctx);
		ctx.ui.notify(
			"Jittor enforcement is off (monitor-only); the informational footer remains independent and provider requests will not be blocked.",
			"warning",
		);
	};
	const enable = async (ctx: ExtensionContext): Promise<void> => {
		try {
			await syncCurrentRoute(pi, client, ctx);
			await syncAvailableRoutes(pi, client, ctx);
			await client.call("telemetry.poll", {});
			const readinessDecision = (await client.call("router.decide", { session_id: ctx.sessionManager.getSessionId() })) as PolicyDecision;
			if (readinessDecision.action === "halt") throw new Error(readinessDecision.reason);
			await enforcement.setEnabled(true);
			showFooter(ctx);
			await refreshFooter(client, footerState, ctx.sessionManager.getSessionId());
			ctx.ui.notify("Jittor enforcement enabled.", "info");
		} catch (error) {
			await enforcement.setEnabled(false);
			showFooter(ctx);
			const reason = error instanceof Error ? error.message : "readiness failed";
			ctx.ui.notify(`Jittor remains monitor-only: ${reason}. ${RECOVERY_GUIDANCE}.`, "error");
		}
	};

	pi.registerCommand("jittor", {
		description: "Jittor settings, routing status, benchmarks, and Codex recovery controls",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action === "" || action === "settings") {
				await showSettingsPanel(ctx, enforcement, codexRecovery, usageBudgets, {
					setEnforcement: async (enabled) => (enabled ? enable(ctx) : disable(ctx)),
					setFooter: async (enabled) => {
						await enforcement.setFooterEnabled(enabled);
						showFooter(ctx);
						if (enabled) await refreshFooter(client, footerState, ctx.sessionManager.getSessionId()).catch(() => undefined);
					},
					setRecovery: async (enabled) => {
						if (!enabled) cancelRecovery(true);
						await codexRecovery.setCodexRecoveryEnabled(enabled);
					},
				});
				return;
			}
			if (action === "benchmarks" || action.startsWith("benchmarks ")) {
				if (!ctx.model) {
					ctx.ui.notify("No active Pi model is available for benchmark recommendations.", "warning");
					return;
				}
				// Domain (subject matter, e.g. coding) and type (activity, e.g. research/planning) are
				// independent axes -- each positional word is classified against whichever axis it
				// belongs to, in either order, so "/jittor benchmarks coding research" and
				// "/jittor benchmarks research coding" both work; an unmatched word is a usage error.
				const requested = action.split(/\s+/).slice(1);
				let requestedDomain: ModelTaskDomain | undefined;
				let requestedType: ModelTaskType | undefined;
				let malformed = requested.length > 2;
				for (const word of requested) {
					if (TASK_DOMAINS.includes(word as ModelTaskDomain) && requestedDomain === undefined) requestedDomain = word as ModelTaskDomain;
					else if (TASK_TYPES.includes(word as ModelTaskType) && requestedType === undefined) requestedType = word as ModelTaskType;
					else malformed = true;
				}
				if (malformed) {
					ctx.ui.notify("Usage: /jittor benchmarks [coding|general] [research|planning|general]", "warning");
					return;
				}
				const candidates = benchmarkCandidatesFromPi(ctx.modelRegistry.getAvailable() as PiRouteModel[], pi.getThinkingLevel());
				await showBenchmarkPanel(
					ctx,
					client,
					candidates,
					`${ctx.model.provider}/${ctx.model.id}`,
					requestedDomain ?? "general",
					requestedType ?? "general",
				);
				return;
			}
			if (action === "outcome accepted" || action === "outcome rejected") {
				const explicitOutcome = action.endsWith("accepted") ? ("accepted" as const) : ("rejected" as const);
				const outcomeMetric = localRunTelemetry.explicitOutcomeMetric(explicitOutcome);
				if (!outcomeMetric) {
					ctx.ui.notify("No completed local model run is available for an explicit outcome.", "warning");
					return;
				}
				outcomeMetric.observedAt = Date.now();
				await recordMetrics(client, [outcomeMetric]);
				ctx.ui.notify(`Recorded explicit ${explicitOutcome} outcome for the latest local model run.`, "info");
				return;
			}
			if (action === "recovery" || action === "recovery status") {
				ctx.ui.notify(recoveryStatusText(), "info");
				return;
			}
			if (action === "recovery on" || action === "recovery enable") {
				await codexRecovery.setCodexRecoveryEnabled(true);
				ctx.ui.notify("Jittor Codex recovery enabled; bounded retries begin only after transient failures fully settle.", "info");
				return;
			}
			if (action === "recovery off" || action === "recovery disable") {
				cancelRecovery(true);
				await codexRecovery.setCodexRecoveryEnabled(false);
				ctx.ui.notify("Jittor Codex recovery disabled and pending recovery cleared.", "info");
				return;
			}
			if (action === "recovery cancel") {
				cancelRecovery(true);
				ctx.ui.notify(
					`Jittor Codex recovery cooldown and attempt window cleared; recovery remains ${codexRecovery.isCodexRecoveryEnabled() ? "on" : "off"}.`,
					"info",
				);
				return;
			}
			if (action === "off" || action === "disable") {
				await disable(ctx);
				return;
			}
			if (action === "on" || action === "enable") {
				await enable(ctx);
				return;
			}
			if (action === "footer off" || action === "footer disable") {
				await enforcement.setFooterEnabled(false);
				ctx.ui.setFooter(undefined);
				ctx.ui.notify("Jittor footer disabled; routing enforcement is unchanged.", "info");
				return;
			}
			if (action === "footer on" || action === "footer enable") {
				await enforcement.setFooterEnabled(true);
				showFooter(ctx);
				await refreshFooter(client, footerState, ctx.sessionManager.getSessionId()).catch(() => undefined);
				ctx.ui.notify("Jittor informational footer enabled; routing enforcement is unchanged.", "info");
				return;
			}
			if (action === "context") {
				const summary = (await client.call("context.assess", {})) as ContextAssessment;
				const average =
					summary.injection.averageCharacters === null ? "unknown" : Math.round(summary.injection.averageCharacters).toLocaleString();
				const p95 = summary.injection.p95Characters === null ? "unknown" : Math.round(summary.injection.p95Characters).toLocaleString();
				ctx.ui.notify(
					[
						`Papyrus injection: ${summary.injection.runs} runs · avg ${average} chars · p95 ${p95} chars · unchanged ${summary.injection.unchangedRate === null ? "unknown" : `${(summary.injection.unchangedRate * 100).toFixed(1)}%`}`,
						`Mix: rules ${summary.injection.ruleCharacters.toLocaleString()} chars · tasks ${summary.injection.taskCharacters.toLocaleString()} chars · estimated ${summary.injection.estimatedTokens.toLocaleString()} tokens`,
						`Compactions: ${summary.compaction.completed} completed · ${summary.compaction.aborted} aborted · ${summary.compaction.perRun === null ? "unknown" : summary.compaction.perRun.toFixed(3)} per agent run · ${summary.compaction.perTurn === null ? "unknown" : summary.compaction.perTurn.toFixed(3)} per turn`,
						`Completeness: ${summary.completeness}`,
					].join("\n"),
					"info",
				);
				return;
			}
			// Reached only for the explicit "status" keyword or any other unrecognized text; bare "" is
			// handled above by the settings branch, so this always has a non-empty, non-settings action.
			if (!enforcement.isEnabled()) {
				ctx.ui.notify("Jittor is monitor-only. Run /jittor on to re-enable blocking.", "info");
				return;
			}
			await showJittorPanel(ctx, client);
		},
	});

	pi.registerCommand("context", {
		description:
			"Context Hub: real usage plus every segment's estimated size (base prompt, message history, tool schemas by owning extension, and whatever other extensions contributed), each tagged with how it was attributed",
		handler: async (_args, ctx) => {
			const activeToolNames = new Set(pi.getActiveTools());
			const toolSegment = toolLedgerSegment(pi.getAllTools().filter((tool) => activeToolNames.has(tool.name)));
			// Real tree (not just the linear current-branch path): surfaces content sitting in an
			// abandoned /tree branch, which cost real tokens to generate but isn't in context now.
			const tree = ctx.sessionManager.getTree() as SessionTreeNodeLike[];
			// buildContextEntries(), NOT getBranch(): getBranch() returns every raw entry on the current
			// path including everything a real compaction has already summarized away.
			const activeEntryIds = new Set((ctx.sessionManager.buildContextEntries() as SessionEntryLike[]).map((entry) => entry.id));
			const branchEntryIds = new Set((ctx.sessionManager.getBranch() as SessionEntryLike[]).map((entry) => entry.id));
			const messageHistory = buildMessageHistoryTree(tree, activeEntryIds, branchEntryIds);
			const usage = ctx.getContextUsage();
			const ownSegments = [
				basePromptSegment(lastObservedBasePromptTokens, lastObservedBasePromptItems),
				messageHistorySegment(messageHistory),
				toolSegment,
			];
			const breakdown = composeContextBreakdown({
				totalTokens: usage?.tokens ?? null,
				contextWindow: ctx.model?.contextWindow ?? null,
				segments: [...ownSegments, ...contextHub.contributedSegments()],
			});
			await showContextView(ctx, breakdown);
		},
	});

	pi.registerCommand("usage", {
		description: "Cumulative token/cost usage graph with hourly/daily/weekly/monthly/quarterly views",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action === "budget" || action.startsWith("budget ")) {
				const [, periodText, valueText] = action.split(/\s+/);
				const period = USAGE_PERIODS.some((candidate) => candidate.id === periodText) ? (periodText as UsagePeriod) : undefined;
				if (!period) {
					const values = USAGE_PERIODS.map(
						({ id, label }) => `${label}: ${usageBudgets.getUsageTokenBudget(id)?.toLocaleString() ?? "not configured"}`,
					).join(" · ");
					ctx.ui.notify(`Token budgets · ${values}`, "info");
					return;
				}
				if (valueText === undefined) {
					ctx.ui.notify(
						`${USAGE_PERIODS.find((candidate) => candidate.id === period)!.label} token budget: ${usageBudgets.getUsageTokenBudget(period)?.toLocaleString() ?? "not configured"}`,
						"info",
					);
					return;
				}
				if (valueText === "off" || valueText === "clear") {
					await usageBudgets.setUsageTokenBudget(period, undefined);
					ctx.ui.notify(`${USAGE_PERIODS.find((candidate) => candidate.id === period)!.label} token budget cleared.`, "info");
					return;
				}
				const tokens = Number(valueText.replaceAll(",", ""));
				if (!Number.isFinite(tokens) || tokens <= 0) {
					ctx.ui.notify("Usage: /usage budget <hourly|daily|weekly|monthly|quarterly> <positive-tokens|off>", "warning");
					return;
				}
				await usageBudgets.setUsageTokenBudget(period, tokens);
				ctx.ui.notify(
					`${USAGE_PERIODS.find((candidate) => candidate.id === period)!.label} token budget set to ${tokens.toLocaleString()} tokens.`,
					"info",
				);
				return;
			}
			if (action !== "" && action !== "cost" && action !== "tokens") {
				ctx.ui.notify("Usage: /usage [cost] | /usage budget <hourly|daily|weekly|monthly|quarterly> <positive-tokens|off>", "warning");
				return;
			}
			await showUsagePanel(ctx, client, usageBudgets, Date.now(), action === "cost" ? "cost" : "tokens");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		currentSessionId = ctx.sessionManager.getSessionId();
		focusedTaskId = null;
		finishCompactionUi();
		compactionTelemetry = new CompactionTelemetry();
		localRunTelemetry.reset();
		contextHub.reset();
		cancelRecovery(true);
		providerResponseTelemetry.resetTurn();
		ctx.ui.setStatus("jittor", undefined);
		showFooter(ctx);
		// Registered before any router-mutating call could plausibly happen, closing most of the
		// first-touch registration window; best-effort -- a registration failure leaves this session
		// unarmored (opt-in armor), never blocked.
		try {
			const { secret } = await client.call("session.register", { session_id: currentSessionId });
			cacheSessionSecret(currentSessionId, secret);
		} catch {
			// Unarmored for this session; every router.* call still works exactly as before.
		}
		try {
			await syncCurrentRoute(pi, client, ctx);
			await syncAvailableRoutes(pi, client, ctx);
			await client.call("telemetry.poll", {});
			await refreshFooter(client, footerState, ctx.sessionManager.getSessionId());
		} catch {
			footerState.providerBudget = null;
			footerState.requestRender?.();
		}
	});

	pi.on("before_agent_start", async (event) => {
		// No new hook, no new risk: measures event.systemPrompt's length and structural
		// event.systemPromptOptions as-of this handler's own place in the before_agent_start chain --
		// see buildBasePromptItems' own doc comment for the resulting load-order caveat.
		const characters = (event.systemPrompt ?? "").length;
		lastObservedBasePromptTokens = Math.ceil(characters / CONTEXT_ESTIMATE_CHARACTERS_PER_TOKEN);
		lastObservedBasePromptItems = buildBasePromptItems(event.systemPromptOptions, characters);
	});

	pi.on("session_before_compact", async (event, ctx) => {
		beginCompactionUi(ctx, event.signal);
		const usage = ctx.getContextUsage();
		const metric = compactionTelemetry.begin({
			reason: event.reason,
			willRetry: event.willRetry,
			...(usage?.percent === null || usage?.percent === undefined ? {} : { contextPercent: usage.percent }),
			...(usage?.tokens === null || usage?.tokens === undefined ? {} : { contextTokens: usage.tokens }),
		});
		await recordMetrics(client, [metric]).catch(() => undefined);
	});

	pi.on("session_compact", async (event) => {
		finishCompactionUi();
		await recordMetrics(client, [compactionTelemetry.complete({ reason: event.reason, willRetry: event.willRetry })]).catch(
			() => undefined,
		);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (footerState.compaction) {
			finishCompactionUi();
			if (compactionTelemetry.hasOpenCompaction())
				await recordMetrics(client, [compactionTelemetry.abort(Date.now(), "agent-settled-without-completion")]).catch(() => undefined);
		}
		scheduleCodexRecovery(ctx);
		if (!enforcement.isFooterEnabled()) return;
		try {
			await syncCurrentRoute(pi, client, ctx);
			await syncAvailableRoutes(pi, client, ctx);
			await refreshFooter(client, footerState, ctx.sessionManager.getSessionId());
		} catch {
			footerState.providerBudget = null;
			footerState.requestRender?.();
		}
	});

	pi.on("input", async (event, ctx) => {
		if (event.source !== "extension") cancelRecovery(true);
		if (event.source === "extension" || !enforcement.isEnabled()) return { action: "continue" as const };
		try {
			const next = (await client.call("router.decide", { session_id: ctx.sessionManager.getSessionId() })) as PolicyDecision;
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
		await syncCurrentRoute(pi, client, ctx, event.model)
			.then(() => syncAvailableRoutes(pi, client, ctx))
			.catch(() => undefined);
		if (enforcement.isFooterEnabled()) await refreshFooter(client, footerState, ctx.sessionManager.getSessionId()).catch(() => undefined);
	});

	pi.on("thinking_level_select", async (event, ctx) => {
		await syncCurrentRoute(pi, client, ctx, ctx.model, event.level).catch(() => undefined);
	});

	pi.on("turn_start", async (event, ctx) => {
		currentSessionId = ctx.sessionManager.getSessionId();
		compactionTelemetry.observeTurn();
		codexRecoveryCapability.resetTurn();
		providerResponseTelemetry.resetTurn();
		localRunTelemetry.beginTurn(event.timestamp);
		if (!enforcement.isEnabled()) return;
		try {
			await syncCurrentRoute(pi, client, ctx);
			await syncAvailableRoutes(pi, client, ctx);
			await applyDecision(
				pi,
				client,
				ctx,
				(await client.call("router.decide", { session_id: ctx.sessionManager.getSessionId() })) as PolicyDecision,
			);
			await refreshFooter(client, footerState, ctx.sessionManager.getSessionId());
		} catch {
			halt(ctx, "Jittor could not verify or apply a safe route");
		}
	});

	pi.on("message_update", async (event) => {
		localRunTelemetry.onMessageUpdate(event.assistantMessageEvent.type);
	});

	pi.on("tool_execution_end", async (event) => {
		localRunTelemetry.onToolExecutionEnd(event.toolName, event.isError);
	});

	pi.on("after_provider_response", async (event, ctx) => {
		localRunTelemetry.onProviderResponse();
		if (ctx.model?.provider === "openai-codex") codexRecoveryCapability.notifyResponse(event.status, event.headers);
		const notifySchemaDrift = (message: string) => {
			if (enforcement.isEnabled()) ctx.ui.notify(`Jittor detected ${message}. ${RECOVERY_GUIDANCE}.`, "error");
		};
		await providerResponseTelemetry.handleProviderResponse(client, ctx.model?.provider, event.status, event.headers, notifySchemaDrift);
		if (enforcement.isFooterEnabled()) await refreshFooter(client, footerState, ctx.sessionManager.getSessionId()).catch(() => undefined);
	});

	pi.on("turn_end", async (event) => {
		const metrics = localRunTelemetry.completeTurn(event.message, pi.getThinkingLevel());
		await recordMetrics(client, metrics).catch(() => undefined);
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role === "assistant") {
			if (event.message.provider === "openai-codex")
				codexRecoveryCapability.notifyMessageEnd(event.message.stopReason, event.message.errorMessage);
			await providerResponseTelemetry.handleMessageEnd(
				client,
				event.message.provider,
				event.message.stopReason,
				event.message.errorMessage,
			);
		}
		const metrics = assistantUsageMetrics(event.message, Date.now(), focusedTaskId, pi.getThinkingLevel());
		if (metrics.length > 0) {
			const amount = (name: string): number =>
				metrics
					.filter((metric) => metric.metric === name && typeof metric.value === "number")
					.reduce((sum, metric) => sum + (metric.value ?? 0), 0);
			compactionTelemetry.observeProviderUsage({
				input: amount("input-tokens"),
				output: amount("output-tokens"),
				cacheRead: amount("cache-read-tokens"),
				cacheWrite: amount("cache-write-tokens"),
			});
			await recordMetrics(client, metrics).catch(() => undefined);
		}
		if (enforcement.isFooterEnabled()) await refreshFooter(client, footerState, ctx.sessionManager.getSessionId()).catch(() => undefined);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		finishCompactionUi();
		if (compactionTelemetry.hasOpenCompaction())
			await recordMetrics(client, [compactionTelemetry.abort(Date.now(), "session-shutdown")]).catch(() => undefined);
		stopPapyrusContext?.();
		stopPapyrusTaskFocus?.();
		stopContextHub?.();
		cancelRecovery(true);
		localRunTelemetry.reset();
		const session_id = ctx.sessionManager.getSessionId();
		const secret = sessionSecretField(session_id);
		if (secret.session_secret) await client.call("session.release", { session_id, ...secret }).catch(() => undefined);
		forgetSessionSecret(session_id);
		ctx.ui.setStatus("jittor", undefined);
		ctx.ui.setFooter(undefined);
	});
}

export default function jittorExtension(pi: ExtensionAPI): void {
	registerJittorExtension(pi);
}

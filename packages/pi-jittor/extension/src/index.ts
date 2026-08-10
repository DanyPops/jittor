import type { ContextSegmentItem, ContextSnapshot } from "@danypops/jittor";
import {
	applyTaskFocusEvent,
	CONTEXT_ESTIMATE_CHARACTERS_PER_TOKEN,
	CONTEXT_EVENT_DEDUP_LIMIT,
	CONTEXT_HUB_CONTRIBUTION_CHANNEL,
	CompactionTelemetry,
	type ContextAssessment,
	classifyTaskFromTools,
	FOOTER_COMPACTION_RENDER_INTERVAL_MS,
	HmacContextFingerprinter,
	loadOpenAiTextTokenCounter,
	MAX_DYNAMIC_ROUTES,
	type MetricObservation,
	MILLISECONDS_PER_DAY,
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
	type TextTokenCounter,
	type TokenMeasurementScope,
	toolLedgerSegment,
	USAGE_PERIODS,
	type UsagePeriod,
	validatePapyrusContextInjection,
	validateTaskFocusEvent,
} from "@danypops/jittor";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { jittorArgumentCompletions, jittorUsageError } from "./jittor-command.ts";
import { showJittorShell } from "./jittor-shell.ts";
import {
	basePromptSegment,
	buildBasePromptItems,
	buildMessageHistoryTree,
	composeContextBreakdown,
	messageHistorySegment,
	type SessionEntryLike,
	type SessionTreeNodeLike,
} from "./observability/context-breakdown.ts";
import { ContextGrowthCapability } from "./observability/context-growth.ts";
import { ContextHubCapability } from "./observability/context-hub.ts";
import { showContextView } from "./observability/context-view.ts";
import { type CompactionProgress, type IntegratedFooterState, installIntegratedFooter } from "./observability/footer.ts";
import { LocalRunTelemetry } from "./observability/model-run.ts";
import { captureProviderContextSnapshot } from "./observability/provider-context-snapshot.ts";
import { ProviderResponseTelemetry } from "./observability/provider-response.ts";
import { buildFooterBudget, providerBudgetMetricQuery } from "./observability/status.ts";
import { showUsagePanel } from "./observability/usage.ts";
import { CodexRecoveryCapability, type CodexRecoveryRuntime, SYSTEM_RECOVERY_RUNTIME } from "./optimization/recovery/codex.ts";
import { callJittor } from "./service-client.ts";
import { cacheSessionSecret, forgetSessionSecret, sessionSecretField } from "./session-identity.ts";
import { type CodexRecoveryControl, type EnforcementControl, persistentEnforcementControl, type UsageBudgetControl } from "./settings.ts";

export { formatFooterStatus } from "./observability/status.ts";
export type { CodexRecoveryRuntime } from "./optimization/recovery/codex.ts";

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const textTokenCounterPromises = new Map<string, Promise<readonly TextTokenCounter[]>>();

function textTokenCounters(provider: string | undefined, model: string | undefined): Promise<readonly TextTokenCounter[]> {
	if (!provider || !model) return Promise.resolve([]);
	const key = `${provider}\u0000${model}`;
	let counters = textTokenCounterPromises.get(key);
	if (!counters) {
		counters = loadOpenAiTextTokenCounter(provider, model)
			.then((counter) => (counter ? [counter] : []))
			.catch(() => []);
		textTokenCounterPromises.set(key, counters);
	}
	return counters;
}
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

/**
 * Pi's own `--models`/`enabledModels` scoping (`ctx.scopedModels`, the same set the `/scoped-models`
 * command shows) is the authority for which models a session may actually use -- e.g. a "work"
 * profile scoped to one provider/model set versus a "personal" profile scoped to a different one.
 * `ctx.modelRegistry.getAvailable()` enumerates every authenticated model on the host regardless of
 * that restriction (Pi's own docs warn against using it for a model picker for exactly this reason:
 * "instead of enumerating the whole catalogue via ctx.modelRegistry.getAvailable()"). Every Jittor
 * call site that builds a candidate/route set for routing or ranking must prefer the scoped set
 * when one is configured, or a scoped session keeps seeing -- and can be automatically routed onto
 * -- another profile's models. An empty scopedModels list means "no scoping configured" (matching
 * Pi's own semantics), not "scoped to nothing", so it still falls back to the full catalog.
 */
function scopedOrAvailableModels(ctx: ExtensionContext): PiRouteModel[] {
	if (ctx.scopedModels.length > 0) return ctx.scopedModels.map((entry) => entry.model as PiRouteModel);
	return ctx.modelRegistry.getAvailable() as PiRouteModel[];
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
	const models = scopedOrAvailableModels(ctx);
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

let assistantUsageRunSequence = 0;

/**
 * taskId, when a Papyrus task is focused, tags the metric for cost-per-task correlation. thinking
 * comes from pi.getThinkingLevel() at message_end time, not from the message itself -- AssistantMessage
 * has no thinking field of its own, and the level can't have changed mid-message. sessionId tags every
 * row so cache economics (see @danypops/jittor's cache-economics.ts) can correlate a cache write back
 * to this same session's own context-prefix reset evidence, without ever widening scope by provider/model.
 * runId ties every metric emitted for this one turn together (a counter, not just observedAt, since
 * two turns can share a millisecond) so cache economics can resolve per-turn (e.g. tiered) catalog
 * pricing against this turn's own real size instead of a blended sum across a whole query window.
 */
function assistantUsageMetrics(
	message: unknown,
	observedAt: number,
	taskId: string | null = null,
	thinking: string | null = null,
	sessionId: string | null = null,
): MetricObservation[] {
	if (typeof message !== "object" || message === null || Array.isArray(message)) return [];
	const value = message as Record<string, unknown>;
	if (value.role !== "assistant" || typeof value.usage !== "object" || value.usage === null) return [];
	const usage = value.usage as Record<string, unknown>;
	const messageTimestamp = value.timestamp;
	const metricObservedAt =
		typeof messageTimestamp === "number" && Number.isSafeInteger(messageTimestamp) && messageTimestamp >= 0 ? messageTimestamp : observedAt;
	const provider = typeof value.provider === "string" ? value.provider : "unknown";
	const model = typeof value.model === "string" ? value.model : "unknown";
	const scope = `${provider}:${model}`;
	const runId = `pi-usage-${metricObservedAt}-${++assistantUsageRunSequence}`;
	const attributes = {
		provider,
		model,
		runId,
		...(taskId === null ? {} : { taskId }),
		...(thinking === null || thinking.length === 0 ? {} : { thinking }),
		...(sessionId === null || sessionId.length === 0 ? {} : { sessionId }),
	};
	const metrics: MetricObservation[] = [];
	for (const [field, metric, tokenScope] of [
		["input", "input-tokens", "request-input"],
		["output", "output-tokens", "response-output"],
		["cacheRead", "cache-read-tokens", "cache-read"],
		["cacheWrite", "cache-write-tokens", "cache-write"],
	] as const satisfies ReadonlyArray<readonly [string, string, TokenMeasurementScope]>) {
		const amount = usage[field];
		if (typeof amount === "number" && Number.isSafeInteger(amount) && amount >= 0)
			metrics.push({
				source: "pi",
				scope,
				metric,
				value: amount,
				unit: "tokens",
				observedAt: metricObservedAt,
				attributes: {
					...attributes,
					tokenMeasurement: {
						tokens: amount,
						scope: tokenScope,
						provenance: "provider-reported",
						method: "pi-assistant-usage",
						provider,
						model,
					},
				},
			});
	}
	const costBreakdown = typeof usage.cost === "object" && usage.cost !== null ? (usage.cost as Record<string, unknown>) : undefined;
	const cost = costBreakdown?.total;
	if (typeof cost === "number" && Number.isFinite(cost))
		metrics.push({ source: "pi", scope, metric: "cost", value: cost, unit: "usd", observedAt: metricObservedAt, attributes });
	// Itemized provider-reported cost, when the provider breaks it out -- the real dollar figures cache
	// economics needs (see cache-economics.ts) instead of ever re-deriving them from catalog prices when
	// the provider already told us. Never fabricated: omitted entirely when a field is absent.
	for (const [field, metric] of [
		["input", "input-cost"],
		["output", "output-cost"],
		["cacheRead", "cache-read-cost"],
		["cacheWrite", "cache-write-cost"],
	] as const satisfies ReadonlyArray<readonly [string, string]>) {
		const amount = costBreakdown?.[field];
		if (typeof amount === "number" && Number.isFinite(amount))
			metrics.push({ source: "pi", scope, metric, value: amount, unit: "usd", observedAt: metricObservedAt, attributes });
	}
	return metrics;
}

export function registerJittorExtension(
	pi: ExtensionAPI,
	client: JittorExtensionClient = daemonClient,
	enforcement: EnforcementControl = persistentEnforcementControl(),
	codexRecovery: CodexRecoveryControl = recoveryControl(enforcement),
	recoveryRuntime: CodexRecoveryRuntime = SYSTEM_RECOVERY_RUNTIME,
	contextGrowth: ContextGrowthCapability = new ContextGrowthCapability(),
): void {
	const footerState: IntegratedFooterState = { providerBudget: null };
	const usageBudgets = usageBudgetControl(enforcement);
	let compactionTelemetry = new CompactionTelemetry();
	let contextGrowthTurn = 0;
	const localRunTelemetry = new LocalRunTelemetry();
	const providerResponseTelemetry = new ProviderResponseTelemetry();
	const codexRecoveryCapability = new CodexRecoveryCapability(pi, codexRecovery, recoveryRuntime);
	const contextHub = new ContextHubCapability();
	const contextFingerprintKey = new Uint8Array(32);
	crypto.getRandomValues(contextFingerprintKey);
	const contextFingerprinter = new HmacContextFingerprinter(contextFingerprintKey);
	let contextCaptureSequence = 0;
	pi.on("before_provider_request", (event, ctx) => {
		try {
			const sessionId = ctx.sessionManager.getSessionId();
			let history:
				| {
						roots: SessionTreeNodeLike[];
						activeEntryIds: Set<string>;
						branchEntryIds: Set<string>;
				  }
				| undefined;
			try {
				history = {
					roots: ctx.sessionManager.getTree() as SessionTreeNodeLike[],
					activeEntryIds: new Set((ctx.sessionManager.buildContextEntries() as SessionEntryLike[]).map((entry) => entry.id)),
					branchEntryIds: new Set((ctx.sessionManager.getBranch() as SessionEntryLike[]).map((entry) => entry.id)),
				};
			} catch {
				// Older/custom SessionManager implementations may not expose tree projections.
			}
			const captureInput = {
				payload: event.payload,
				captureId: `${++contextCaptureSequence}`,
				sessionId,
				provider: ctx.model?.provider ?? "unknown",
				model: ctx.model?.id ?? "unknown",
				capturedAt: Date.now(),
				fingerprinter: contextFingerprinter,
			};
			let snapshot: ContextSnapshot;
			try {
				snapshot = captureProviderContextSnapshot({ ...captureInput, ...(history ? { history } : {}) });
			} catch {
				// A custom SessionManager tree shape must not suppress the real request-payload snapshot.
				snapshot = captureProviderContextSnapshot(captureInput);
			}
			// Observation must never alter or abort the provider request. Both local writes are detached;
			// they receive only bounded token sizes and keyed fingerprints.
			const requestTokens = snapshot.segments
				.filter((segment) => segment.requestPosition !== null)
				.reduce((sum, segment) => sum + segment.tokens, 0);
			const compactionMetrics = compactionTelemetry.observeContextSnapshot(requestTokens, "structural-estimate", snapshot.capturedAt, {
				provider: snapshot.provider,
				model: snapshot.model,
			});
			void client.call("context.snapshot", snapshot).catch(() => undefined);
			if (compactionMetrics.length > 0) void recordMetrics(client, compactionMetrics).catch(() => undefined);
		} catch {
			// Snapshot collection is strictly failure-isolated from provider delivery.
		}
	});
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
		description: "Jittor settings, routing status, benchmarks, cache economics, and Codex recovery controls",
		getArgumentCompletions: jittorArgumentCompletions,
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			const usageError = jittorUsageError(action);
			if (usageError) {
				ctx.ui.notify(usageError, "warning");
				return;
			}
			// One shared JittorShellDeps builder for every /jittor entry point below -- all four tabs
			// (Settings/Status/Benchmarks/Cache) are reachable from a single opened shell regardless of
			// which subcommand opened it, so every entry point needs the full dependency set, not just
			// its own tab's. `benchmarksTask` overrides the domain/type only for an explicit
			// "/jittor benchmarks ..." invocation; every other entry point defaults to general/general
			// (only meaningfully exercised if the user tab-cycles into Benchmarks from elsewhere).
			const buildShellDeps = (benchmarksTask?: {
				domain: ModelTaskDomain;
				type: ModelTaskType;
			}): Parameters<typeof showJittorShell>[1] => ({
				settings: {
					enforcement,
					recovery: codexRecovery,
					budgets: usageBudgets,
					effects: {
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
					},
				},
				status: { client },
				benchmarks: {
					client,
					candidates: benchmarkCandidatesFromPi(scopedOrAvailableModels(ctx), pi.getThinkingLevel()),
					currentIdentity: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "",
					domain: benchmarksTask?.domain ?? "general",
					type: benchmarksTask?.type ?? "general",
				},
				cache: { client, windowMs: 7 * MILLISECONDS_PER_DAY },
			});
			if (action === "" || action === "settings") {
				await showJittorShell(ctx, buildShellDeps(), "settings");
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
				await showJittorShell(
					ctx,
					buildShellDeps({ domain: requestedDomain ?? "general", type: requestedType ?? "general" }),
					"benchmarks",
				);
				return;
			}
			if (action === "cache") {
				await showJittorShell(ctx, buildShellDeps(), "cache");
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
						`Effectiveness: ${summary.compaction.effectivenessSamples} samples · avg reduction ${summary.compaction.averageReductionRatio === null ? "unknown" : `${(summary.compaction.averageReductionRatio * 100).toFixed(1)}%`} · mechanisms Pi/provider/extension ${summary.compaction.mechanisms["pi-native"]}/${summary.compaction.mechanisms["provider-side"]}/${summary.compaction.mechanisms.extension}`,
						`Completeness: ${summary.completeness}`,
					].join("\n"),
					"info",
				);
				return;
			}
			// Reached only for the explicit "status" keyword -- jittorUsageError above already rejected
			// anything else this handler doesn't recognize, so this is never an unrecognized fallback.
			if (!enforcement.isEnabled()) {
				ctx.ui.notify("Jittor is monitor-only. Run /jittor on to re-enable blocking.", "info");
				return;
			}
			await showJittorShell(ctx, buildShellDeps(), "status");
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
			const messageHistory = buildMessageHistoryTree(tree, activeEntryIds, branchEntryIds, {
				...(ctx.model ? { provider: ctx.model.provider, model: ctx.model.id } : {}),
				counters: await textTokenCounters(ctx.model?.provider, ctx.model?.id),
			});
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
			const opaqueSessionId = contextFingerprinter.fingerprint(`session:${ctx.sessionManager.getSessionId()}`);
			const delta = await client.call("context.delta", { session_id: opaqueSessionId }).catch(() => null);
			await showContextView(ctx, breakdown, delta);
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
		contextGrowthTurn = 0;
		contextGrowth.reset();
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
		const preparationTokens = event.preparation?.tokensBefore;
		const metric = compactionTelemetry.begin({
			reason: event.reason,
			willRetry: event.willRetry,
			mechanism: "pi-native",
			provider: ctx.model?.provider ?? "unknown",
			model: ctx.model?.id ?? "unknown",
			...(usage?.percent === null || usage?.percent === undefined ? {} : { contextPercent: usage.percent }),
			...(typeof preparationTokens === "number" && Number.isSafeInteger(preparationTokens) && preparationTokens > 0
				? { contextTokens: preparationTokens, contextProvenance: "structural-estimate" as const }
				: usage?.tokens === null || usage?.tokens === undefined
					? {}
					: { contextTokens: usage.tokens, contextProvenance: "provider-reported" as const }),
		});
		await recordMetrics(client, [metric]).catch(() => undefined);
	});

	pi.on("session_compact", async (event) => {
		finishCompactionUi();
		contextGrowth.reset();
		const summary = event.compactionEntry?.summary;
		await recordMetrics(client, [
			compactionTelemetry.complete({
				reason: event.reason,
				willRetry: event.willRetry,
				mechanism: event.fromExtension ? "extension" : "pi-native",
				...(typeof summary === "string"
					? {
							summaryTokens: Math.ceil(summary.length / CONTEXT_ESTIMATE_CHARACTERS_PER_TOKEN),
							summaryProvenance: "structural-estimate" as const,
						}
					: {}),
			}),
		]).catch(() => undefined);
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
		const classification = classifyTaskFromTools([event.toolName]);
		compactionTelemetry.observeToolClass(`${classification.domain}-${classification.type}`, event.isError);
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

	pi.on("turn_end", async (event, ctx) => {
		const tokens = ctx.getContextUsage()?.tokens;
		if (typeof tokens === "number" && Number.isFinite(tokens)) contextGrowth.observe(++contextGrowthTurn, tokens);
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
		const metrics = assistantUsageMetrics(
			event.message,
			Date.now(),
			focusedTaskId,
			pi.getThinkingLevel(),
			ctx.sessionManager.getSessionId(),
		);
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

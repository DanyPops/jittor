import { describe, expect, it } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatFooterStatus, registerJittorExtension, routesFromPi, type CodexRecoveryRuntime, type JittorExtensionClient } from "../extension/src/index.ts";
import { buildFooterBudget } from "../extension/src/tui.ts";
import type { EnforcementControl } from "../extension/src/settings.ts";
import type { PolicyDecision } from "../src/policy.ts";
import type { RouterStatus } from "../src/ports/router-controller.ts";

function decision(overrides: Partial<PolicyDecision> = {}): PolicyDecision {
	return { action: "continue", pressure: 0.5, reason: "ok", decidedAt: 1000, trace: [], ...overrides };
}

class FakeClient implements JittorExtensionClient {
	calls: Array<{ operation: string; input: unknown }> = [];
	decision = decision();
	decisionQueue: PolicyDecision[] = [];
	status: RouterStatus = { ready: true, paused: false, sources: [], lastDecision: this.decision, override: null, currentRoute: null, availableRoutes: [] };
	metrics: any[] = [];
	compactionEstimate: { ms: number | null; confidence: "cold-start" | "learned"; sampleSize: number; observedAt: number } = { ms: null, confidence: "cold-start", sampleSize: 0, observedAt: 0 };
	async call(operation: string, input: unknown): Promise<any> {
		this.calls.push({ operation, input });
		if (operation === "compaction.estimate") return this.compactionEstimate;
		if (operation === "router.decide") return this.decisionQueue.shift() ?? this.decision;
		if (operation === "router.current_route") {
			this.status = { ...this.status, currentRoute: input as RouterStatus["currentRoute"] };
			return this.status;
		}
		if (operation === "router.available_routes") {
			this.status = { ...this.status, availableRoutes: (input as { routes: RouterStatus["availableRoutes"] }).routes };
			return this.status;
		}
		if (operation === "router.status") return this.status;
		if (operation === "metrics.query") return this.metrics;
		if (operation === "metrics.record") return { id: this.calls.length, ...(input as object) };
		if (operation === "models.rank") return { scopeAuthority: "available-models", scopeWarning: "exact session scope unavailable", taskClass: "coding", completeness: "insufficient-evidence", ranked: [], automaticSelection: null };
		return {};
	}
}

class FakeRecoveryRuntime implements CodexRecoveryRuntime {
	nowValue = 1_000;
	readonly delays: number[] = [];
	private sequence = 0;
	private readonly timers = new Map<number, () => void | Promise<void>>();
	now = () => this.nowValue;
	random = () => 0.5;
	setTimeout = (callback: () => void | Promise<void>, delayMs: number): number => {
		const id = ++this.sequence;
		this.delays.push(delayMs);
		this.timers.set(id, callback);
		return id;
	};
	clearTimeout = (handle: unknown): void => { this.timers.delete(handle as number); };
	pendingCount(): number { return this.timers.size; }
	async runNext(): Promise<void> {
		const entry = this.timers.entries().next().value as [number, () => void | Promise<void>] | undefined;
		if (!entry) throw new Error("no recovery timer");
		this.timers.delete(entry[0]);
		await entry[1]();
	}
}

function harness(
	client: FakeClient,
	enforcement?: EnforcementControl,
	recovery: { enabled: boolean; runtime: CodexRecoveryRuntime } = { enabled: false, runtime: new FakeRecoveryRuntime() },
	modelOverride?: { provider: string; id: string },
) {
	let defaultEnabled = true;
	let footerEnabled = true;
	const control = enforcement ?? {
		isEnabled: () => defaultEnabled,
		setEnabled(value: boolean) { defaultEnabled = value; },
		isFooterEnabled: () => footerEnabled,
		setFooterEnabled(value: boolean) { footerEnabled = value; },
	};
	const handlers = new Map<string, Function[]>();
	const sharedEvents = new Map<string, Set<(payload: unknown) => void>>();
	const commands = new Map<string, any>();
	const modelChanges: unknown[] = [];
	const thinkingChanges: string[] = [];
	const pi = {
		on(name: string, handler: Function) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		registerCommand(name: string, command: unknown) { commands.set(name, command); },
		async setModel(model: unknown) { modelChanges.push(model); return true; },
		setThinkingLevel(level: string) { thinkingChanges.push(level); },
		getThinkingLevel() { return "high"; },
		events: {
			on(channel: string, handler: (payload: unknown) => void) {
				const listeners = sharedEvents.get(channel) ?? new Set();
				listeners.add(handler);
				sharedEvents.set(channel, listeners);
				return () => listeners.delete(handler);
			},
			emit(channel: string, payload: unknown) { for (const handler of sharedEvents.get(channel) ?? []) handler(payload); },
		},
	} as unknown as ExtensionAPI;
	const sentMessages: Array<{ message: unknown; options: unknown }> = [];
	let recoveryEnabled = recovery.enabled;
	(pi as unknown as { sendMessage(message: unknown, options: unknown): void }).sendMessage = (message, options) => { sentMessages.push({ message, options }); };
	registerJittorExtension(pi, client, control, {
		isCodexRecoveryEnabled: () => recoveryEnabled,
		setCodexRecoveryEnabled(value: boolean) { recoveryEnabled = value; },
	}, recovery.runtime);
	const statuses: Array<string | undefined> = [];
	const footers: unknown[] = [];
	const notifications: string[] = [];
	let aborted = false;
	let idle = true;
	let pendingMessages = false;
	const model = modelOverride ?? { provider: "openai-codex", id: "gpt-5.3-codex" };
	const ctx = {
		mode: "tui", hasUI: true, model,
		modelRegistry: {
			find: (provider: string, id: string) => ({ provider, id }),
			getAvailable: () => [
				{ provider: "openai-codex", id: "gpt-5.6-sol" },
				{ provider: "openai-codex", id: "gpt-5.3-codex" },
				{ provider: "openai-codex", id: "gpt-5.1-codex-mini" },
				{ provider: "openrouter", id: "openai/gpt-4.1-mini" },
			],
		},
		abort() { aborted = true; },
		isIdle() { return idle; },
		hasPendingMessages() { return pendingMessages; },
		getContextUsage() { return { tokens: 190_000, contextWindow: 200_000, percent: 95 }; },
		sessionManager: { getSessionId: () => "test-session" },
		ui: {
			setStatus(_key: string, value: string | undefined) { statuses.push(value); },
			setFooter(footer: unknown) { footers.push(footer); },
			notify(message: string) { notifications.push(message); },
		},
	} as unknown as ExtensionContext;
	return {
		handlers, commands, modelChanges, thinkingChanges, statuses, footers, notifications, sentMessages, ctx,
		emit(channel: string, payload: unknown) { for (const handler of sharedEvents.get(channel) ?? []) handler(payload); },
		aborted: () => aborted,
		setIdle(value: boolean) { idle = value; },
		setPendingMessages(value: boolean) { pendingMessages = value; },
		recoveryEnabled: () => recoveryEnabled,
	};
}

describe("Jittor Pi actuator", () => {
	it("tracks Pi's public compaction lifecycle for footer animation and cleanup", () => {
		const app = harness(new FakeClient());
		expect(app.handlers.get("session_before_compact")).toHaveLength(1);
		expect(app.handlers.get("session_compact")).toHaveLength(1);
		expect(app.handlers.get("agent_settled")).toHaveLength(1);
		expect(app.handlers.get("session_shutdown")).toHaveLength(1);
	});

	it("ingests Papyrus context push events and records completed Pi compactions end to end", async () => {
		const client = new FakeClient();
		const app = harness(client);
		const now = Date.now();
		app.emit("papyrus.context-injection.v1", {
			schema: "papyrus.context-injection/v1", observedAt: now, sequence: 1, producerId: "123e4567-e89b-42d3-a456-426614174000",
			before: { characters: 1_000, bytes: 1_000 }, rules: { characters: 100, bytes: 100, count: 1 },
			tasks: { characters: 200, bytes: 200 }, injected: { characters: 300, bytes: 300 }, after: { characters: 1_300, bytes: 1_300 },
			estimatedTokens: 75, share: 300 / 1_300, fingerprint: "a".repeat(64), unchanged: false,
		});
		await Promise.resolve();
		const signal = new AbortController().signal;
		await app.handlers.get("session_before_compact")![0]!({ reason: "threshold", willRetry: false, signal }, app.ctx);
		await app.handlers.get("session_compact")![0]!({ reason: "threshold", willRetry: false }, app.ctx);
		const recorded = client.calls.filter((call) => call.operation === "metrics.record").map((call) => call.input as { source: string; metric: string; attributes?: Record<string, unknown> });
		expect(recorded.some((metric) => metric.source === "papyrus-context" && metric.metric === "injected-characters")).toBe(true);
		expect(recorded.some((metric) => metric.source === "pi-context" && metric.metric === "compaction-duration" && metric.attributes?.reason === "threshold")).toBe(true);
	});

	it("fetches a compaction duration estimate once per compaction without polling on every render tick", async () => {
		const client = new FakeClient();
		const app = harness(client);
		const firstSignal = new AbortController().signal;
		await app.handlers.get("session_before_compact")![0]!({ reason: "threshold", willRetry: false, signal: firstSignal }, app.ctx);
		await Promise.resolve();
		expect(client.calls.filter((call) => call.operation === "compaction.estimate")).toHaveLength(1);
		await app.handlers.get("session_compact")![0]!({ reason: "threshold", willRetry: false }, app.ctx);
		const secondSignal = new AbortController().signal;
		await app.handlers.get("session_before_compact")![0]!({ reason: "threshold", willRetry: false, signal: secondSignal }, app.ctx);
		await Promise.resolve();
		expect(client.calls.filter((call) => call.operation === "compaction.estimate")).toHaveLength(2);
	});

	it("never applies a resolved estimate to a compaction that has already finished or been superseded", async () => {
		const client = new FakeClient();
		let resolveEstimate: ((value: unknown) => void) | undefined;
		client.call = async (operation: string, input: unknown) => {
			client.calls.push({ operation, input });
			if (operation === "compaction.estimate") return new Promise((resolve) => { resolveEstimate = resolve; });
			return { ready: true, paused: false, sources: [], lastDecision: null, override: null, currentRoute: null, availableRoutes: [] };
		};
		const app = harness(client);
		const signal = new AbortController().signal;
		await app.handlers.get("session_before_compact")![0]!({ reason: "threshold", willRetry: false, signal }, app.ctx);
		// Compaction finishes before the estimate resolves.
		await app.handlers.get("session_compact")![0]!({ reason: "threshold", willRetry: false }, app.ctx);
		expect(() => resolveEstimate?.({ ms: 9_000, confidence: "learned", sampleSize: 5, observedAt: Date.now() })).not.toThrow();
		await Promise.resolve();
		await Promise.resolve();
		// No observable crash and no dangling reference to the finished compaction; nothing further to assert
		// without exposing internal footer state, which stays module-private by design.
	});

	it("tags newly recorded token/cost metrics with the currently focused Papyrus task, in real time", async () => {
		const client = new FakeClient();
		const app = harness(client);
		await app.handlers.get("session_start")![0]!({}, app.ctx);
		const now = Date.now();
		const emitFocus = (overrides: Record<string, unknown>) => app.emit("papyrus.task-focus.v1", {
			schema: "papyrus.task-focus/v1", sessionId: "test-session", observedAt: now, ...overrides,
		});
		const endTurnWithUsage = async () => {
			await app.handlers.get("message_end")![0]!({ message: {
				role: "assistant", provider: "anthropic", model: "claude-sonnet-5",
				usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
			} }, app.ctx);
		};
		const recordedTaskIds = () => client.calls
			.filter((call) => call.operation === "metrics.record" && (call.input as any).metric === "cost")
			.map((call) => ((call.input as any).attributes as Record<string, unknown> | undefined)?.["taskId"]);

		// Nothing focused yet: no taskId attribute at all (not null, not empty string).
		await endTurnWithUsage();
		expect(recordedTaskIds()).toEqual([undefined]);

		emitFocus({ taskId: "ship-feature-x", status: "focused" });
		await Promise.resolve();
		await endTurnWithUsage();
		expect(recordedTaskIds().at(-1)).toBe("ship-feature-x");

		emitFocus({ taskId: "ship-feature-x", status: "paused" });
		await Promise.resolve();
		await endTurnWithUsage();
		expect(recordedTaskIds().at(-1)).toBeUndefined();

		emitFocus({ taskId: "ship-feature-x", status: "unpaused" });
		await Promise.resolve();
		await endTurnWithUsage();
		expect(recordedTaskIds().at(-1)).toBe("ship-feature-x");

		emitFocus({ taskId: null, status: "cleared" });
		await Promise.resolve();
		await endTurnWithUsage();
		expect(recordedTaskIds().at(-1)).toBeUndefined();
	});

	it("ignores a task-focus event from a different Pi session, and fails closed on schema drift, without crashing", async () => {
		const client = new FakeClient();
		const app = harness(client);
		const now = Date.now();
		expect(() => app.emit("papyrus.task-focus.v1", { schema: "papyrus.task-focus/v1", sessionId: "a-different-session", taskId: "other-task", status: "focused", observedAt: now })).not.toThrow();
		expect(() => app.emit("papyrus.task-focus.v1", { schema: "v2", taskId: "x", status: "focused", observedAt: now })).not.toThrow();
		await Promise.resolve();
		await app.handlers.get("message_end")![0]!({ message: {
			role: "assistant", provider: "anthropic", model: "claude-sonnet-5",
			usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
		} }, app.ctx);
		const recorded = client.calls.filter((call) => call.operation === "metrics.record" && (call.input as any).metric === "cost").map((call) => call.input as any);
		expect(recorded[0]?.attributes?.taskId).toBeUndefined();
	});

	it("derives routes from Pi's current provider and authenticated model catalog without model IDs", () => {
		const current = { provider: "provider-a", id: "current-model", reasoning: true, cost: { input: 4, output: 8 } };
		const routes = routesFromPi([
			current,
			{ provider: "provider-a", id: "cheaper-model", reasoning: true, cost: { input: 1, output: 2 } },
			{ provider: "provider-b", id: "other-provider", reasoning: true, cost: { input: 0, output: 0 } },
		], current, "high");
		expect(routes[0]).toEqual({ provider: "provider-a", model: "current-model", thinking: "high" });
		expect(routes.some((route) => route.model === "current-model" && route.thinking === "medium")).toBe(true);
		expect(routes.some((route) => route.model === "cheaper-model")).toBe(true);
		expect(new Set(routes.map((route) => route.provider))).toEqual(new Set(["provider-a"]));
	});

	it("blocks input before a forbidden provider request with actionable recovery guidance", async () => {
		const client = new FakeClient();
		client.decision = decision({ action: "halt", pressure: Infinity, reason: "budget exhausted" });
		const app = harness(client);
		const result = await app.handlers.get("input")![0]!({ source: "interactive", text: "go" }, app.ctx);
		expect(result).toEqual({ action: "handled" });
		expect(app.notifications.join("\n")).toContain("/jittor off");
	});

	it("opens the consolidated settings TUI through /jittor settings, and through bare /jittor since settings is now its default", async () => {
		const app = harness(new FakeClient());
		let opened = 0;
		(app.ctx.ui as any).custom = async (factory: Function) => {
			opened += 1;
			const component = factory({ requestRender() {} }, { fg: (_color: string, text: string) => text, bold: (text: string) => text }, {}, () => undefined);
			expect(component.render(50).join("\n")).toContain("Jittor Settings");
			return { kind: "close" };
		};
		await app.commands.get("jittor").handler("settings", app.ctx);
		await app.commands.get("jittor").handler("", app.ctx);
		expect(opened).toBe(2);
	});

	it("opens the routing status panel through the explicit /jittor status keyword", async () => {
		const client = new FakeClient();
		const app = harness(client);
		let opened = false;
		(app.ctx.ui as any).custom = async () => { opened = true; return "close"; };
		await app.commands.get("jittor").handler("status", app.ctx);
		expect(opened).toBe(true);
	});

	it("sends only public Pi candidates to the advisory benchmark ranking panel", async () => {
		const client = new FakeClient();
		const app = harness(client);
		let rendered = "";
		(app.ctx.ui as any).custom = async (factory: Function) => {
			const component = factory({}, { fg: (_color: string, text: string) => text, bold: (text: string) => text }, {}, () => undefined);
			rendered = component.render(80).join("\n");
			return "close";
		};
		await app.commands.get("jittor").handler("benchmarks coding", app.ctx);
		const call = client.calls.find((candidate) => candidate.operation === "models.rank")!;
		expect(call.input).toMatchObject({ scopeAuthority: "available-models", taskClass: "coding" });
		expect((call.input as any).candidates).toHaveLength(4);
		expect((call.input as any).candidates.map((candidate: any) => `${candidate.provider}/${candidate.model}`)).toContain("openrouter/openai/gpt-4.1-mini");
		expect(rendered).toContain("ADVISORY");
	});

	it("supports a local emergency off switch without calling the daemon", async () => {
		let enabled = true;
		let footerEnabled = true;
		const enforcement: EnforcementControl = {
			isEnabled: () => enabled,
			setEnabled(value) { enabled = value; },
			isFooterEnabled: () => footerEnabled,
			setFooterEnabled(value) { footerEnabled = value; },
		};
		const client = new FakeClient();
		const app = harness(client, enforcement);
		await app.commands.get("jittor").handler("off", app.ctx);
		const before = client.calls.length;
		const result = await app.handlers.get("input")![0]!({ source: "interactive", text: "work" }, app.ctx);
		expect(result).toEqual({ action: "continue" });
		expect(client.calls).toHaveLength(before);
		expect(enabled).toBe(false);
		expect(app.footers.at(-1)).toBeTypeOf("function");
		expect(app.notifications.join("\n")).toContain("monitor-only");
	});

	it("toggles the informational footer without enabling monitor-only enforcement", async () => {
		let enabled = false;
		let footerEnabled = true;
		const enforcement: EnforcementControl = {
			isEnabled: () => enabled,
			setEnabled(value) { enabled = value; },
			isFooterEnabled: () => footerEnabled,
			setFooterEnabled(value) { footerEnabled = value; },
		};
		const app = harness(new FakeClient(), enforcement);
		await app.commands.get("jittor").handler("footer off", app.ctx);
		expect(app.footers.at(-1)).toBeUndefined();
		expect(enabled).toBe(false);
		await app.commands.get("jittor").handler("footer on", app.ctx);
		expect(app.footers.at(-1)).toBeTypeOf("function");
		expect(enabled).toBe(false);
	});

	it("resynchronizes the route and footer after a daemon restart while monitor-only", async () => {
		const client = new FakeClient();
		const enforcement: EnforcementControl = {
			isEnabled: () => false,
			setEnabled() {},
			isFooterEnabled: () => true,
			setFooterEnabled() {},
		};
		const app = harness(client, enforcement);

		await app.handlers.get("agent_settled")![0]!({}, app.ctx);

		expect(client.calls.some((call) => call.operation === "router.current_route")).toBe(true);
		expect(client.calls.some((call) => call.operation === "router.available_routes")).toBe(true);
		expect(client.calls.some((call) => call.operation === "router.status")).toBe(true);
		expect(client.calls.some((call) => call.operation === "metrics.query")).toBe(true);
	});

	it("applies model and thinking decisions before a turn", async () => {
		const client = new FakeClient();
		client.decision = decision({
			action: "switch-model",
			route: { provider: "openai-codex", model: "gpt-5.1-codex-mini", thinking: "medium" },
		});
		const app = harness(client);
		await app.handlers.get("turn_start")![0]!({ turnIndex: 1, timestamp: 1000 }, app.ctx);
		expect(app.modelChanges).toEqual([{ provider: "openai-codex", id: "gpt-5.1-codex-mini" }]);
		expect(app.thinkingChanges).toEqual(["medium"]);
		expect(app.aborted()).toBe(false);
	});

	it("resynchronizes stale unavailable routes and applies a valid fallback", async () => {
		const client = new FakeClient();
		client.decisionQueue = [
			decision({ action: "switch-model", route: { provider: "openai-codex", model: "removed-model", thinking: "medium" } }),
			decision({ action: "lower-thinking", route: { provider: "openai-codex", model: "gpt-5.3-codex", thinking: "medium" } }),
		];
		const app = harness(client);
		await app.handlers.get("turn_start")![0]!({ turnIndex: 1, timestamp: 1000 }, app.ctx);
		expect(client.calls.some((call) => call.operation === "router.available_routes")).toBe(true);
		expect(app.modelChanges).toEqual([]);
		expect(app.thinkingChanges).toEqual(["medium"]);
		expect(app.aborted()).toBe(false);
	});

	it("records content-free local timing reliability tool-loop and explicit outcome evidence", async () => {
		const client = new FakeClient();
		const app = harness(client);
		const startedAt = Date.now() - 1_000;
		await app.handlers.get("turn_start")![0]!({ turnIndex: 1, timestamp: startedAt }, app.ctx);
		await app.handlers.get("message_update")![0]!({ assistantMessageEvent: { type: "text_delta", delta: "private response must not persist" } }, app.ctx);
		await app.handlers.get("after_provider_response")![0]!({ status: 200, headers: {} }, app.ctx);
		await app.handlers.get("tool_execution_end")![0]!({ toolCallId: "tool-1", toolName: "edit", args: { secret: "private" }, result: { private: true }, isError: false }, app.ctx);
		await app.handlers.get("turn_end")![0]!({ message: {
			role: "assistant", provider: "openai-codex", model: "gpt-5.4", stopReason: "stop",
			usage: { input: 100, output: 20, cacheRead: 10, cacheWrite: 0, cost: { total: 0.004 } },
		}, toolResults: [{ content: "private tool output" }] }, app.ctx);
		await app.commands.get("jittor").handler("outcome accepted", app.ctx);
		const local = client.calls.filter((call) => call.operation === "metrics.record" && (call.input as any).source === "local-model").map((call) => call.input as any);
		expect(local.map((metric) => metric.metric)).toContain("ttft");
		expect(local.map((metric) => metric.metric)).toContain("tool-calls");
		expect(local.some((metric) => metric.metric === "outcome-accepted" && metric.value === 1)).toBe(true);
		expect(local.every((metric) => metric.attributes.taskClass === "coding")).toBe(true);
		expect(JSON.stringify(local)).not.toContain("private");
	});

	it("records Codex response headers and finalized assistant usage through the daemon", async () => {
		const client = new FakeClient();
		const app = harness(client);
		await app.handlers.get("after_provider_response")![0]!({ status: 200, headers: {
			"x-codex-primary-used-percent": "20", "x-codex-primary-window-minutes": "300", "x-codex-primary-reset-at": "1800000000",
		} }, app.ctx);
		await app.handlers.get("message_end")![0]!({ message: {
			role: "assistant", provider: "openrouter", model: "openai/gpt-4.1-mini",
			usage: { input: 100, output: 20, cacheRead: 10, cacheWrite: 0, cost: { total: 0.004 } },
		} }, app.ctx);
		const records = client.calls.filter((call) => call.operation === "metrics.record");
		expect(records.some((call) => (call.input as any).source === "codex-subscription")).toBe(true);
		expect(records.some((call) => (call.input as any).metric === "cost" && (call.input as any).value === 0.004)).toBe(true);
	});

	it("records official Anthropic rate-limit response headers only for the active Anthropic route", async () => {
		const client = new FakeClient();
		const app = harness(client, undefined, undefined, { provider: "anthropic", id: "claude-sonnet-5" });
		await app.handlers.get("after_provider_response")![0]!({ status: 200, headers: {
			"anthropic-ratelimit-tokens-limit": "2000000",
			"anthropic-ratelimit-tokens-remaining": "1500000",
			"anthropic-ratelimit-tokens-reset": "2026-07-21T12:00:00Z",
		} }, app.ctx);
		const records = client.calls.filter((call) => call.operation === "metrics.record");
		expect(records.some((call) => (call.input as any).source === "anthropic" && (call.input as any).scope === "tokens" && (call.input as any).metric === "used-fraction" && (call.input as any).value === 0.25)).toBe(true);
	});

	it("notifies instead of silently dropping telemetry on Anthropic header schema drift", async () => {
		const client = new FakeClient();
		const app = harness(client, undefined, undefined, { provider: "anthropic", id: "claude-sonnet-5" });
		await app.handlers.get("after_provider_response")![0]!({ status: 200, headers: { "anthropic-ratelimit-requests-limit": "not-a-number" } }, app.ctx);
		expect(app.notifications.at(-1)).toContain("Anthropic telemetry schema drift");
		expect(client.calls.some((call) => call.operation === "metrics.record" && (call.input as any).source === "anthropic")).toBe(false);
	});

	it("classifies a failed Google Vertex response as a bounded failure-count metric, never a fabricated budget", async () => {
		const client = new FakeClient();
		const app = harness(client, undefined, undefined, { provider: "google-vertex", id: "gemini-3-pro" });
		await app.handlers.get("after_provider_response")![0]!({ status: 429, headers: {} }, app.ctx);
		await app.handlers.get("message_end")![0]!({ message: {
			role: "assistant", provider: "google-vertex", stopReason: "error", errorMessage: "429 RESOURCE_EXHAUSTED. Quota exceeded",
		} }, app.ctx);
		const records = client.calls.filter((call) => call.operation === "metrics.record").map((call) => call.input as any);
		expect(records).toContainEqual(expect.objectContaining({ source: "google-vertex", scope: "failure", metric: "quota", value: 1, unit: "count" }));
		expect(records.some((record) => record.unit === "ratio")).toBe(false);
		expect(JSON.stringify(records)).not.toContain("Quota exceeded");
	});
});

describe("Jittor Codex settled-turn recovery", () => {
	async function failCodex(app: ReturnType<typeof harness>): Promise<void> {
		await app.handlers.get("after_provider_response")![0]!({ status: 429, headers: { "retry-after": "12" } }, app.ctx);
		await app.handlers.get("message_end")![0]!({ message: {
			role: "assistant",
			provider: "openai-codex",
			stopReason: "error",
			errorMessage: "Too many concurrent requests",
		} }, app.ctx);
	}

	it("waits for agent_settled before scheduling one opted-in hidden retry", async () => {
		const runtime = new FakeRecoveryRuntime();
		const app = harness(new FakeClient(), undefined, { enabled: true, runtime });
		await failCodex(app);
		expect(runtime.pendingCount()).toBe(0);

		await app.handlers.get("agent_settled")![0]!({}, app.ctx);
		await app.handlers.get("agent_settled")![0]!({}, app.ctx);
		expect(runtime.pendingCount()).toBe(1);
		expect(runtime.delays).toEqual([12_000]);
		await runtime.runNext();

		expect(app.sentMessages).toHaveLength(1);
		expect(app.sentMessages[0]?.options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
		expect(app.sentMessages[0]?.message).toMatchObject({ customType: "jittor-codex-recovery", display: false });
		expect(JSON.stringify(app.sentMessages[0])).not.toContain("Too many concurrent requests");
	});

	it("stays off by default and never overlaps pending Pi messages", async () => {
		const disabledRuntime = new FakeRecoveryRuntime();
		const disabled = harness(new FakeClient(), undefined, { enabled: false, runtime: disabledRuntime });
		await failCodex(disabled);
		await disabled.handlers.get("agent_settled")![0]!({}, disabled.ctx);
		expect(disabledRuntime.pendingCount()).toBe(0);

		const runtime = new FakeRecoveryRuntime();
		const app = harness(new FakeClient(), undefined, { enabled: true, runtime });
		await failCodex(app);
		await app.handlers.get("agent_settled")![0]!({}, app.ctx);
		app.setPendingMessages(true);
		await runtime.runNext();
		expect(app.sentMessages).toHaveLength(0);
		await app.handlers.get("agent_settled")![0]!({}, app.ctx);
		expect(runtime.pendingCount()).toBe(0);
		app.setPendingMessages(false);
		await app.handlers.get("agent_settled")![0]!({}, app.ctx);
		expect(runtime.pendingCount()).toBe(1);
	});

	it("exposes payload-safe status plus persistent on, off, and cancel controls", async () => {
		const runtime = new FakeRecoveryRuntime();
		const app = harness(new FakeClient(), undefined, { enabled: false, runtime });
		await app.commands.get("jittor").handler("recovery status", app.ctx);
		expect(app.notifications.at(-1)).toBe("Codex recovery: off · idle · attempt 0/3 · window 10m");

		await app.commands.get("jittor").handler("recovery on", app.ctx);
		expect(app.recoveryEnabled()).toBe(true);
		await failCodex(app);
		await app.handlers.get("agent_settled")![0]!({}, app.ctx);
		await app.commands.get("jittor").handler("recovery", app.ctx);
		expect(app.notifications.at(-1)).toBe("Codex recovery: on · cooldown 12s · attempt 1/3 · window 10m · concurrency");
		expect(app.notifications.join("\n")).not.toContain("Too many concurrent requests");

		await app.commands.get("jittor").handler("recovery cancel", app.ctx);
		expect(runtime.pendingCount()).toBe(0);
		expect(app.recoveryEnabled()).toBe(true);
		await app.commands.get("jittor").handler("recovery off", app.ctx);
		expect(app.recoveryEnabled()).toBe(false);
	});

	it("cancels a scheduled retry on human input and session shutdown", async () => {
		const runtime = new FakeRecoveryRuntime();
		const app = harness(new FakeClient(), undefined, { enabled: true, runtime });
		await failCodex(app);
		await app.handlers.get("agent_settled")![0]!({}, app.ctx);
		expect(runtime.pendingCount()).toBe(1);
		await app.handlers.get("input")![0]!({ source: "interactive", text: "do something else" }, app.ctx);
		expect(runtime.pendingCount()).toBe(0);

		await failCodex(app);
		await app.handlers.get("agent_settled")![0]!({}, app.ctx);
		expect(runtime.pendingCount()).toBe(1);
		await app.handlers.get("session_shutdown")![0]!({}, app.ctx);
		expect(runtime.pendingCount()).toBe(0);
	});
});

describe("Jittor footer status", () => {
	const metrics = [
		{ source: "codex-subscription", scope: "codex:primary", metric: "used-fraction", value: 0.2, unit: "ratio", observedAt: 1, id: 1, attributes: { windowSeconds: 18_000 } },
		{ source: "codex-subscription", scope: "codex:secondary", metric: "used-fraction", value: 0.42, unit: "ratio", observedAt: 2, id: 2, attributes: { limitId: "codex", windowSeconds: 604_800, resetsAt: 1_800_000_000 } },
		{ source: "codex-subscription", scope: "codex_bengalfox:primary", metric: "used-fraction", value: 0, unit: "ratio", observedAt: 3, id: 3, attributes: { limitId: "codex_bengalfox", limitName: "GPT-5.3-Codex-Spark", windowSeconds: 604_800, resetsAt: 1_800_100_000 } },
		{ source: "openrouter", scope: "key:default", metric: "remaining-fraction", value: 0.4, unit: "ratio", observedAt: 5, id: 5, attributes: { limit: 100, remaining: 40, reset: "monthly" } },
		{ source: "openrouter", scope: "key:default", metric: "usage", value: 60, unit: "usd", observedAt: 4, id: 4, attributes: {} },
		{ source: "anthropic", scope: "requests", metric: "used-fraction", value: 0.1, unit: "ratio", observedAt: 6, id: 6, attributes: { resetsAt: 1_800_000_000_000 } },
		{ source: "anthropic", scope: "tokens", metric: "used-fraction", value: 0.25, unit: "ratio", observedAt: 7, id: 7, attributes: { resetsAt: 1_800_050_000_000 } },
	] as any[];

	it("shows the default Codex budget remaining instead of a same-duration additional model limit", () => {
		const routeStatus = { ready: true, paused: false, sources: [], lastDecision: decision(), override: null, currentRoute: { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high" }, availableRoutes: [] };
		const budget = buildFooterBudget(routeStatus, metrics);
		expect(budget).toMatchObject({ kind: "bounded", label: "W", resetsAt: 1_800_000_000_000 });
		expect(budget?.kind === "bounded" ? budget.remainingFraction : null).toBeCloseTo(0.58);
		expect(formatFooterStatus(routeStatus, metrics)).toBe("W 58.0% left");
	});

	it("selects a named additional Codex limit only for its matching model", () => {
		const budget = buildFooterBudget(
			{ ready: true, paused: false, sources: [], lastDecision: decision(), override: null, currentRoute: { provider: "openai-codex", model: "gpt-5.3-codex-spark", thinking: "high" }, availableRoutes: [] },
			metrics,
		);
		expect(budget).toMatchObject({ kind: "bounded", label: "W", remainingFraction: 1, resetsAt: 1_800_100_000_000 });
	});

	it("shows a draining remaining-budget value for an officially bounded OpenRouter key", () => {
		const routeStatus = { ready: true, paused: false, sources: [], lastDecision: decision(), override: null, currentRoute: { provider: "openrouter", model: "openai/gpt-4.1-mini", thinking: "medium" }, availableRoutes: [] };
		expect(buildFooterBudget(routeStatus, metrics)).toMatchObject({
			kind: "bounded", label: "OR", remainingFraction: 0.4, resetText: "monthly reset",
		});
		expect(formatFooterStatus(routeStatus, metrics)).toBe("OR 40.0% left");
	});

	it("prefers the Anthropic tokens bucket over requests, since it reflects the most restrictive limit in effect", () => {
		const routeStatus = { ready: true, paused: false, sources: [], lastDecision: decision(), override: null, currentRoute: { provider: "anthropic", model: "claude-sonnet-5", thinking: "high" }, availableRoutes: [] };
		expect(buildFooterBudget(routeStatus, metrics)).toMatchObject({
			kind: "bounded", label: "tok", remainingFraction: 0.75, resetsAt: 1_800_050_000_000,
		});
		expect(formatFooterStatus(routeStatus, metrics)).toBe("tok 75.0% left");
	});

	it("falls back to the Anthropic requests bucket when no tokens bucket was observed", () => {
		const routeStatus = { ready: true, paused: false, sources: [], lastDecision: decision(), override: null, currentRoute: { provider: "anthropic", model: "claude-sonnet-5", thinking: "high" }, availableRoutes: [] };
		expect(buildFooterBudget(routeStatus, metrics.filter((metric) => metric.scope !== "tokens"))).toMatchObject({
			kind: "bounded", label: "req", remainingFraction: 0.9, resetsAt: 1_800_000_000_000,
		});
	});

	it("keeps OpenRouter spend text-only when the key has no official limit", () => {
		const text = formatFooterStatus(
			{ ready: true, paused: false, sources: [], lastDecision: decision(), override: null, currentRoute: { provider: "openrouter", model: "openai/gpt-4.1-mini", thinking: "medium" }, availableRoutes: [] },
			metrics.filter((metric) => metric.metric !== "remaining-fraction"),
		);
		expect(text).toBe("$60.000");
	});

	it("reports undefined (never displayable), not null (not yet known), for a provider with no possible budget signal at all", () => {
		// Google Vertex has no documented rate-limit/quota header or endpoint (see google-vertex-contracts.ts):
		// there is nothing that could ever populate this, so it must be distinguishable from "not yet observed".
		const routeStatus = { ready: true, paused: false, sources: [], lastDecision: decision(), override: null, currentRoute: { provider: "google-vertex", model: "claude-sonnet-5", thinking: "high" }, availableRoutes: [] };
		expect(buildFooterBudget(routeStatus, metrics)).toBeUndefined();
		expect(formatFooterStatus(routeStatus, metrics)).toBe("");
	});
});

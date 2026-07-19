import { describe, expect, it } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatFooterStatus, registerJittorExtension, routesFromPi, type JittorExtensionClient } from "../extension/src/index.ts";
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
	async call(operation: string, input: unknown): Promise<any> {
		this.calls.push({ operation, input });
		if (operation === "router.decide") return this.decisionQueue.shift() ?? this.decision;
		if (operation === "router.status") return this.status;
		if (operation === "metrics.query") return this.metrics;
		if (operation === "metrics.record") return { id: this.calls.length, ...(input as object) };
		return {};
	}
}

function harness(client: FakeClient, enforcement?: EnforcementControl) {
	let defaultEnabled = true;
	const control = enforcement ?? {
		isEnabled: () => defaultEnabled,
		setEnabled(value: boolean) { defaultEnabled = value; },
	};
	const handlers = new Map<string, Function[]>();
	const commands = new Map<string, any>();
	const modelChanges: unknown[] = [];
	const thinkingChanges: string[] = [];
	const pi = {
		on(name: string, handler: Function) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		registerCommand(name: string, command: unknown) { commands.set(name, command); },
		async setModel(model: unknown) { modelChanges.push(model); return true; },
		setThinkingLevel(level: string) { thinkingChanges.push(level); },
		getThinkingLevel() { return "high"; },
	} as unknown as ExtensionAPI;
	registerJittorExtension(pi, client, control);
	const statuses: Array<string | undefined> = [];
	const notifications: string[] = [];
	let aborted = false;
	const model = { provider: "openai-codex", id: "gpt-5.3-codex" };
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
		ui: {
			setStatus(_key: string, value: string | undefined) { statuses.push(value); },
			setFooter() {},
			notify(message: string) { notifications.push(message); },
		},
	} as unknown as ExtensionContext;
	return { handlers, commands, modelChanges, thinkingChanges, statuses, notifications, ctx, aborted: () => aborted };
}

describe("Jittor Pi actuator", () => {
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

	it("supports a local emergency off switch without calling the daemon", async () => {
		let enabled = true;
		const enforcement: EnforcementControl = {
			isEnabled: () => enabled,
			setEnabled(value) { enabled = value; },
		};
		const client = new FakeClient();
		const app = harness(client, enforcement);
		await app.commands.get("jittor").handler("off", app.ctx);
		const before = client.calls.length;
		const result = await app.handlers.get("input")![0]!({ source: "interactive", text: "work" }, app.ctx);
		expect(result).toEqual({ action: "continue" });
		expect(client.calls).toHaveLength(before);
		expect(enabled).toBe(false);
		expect(app.notifications.join("\n")).toContain("monitor-only");
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
});

describe("Jittor footer status", () => {
	const metrics = [
		{ source: "codex-subscription", scope: "codex:primary", metric: "used-fraction", value: 0.2, unit: "ratio", observedAt: 1, id: 1, attributes: { windowSeconds: 18_000 } },
		{ source: "codex-subscription", scope: "codex:secondary", metric: "used-fraction", value: 0.42, unit: "ratio", observedAt: 2, id: 2, attributes: { windowSeconds: 604_800 } },
		{ source: "openrouter", scope: "key:default", metric: "usage", value: 12.3456, unit: "usd", observedAt: 3, id: 3, attributes: {} },
	] as any[];

	it("shows only Codex usage for the current Codex model without a Jittor label", () => {
		const text = formatFooterStatus(
			{ ready: true, paused: false, sources: [], lastDecision: decision(), override: null, currentRoute: { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high" }, availableRoutes: [] },
			metrics,
		);
		expect(text).toBe("W 42.0%");
	});

	it("shows only raw spend for the current OpenRouter model", () => {
		const text = formatFooterStatus(
			{ ready: true, paused: false, sources: [], lastDecision: decision(), override: null, currentRoute: { provider: "openrouter", model: "openai/gpt-4.1-mini", thinking: "medium" }, availableRoutes: [] },
			metrics,
		);
		expect(text).toBe("$12.346");
	});
});

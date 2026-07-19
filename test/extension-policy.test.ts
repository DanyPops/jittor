import { describe, expect, it } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatFooterStatus, registerJittorExtension, type JittorExtensionClient } from "../extension/src/index.ts";
import type { PolicyDecision } from "../src/policy.ts";
import type { RouterStatus } from "../src/ports/router-controller.ts";

function decision(overrides: Partial<PolicyDecision> = {}): PolicyDecision {
	return { action: "continue", pressure: 0.5, reason: "ok", decidedAt: 1000, trace: [], ...overrides };
}

class FakeClient implements JittorExtensionClient {
	calls: Array<{ operation: string; input: unknown }> = [];
	decision = decision();
	status: RouterStatus = { ready: true, paused: false, sources: [], lastDecision: this.decision, override: null, currentRoute: null };
	metrics: any[] = [];
	async call(operation: string, input: unknown): Promise<any> {
		this.calls.push({ operation, input });
		if (operation === "router.decide") return this.decision;
		if (operation === "router.status") return this.status;
		if (operation === "metrics.query") return this.metrics;
		if (operation === "metrics.record") return { id: this.calls.length, ...(input as object) };
		return {};
	}
}

function harness(client: FakeClient) {
	const handlers = new Map<string, Function[]>();
	const modelChanges: unknown[] = [];
	const thinkingChanges: string[] = [];
	const pi = {
		on(name: string, handler: Function) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		registerCommand() {},
		async setModel(model: unknown) { modelChanges.push(model); return true; },
		setThinkingLevel(level: string) { thinkingChanges.push(level); },
	} as unknown as ExtensionAPI;
	registerJittorExtension(pi, client);
	const statuses: Array<string | undefined> = [];
	let aborted = false;
	const model = { provider: "openai-codex", id: "gpt-5.3-codex" };
	const ctx = {
		mode: "tui", hasUI: true, model,
		modelRegistry: { find: (provider: string, id: string) => ({ provider, id }) },
		abort() { aborted = true; },
		ui: { setStatus(_key: string, value: string | undefined) { statuses.push(value); }, notify() {} },
	} as unknown as ExtensionContext;
	return { handlers, modelChanges, thinkingChanges, statuses, ctx, aborted: () => aborted };
}

describe("Jittor Pi actuator", () => {
	it("blocks input before a forbidden provider request", async () => {
		const client = new FakeClient();
		client.decision = decision({ action: "halt", pressure: Infinity, reason: "budget exhausted" });
		const app = harness(client);
		const result = await app.handlers.get("input")![0]!({ source: "interactive", text: "go" }, app.ctx);
		expect(result).toEqual({ action: "handled" });
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
	it("shows longest Codex window percentage and raw OpenRouter spend", () => {
		const text = formatFooterStatus(
			{ ready: true, paused: false, sources: [], lastDecision: decision({ action: "throttle" }), override: null, currentRoute: null },
			[
				{ source: "codex-subscription", scope: "codex:primary", metric: "used-fraction", value: 0.2, unit: "ratio", observedAt: 1, id: 1, attributes: { windowSeconds: 18_000 } },
				{ source: "codex-subscription", scope: "codex:secondary", metric: "used-fraction", value: 0.42, unit: "ratio", observedAt: 2, id: 2, attributes: { windowSeconds: 604_800 } },
				{ source: "openrouter", scope: "key:default", metric: "usage", value: 12.3456, unit: "usd", observedAt: 3, id: 3, attributes: {} },
			],
		);
		expect(text).toBe("Jittor · Codex W 42.0% · OpenRouter $12.346 · throttle");
	});
});

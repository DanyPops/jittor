import { describe, expect, it } from "bun:test";
import type { Route } from "@danypops/jittor";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { showConfirmDialog, showRouteOverrideMenu } from "../extension/src/tui-prompts.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

type CustomFactory = (...args: unknown[]) => { render(width: number): string[]; handleInput?(data: string): void };

function harness() {
	const ctx = {
		mode: "tui",
		ui: {
			custom<T>(factory: CustomFactory): Promise<T> {
				// A real host doesn't resolve custom() until the panel calls `done` -- resolving
				// synchronously here (before the test ever gets a chance to call handleInput)
				// would make every assertion below observe a promise that already settled.
				return new Promise<T>((resolve) => {
					const component = factory({ requestRender() {} }, theme, {}, (value: unknown) => resolve(value as T));
					(ctx as unknown as { _component: unknown })._component = component;
				});
			},
		},
	} as unknown as ExtensionCommandContext & { _component: { render(width: number): string[]; handleInput?(data: string): void } };
	return { ctx };
}

describe("Jittor TUI confirm/select prompts (Dialog/TabMenu, not host-native ctx.ui.confirm/select)", () => {
	it("renders a real Dialog with the given title/body and resolves true on 'y'", async () => {
		const { ctx } = harness();
		const promise = showConfirmDialog(ctx, "Disable routing enforcement?", "Jittor will remain monitor-only.");
		const rendered = ctx._component.render(60).join("\n");
		expect(rendered).toContain("Disable routing enforcement?");
		expect(rendered).toContain("Jittor will remain monitor-only.");
		ctx._component.handleInput!("y");
		expect(await promise).toBe(true);
	});

	it("resolves false on 'n'", async () => {
		const { ctx } = harness();
		const promise = showConfirmDialog(ctx, "Enable Codex recovery?", "body");
		ctx._component.handleInput!("n");
		expect(await promise).toBe(false);
	});

	it("resolves false on Escape (Dialog's own n/Esc-keyed action wiring)", async () => {
		const { ctx } = harness();
		const promise = showConfirmDialog(ctx, "title", "body");
		ctx._component.handleInput!("\x1b");
		expect(await promise).toBe(false);
	});

	it("resolves false on Ctrl+C", async () => {
		const { ctx } = harness();
		const promise = showConfirmDialog(ctx, "title", "body");
		ctx._component.handleInput!("\x03");
		expect(await promise).toBe(false);
	});

	it("treats a dismissed dialog (custom() resolves undefined) as cancel, not confirm", async () => {
		const ctx = {
			mode: "tui",
			ui: {
				async custom() {
					return undefined;
				},
			},
		} as unknown as ExtensionCommandContext;
		expect(await showConfirmDialog(ctx, "title", "body")).toBe(false);
	});

	it("renders every route as a real TabMenu leaf node and resolves the selected route", async () => {
		const { ctx } = harness();
		const routes: Route[] = [
			{ provider: "anthropic", model: "claude-sonnet-5", thinking: "high" },
			{ provider: "openai-codex", model: "gpt-5.6-sol", thinking: "low" },
		];
		const promise = showRouteOverrideMenu(ctx, routes, (route) => `${route.provider}/${route.model}`);
		const rendered = ctx._component.render(80).join("\n");
		expect(rendered).toContain("anthropic/claude-sonnet-5");
		expect(rendered).toContain("openai-codex/gpt-5.6-sol");
		ctx._component.handleInput!("\t"); // move to the second route
		ctx._component.handleInput!("\r"); // select it
		expect(await promise).toEqual(routes[1]);
	});

	it("resolves undefined on cancel (Escape at the root)", async () => {
		const { ctx } = harness();
		const routes: Route[] = [{ provider: "anthropic", model: "claude-sonnet-5", thinking: "high" }];
		const promise = showRouteOverrideMenu(ctx, routes, (route) => route.model);
		ctx._component.handleInput!("\x1b");
		expect(await promise).toBeUndefined();
	});
});

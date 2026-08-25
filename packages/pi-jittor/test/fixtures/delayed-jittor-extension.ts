import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerJittorExtension } from "../../extension/src/index.ts";

const DELAY_ENV = "PI_JITTOR_TEST_DAEMON_DELAY_MS";

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export default function delayedJittorExtension(pi: ExtensionAPI): void {
	const delayMs = Number(process.env[DELAY_ENV] ?? "600");
	const delayedOperations = new Set((process.env.PI_JITTOR_TEST_DELAY_OPERATIONS ?? "*").split(","));
	const decision = { action: "continue", pressure: 0.5, reason: "ambient test", decidedAt: Date.now(), trace: [] };
	const status = {
		ready: true,
		paused: false,
		sources: [],
		lastDecision: decision,
		override: null,
		currentRoute: null,
		availableRoutes: [],
	};
	const client = {
		async call(operation: string, input: unknown): Promise<unknown> {
			if (delayedOperations.has("*") || delayedOperations.has(operation)) await delay(delayMs);
			if (operation === "session.register")
				return { sessionId: (input as { session_id: string }).session_id, secret: "pi-jittor-test-session-secret" };
			if (operation === "router.decide") return decision;
			if (operation === "router.status" || operation === "router.current_route" || operation === "router.available_routes") return status;
			if (operation === "metrics.query") return [];
			if (operation === "models.rank")
				return {
					scopeAuthority: "exact-session",
					domain: "general",
					type: "general",
					completeness: "insufficient-evidence",
					ranked: [],
					recommendation: null,
					automaticSelection: null,
				};
			if (operation === "compaction.estimate") return { ms: null, confidence: "cold-start", sampleSize: 0, observedAt: 0 };
			return {};
		},
	};
	const control = {
		isEnabled: () => true,
		setEnabled() {},
		isFooterEnabled: () => true,
		setFooterEnabled() {},
		isCodexRecoveryEnabled: () => false,
		setCodexRecoveryEnabled() {},
		getUsageTokenBudget: () => undefined,
		setUsageTokenBudget() {},
		getAutoMode: () => "auto-switch" as const,
		setAutoMode() {},
		isAutoModeVerbose: () => false,
		setAutoModeVerbose() {},
	};
	registerJittorExtension(pi, client, control);
}

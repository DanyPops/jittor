import { afterEach, describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import {
	encodeFauxScript,
	FIRST_TOKEN_DELAY_ENV_VAR,
	type RealPiProcess,
	resolveFauxProviderExtensionPath,
	SCRIPT_ENV_VAR,
	spawnRealPiProcess,
	waitForRpcEvent,
} from "@danypops/pi-process-harness";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

const DELAYED_JITTOR_EXTENSION = fileURLToPath(new URL("./fixtures/delayed-jittor-extension.ts", import.meta.url));
const PI_CLI = fileURLToPath(new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));

let pi: RealPiProcess | undefined;

afterEach(async () => {
	await pi?.dispose();
	pi = undefined;
});

describe("ambient Jittor routing through a real Pi process", () => {
	it("preserves a 1:1 prompt-to-first-token ratio while daemon operations are slower than the faux model", async () => {
		const daemonDelayMs = 800;
		const fauxFirstTokenMs = 500;
		async function measure(extensions: string[], env: Record<string, string> = {}): Promise<number> {
			pi = spawnRealPiProcess({
				bin: PI_CLI,
				extensions: [resolveFauxProviderExtensionPath(), ...extensions],
				extraArgs: ["--provider", "faux", "--model", "faux-1"],
				env: {
					[SCRIPT_ENV_VAR]: encodeFauxScript([{ type: "text", text: "first token" }]),
					[FIRST_TOKEN_DELAY_ENV_VAR]: String(fauxFirstTokenMs),
					...env,
				},
			});
			const events: AgentSessionEvent[] = [];
			const timedEvents: Array<{ event: AgentSessionEvent; elapsedMs: number }> = [];
			pi.onEvent((event) => events.push(event));
			pi.onTimedEvent((event) => timedEvents.push(event));
			pi.send({ type: "get_entries" });
			await waitForRpcEvent(
				events,
				(event) =>
					(event as unknown as { type: string }).type === "response" &&
					(event as unknown as { command?: string }).command === "get_entries",
				{ timeoutMs: 15_000 },
			);
			const sentAtMs = pi.sendPrompt("measure ttft");
			await waitForRpcEvent(events, (event) => event.type === "message_update" && event.assistantMessageEvent.type === "text_delta", {
				timeoutMs: 15_000,
			});
			const firstToken = timedEvents.find(
				({ event }) => event.type === "message_update" && event.assistantMessageEvent.type === "text_delta",
			);
			expect(firstToken).toBeDefined();
			await pi.dispose();
			pi = undefined;
			return firstToken!.elapsedMs - sentAtMs;
		}

		const baselineT = await measure([]);
		const withJittorT = await measure([DELAYED_JITTOR_EXTENSION], {
			PI_JITTOR_TEST_DAEMON_DELAY_MS: String(daemonDelayMs),
			PI_JITTOR_TEST_DELAY_OPERATIONS: "router.decide,models.rank,metrics.record_batch,router.status",
		});

		expect(baselineT).toBeGreaterThanOrEqual(fauxFirstTokenMs);
		expect(withJittorT).toBeLessThan(daemonDelayMs);
		const ttftRatio = withJittorT / baselineT;
		expect(ttftRatio).toBeGreaterThanOrEqual(0.9);
		expect(ttftRatio).toBeLessThanOrEqual(1.1);
	}, 30_000);
});

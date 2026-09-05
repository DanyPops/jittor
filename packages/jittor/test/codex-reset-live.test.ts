import { expect, it } from "bun:test";
import { CodexSubscriptionTelemetryAdapter, loadCodexFileCredentials } from "../src/codex/telemetry.ts";

// Explicit opt-in; only GET requests. Credentials and response payloads stay out of test output.
it.skipIf(!process.env.JITTOR_CODEX_RESET_LIVE_AUTH_FILE)(
	"reads live reset availability",
	async () => {
		const adapter = new CodexSubscriptionTelemetryAdapter(
			loadCodexFileCredentials(process.env.JITTOR_CODEX_RESET_LIVE_AUTH_FILE!),
			async (request) => {
				expect(request.method).toBe("GET");
				const response = await fetch(new Request(request, { redirect: "error", signal: AbortSignal.timeout(10_000) }));
				expect(response.status).toBe(200);
				return response;
			},
		);
		const usage = await adapter.readUsage();
		const details = await adapter.readResets();
		for (const count of [usage.availableResets, details.availableCount]) {
			expect(typeof count === "number" && Number.isSafeInteger(count) && count >= 0).toBe(true);
		}
		console.info(
			JSON.stringify({ event: "codex_reset_read_probe", usageCount: usage.availableResets, detailsCount: details.availableCount }),
		);
	},
	25_000,
);

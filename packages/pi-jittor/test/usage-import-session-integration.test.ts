import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiSessionUsageSource } from "@danypops/jittor";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("historical usage against a real Pi SessionManager", () => {
	it("reads the supported persisted session contract without retaining message content or paths", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-usage-session-"));
		roots.push(root);
		const sessionDir = join(root, "sessions");
		const manager = SessionManager.create(join(root, "private-project"), sessionDir);
		manager.appendModelChange("openai", "gpt-5");
		manager.appendThinkingLevelChange("high");
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "private persisted response" }],
			api: "test",
			provider: "openai",
			model: "gpt-5",
			usage: {
				input: 12,
				output: 3,
				cacheRead: 4,
				cacheWrite: 1,
				totalTokens: 20,
				cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33 },
			},
			stopReason: "stop",
			timestamp: 1_735_689_603_000,
		});
		const scan = await new PiSessionUsageSource(sessionDir).scan(() => false);
		expect(scan.records).toHaveLength(1);
		expect(scan.records[0]).toMatchObject({ provider: "openai", model: "gpt-5", thinking: "high", inputTokens: 12, costUsd: 0.33 });
		expect(JSON.stringify(scan)).not.toContain("private persisted response");
		expect(JSON.stringify(scan)).not.toContain("private-project");
	});
});

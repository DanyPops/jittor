import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { persistentEnforcementControl } from "../extension/src/settings.ts";

describe("Jittor extension enforcement settings", () => {
	it("persists an emergency off switch privately across extension reloads", async () => {
		const root = mkdtempSync(join(tmpdir(), "jittor-settings-"));
		try {
			const env = { HOME: root, XDG_CONFIG_HOME: join(root, "config") };
			const first = persistentEnforcementControl(env);
			expect(first.isEnabled()).toBe(true);
			expect(first.isFooterEnabled()).toBe(true);
			expect(first.isCodexRecoveryEnabled()).toBe(false);
			expect(first.getUsageTokenBudget("hourly")).toBeUndefined();
			// Every setter now persists atomically (temp file + rename) via vehicle-core's
			// createAtomicJsonWriter -- a real async fs write, not a synchronous writeFileSync -- so each
			// call must be awaited before the next one, or before a fresh control re-reads the file, the
			// same discipline any real caller (index.ts/settings-tui.ts, all already async) already follows.
			await first.setUsageTokenBudget("hourly", 25_000);
			await first.setUsageTokenBudget("daily", 250_000);
			await first.setCodexRecoveryEnabled(true);
			await first.setEnabled(false);
			expect(first.isFooterEnabled()).toBe(true);
			await first.setFooterEnabled(false);
			const second = persistentEnforcementControl(env);
			expect(second.isEnabled()).toBe(false);
			expect(second.isFooterEnabled()).toBe(false);
			expect(second.isCodexRecoveryEnabled()).toBe(true);
			expect(second.getUsageTokenBudget("hourly")).toBe(25_000);
			expect(second.getUsageTokenBudget("daily")).toBe(250_000);
			// A validation failure now rejects (async function) rather than throwing synchronously.
			await expect(second.setUsageTokenBudget("weekly", -1)).rejects.toThrow("positive finite");
			await second.setUsageTokenBudget("hourly", undefined);
			expect(second.getUsageTokenBudget("hourly")).toBeUndefined();
			await second.setFooterEnabled(true);
			expect(second.isEnabled()).toBe(false);
			expect(statSync(join(root, "config", "jittor", "extension.json")).mode & 0o777).toBe(0o600);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

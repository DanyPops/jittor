import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { persistentEnforcementControl } from "../extension/src/settings.ts";

describe("Jittor extension enforcement settings", () => {
	it("persists an emergency off switch privately across extension reloads", () => {
		const root = mkdtempSync(join(tmpdir(), "jittor-settings-"));
		try {
			const env = { HOME: root, XDG_CONFIG_HOME: join(root, "config") };
			const first = persistentEnforcementControl(env);
			expect(first.isEnabled()).toBe(true);
			expect(first.isFooterEnabled()).toBe(true);
			expect(first.isCodexRecoveryEnabled()).toBe(false);
			first.setCodexRecoveryEnabled(true);
			first.setEnabled(false);
			expect(first.isFooterEnabled()).toBe(true);
			first.setFooterEnabled(false);
			const second = persistentEnforcementControl(env);
			expect(second.isEnabled()).toBe(false);
			expect(second.isFooterEnabled()).toBe(false);
			expect(second.isCodexRecoveryEnabled()).toBe(true);
			second.setFooterEnabled(true);
			expect(second.isEnabled()).toBe(false);
			expect(statSync(join(root, "config", "jittor", "extension.json")).mode & 0o777).toBe(0o600);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

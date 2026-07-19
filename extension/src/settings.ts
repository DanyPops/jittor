import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { JITTOR_EXTENSION_SETTINGS_FILENAME, JITTOR_STATE_DIRECTORY } from "../../src/constants.ts";

export interface EnforcementControl {
	isEnabled(): boolean;
	setEnabled(enabled: boolean): void;
}

function settingsPath(env: Record<string, string | undefined> = process.env): string {
	const config = env["XDG_CONFIG_HOME"] ?? join(env["HOME"] ?? ".", ".config");
	return join(config, JITTOR_STATE_DIRECTORY, JITTOR_EXTENSION_SETTINGS_FILENAME);
}

function loadEnabled(path: string): boolean {
	try {
		const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (typeof value !== "object" || value === null || Array.isArray(value)) return true;
		return (value as Record<string, unknown>)["enforcementEnabled"] !== false;
	} catch {
		return true;
	}
}

export function persistentEnforcementControl(env: Record<string, string | undefined> = process.env): EnforcementControl {
	const path = settingsPath(env);
	let enabled = loadEnabled(path);
	return {
		isEnabled: () => enabled,
		setEnabled(value: boolean): void {
			enabled = value;
			mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
			const temporary = `${path}.${process.pid}.tmp`;
			writeFileSync(temporary, `${JSON.stringify({ enforcementEnabled: enabled }, null, 2)}\n`, { mode: 0o600 });
			chmodSync(temporary, 0o600);
			renameSync(temporary, path);
		},
	};
}

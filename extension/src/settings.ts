import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { JITTOR_EXTENSION_SETTINGS_FILENAME, JITTOR_STATE_DIRECTORY } from "../../src/constants.ts";

export interface EnforcementControl {
	isEnabled(): boolean;
	setEnabled(enabled: boolean): void;
	isFooterEnabled(): boolean;
	setFooterEnabled(enabled: boolean): void;
}

interface ExtensionSettings {
	enforcementEnabled: boolean;
	footerEnabled: boolean;
}

function settingsPath(env: Record<string, string | undefined> = process.env): string {
	const config = env["XDG_CONFIG_HOME"] ?? join(env["HOME"] ?? ".", ".config");
	return join(config, JITTOR_STATE_DIRECTORY, JITTOR_EXTENSION_SETTINGS_FILENAME);
}

function loadSettings(path: string): ExtensionSettings {
	try {
		const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (typeof value !== "object" || value === null || Array.isArray(value)) return { enforcementEnabled: true, footerEnabled: true };
		const record = value as Record<string, unknown>;
		return {
			enforcementEnabled: record["enforcementEnabled"] !== false,
			footerEnabled: record["footerEnabled"] !== false,
		};
	} catch {
		return { enforcementEnabled: true, footerEnabled: true };
	}
}

function persistSettings(path: string, settings: ExtensionSettings): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
	chmodSync(temporary, 0o600);
	renameSync(temporary, path);
}

export function persistentEnforcementControl(env: Record<string, string | undefined> = process.env): EnforcementControl {
	const path = settingsPath(env);
	const settings = loadSettings(path);
	return {
		isEnabled: () => settings.enforcementEnabled,
		setEnabled(value: boolean): void {
			settings.enforcementEnabled = value;
			persistSettings(path, settings);
		},
		isFooterEnabled: () => settings.footerEnabled,
		setFooterEnabled(value: boolean): void {
			settings.footerEnabled = value;
			persistSettings(path, settings);
		},
	};
}

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { JITTOR_EXTENSION_SETTINGS_FILENAME, JITTOR_STATE_DIRECTORY } from "../../src/constants.ts";
import { USAGE_PERIODS, type UsagePeriod } from "../../src/domain/usage.ts";

export interface EnforcementControl {
	isEnabled(): boolean;
	setEnabled(enabled: boolean): void;
	isFooterEnabled(): boolean;
	setFooterEnabled(enabled: boolean): void;
}

export interface CodexRecoveryControl {
	isCodexRecoveryEnabled(): boolean;
	setCodexRecoveryEnabled(enabled: boolean): void;
}

export interface UsageBudgetControl {
	getUsageTokenBudget(period: UsagePeriod): number | undefined;
	setUsageTokenBudget(period: UsagePeriod, tokens: number | undefined): void;
}

export interface PersistentExtensionControl extends EnforcementControl, CodexRecoveryControl, UsageBudgetControl {}

interface ExtensionSettings {
	enforcementEnabled: boolean;
	footerEnabled: boolean;
	codexRecoveryEnabled: boolean;
	usageTokenBudgets: Partial<Record<UsagePeriod, number>>;
}

function defaultSettings(): ExtensionSettings {
	return { enforcementEnabled: true, footerEnabled: true, codexRecoveryEnabled: false, usageTokenBudgets: {} };
}

function parseUsageTokenBudgets(value: unknown): Partial<Record<UsagePeriod, number>> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
	const record = value as Record<string, unknown>;
	return Object.fromEntries(USAGE_PERIODS.flatMap(({ id }) => {
		const tokens = record[id];
		return typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0 ? [[id, tokens]] : [];
	})) as Partial<Record<UsagePeriod, number>>;
}

function settingsPath(env: Record<string, string | undefined> = process.env): string {
	const config = env["XDG_CONFIG_HOME"] ?? join(env["HOME"] ?? ".", ".config");
	return join(config, JITTOR_STATE_DIRECTORY, JITTOR_EXTENSION_SETTINGS_FILENAME);
}

function loadSettings(path: string): ExtensionSettings {
	try {
		const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (typeof value !== "object" || value === null || Array.isArray(value)) return defaultSettings();
		const record = value as Record<string, unknown>;
		return {
			enforcementEnabled: record["enforcementEnabled"] !== false,
			footerEnabled: record["footerEnabled"] !== false,
			codexRecoveryEnabled: record["codexRecoveryEnabled"] === true,
			usageTokenBudgets: parseUsageTokenBudgets(record["usageTokenBudgets"]),
		};
	} catch {
		return defaultSettings();
	}
}

function persistSettings(path: string, settings: ExtensionSettings): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
	chmodSync(temporary, 0o600);
	renameSync(temporary, path);
}

export function persistentEnforcementControl(env: Record<string, string | undefined> = process.env): PersistentExtensionControl {
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
		isCodexRecoveryEnabled: () => settings.codexRecoveryEnabled,
		setCodexRecoveryEnabled(value: boolean): void {
			settings.codexRecoveryEnabled = value;
			persistSettings(path, settings);
		},
		getUsageTokenBudget(period): number | undefined {
			return settings.usageTokenBudgets[period];
		},
		setUsageTokenBudget(period, tokens): void {
			if (tokens !== undefined && (!Number.isFinite(tokens) || tokens <= 0)) throw new Error("usage token budget must be a positive finite number");
			if (tokens === undefined) delete settings.usageTokenBudgets[period];
			else settings.usageTokenBudgets[period] = tokens;
			persistSettings(path, settings);
		},
	};
}

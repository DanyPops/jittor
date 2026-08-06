import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { JITTOR_EXTENSION_SETTINGS_FILENAME, JITTOR_STATE_DIRECTORY, USAGE_PERIODS, type UsagePeriod } from "@danypops/jittor";
import { createAtomicJsonWriter } from "@danypops/vehicle-core";
import { createNodeAtomicJsonFsAdapter } from "@danypops/vehicle-server/atomic-json";

const atomicJson = createAtomicJsonWriter({ fs: createNodeAtomicJsonFsAdapter() });

// Every setter persists to disk before resolving, so a caller that awaits it (every real call
// site in index.ts/settings-tui.ts already runs inside an async handler) observes a completed
// write -- no fire-and-forget persistence that a subsequent synchronous re-read could race. The
// return type stays `void | Promise<void>` (not a strict `Promise<void>`) so a test/adapter
// implementation that has no real persistence to await (e.g. the no-op fallback stubs in
// index.ts's usageBudgetControl()/recoveryControl()) can stay trivially synchronous.
export interface EnforcementControl {
	isEnabled(): boolean;
	setEnabled(enabled: boolean): void | Promise<void>;
	isFooterEnabled(): boolean;
	setFooterEnabled(enabled: boolean): void | Promise<void>;
}

export interface CodexRecoveryControl {
	isCodexRecoveryEnabled(): boolean;
	setCodexRecoveryEnabled(enabled: boolean): void | Promise<void>;
}

export interface UsageBudgetControl {
	getUsageTokenBudget(period: UsagePeriod): number | undefined;
	setUsageTokenBudget(period: UsagePeriod, tokens: number | undefined): void | Promise<void>;
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
	return Object.fromEntries(
		USAGE_PERIODS.flatMap(({ id }) => {
			const tokens = record[id];
			return typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0 ? [[id, tokens]] : [];
		}),
	) as Partial<Record<UsagePeriod, number>>;
}

function settingsPath(env: Record<string, string | undefined> = process.env): string {
	const config = env.XDG_CONFIG_HOME ?? join(env.HOME ?? ".", ".config");
	return join(config, JITTOR_STATE_DIRECTORY, JITTOR_EXTENSION_SETTINGS_FILENAME);
}

function loadSettings(path: string): ExtensionSettings {
	try {
		const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (typeof value !== "object" || value === null || Array.isArray(value)) return defaultSettings();
		const record = value as Record<string, unknown>;
		return {
			enforcementEnabled: record.enforcementEnabled !== false,
			footerEnabled: record.footerEnabled !== false,
			codexRecoveryEnabled: record.codexRecoveryEnabled === true,
			usageTokenBudgets: parseUsageTokenBudgets(record.usageTokenBudgets),
		};
	} catch {
		return defaultSettings();
	}
}

async function persistSettings(path: string, settings: ExtensionSettings): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	await atomicJson.write(path, settings, { mode: 0o600, pretty: true, trailingNewline: true });
}

export function persistentEnforcementControl(env: Record<string, string | undefined> = process.env): PersistentExtensionControl {
	const path = settingsPath(env);
	const settings = loadSettings(path);
	return {
		isEnabled: () => settings.enforcementEnabled,
		async setEnabled(value: boolean): Promise<void> {
			settings.enforcementEnabled = value;
			await persistSettings(path, settings);
		},
		isFooterEnabled: () => settings.footerEnabled,
		async setFooterEnabled(value: boolean): Promise<void> {
			settings.footerEnabled = value;
			await persistSettings(path, settings);
		},
		isCodexRecoveryEnabled: () => settings.codexRecoveryEnabled,
		async setCodexRecoveryEnabled(value: boolean): Promise<void> {
			settings.codexRecoveryEnabled = value;
			await persistSettings(path, settings);
		},
		getUsageTokenBudget(period): number | undefined {
			return settings.usageTokenBudgets[period];
		},
		async setUsageTokenBudget(period, tokens): Promise<void> {
			if (tokens !== undefined && (!Number.isFinite(tokens) || tokens <= 0))
				throw new Error("usage token budget must be a positive finite number");
			if (tokens === undefined) delete settings.usageTokenBudgets[period];
			else settings.usageTokenBudgets[period] = tokens;
			await persistSettings(path, settings);
		},
	};
}

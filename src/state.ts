import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import {
	DATABASE_FILENAME,
	HANDLE_FILENAME,
	JITTOR_STATE_DIRECTORY,
	LOOPBACK_HOST,
	SYSTEMD_UNIT_NAME,
	TOKEN_FILENAME,
} from "./constants.ts";

export interface JittorPaths {
	database: string;
	token: string;
	handle: string;
	systemdUnit: string;
}

export interface DaemonHandle {
	host: typeof LOOPBACK_HOST;
	port: number;
	pid: number;
}

export interface PathEnvironment {
	env?: Record<string, string | undefined>;
	home?: string;
	uid?: number;
}

export function resolveJittorPaths(options: PathEnvironment = {}): JittorPaths {
	const env = options.env ?? process.env;
	const home = options.home ?? homedir();
	const uid = options.uid ?? process.getuid?.() ?? 0;
	const dataHome = env["XDG_DATA_HOME"] ?? join(home, ".local", "share");
	const stateHome = env["XDG_STATE_HOME"] ?? join(home, ".local", "state");
	const runtimeHome = env["XDG_RUNTIME_DIR"] ?? join("/run", "user", String(uid));
	const configHome = env["XDG_CONFIG_HOME"] ?? join(home, ".config");
	return {
		database: join(dataHome, JITTOR_STATE_DIRECTORY, DATABASE_FILENAME),
		token: join(stateHome, JITTOR_STATE_DIRECTORY, TOKEN_FILENAME),
		handle: join(runtimeHome, JITTOR_STATE_DIRECTORY, HANDLE_FILENAME),
		systemdUnit: join(configHome, "systemd", "user", SYSTEMD_UNIT_NAME),
	};
}

export function ensureAuthToken(paths: JittorPaths = resolveJittorPaths()): string {
	mkdirSync(dirname(paths.token), { recursive: true, mode: 0o700 });
	if (existsSync(paths.token)) {
		chmodSync(paths.token, 0o600);
		const token = readFileSync(paths.token, "utf8").trim();
		if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("invalid Jittor authentication token");
		return token;
	}
	const token = randomBytes(32).toString("hex");
	writeFileSync(paths.token, `${token}\n`, { mode: 0o600 });
	return token;
}

export function writeDaemonHandle(paths: JittorPaths, handle: DaemonHandle): void {
	mkdirSync(dirname(paths.handle), { recursive: true, mode: 0o700 });
	const temporary = `${paths.handle}.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(handle)}\n`, { mode: 0o600 });
	renameSync(temporary, paths.handle);
}

export function readDaemonHandle(paths: JittorPaths = resolveJittorPaths()): DaemonHandle | null {
	try {
		const value = JSON.parse(readFileSync(paths.handle, "utf8")) as Partial<DaemonHandle>;
		if (value.host !== LOOPBACK_HOST || !Number.isInteger(value.port) || value.port! < 1 || value.port! > 65_535 || !Number.isInteger(value.pid)) return null;
		return value as DaemonHandle;
	} catch {
		return null;
	}
}

export function removeDaemonHandle(paths: JittorPaths = resolveJittorPaths()): void {
	rmSync(paths.handle, { force: true });
}

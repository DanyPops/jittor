/**
 * Jittor's XDG paths/token/handle layout, now delegating to `@danypops/daemon-kit/paths` --
 * the shared substrate factored out after jittor's own state.ts and web-spider-daemon's were
 * found byte-identical (see daemon-kit's README). Kept as a thin jittor-named wrapper (same
 * exported function names/signatures as before) so every existing call site (daemon.ts,
 * client.ts, cli.ts, and their tests) is untouched by this migration.
 */
import {
	ensureAuthToken as ensureDaemonKitAuthToken,
	readDaemonHandle as readDaemonKitHandle,
	removeDaemonHandle as removeDaemonKitHandle,
	resolveDaemonPaths,
	writeDaemonHandle as writeDaemonKitHandle,
	type DaemonHandle,
	type DaemonPaths,
	type PathEnvironment,
} from "@danypops/daemon-kit/paths";
import {
	DATABASE_FILENAME,
	HANDLE_FILENAME,
	JITTOR_STATE_DIRECTORY,
	SYSTEMD_UNIT_NAME,
	TOKEN_FILENAME,
} from "./constants.ts";

export type JittorPaths = DaemonPaths;
export type { DaemonHandle, PathEnvironment };

const JITTOR_PATH_NAMES = {
	stateDirectoryName: JITTOR_STATE_DIRECTORY,
	databaseFilename: DATABASE_FILENAME,
	tokenFilename: TOKEN_FILENAME,
	handleFilename: HANDLE_FILENAME,
	systemdUnitName: SYSTEMD_UNIT_NAME,
};

export function resolveJittorPaths(options: PathEnvironment = {}): JittorPaths {
	return resolveDaemonPaths(JITTOR_PATH_NAMES, options);
}

export function ensureAuthToken(paths: JittorPaths = resolveJittorPaths()): string {
	return ensureDaemonKitAuthToken(paths.token, "Jittor");
}

export function writeDaemonHandle(paths: JittorPaths, handle: DaemonHandle): void {
	writeDaemonKitHandle(paths.handle, handle);
}

export function readDaemonHandle(paths: JittorPaths = resolveJittorPaths()): DaemonHandle | null {
	return readDaemonKitHandle(paths.handle);
}

export function removeDaemonHandle(paths: JittorPaths = resolveJittorPaths()): void {
	removeDaemonKitHandle(paths.handle);
}

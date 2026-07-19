import { describe, expect, it } from "bun:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderSystemdUnit } from "../src/cli.ts";
import { connectJittorClient } from "../src/client.ts";
import { startDaemon, telemetrySourcesFromEnvironment } from "../src/daemon.ts";
import { ensureAuthToken, readDaemonHandle, resolveJittorPaths, writeDaemonHandle } from "../src/state.ts";

describe("Jittor daemon state", () => {
	it("resolves database, runtime handle, and config through XDG paths", () => {
		const paths = resolveJittorPaths({
			home: "/home/test", uid: 1000,
			env: { XDG_DATA_HOME: "/data", XDG_STATE_HOME: "/state", XDG_RUNTIME_DIR: "/run/user/1000", XDG_CONFIG_HOME: "/config" },
		});
		expect(paths.database).toBe("/data/jittor/jittor.db");
		expect(paths.token).toBe("/state/jittor/auth-token");
		expect(paths.handle).toBe("/run/user/1000/jittor/daemon.json");
		expect(paths.systemdUnit).toBe("/config/systemd/user/jittor.service");
	});

	it("persists a private token and discoverable loopback handle", () => {
		const root = mkdtempSync(join(tmpdir(), "jittor-state-"));
		const paths = resolveJittorPaths({
			home: root, uid: 1000,
			env: { XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"), XDG_RUNTIME_DIR: join(root, "run"), XDG_CONFIG_HOME: join(root, "config") },
		});
		const token = ensureAuthToken(paths);
		expect(token).toMatch(/^[a-f0-9]{64}$/);
		expect(statSync(paths.token).mode & 0o777).toBe(0o600);
		writeDaemonHandle(paths, { host: "127.0.0.1", port: 43123, pid: 99 });
		expect(readDaemonHandle(paths)).toEqual({ host: "127.0.0.1", port: 43123, pid: 99 });
	});

	it("configures providers only from explicit environment inputs", () => {
		expect(telemetrySourcesFromEnvironment({})).toEqual([]);
		expect(telemetrySourcesFromEnvironment({ JITTOR_CODEX_AUTH_FILE: "/private/auth.json" }).map((source) => source.id)).toEqual(["codex-subscription"]);
		expect(telemetrySourcesFromEnvironment({ OPENROUTER_API_KEY: "secret" }).map((source) => source.id)).toEqual(["openrouter"]);
	});

	it("composes SQLite, authenticated HTTP, and the typed client", async () => {
		const root = mkdtempSync(join(tmpdir(), "jittor-daemon-"));
		const paths = resolveJittorPaths({
			home: root, uid: 1000,
			env: { XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"), XDG_RUNTIME_DIR: join(root, "run"), XDG_CONFIG_HOME: join(root, "config") },
		});
		const daemon = startDaemon(paths);
		try {
			const client = connectJittorClient(paths);
			expect(await client.health()).toEqual({ ok: true, version: "0.1.2" });
			await client.call("metrics.record", {
				source: "jittor", scope: "daemon", metric: "requests", value: 1, unit: "count", observedAt: 1000,
			});
			expect(await client.call("metrics.query", { source: "jittor" })).toHaveLength(1);
		} finally {
			await daemon.stop();
		}
		expect(readDaemonHandle(paths)).toBeNull();
	});
});

describe("Jittor systemd unit", () => {
	it("supervises the Bun daemon with restart and hardening controls", () => {
		const unit = renderSystemdUnit({ bunBin: "/usr/bin/bun", cliPath: "/opt/jittor/src/cli.ts" });
		expect(unit).toContain("ExecStart=/usr/bin/bun /opt/jittor/src/cli.ts serve");
		expect(unit).toContain("Restart=always");
		expect(unit).toContain("NoNewPrivileges=true");
		expect(renderSystemdUnit({
			bunBin: "/usr/bin/bun", cliPath: "/opt/jittor/src/cli.ts", codexAuthFile: "/home/test/.codex/auth.json",
		})).toContain('Environment="JITTOR_CODEX_AUTH_FILE=/home/test/.codex/auth.json"');
	});
});

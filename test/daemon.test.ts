import { describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderSystemdUnit } from "../src/cli.ts";
import { connectJittorClient } from "../src/client.ts";
import { benchmarkSourcesFromEnvironment, reportMaintenanceFailure, startDaemon, telemetrySourcesFromEnvironment } from "../src/daemon.ts";
import { ensureAuthToken, readDaemonHandle, resolveJittorPaths, writeDaemonHandle } from "../src/state.ts";
import { VERSION } from "../src/version.ts";

describe("reportMaintenanceFailure", () => {
	// This is the seam that replaced `void somePromise()` with no .catch at
	// all in the maintenance/poll timers. An unhandled rejection there used
	// to be fatal -- verified directly (Bun crashes the process; it does not
	// invoke `process.on("unhandledRejection")` first). Every timer callback
	// now routes failures through this function instead of letting them
	// become unhandled rejections.
	it("logs a structured, credential-safe event instead of throwing or crashing", () => {
		const errorSpy = spyOn(console, "error").mockImplementation(() => {});
		try {
			expect(() => reportMaintenanceFailure("checkpoint_failed", new Error("disk full"))).not.toThrow();
			expect(errorSpy).toHaveBeenCalledTimes(1);
			const logged = JSON.parse(String(errorSpy.mock.calls[0]?.[0]));
			// `msg`, not a separate `event` field, since log.ts now delegates to daemon-kit's
			// pino-backed createLogger -- one deliberate, disclosed shape change from the old
			// hand-rolled format (see log.ts's doc comment).
			expect(logged).toMatchObject({ level: "error", component: "jittor-daemon", msg: "checkpoint_failed", message: "disk full" });
			expect(typeof logged.timestamp).toBe("string");
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("stringifies a non-Error rejection reason rather than losing it", () => {
		const errorSpy = spyOn(console, "error").mockImplementation(() => {});
		try {
			reportMaintenanceFailure("benchmark_refresh_failed", "plain string rejection");
			const logged = JSON.parse(String(errorSpy.mock.calls[0]?.[0]));
			expect(logged.message).toBe("plain string rejection");
		} finally {
			errorSpy.mockRestore();
		}
	});
});

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
		expect(benchmarkSourcesFromEnvironment({})).toEqual([]);
		expect(benchmarkSourcesFromEnvironment({ JITTOR_OPENROUTER_BENCHMARKS: "1" }).map((source) => source.id)).toEqual(["openrouter-models"]);
		expect(benchmarkSourcesFromEnvironment({ JITTOR_OPENROUTER_BENCHMARKS: "1", OPENROUTER_API_KEY: "secret" }).map((source) => source.id)).toEqual(["openrouter-models", "openrouter-artificial-analysis", "openrouter-design-arena"]);
	});

	it("starting with a configured (but unreachable) telemetry source never crashes or hangs the daemon", async () => {
		// router.poll() and benchmarks.refresh() both already catch per-source
		// failures internally and never reject their outer promise (verified
		// by reading router.ts/benchmark.ts directly) -- so this exercises the
		// realistic "misconfigured auth file" path end to end and confirms it
		// stays a non-event for the daemon, matching that internal contract.
		const root = mkdtempSync(join(tmpdir(), "jittor-daemon-poll-fail-"));
		const paths = resolveJittorPaths({
			home: root, uid: 1000,
			env: { XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"), XDG_RUNTIME_DIR: join(root, "run"), XDG_CONFIG_HOME: join(root, "config") },
		});
		const daemon = startDaemon(paths, { JITTOR_CODEX_AUTH_FILE: join(root, "definitely-does-not-exist.json") });
		try {
			await new Promise((resolve) => setTimeout(resolve, 50));
			const client = connectJittorClient(paths);
			expect(await client.health()).toEqual({ ok: true, version: VERSION });
		} finally {
			await daemon.stop();
		}
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
			expect(await client.health()).toEqual({ ok: true, version: VERSION });
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
		expect(renderSystemdUnit({
			bunBin: "/usr/bin/bun", cliPath: "/opt/jittor/src/cli.ts", openRouterBenchmarks: true,
		})).toContain("Environment=JITTOR_OPENROUTER_BENCHMARKS=1");
	});
});

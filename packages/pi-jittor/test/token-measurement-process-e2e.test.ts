import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type CompanionDaemon,
	encodeFauxScript,
	type RealPiProcess,
	resolveFauxProviderExtensionPath,
	runCliToCompletion,
	SCRIPT_ENV_VAR,
	spawnCompanionDaemon,
	spawnRealPiProcess,
	waitForRpcEvent,
} from "@danypops/pi-process-harness";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

const JITTOR_PACKAGE = fileURLToPath(new URL("../../jittor", import.meta.url));
const JITTOR_EXTENSION = fileURLToPath(new URL("../extension/src/index.ts", import.meta.url));

let sandbox: string | undefined;
let daemon: CompanionDaemon | undefined;
let pi: RealPiProcess | undefined;

afterEach(async () => {
	if (pi) {
		await pi.dispose();
		pi = undefined;
	}
	await daemon?.dispose();
	daemon = undefined;
	if (sandbox) rmSync(sandbox, { recursive: true, force: true });
	sandbox = undefined;
});

interface IsolatedEnvironment extends Record<string, string> {
	XDG_DATA_HOME: string;
	XDG_STATE_HOME: string;
	XDG_RUNTIME_DIR: string;
	XDG_CONFIG_HOME: string;
}

function isolatedEnvironment(root: string): IsolatedEnvironment {
	const env = {
		XDG_DATA_HOME: join(root, "data"),
		XDG_STATE_HOME: join(root, "state"),
		XDG_RUNTIME_DIR: join(root, "runtime"),
		XDG_CONFIG_HOME: join(root, "config"),
		OPENROUTER_API_KEY: "",
		ARTIFICIAL_ANALYSIS_API_KEY: "",
		JITTOR_CODEX_AUTH_FILE: "",
		JITTOR_GOOGLE_VERTEX_BUDGET_SUBSCRIPTION: "",
	};
	for (const directory of Object.values(env).slice(0, 4)) mkdirSync(directory, { recursive: true });
	return env;
}

describe("provider token provenance through a real Pi + Jittor daemon", () => {
	it("persists provider-reported usage with provenance and no prompt content", async () => {
		sandbox = mkdtempSync(join(tmpdir(), "pi-jittor-token-e2e-"));
		const env = isolatedEnvironment(sandbox);
		const handlePath = join(env.XDG_RUNTIME_DIR, "jittor", "daemon.json");
		daemon = await spawnCompanionDaemon({
			command: "bun",
			args: ["src/cli.ts", "serve"],
			cwd: JITTOR_PACKAGE,
			env,
			isReady: () => existsSync(handlePath),
			readyTimeoutMs: 10_000,
			pollIntervalMs: 20,
		});

		pi = spawnRealPiProcess({
			extensions: [resolveFauxProviderExtensionPath(), JITTOR_EXTENSION],
			extraArgs: ["--provider", "faux", "--model", "faux-1"],
			cwd: sandbox,
			isolatedHome: join(sandbox, "home"),
			env: {
				...env,
				[SCRIPT_ENV_VAR]: encodeFauxScript([{ type: "text", text: "deterministic response" }]),
			},
		});
		const events: AgentSessionEvent[] = [];
		pi.onEvent((event) => events.push(event));
		pi.sendPrompt("private e2e prompt that must not be persisted");
		await waitForRpcEvent(events, (event) => event.type === "agent_end", { timeoutMs: 15_000 });

		const query = await runCliToCompletion(
			"bun",
			["src/cli.ts", "metrics", "query", "--source", "pi", "--metric", "input-tokens", "--limit", "10", "--json"],
			{ cwd: JITTOR_PACKAGE, env: { ...process.env, ...env }, maxAttempts: 1 },
		);
		expect(query.code, query.stderr).toBe(0);
		const rows = JSON.parse(query.stdout) as Array<Record<string, unknown>>;
		expect(rows.length).toBeGreaterThan(0);
		const attributes = rows[0]!.attributes as Record<string, unknown>;
		expect(attributes.tokenMeasurement).toMatchObject({
			scope: "request-input",
			provenance: "provider-reported",
			method: "pi-assistant-usage",
			provider: "faux",
			model: "faux-1",
		});
		expect(JSON.stringify(rows)).not.toContain("private e2e prompt");
		expect(JSON.stringify(rows)).not.toContain("deterministic response");

		let snapshots: Array<{ scope: string; attributes: { truncated: boolean } }> = [];
		for (let attempt = 0; attempt < 10 && snapshots.length === 0; attempt++) {
			const snapshotsQuery = await runCliToCompletion(
				"bun",
				["src/cli.ts", "metrics", "query", "--source", "pi-context-snapshot", "--metric", "snapshot", "--limit", "10", "--json"],
				{ cwd: JITTOR_PACKAGE, env: { ...process.env, ...env }, maxAttempts: 1 },
			);
			expect(snapshotsQuery.code, snapshotsQuery.stderr).toBe(0);
			snapshots = JSON.parse(snapshotsQuery.stdout) as typeof snapshots;
			if (snapshots.length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
		}
		expect(snapshots).toHaveLength(1);
		expect(snapshots[0]!.scope).toMatch(/^[A-Za-z0-9_-]{32,64}$/);
		expect(snapshots[0]!.attributes.truncated).toBe(false);
		expect(JSON.stringify(snapshots)).not.toContain("private e2e prompt");
		expect(JSON.stringify(snapshots)).not.toContain("deterministic response");

		const delta = await runCliToCompletion("bun", ["src/cli.ts", "context", "delta", "--session-id", snapshots[0]!.scope], {
			cwd: JITTOR_PACKAGE,
			env: { ...process.env, ...env },
			maxAttempts: 1,
		});
		expect(delta.code, delta.stderr).toBe(0);
		expect(delta.stdout).toContain("Stable prefix: 0 tokens");
		expect(delta.stdout).toContain("structural evidence, not proof of provider cache behavior");
		expect(delta.stdout).not.toContain("private e2e prompt");
	}, 25_000);
});

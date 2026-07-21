import { describe, expect, it } from "bun:test";
import { runCli } from "../src/cli.ts";
import { EXPECTED_OPERATION_NAMES, type OperationName } from "../src/service.ts";

interface Case {
	args: string[];
	operation: OperationName;
}

const routeArg = "openai/gpt-5.4@high";

const cases: Case[] = [
	{ args: ["metrics", "record", "--source", "s", "--scope", "sc", "--metric", "m", "--value", "1", "--unit", "count", "--observed-at", "1000", "--json"], operation: "metrics.record" },
	{ args: ["metrics", "query", "--source", "s", "--json"], operation: "metrics.query" },
	{ args: ["metrics", "prune", "--before", "1000", "--json"], operation: "metrics.prune" },
	{ args: ["metrics", "distinct-scopes", "--source", "pi", "--since", "0", "--until", "1000", "--json"], operation: "metrics.distinct_scopes" },
	{ args: ["benchmarks", "refresh", "--json"], operation: "benchmark.refresh" },
	{ args: ["benchmarks", "status", "--json"], operation: "benchmark.status" },
	{ args: ["benchmarks", "list", "--source", "s", "--json"], operation: "benchmark.query" },
	{ args: ["benchmarks", "rank", "--candidate", routeArg, "--source", "s", "--json"], operation: "models.rank" },
	{ args: ["context", "--json"], operation: "context.assess" },
	{ args: ["service", "checkpoint", "--json"], operation: "service.checkpoint" },
	{ args: ["telemetry", "poll", "--json"], operation: "telemetry.poll" },
	{ args: ["compaction", "estimate", "--json"], operation: "compaction.estimate" },
	{ args: ["router", "status", "--json"], operation: "router.status" },
	{ args: ["router", "decide", "--json"], operation: "router.decide" },
	{ args: ["router", "pause", "--json"], operation: "router.pause" },
	{ args: ["router", "resume", "--json"], operation: "router.resume" },
	{ args: ["router", "override", "--route", routeArg, "--json"], operation: "router.override" },
	{ args: ["router", "clear-override", "--json"], operation: "router.clear_override" },
	{ args: ["router", "current-route", "--route", routeArg, "--json"], operation: "router.current_route" },
	{ args: ["router", "available-routes", "--route", routeArg, "--json"], operation: "router.available_routes" },
];

function fakeDeps(calls: Array<{ operation: string; input: unknown }>, result: unknown = {}) {
	return {
		client: { async call(operation: string, input: unknown) { calls.push({ operation, input }); return result; } } as never,
		stdout: () => {}, stderr: () => {}, systemctl: () => {}, installService: () => {}, serve: () => {},
	};
}

describe("Jittor CLI operation parity", () => {
	it("maps every daemon operation name to at least one first-class CLI command", () => {
		const covered = new Set(cases.map((testCase) => testCase.operation));
		expect([...covered].sort()).toEqual([...EXPECTED_OPERATION_NAMES].sort());
	});

	it("invokes the exact typed operation the daemon expects for each command", async () => {
		for (const testCase of cases) {
			const calls: Array<{ operation: string; input: unknown }> = [];
			const code = await runCli(testCase.args, fakeDeps(calls, {
				deleted: 0, ranked: [], sources: [], observations: [], observedAt: 1, availableRoutes: [], ready: true, paused: false, lastDecision: null, override: null, currentRoute: null,
			}));
			expect(code).toBe(0);
			expect(calls).toHaveLength(1);
			expect(calls[0]?.operation).toBe(testCase.operation);
		}
	});

	it("exposes every EXPECTED_OPERATION_NAMES entry through the raw op escape hatch", async () => {
		for (const operation of EXPECTED_OPERATION_NAMES) {
			const calls: Array<{ operation: string; input: unknown }> = [];
			const code = await runCli(["op", operation, "--input", "{}"], fakeDeps(calls));
			expect(code).toBe(0);
			expect(calls).toEqual([{ operation, input: {} }]);
		}
	});

	it("rejects an unknown operation name through the escape hatch instead of forwarding it blindly", async () => {
		const calls: Array<{ operation: string; input: unknown }> = [];
		const code = await runCli(["op", "not-a-real-operation"], fakeDeps(calls));
		expect(code).toBe(2);
		expect(calls).toHaveLength(0);
	});
});

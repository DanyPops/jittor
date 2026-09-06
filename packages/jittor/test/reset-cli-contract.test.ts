import { expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { auditVehicleOperationContracts } from "@danypops/vehicle-conformance/core";
import { runCli } from "../src/cli.ts";
import type { CliDependencies } from "../src/cli-commands/support.ts";
import { resetContracts } from "../src/vehicle/reset-contracts.ts";

function fixture() {
	const calls: unknown[] = [],
		output: string[] = [];
	const deps = {
		client: {
			call: async (name: string, input: unknown) => {
				calls.push({ name, input });
				return { code: "reset", telemetryRefreshed: false };
			},
		},
		stdout: (text: string) => output.push(text),
		stderr: () => {},
	} as unknown as CliDependencies;
	return { deps, calls, output };
}
it("derives machine help from the operation", async () => {
	const f = fixture();
	expect(await runCli(["resets", "redeem", "--help", "--json"], f.deps)).toBe(0);
	const descriptor = JSON.parse(f.output[0]!).operation;
	expect(descriptor).toEqual(resetContracts["subscription.resets.redeem"].descriptor);
	expect(
		auditVehicleOperationContracts(
			[resetContracts["subscription.resets.redeem"].descriptor],
			[{ surface: "cli", exposedName: "resets redeem", descriptor, presentation: "custom" }],
			{
				readPermissions: ["jittor:read"],
				surfaceExceptions: [
					{
						operation: `${descriptor.name}@${descriptor.version}`,
						surface: "pi",
						reason: "The extension consumes authenticated RPC; reset commands have no native Pi tools.",
					},
				],
			},
		),
	).toMatchObject({ complete: true, truncated: false, issues: [] });
	expect(f.calls).toHaveLength(0);
});
it("prints bounded schema help through the real CLI", () => {
	const output = execFileSync(
		process.execPath,
		[fileURLToPath(new URL("../src/cli.ts", import.meta.url)), "resets", "list", "--help", "--json"],
		{ input: "", timeout: 10_000, maxBuffer: 65_536, encoding: "utf8" },
	);
	expect(JSON.parse(output).operation).toEqual(resetContracts["subscription.resets.list"].descriptor);
});
it("accepts explicit canonical JSON redemption", async () => {
	const f = fixture();
	const input = { confirm: true, creditId: "reset-1", idempotencyKey: "00000000-0000-4000-8000-000000000001" };
	expect(await runCli(["resets", "redeem", "--input", JSON.stringify(input), "--json"], f.deps)).toBe(0);
	expect(f.calls).toEqual([{ name: "subscription.resets.redeem", input }]);
});
it("rejects mixed flag and JSON inputs", async () => {
	const f = fixture();
	expect(await runCli(["resets", "redeem", "--input", "{}", "--confirm"], f.deps)).toBe(2);
	expect(f.calls).toHaveLength(0);
});

import { EXPECTED_OPERATION_NAMES, type OperationName } from "../service.ts";
import type { CliDependencies } from "./support.ts";

export const OP_USAGE_LINES = ["  op <operation> [--input <json>]"];

function parseOpArgs(args: string[]): { operation: OperationName; input: Record<string, unknown> } | null {
	const [operation, ...rest] = args;
	if (operation === undefined || !EXPECTED_OPERATION_NAMES.includes(operation as OperationName)) return null;
	let input: Record<string, unknown> = {};
	for (let index = 0; index < rest.length; index += 1) {
		if (rest[index] !== "--input") return null;
		const raw = rest[++index];
		if (raw === undefined) return null;
		try {
			const parsed = JSON.parse(raw);
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
			input = parsed as Record<string, unknown>;
		} catch {
			return null;
		}
	}
	return { operation: operation as OperationName, input };
}

export async function runOpCommand(
	action: string | undefined,
	rest: string[],
	deps: CliDependencies,
	usage: () => number,
): Promise<number> {
	const parsed = parseOpArgs(action === undefined ? [] : [action, ...rest]);
	if (!parsed) return usage();
	try {
		// The escape hatch dispatches a dynamically named operation; OperationInputs/OperationOutputs
		// are only known statically per literal operation name, so this one call site is intentionally
		// untyped at the boundary. parseOpArgs already restricts `operation` to EXPECTED_OPERATION_NAMES.
		const call = deps.client.call as (operation: OperationName, input: Record<string, unknown>) => Promise<unknown>;
		const result = await call(parsed.operation, parsed.input);
		deps.stdout(JSON.stringify(result));
		return 0;
	} catch (error) {
		deps.stderr(error instanceof Error ? error.message : String(error));
		return 1;
	}
}

import { connectJittorClient } from "../../src/client.ts";
import type { OperationInputs, OperationName, OperationOutputs } from "../../src/service.ts";

let cached = connectJittorClient;
let client: ReturnType<typeof connectJittorClient> | undefined;

export async function callJittor<Name extends OperationName>(
	operation: Name,
	input: OperationInputs[Name],
): Promise<OperationOutputs[Name]> {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			client ??= cached();
			return await client.call(operation, input);
		} catch (error) {
			client = undefined;
			if (attempt === 1) throw error;
		}
	}
	throw new Error("Jittor client retry exhausted");
}

export function resetJittorClientForTests(): void {
	client = undefined;
	cached = connectJittorClient;
}

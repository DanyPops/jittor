import { HUMAN_TEXT_FIELD_MAX_CHARACTERS } from "../constants.ts";
import type { JittorClient } from "../client.ts";
import type { OperationInputs, OperationName, OperationOutputs } from "../service.ts";

export interface CliDependencies {
	client: Pick<JittorClient, "call">;
	stdout(line: string): void;
	stderr(line: string): void;
	systemctl(...args: string[]): void;
	installService(): void;
	serve(): void;
}

export function humanField(value: string): string {
	return value.length <= HUMAN_TEXT_FIELD_MAX_CHARACTERS ? value : `${value.slice(0, HUMAN_TEXT_FIELD_MAX_CHARACTERS - 1)}…`;
}

export async function callAndPrint<Name extends OperationName>(
	deps: CliDependencies,
	operation: Name,
	input: OperationInputs[Name],
	json: boolean,
	formatHuman: (result: OperationOutputs[Name]) => string,
): Promise<number> {
	try {
		const result = await deps.client.call(operation, input);
		deps.stdout(json ? JSON.stringify(result) : formatHuman(result));
		return 0;
	} catch (error) {
		deps.stderr(error instanceof Error ? error.message : String(error));
		return 1;
	}
}

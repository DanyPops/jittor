import type { BenchmarkQuery } from "../domain/benchmark.ts";
import type { BenchmarkController } from "../ports/benchmark-controller.ts";
import type { OperationHandlerMap } from "./types.ts";

/** benchmark.* -- every operation whose only collaborator is the benchmark-controller port. */
export function benchmarkOperations(benchmarks: BenchmarkController): OperationHandlerMap {
	return {
		"benchmark.refresh": (input) => benchmarks.refresh(input["force"] === true),
		"benchmark.status": () => benchmarks.status(),
		"benchmark.query": (input) => benchmarks.query(input as unknown as BenchmarkQuery),
	};
}

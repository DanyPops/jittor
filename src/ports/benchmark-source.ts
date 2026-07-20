import type { BenchmarkSourceSnapshot } from "../domain/benchmark.ts";

/** External evidence boundary. Implementations validate one source-specific schema. */
export interface BenchmarkSource {
	readonly id: string;
	fetch(): Promise<BenchmarkSourceSnapshot>;
}

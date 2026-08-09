import type { BenchmarkQuery, BenchmarkQueryResult, BenchmarkRefreshResult } from "./benchmark.ts";

export interface BenchmarkController {
	refresh(force?: boolean): Promise<BenchmarkRefreshResult>;
	status(): BenchmarkRefreshResult;
	query(input: BenchmarkQuery): BenchmarkQueryResult;
}

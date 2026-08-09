export interface HistoricalUsageRecord {
	identity: string;
	observedAt: number;
	provider: string;
	model: string;
	thinking: string | null;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	costUsd: number;
}

export interface HistoricalUsageScan {
	records: HistoricalUsageRecord[];
	filesScanned: number;
	entriesScanned: number;
	bytesScanned: number;
	malformedEntries: number;
	truncated: boolean;
	canceled: boolean;
	cursor: string | null;
}

export interface HistoricalUsageSource {
	scan(canceled: () => boolean): Promise<HistoricalUsageScan>;
}

export interface UsageImportResult {
	dryRun: boolean;
	discovered: number;
	imported: number;
	duplicates: number;
	filesScanned: number;
	entriesScanned: number;
	bytesScanned: number;
	malformedEntries: number;
	truncated: boolean;
	canceled: boolean;
	cursor: string | null;
	completedAt: number;
}

export interface UsageImportStatus {
	running: boolean;
	cancelRequested: boolean;
	lastResult: UsageImportResult | null;
}

export interface UsageImportStore {
	import(records: HistoricalUsageRecord[]): { imported: number; duplicates: number };
	preview(records: HistoricalUsageRecord[]): { duplicates: number };
	status(): UsageImportStatus;
	saveStatus(status: UsageImportStatus): void;
}

export interface UsageImportController {
	run(input?: { dryRun?: boolean }): Promise<UsageImportResult>;
	status(): UsageImportStatus;
	cancel(): UsageImportStatus;
}

export class HistoricalUsageImporter implements UsageImportController {
	private cancelRequested = false;
	private active = 0;

	constructor(
		private readonly source: HistoricalUsageSource,
		private readonly store: UsageImportStore,
		private readonly clock: () => number = Date.now,
	) {}

	async run(input: { dryRun?: boolean } = {}): Promise<UsageImportResult> {
		this.cancelRequested = false;
		this.active += 1;
		this.persistStatus();
		try {
			const scan = await this.source.scan(() => this.cancelRequested);
			const dryRun = input.dryRun === true;
			const outcome = dryRun ? { imported: 0, duplicates: this.store.preview(scan.records).duplicates } : this.store.import(scan.records);
			const result: UsageImportResult = {
				dryRun,
				discovered: scan.records.length,
				...outcome,
				filesScanned: scan.filesScanned,
				entriesScanned: scan.entriesScanned,
				bytesScanned: scan.bytesScanned,
				malformedEntries: scan.malformedEntries,
				truncated: scan.truncated,
				canceled: scan.canceled,
				cursor: scan.cursor,
				completedAt: this.clock(),
			};
			this.active -= 1;
			this.store.saveStatus({ running: this.active > 0, cancelRequested: this.cancelRequested, lastResult: result });
			return result;
		} catch (error) {
			this.active -= 1;
			this.persistStatus();
			throw error;
		}
	}

	status(): UsageImportStatus {
		const persisted = this.store.status();
		return { ...persisted, running: this.active > 0, cancelRequested: this.cancelRequested };
	}

	cancel(): UsageImportStatus {
		this.cancelRequested = true;
		this.persistStatus();
		return this.status();
	}

	private persistStatus(): void {
		this.store.saveStatus({
			running: this.active > 0,
			cancelRequested: this.cancelRequested,
			lastResult: this.store.status().lastResult,
		});
	}
}

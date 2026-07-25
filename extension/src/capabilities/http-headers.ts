/** Case-insensitive header lookup -- Pi's provider-response event headers are a plain Record, not a Headers instance. */
export function headerValue(headers: Record<string, string>, name: string): string | undefined {
	const expected = name.toLowerCase();
	return Object.entries(headers).find(([key]) => key.toLowerCase() === expected)?.[1];
}

export interface MapWithConcurrencyError {
    index: number;
    error: unknown;
}

export interface MapWithConcurrencyResult<R> {
    // Results indexed parallel to `items`. Indexes where `fn` rejected hold
    // `undefined`; check `errors` to distinguish a thrown rejection from an
    // `fn` that legitimately returned `undefined`.
    results: (R | undefined)[];
    errors: MapWithConcurrencyError[];
}

export async function mapWithConcurrency<T, R>(
    items: T[],
    concurrency: number,
    fn: (item: T) => Promise<R>,
): Promise<MapWithConcurrencyResult<R>> {
    const results: (R | undefined)[] = new Array(items.length);
    const errors: MapWithConcurrencyError[] = [];
    let next = 0;
    const workerCount = Math.min(concurrency, items.length);
    const workers = Array.from({ length: workerCount }, async () => {
        while (true) {
            const idx = next++;
            if (idx >= items.length) return;
            try {
                results[idx] = await fn(items[idx]);
            } catch (error) {
                results[idx] = undefined;
                errors.push({ index: idx, error });
            }
        }
    });
    await Promise.all(workers);
    return { results, errors };
}

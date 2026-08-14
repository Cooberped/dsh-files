// Bounded LRU cache for parsed document text. Keys are the fs target key plus
// the observed file version, so an edited file never serves stale text while
// unchanged files are parsed at most once per process.
export class ParseCache {
    map = new Map();
    maxEntries;
    constructor(maxEntries) {
        if (!Number.isInteger(maxEntries) || maxEntries < 1) {
            throw new Error(`ParseCache: maxEntries must be a positive integer, got ${maxEntries}`);
        }
        this.maxEntries = maxEntries;
    }
    get(key) {
        const k = this.keyOf(key);
        const hit = this.map.get(k);
        if (hit !== undefined) {
            // Refresh recency.
            this.map.delete(k);
            this.map.set(k, hit);
        }
        return hit;
    }
    set(key, text) {
        const k = this.keyOf(key);
        if (this.map.has(k))
            this.map.delete(k);
        this.map.set(k, text);
        while (this.map.size > this.maxEntries) {
            const oldest = this.map.keys().next().value;
            if (oldest === undefined)
                break;
            this.map.delete(oldest);
        }
    }
    clear() {
        this.map.clear();
    }
    get size() {
        return this.map.size;
    }
    keyOf(key) {
        return `${key.targetKey}\u0000${key.version}\u0000${key.format}`;
    }
}

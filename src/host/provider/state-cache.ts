/** A short-lived promise cache that coalesces concurrent reads. */
export class StateCache<K, V> {
  private readonly entries = new Map<K, { readonly at: number; readonly value: Promise<V> }>()

  constructor(private readonly ttlMs: number) {}

  /** Return a fresh cached promise or compute and cache one. */
  get(key: K, compute: () => Promise<V>): Promise<V> {
    const cached = this.entries.get(key)
    if (cached !== undefined && Date.now() - cached.at < this.ttlMs) return cached.value
    const value = compute()
    this.entries.set(key, { at: Date.now(), value })
    void value.catch(() => {
      if (this.entries.get(key)?.value === value) this.entries.delete(key)
    })
    return value
  }

  /** Remove one entry after a mutation. */
  delete(key: K): void {
    this.entries.delete(key)
  }

  /** Remove all cached state during disposal. */
  clear(): void {
    this.entries.clear()
  }
}

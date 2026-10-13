/** A bounded, asynchronous memory job. It grants no tool authorization. */
export class MemoryMaintenance {
  private readonly roots = new Set<string>();
  private running = false;
  private closed = false;
  private immediate: NodeJS.Immediate | undefined;
  private readonly timer: NodeJS.Timeout;
  constructor(private readonly improve: (cwd: string) => Promise<unknown>, intervalMs = 15 * 60 * 1000) {
    this.timer = setInterval(() => { void this.runOnce(); }, intervalMs);
    this.timer.unref();
  }
  schedule(cwd: string): void {
    if (this.closed) return;
    if (this.roots.size < 32 || this.roots.has(cwd)) this.roots.add(cwd);
    if (!this.immediate) {
      this.immediate = setImmediate(() => { this.immediate = undefined; void this.runOnce(); });
      this.immediate.unref();
    }
  }
  async runOnce(): Promise<void> {
    if (this.running || this.closed) return;
    this.running = true;
    try {
      for (const cwd of this.roots) {
        if (this.closed) break;
        try { await this.improve(cwd); }
        catch { /* A failed observation must never fail the caller's work. */ }
      }
    } finally { this.running = false; }
  }
  close(): void {
    this.closed = true; clearInterval(this.timer);
    if (this.immediate) clearImmediate(this.immediate);
    this.roots.clear();
  }
}

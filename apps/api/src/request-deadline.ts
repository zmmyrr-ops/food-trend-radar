/** Bounds headers AND body reads. A transport ignoring abort quarantines the lane. */
export class RequestDeadline {
  private active = false;
  private availableAt = 0;
  get pending() {
    return this.active;
  }
  constructor(private readonly timeoutMs = 25_000) {}
  async run<T>(request: (signal: AbortSignal) => Promise<T>): Promise<T> {
    // Do not overlap with an unresolved request, even after manual resume.
    if (this.active) throw new Error("REQUEST_TIMEOUT");
    this.active = true;
    // If a timed-out transport settled late, retain the global two-second gap.
    const wait = this.availableAt - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    const controller = new AbortController();
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const operation = Promise.resolve()
      .then(() => request(controller.signal))
      .finally(() => {
        this.active = false;
        if (expired) this.availableAt = Date.now() + 2000;
      });
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        expired = true;
        reject(new Error("REQUEST_TIMEOUT"));
        controller.abort();
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([operation, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }
}

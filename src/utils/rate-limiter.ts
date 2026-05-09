export class RateLimiter {
  private queue = Promise.resolve();
  private readonly intervalMs: number;

  constructor(requestsPerSecond: number) {
    this.intervalMs = Math.ceil(1000 / requestsPerSecond);
  }

  schedule<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const result = await operation();
      await new Promise((resolve) => setTimeout(resolve, this.intervalMs));
      return result;
    });

    this.queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
}

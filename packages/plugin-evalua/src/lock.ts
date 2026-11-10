/** Raised when a caller waited longer than its timeout for the lock (the section never ran). */
export class LockTimeoutError extends Error {
  constructor() {
    super("The Evalua workspace is busy; try again in a moment");
    this.name = "LockTimeoutError";
  }
}

/**
 * Async mutex (app spec D2): one per coordinator, so every read-modify-write of the workspace state
 * (chat commands, tools and app actions) runs alone and in arrival order. Not re-entrant.
 */
export class Mutex {
  private held = false;
  private readonly waiters: Array<() => void> = [];

  get locked(): boolean {
    return this.held;
  }

  private acquire(timeoutMs?: number): Promise<() => void> {
    if (!this.held) {
      this.held = true;
      return Promise.resolve(this.releaser());
    }
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiter = () => {
        if (timer !== undefined) clearTimeout(timer);
        resolve(this.releaser());
      };
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new LockTimeoutError());
        }, timeoutMs);
      }
      this.waiters.push(waiter);
    });
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next();
      else this.held = false;
    };
  }

  /** Runs `section` while holding the lock; `timeoutMs` bounds only the wait, not the section. */
  async run<T>(section: () => Promise<T>, options: { timeoutMs?: number } = {}): Promise<T> {
    const release = await this.acquire(options.timeoutMs);
    try {
      return await section();
    } finally {
      release();
    }
  }
}

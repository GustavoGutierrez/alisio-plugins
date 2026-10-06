/** Writes one footer line of the host UI; `undefined` clears it. */
export type StatusSink = (key: string, text: string | undefined) => void;

/**
 * `ui.status` lines (spec 18.1): key `phase` is `<feature> <phase> <unit>`, key `job` is
 * `<jobId> <n>/<m>`. Only the TUI shows them, other surfaces ignore them, and a failing host call
 * never breaks a command.
 */
export class StatusPresenter {
  constructor(private readonly sink: StatusSink) {}

  phase(feature: string, phase: string, unit: string): void {
    this.set("phase", `${feature} ${phase} ${unit}`);
  }

  job(id: string, done: number, total: number): void {
    this.set("job", `${id} ${done}/${total}`);
  }

  /** Both lines cleared: nothing is running. */
  idle(): void {
    this.set("phase", undefined);
    this.set("job", undefined);
  }

  private set(key: string, text: string | undefined): void {
    try {
      this.sink(key, text);
    } catch {
      // The footer is decoration; the work goes on without it.
    }
  }
}

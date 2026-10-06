export interface RunningServer {
  stop(): Promise<void>;
}

export type ServerOutcome = { ok: true; server: RunningServer } | { ok: false; reason: string };

/** The one optional `fidelity.serve` command: started, waited for on its ready URL, then stopped. */
export interface DevServer {
  start(input: {
    root: string;
    argv: readonly string[];
    readyUrl: string;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<ServerOutcome>;
}

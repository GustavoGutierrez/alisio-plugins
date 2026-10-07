export type Severity = "error" | "warning";

export interface CheckFinding {
  id: string;
  severity: Severity;
  subject: string;
  message: string;
  fix?: string;
}

export interface CheckReport {
  ok: boolean;
  results: CheckFinding[];
}

/** Collects `EVL-*` findings and derives `ok` (no error-severity finding). */
export class CheckCollector {
  readonly results: CheckFinding[] = [];

  error(id: string, subject: string, message: string, fix?: string): void {
    this.results.push({
      id,
      severity: "error",
      subject,
      message,
      ...(fix === undefined ? {} : { fix }),
    });
  }

  warning(id: string, subject: string, message: string, fix?: string): void {
    this.results.push({
      id,
      severity: "warning",
      subject,
      message,
      ...(fix === undefined ? {} : { fix }),
    });
  }

  report(): CheckReport {
    return {
      ok: !this.results.some((finding) => finding.severity === "error"),
      results: this.results,
    };
  }
}

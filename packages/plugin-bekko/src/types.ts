/**
 * The subset of the `jev-web` contract this plugin relies on. `jev-web` ships plain JavaScript
 * without type declarations, so the shapes are declared here and every value coming back from it
 * is validated by the codec before it reaches the host.
 */
export type Variant = "68m" | "17m";

export type Question =
  | {
      id: string;
      type: "choice";
      instructions: string;
      options: string[];
      criteria: Record<string, string>;
    }
  | {
      id: string;
      type: "noul";
      instructions: string;
      options: ["no", "yes"];
      criteria: { true: string; false: string };
    }
  | { id: string; type: "score"; instructions: string; options: string[] };

/** One answer as returned by the model runtime. Untrusted until decoded. */
export interface RawAnswer {
  type?: unknown;
  choice?: unknown;
  noul?: unknown;
  probabilities?: unknown;
  confidence?: unknown;
}

export interface Prediction {
  answers: RawAnswer[];
  truncated: boolean;
}

/** A loaded model. `decide` runs one batch; `dispose` releases the ONNX session. */
export interface Engine {
  decide(state: string, questions: Question[]): Promise<Prediction>;
  dispose(): Promise<void>;
}

export type EngineFactory = (
  variant: Variant,
  progress: (message: string) => void,
) => Promise<Engine>;

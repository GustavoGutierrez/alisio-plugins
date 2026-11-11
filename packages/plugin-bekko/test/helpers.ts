import type { DecisionRequest } from "@alisio/sdk";
import type { Engine, Prediction, Question } from "../src/types.js";

export function request(decisions: DecisionRequest["decisions"], state: unknown = { a: 1 }) {
  return { version: 1, id: "test", state, decisions } as DecisionRequest;
}

/** A fake engine that answers every question with a fixed, valid answer. */
export function fakeEngine(answer?: (q: Question) => unknown): Engine & { disposed: boolean } {
  const engine = {
    disposed: false,
    async decide(_state: string, questions: Question[]): Promise<Prediction> {
      return {
        truncated: false,
        answers: questions.map((q) => {
          if (answer) return answer(q) as never;
          if (q.type === "choice") {
            const probabilities = Object.fromEntries(
              q.options.map((o, i) => [o, i === 0 ? 0.9 : 0.1 / (q.options.length - 1)]),
            );
            return { type: "choice", choice: q.options[0], probabilities, confidence: 0.9 };
          }
          if (q.type === "noul") return { type: "noul", noul: 0.8 };
          const probabilities = Object.fromEntries(
            q.options.map((_, i) => [String(i), i === 1 ? 0.7 : 0.3 / (q.options.length - 1)]),
          );
          return { type: "score", probabilities };
        }),
      };
    },
    async dispose() {
      engine.disposed = true;
    },
  };
  return engine;
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

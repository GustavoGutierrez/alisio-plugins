import { num } from "../svg.js";

/**
 * One curve, evaluated by the component from exact parameters, so a family draws the very function
 * it asks about. `polynomial` takes ascending coefficients (`[c, b, a]` is `a x² + b x + c`),
 * `exponential` is `a · base^x`, `logarithm` is `log_base(x)`, `sinusoid` is
 * `amplitude · fn(2πx / period) + shift` (a trigonometric curve whose period is in x units).
 */
export type Curve =
  | { type: "polynomial"; coefficients: number[] }
  | { type: "exponential"; a: number; base: number }
  | { type: "logarithm"; base: number }
  | { type: "sinusoid"; fn: "sin" | "cos"; amplitude: number; period: number; shift: number };

export function evaluateCurve(curve: Curve, x: number): number {
  switch (curve.type) {
    case "polynomial":
      return curve.coefficients.reduceRight((total, coefficient) => total * x + coefficient, 0);
    case "exponential":
      return curve.a * curve.base ** x;
    case "logarithm":
      return x > 0 && curve.base > 0 && curve.base !== 1 ? Math.log(x) / Math.log(curve.base) : NaN;
    case "sinusoid": {
      const phase = (2 * Math.PI * x) / curve.period;
      const wave = curve.fn === "sin" ? Math.sin(phase) : Math.cos(phase);
      return curve.amplitude * wave + curve.shift;
    }
  }
}

export function curves(value: unknown): Curve[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 3).flatMap((entry): Curve[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const raw = entry as Record<string, unknown>;
    if (raw.type === "polynomial" && Array.isArray(raw.coefficients)) {
      const coefficients = raw.coefficients.filter(
        (c): c is number => typeof c === "number" && Number.isFinite(c),
      );
      return coefficients.length === 0 ? [] : [{ type: "polynomial", coefficients }];
    }
    if (raw.type === "exponential") {
      return [{ type: "exponential", a: num(raw.a, 1), base: Math.max(0.01, num(raw.base, 2)) }];
    }
    if (raw.type === "logarithm") return [{ type: "logarithm", base: num(raw.base, 2) }];
    if (raw.type === "sinusoid") {
      return [
        {
          type: "sinusoid",
          fn: raw.fn === "cos" ? "cos" : "sin",
          amplitude: num(raw.amplitude, 1),
          period: Math.max(0.5, num(raw.period, 4)),
          shift: num(raw.shift, 0),
        },
      ];
    }
    return [];
  });
}

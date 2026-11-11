import { expect } from "vitest";
import { type FigureSpec, figureSvg } from "../../src/figures/index.js";

/** Largest SVG a single figure may emit; keeps exam pages light and PDFs fast. */
export const MAX_SVG_BYTES = 40_000;

/** Renders a spec twice and checks the shared contract: deterministic, accessible, self-contained. */
export function render(spec: FigureSpec): string {
  const svg = figureSvg(spec);
  expect(figureSvg(spec)).toBe(svg);
  expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  expect(svg).toContain('role="img"');
  expect(svg).toMatch(/aria-label="[^"]+"/);
  expect(svg).toMatch(/<title>[^<]+<\/title>/);
  expect(svg).not.toMatch(/href=|<image|<script|url\(/);
  expect(svg.length).toBeLessThan(MAX_SVG_BYTES);
  return svg;
}

export const count = (svg: string, pattern: RegExp): number => svg.match(pattern)?.length ?? 0;

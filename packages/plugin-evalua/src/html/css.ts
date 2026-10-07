import type { DensityPreset } from "../layout/presets.js";
import type { Theme } from "../themes.js";

export interface CssOptions {
  theme: Theme;
  density: DensityPreset;
  paper: "letter" | "a4";
  columns: 1 | 2;
}

/**
 * Builds the print stylesheet from the theme tokens and the density preset (spec 10.1, 10.3, 11.2).
 * It references no network resource: fonts are vendored and inlined elsewhere.
 */
export function renderCss({ theme, density, paper, columns }: CssOptions): string {
  const token = (name: string, fallback: string): string => theme.tokens[name] ?? fallback;
  return `@page { size: ${paper === "a4" ? "A4" : "letter"}; margin: ${density.marginsMm}mm; }
:root {
  --body-font: ${token("bodyFont", "Georgia, serif")};
  --heading-font: ${token("headingFont", "Arial, sans-serif")};
  --body-pt: ${density.bodyPt}pt;
  --line-height: ${density.lineHeight};
  --item-gap: ${density.itemGapMm}mm;
  --accent: ${token("accent", "#1a1a1a")};
  --accent-soft: ${token("accentSoft", "#ececec")};
  --rule: ${token("ruleColor", "#333333")};
  --ref: ${token("refColor", "#6b6b6b")};
  --nota-border: ${token("notaBorder", "#1a1a1a")};
  --info-border: ${token("infoBorder", "#D2D2D2")};
  --badge-bg: ${token("badgeBg", "#000000")};
  --badge-text: ${token("badgeText", "#ffffff")};
  --header-bg: ${token("headerBg", "transparent")};
  --header-text: ${token("headerText", "#1a1a1a")};
  --columns: ${columns};
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  font-family: var(--body-font);
  font-size: var(--body-pt);
  line-height: var(--line-height);
  color: #000;
  print-color-adjust: exact;
  -webkit-print-color-adjust: exact;
}
.exam-header { border-top: 3px solid var(--accent); border-bottom: 1px solid var(--rule); padding: 3mm 2mm 2.5mm; }
.exam-header.band { background: var(--header-bg); color: var(--header-text); border-color: var(--header-bg); padding: 3.5mm 3mm; }
.exam-header .header-top { display: flex; align-items: center; justify-content: center; gap: 4mm; }
.exam-header .logo { max-height: 18mm; max-width: 34mm; object-fit: contain; }
.exam-header .header-text { text-align: center; }
.exam-header .institution { font-family: var(--heading-font); font-weight: 700; font-size: 1.15em; letter-spacing: 0.04em; text-transform: uppercase; }
.exam-header .title { font-family: var(--heading-font); font-weight: 700; font-size: 1.05em; margin-top: 1mm; letter-spacing: 0.02em; }
.exam-header .theme { font-family: var(--heading-font); margin-top: 0.8mm; font-size: 0.95em; }
.exam-header.band .institution, .exam-header.band .title, .exam-header.band .theme { color: var(--header-text); }
.info-box { border: 1px solid var(--info-border); border-radius: 16px; margin: 3mm 4mm; padding: 2mm; }
.info-table { width: 100%; border-collapse: collapse; margin: 0; table-layout: fixed; }
.info-table td { border: 1px solid var(--rule); padding: 1.4mm 2mm; vertical-align: middle; }
.info-table .label { font-family: var(--heading-font); font-weight: 700; width: 15%; background: var(--accent-soft); }
.info-table .value { width: 22%; }
.info-table .value.nowrap { white-space: nowrap; }
.info-table .nota { width: 26%; text-align: center; vertical-align: middle; }
.info-table .nota-label { display: block; font-family: var(--heading-font); font-weight: 700; }
.info-table .nota-box { display: block; height: 15mm; border: 1.5px solid var(--nota-border); margin-top: 1mm; }
.intro { border: 1px solid var(--rule); border-radius: 8px; padding: 2.5mm 3mm; margin: 3mm 0; text-align: justify; }
.section-title { font-family: var(--heading-font); font-weight: 700; margin: var(--item-gap) 0 1mm; break-after: avoid; }
.item { margin-bottom: var(--item-gap); break-inside: avoid; }
.item .stem { display: block; }
.item .ref { color: var(--ref); font-size: 0.85em; margin-left: 1mm; }
.item .number { display: inline-block; min-width: 5.6mm; padding: 0.3mm 1.2mm; margin-right: 1.6mm; border-radius: 3px; background: var(--badge-bg); color: var(--badge-text); font-family: var(--heading-font); font-weight: 700; font-size: 0.95em; text-align: center; }
.options { display: grid; grid-template-columns: repeat(2, 1fr); gap: 1mm 6mm; margin: 1mm 0 0 6mm; }
.options.inline { display: block; }
.option .key { font-weight: 700; margin-right: 1mm; }
.answer-space { border: 1px solid var(--rule); height: calc(var(--body-pt) * 2 * var(--answer-lines)); margin-top: 1mm; }
.display { margin: 2mm 0; text-align: center; overflow: hidden; }
.math { white-space: nowrap; }
table.grid { border-collapse: collapse; margin: 1mm 0; }
table.grid th, table.grid td { border: 1px solid var(--rule); padding: 1mm 2mm; }
.figure { margin: 2mm 0; text-align: center; break-inside: avoid; }
.figure .figure-svg { max-width: 100%; height: auto; }
.closing { border: 1px solid var(--rule); border-radius: 8px; padding: 2.5mm 3mm; margin-top: 6mm; text-align: center; font-style: italic; break-inside: avoid; }
.closing .author { display: block; margin-top: 1mm; font-style: normal; font-size: 0.9em; }
.sheet-table { width: 100%; border-collapse: collapse; }
.sheet-table th, .sheet-table td { border: 1px solid var(--rule); padding: 1mm 2mm; }
.solution-entry { margin-bottom: var(--item-gap); break-inside: avoid; }
.solution-entry .answer { font-weight: 700; }
.misconception { font-size: 0.9em; color: var(--ref); }
.columns-2 .questions { column-count: 2; column-gap: 8mm; }
`;
}

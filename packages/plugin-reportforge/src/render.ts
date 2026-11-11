import { PAGE_MARGIN_MM, printableArea } from "./fit.js";
import type { Block, Palette, Report } from "./types.js";

type ChartBlock = Extract<Block, { type: "bars" | "line" | "donut" }>;
export const escapeHtml = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
const num = (n: number) => (Number.isFinite(n) ? n : 0);
const safeColor = (value: string) => (/^#[0-9a-fA-F]{6}$/.test(value) ? value : "#222222");
function svgBars(b: ChartBlock, p: Palette) {
  const n = Math.min(20, b.labels.length, b.values.length);
  const vals = b.values.slice(0, n).map(num);
  const max = Math.max(1, ...vals);
  const height = Math.max(120, Math.min(480, b.height || 210));
  const gap = 16;
  const barw = Math.max(10, (600 - (n + 1) * gap) / Math.max(n, 1));
  const bars = vals
    .map((v, i) => {
      const h = Math.max(0, (v / max) * (height - 58));
      const x = gap + i * (barw + gap);
      const y = height - 32 - h;
      return `<rect x="${x}" y="${y}" width="${barw}" height="${h}" rx="5" fill="${safeColor(i % 2 ? p.secondary : p.accent)}"/><text x="${x + barw / 2}" y="${height - 12}" text-anchor="middle" font-size="11" fill="${safeColor(p.muted)}">${escapeHtml(b.labels[i]!.slice(0, 14))}</text><text x="${x + barw / 2}" y="${Math.max(y - 8, 12)}" text-anchor="middle" font-size="11" fill="${safeColor(p.ink)}">${escapeHtml(v)}</text>`;
    })
    .join("");
  return `<svg role="img" aria-label="${escapeHtml(b.title)}" viewBox="0 0 600 ${height}" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">${bars}</svg>`;
}
function svgLine(b: ChartBlock, p: Palette) {
  const vals = b.values.slice(0, 35).map(num);
  if (!vals.length) return "";
  const lo = Math.min(0, ...vals),
    hi = Math.max(1, ...vals);
  const points = vals.map((v, i) => [
    28 + (i * 544) / Math.max(1, vals.length - 1),
    185 - ((v - lo) / (hi - lo || 1)) * 138,
  ]);
  const d = points
    .map(([x, y], i) => `${i ? "L" : "M"} ${x!.toFixed(1)} ${y!.toFixed(1)}`)
    .join(" ");
  const dots = points
    .map(
      ([x, y], i) =>
        `<circle cx="${x}" cy="${y}" r="4" fill="${safeColor(p.accent)}"><title>${escapeHtml(b.labels[i] || "")}: ${escapeHtml(vals[i])}</title></circle>`,
    )
    .join("");
  return `<svg role="img" aria-label="${escapeHtml(b.title)}" viewBox="0 0 600 220" xmlns="http://www.w3.org/2000/svg"><line x1="28" y1="185" x2="572" y2="185" stroke="${safeColor(p.muted)}" opacity=".25"/><path d="${d}" fill="none" stroke="${safeColor(p.accent)}" stroke-width="4" stroke-linejoin="round"/>${dots}</svg><div class="axis-labels">${b.labels.map((x) => `<small>${escapeHtml(x)}</small>`).join("")}</div>`;
}
function svgDonut(b: ChartBlock, p: Palette) {
  const vals = b.values.slice(0, 16).map((v) => Math.max(0, num(v))),
    sum = vals.reduce((a, c) => a + c, 0);
  if (!sum) return "<p>No data</p>";
  let at = 0;
  const colors = [p.accent, p.secondary, p.tertiary, p.muted];
  const pieces = vals
    .map((v, i) => {
      const portion = (v / sum) * 100;
      const offset = at;
      at += portion;
      return `<circle r="66" cx="100" cy="100" fill="none" stroke="${safeColor(colors[i % colors.length]!)}" stroke-width="29" stroke-dasharray="${portion} ${100 - portion}" stroke-dashoffset="-${offset}" pathLength="100" transform="rotate(-90 100 100)"><title>${escapeHtml(b.labels[i] || "")}: ${v}</title></circle>`;
    })
    .join("");
  const legend = vals
    .map(
      (v, i) =>
        `<li><span class="swatch" style="background:${safeColor(colors[i % colors.length]!)}"></span>${escapeHtml(b.labels[i] || "")} <strong>${Math.round((v / sum) * 100)}%</strong></li>`,
    )
    .join("");
  return `<div class="donut-wrap"><svg viewBox="0 0 200 200" role="img" aria-label="${escapeHtml(b.title)}">${pieces}<text x="100" y="106" text-anchor="middle" font-weight="800" fill="${safeColor(p.ink)}" font-size="22">${escapeHtml(sum.toLocaleString())}</text></svg><ul class="legend">${legend}</ul></div>`;
}
function block(b: Block, p: Palette) {
  const span = Math.min(
    3,
    Math.max(
      1,
      b.span || (["lead", "paragraph", "quote", "table", "timeline"].includes(b.type) ? 3 : 1),
    ),
  );
  const cl = `block block-${b.type} span-${span}`;
  switch (b.type) {
    case "lead":
      return `<section class="${cl}"><span class="rule"></span>${b.title ? `<h2>${escapeHtml(b.title)}</h2>` : ""}<p class="lead">${escapeHtml(b.text)}</p></section>`;
    case "paragraph":
      return `<section class="${cl}">${b.title ? `<h2>${escapeHtml(b.title)}</h2>` : ""}<p>${escapeHtml(b.text)}</p></section>`;
    case "quote":
      return `<blockquote class="${cl}"><p>“${escapeHtml(b.text)}”</p></blockquote>`;
    case "kpi":
      return `<article class="${cl} kpi"><p class="kpi-label">${escapeHtml(b.label)}</p><strong>${escapeHtml(b.value)}</strong>${b.change ? `<span class="chip">${escapeHtml(b.change)}</span>` : ""}<small>${escapeHtml(b.note || "")}</small></article>`;
    case "bars":
    case "line":
    case "donut":
      return `<figure class="${cl} chart"><figcaption>${escapeHtml(b.title)}</figcaption>${b.type === "bars" ? svgBars(b, p) : b.type === "line" ? svgLine(b, p) : svgDonut(b, p)}${b.note ? `<p class="figure-note">${escapeHtml(b.note)}</p>` : ""}</figure>`;
    case "table":
      return `<section class="${cl}"><h2>${escapeHtml(b.title)}</h2><div class="table-scroll"><table><thead><tr>${b.columns.map((s) => `<th scope="col">${escapeHtml(s)}</th>`).join("")}</tr></thead><tbody>${b.rows.map((row) => `<tr>${b.columns.map((_, i) => `<td>${escapeHtml(row[i] ?? "")}</td>`).join("")}</tr>`).join("")}</tbody></table></div></section>`;
    case "timeline":
      return `<section class="${cl}"><h2>${escapeHtml(b.title)}</h2><div class="timeline">${b.steps.map((s, i) => `<div class="step"><div class="step-num">${String(i + 1).padStart(2, "0")}</div><div><strong>${escapeHtml(s.title)}</strong><p>${escapeHtml(s.body || "")}</p></div></div>`).join("")}</div></section>`;
    case "callout":
      return `<aside class="${cl} callout ${escapeHtml(b.tone || "info")}"><h2>${escapeHtml(b.title)}</h2><p>${escapeHtml(b.text)}</p></aside>`;
  }
}
/** True when the stored fit was measured for the report as it is now. */
export function fitIsCurrent(r: Report): boolean {
  const fit = r.fit;
  return (
    !!fit &&
    fit.revision === r.revision &&
    fit.pageSize === r.pageSize &&
    fit.columns === r.columns &&
    Number.isFinite(fit.scale) &&
    fit.scale > 0 &&
    fit.scale <= 1
  );
}

export interface RenderOptions {
  /**
   * Render the single-page print layout on screen, unscaled, so the studio can measure the
   * content at the printable width before computing the fit.
   */
  measure?: boolean;
}

export function renderReport(r: Report, options: RenderOptions = {}) {
  const p = r.palette;
  const colors = Object.entries(p)
    .filter(([k]) =>
      ["background", "paper", "ink", "muted", "accent", "secondary", "tertiary"].includes(k),
    )
    .map(([k, v]) => `--${k}:${safeColor(v)}`)
    .join(";");
  const area = printableArea(r.pageSize);
  const printBase =
    "html,body{background:white!important;-webkit-print-color-adjust:exact;print-color-adjust:exact}.document{max-width:none;padding:0;margin:0;min-height:0;box-shadow:none}.layout{gap:14px}.chart,.kpi,.callout{break-inside:avoid}.block{break-inside:avoid}.hero{break-after:avoid}h2,h3{break-after:avoid}.source-list{overflow-wrap:anywhere}";
  // One page: lay out at the printable width with viewport-independent type, then zoom.
  const singleLayout = `.document{width:${area.width}px}.hero h1{font-size:52px}.kpi strong{font-size:36px}.eyebrow{margin-top:40px}.footer{margin-top:32px}`;
  const single = r.mode === "singlepage";
  const scale = single && fitIsCurrent(r) && r.fit ? r.fit.scale : 1;
  const print = options.measure
    ? `${printBase}${singleLayout}@media print{${printBase}${singleLayout}}`
    : single
      ? `@media print{${printBase}${singleLayout}.document{zoom:${scale}}}`
      : `@media print{${printBase}}`;
  const css = `:root{${colors};color-scheme:light}*{box-sizing:border-box}html{background:var(--background)}body{margin:0;font:15px/1.58 system-ui,-apple-system,'Segoe UI',Arial,sans-serif;color:var(--ink)}.document{max-width:1100px;margin:40px auto;padding:64px;background:var(--paper);min-height:100vh;box-shadow:0 18px 70px #17294b18}.masthead{display:flex;justify-content:space-between;gap:20px;align-items:center;border-bottom:1px solid #8592a73b;padding-bottom:22px}.wordmark{font-size:12px;font-weight:900;letter-spacing:.18em;color:var(--accent)}.meta{text-align:right;color:var(--muted);font-size:11px}.eyebrow{margin-top:70px;font-size:12px;letter-spacing:.18em;color:var(--accent);font-weight:800}.hero h1{font-size:clamp(36px,6vw,66px);line-height:1.04;letter-spacing:-.047em;max-width:850px;margin:16px 0}.subtitle{font-size:21px;color:var(--muted);max-width:720px;margin-top:0}.hero-rule{height:8px;background:linear-gradient(90deg,var(--accent),var(--secondary),var(--tertiary));max-width:250px;border-radius:8px;margin:38px 0}.summary{font-size:17px;max-width:900px;border-left:3px solid var(--accent);padding-left:24px;margin-bottom:35px}.layout{display:grid;grid-template-columns:repeat(var(--cols),minmax(0,1fr));gap:20px}.block{min-width:0;break-inside:avoid;page-break-inside:avoid}.span-1{grid-column:span 1}.span-2{grid-column:span min(2,var(--cols))}.span-3{grid-column:1/-1}h2{font-size:19px;line-height:1.2;letter-spacing:-.025em;margin:0 0 15px}.block p{margin:0}.block-paragraph{padding:16px 0}.block-lead{padding:26px 0}.lead{font-size:22px;line-height:1.48}.rule{display:block;width:38px;height:4px;background:var(--accent);margin-bottom:20px}.kpi,.chart,.callout{padding:22px;border-radius:13px;background:color-mix(in srgb,var(--accent) 5%,var(--paper));border:1px solid color-mix(in srgb,var(--ink) 10%,transparent)}.kpi-label{font-size:12px;font-weight:750;color:var(--muted)}.kpi strong{display:block;font-size:clamp(28px,3vw,44px);letter-spacing:-.06em;line-height:1.2;margin:12px 0}.kpi small{display:block;color:var(--muted);font-size:12px}.chip{display:inline-block;background:color-mix(in srgb,var(--secondary) 18%,transparent);color:var(--ink);border-radius:20px;padding:2px 9px;font-size:11px;font-weight:700}.chart figcaption{font-weight:800;font-size:16px;margin-bottom:16px}.chart svg{width:100%;height:auto;max-height:var(--chart-height,320px)}.figure-note{font-size:12px;color:var(--muted);margin-top:12px!important}.axis-labels{display:flex;justify-content:space-between;color:var(--muted)}.donut-wrap{display:flex;align-items:center;gap:14px}.donut-wrap svg{width:44%;max-width:220px}.legend{list-style:none;padding:0;margin:0;flex:1}.legend li{display:flex;align-items:center;gap:8px;margin:8px 0;font-size:11px}.legend strong{margin-left:auto}.swatch{width:9px;height:9px;border-radius:3px;flex-shrink:0}.table-scroll{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:13px}td,th{text-align:left;padding:11px 10px;border-bottom:1px solid #8e98a735}th{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.04em}.timeline{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:16px}.step{display:flex;gap:12px;align-items:start}.step-num{font-size:21px;font-weight:800;color:var(--accent)}.step p{color:var(--muted);font-size:12px}.callout{border-left:4px solid var(--accent)}.callout.positive{border-left-color:var(--secondary)}.callout.warning{border-left-color:var(--tertiary)}blockquote{margin:0;padding:30px;border-left:5px solid var(--accent);background:var(--background);font-size:22px;font-weight:600}.footer{margin-top:60px;padding-top:15px;display:flex;justify-content:space-between;border-top:1px solid #8e98a735;color:var(--muted);font-size:11px}.source-list{font-size:11px;color:var(--muted);margin-top:34px}.source-list a{color:var(--accent)}@page{size:${r.pageSize === "Letter" ? "letter" : "A4"};margin:${PAGE_MARGIN_MM}mm}@media(max-width:700px){.document{margin:0;padding:30px}.layout{grid-template-columns:1fr!important}.block{grid-column:1/-1}.donut-wrap{display:block}}${print}`;
  const sources = r.sources
    .map((s) =>
      s.url
        ? `<li><a href="${escapeHtml(s.url)}" rel="noreferrer">${escapeHtml(s.name)}</a></li>`
        : `<li>${escapeHtml(s.name)}</li>`,
    )
    .join("");
  return `<!doctype html><html lang="${r.language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(r.title)}</title><style>${css}</style></head><body><main class="document ${single ? "singlepage" : "multipage"}" style="--cols:${r.columns}"${single ? ` data-print-scale="${scale}"` : ""}><header class="masthead"><strong class="wordmark">REPORTFORGE / ALISIO</strong><span class="meta">${escapeHtml(r.type.toUpperCase())}<br>${escapeHtml(new Date(r.updatedAt).toLocaleDateString(r.language))}</span></header><section class="hero"><div class="eyebrow">${escapeHtml(r.eyebrow)}</div><h1>${escapeHtml(r.title)}</h1><p class="subtitle">${escapeHtml(r.subtitle)}</p><div class="hero-rule"></div><p class="summary">${escapeHtml(r.summary)}</p></section><section class="layout">${r.blocks.map((b) => block(b, p)).join("")}</section>${sources ? `<section class="source-list"><strong>${r.language === "es" ? "Fuentes" : "Sources"}</strong><ol>${sources}</ol></section>` : ""}<footer class="footer"><span>${escapeHtml(r.name)}</span><span>${r.language === "es" ? "Diseñado con ReportForge" : "Made with ReportForge"}</span></footer></main></body></html>`;
}

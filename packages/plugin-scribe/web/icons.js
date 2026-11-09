// Hand-made inline line icons (24x24, stroke = currentColor). The frame CSP allows no external
// fonts or images, so every icon is an inline SVG string.
const PATHS = {
  atom: '<circle cx="12" cy="12" r="1.6" fill="currentColor"/><ellipse cx="12" cy="12" rx="10" ry="4"/><ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(120 12 12)"/>',
  sigma: '<path d="M18 5H6l6.5 7L6 19h12"/>',
  laptop: '<rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M2 19h20"/>',
  paperclip:
    '<path d="M20.5 11.5l-8.2 8.2a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8"/>',
  doc: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
  globe:
    '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  cap: '<path d="M2 9l10-5 10 5-10 5z"/><path d="M6 11v5c3 2.5 9 2.5 12 0v-5M22 9v6"/>',
  pencil: '<path d="M4 20l1-4L16 5l3 3L8 19z"/><path d="M14 7l3 3"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
  gear: '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="7"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9L7 7M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
  sparkle:
    '<path d="M11 3l1.8 5.2L18 10l-5.2 1.8L11 17l-1.8-5.2L4 10l5.2-1.8z"/><path d="M19 14l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/>',
  history: '<path d="M3 12a9 9 0 1 0 2.6-6.4L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>',
  upload: '<path d="M12 21V9M7 14l5-5 5 5M5 3h14"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  checkCircle: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.8 2.8L16.5 9.5"/>',
  chevronRight: '<path d="M9 6l6 6-6 6"/>',
  chevronLeft: '<path d="M15 6l-6 6 6 6"/>',
  chevronDown: '<path d="M6 9l6 6 6-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  send: '<path d="M21 3L10 14"/><path d="M21 3l-7 18-4-7-7-4z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  code: '<path d="M8 7l-5 5 5 5M16 7l5 5-5 5M14 4l-4 16"/>',
  more: '<circle cx="5" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="19" cy="12" r="1.4" fill="currentColor"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
  refresh:
    '<path d="M20 11a8 8 0 0 0-14.6-4.5L3 9M3 4v5h5M4 13a8 8 0 0 0 14.6 4.5L21 15M21 20v-5h-5"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  archive:
    '<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M10 13h4"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 15c3-3 5-3 8 0s5 3 10-1"/>',
  table:
    '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M9 4v16M15 4v16"/>',
  braces:
    '<path d="M9 4C7 4 6 5 6 7v2c0 1.5-1 3-2.5 3C5 12 6 13.5 6 15v2c0 2 1 3 3 3M15 4c2 0 3 1 3 3v2c0 1.5 1 3 2.5 3-1.5 0-2.5 1.5-2.5 3v2c0 2-1 3-3 3"/>',
  alert: '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18v.5"/>',
  build: '<path d="M14 4l6 6-9 9H5v-6z"/><path d="M12 6l6 6"/>',
};

/** Inline SVG for `name`; decorative unless a label is given. */
export function icon(name, className = "icon") {
  return `<svg class="${className}" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${PATHS[name] ?? ""}</svg>`;
}

/** Icon per discipline, for category chips and idea rows. */
export const disciplineIcon = (discipline) =>
  ({ physics: "atom", mathematics: "sigma", computing: "laptop" })[discipline] ?? "cap";

/** A small representative glyph drawn on the paper thumbnail of a library card. */
export function paperGlyph(discipline) {
  if (discipline === "mathematics")
    return '<svg viewBox="0 0 60 30" aria-hidden="true"><path d="M10 6h12l-7 9 7 9H10" fill="none" stroke="#1d2b3c" stroke-width="1.6"/><path d="M28 15h24" stroke="#1d2b3c" stroke-width="1.2"/><circle cx="40" cy="9" r="2.4" fill="#2a8bb0"/><circle cx="40" cy="21" r="2.4" fill="#2a8bb0"/></svg>';
  if (discipline === "computing")
    return '<svg viewBox="0 0 60 30" aria-hidden="true"><g stroke="#8aa3b8" stroke-width=".8"><path d="M10 7l20 0M10 7l20 8M10 7l20 16M10 15l20-8M10 15l20 0M10 15l20 8M10 23l20-16M10 23l20-8M10 23l20 0M30 7l18 8M30 15l18 0M30 23l18-8"/></g><g fill="#2a8bb0"><circle cx="10" cy="7" r="2.4"/><circle cx="10" cy="15" r="2.4"/><circle cx="10" cy="23" r="2.4"/><circle cx="30" cy="7" r="2.4"/><circle cx="30" cy="15" r="2.4"/><circle cx="30" cy="23" r="2.4"/></g><circle cx="48" cy="15" r="2.8" fill="#1d2b3c"/></svg>';
  return '<svg viewBox="0 0 60 30" aria-hidden="true"><path d="M14 4c-3 0-3 3-3.5 11S9 26 6 26" fill="none" stroke="#1d2b3c" stroke-width="1.6"/><path d="M20 15c3-7 6-7 9 0s6 7 9 0 6-7 9 0" fill="none" stroke="#2a8bb0" stroke-width="1.6"/></svg>';
}

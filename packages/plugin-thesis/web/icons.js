// Inline 24px stroke icons (own drawings), rendered with currentColor.
const PATHS = {
  home: "M4 11l8-7 8 7v8a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z",
  interview: "M4 5h16v11H9l-5 4zM8 9h8M8 12h5",
  plans: "M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6",
  chapters: "M4 5h7v14H4zM13 5h7v6h-7zM13 13h7v6h-7z",
  evidence: "M4 5a2 2 0 0 1 2-2h5v17H6a2 2 0 0 0-2 2zM20 5a2 2 0 0 0-2-2h-5v17h5a2 2 0 0 1 2 2z",
  review: "M5 21V4h11l-2 4 2 4H5",
  build: "M6 9V3h12v6M6 17H4v-6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v6h-2M7 14h10v7H7z",
  settings:
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12l2-1-1-3-2 .4-1.5-1.5L17 5l-3-1-1 2h-2L10 4 7 5l.5 2L6 8.4 4 8l-1 3 2 1v0l-2 1 1 3 2-.4 1.5 1.5L7 19l3 1 1-2h2l1 2 3-1-.5-2 1.5-1.5 2 .4 1-3z",
  check: "M5 12l5 5 9-10",
  lock: "M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5z",
  dot: "M12 12h.01",
  warning: "M12 4l9 16H3zM12 10v4M12 17v.5",
  close: "M6 6l12 12M18 6L6 18",
  copy: "M9 9h10v10H9zM5 15V5h10",
  copyRich: "M9 9h10v10H9zM5 15V5h10M12 13h4M12 16h3",
  play: "M8 5l11 7-11 7z",
  stop: "M8 8h8v8H8z",
  sparkle:
    "M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z",
  download: "M12 4v12m0 0l-5-5m5 5l5-5M4 20h16",
  left: "M15 18l-6-6 6-6",
  right: "M9 6l6 6-6 6",
  plus: "M12 5v14M5 12h14",
  minus: "M5 12h14",
  fit: "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5",
  edit: "M4 20h4L19 9l-4-4L4 16zM14 6l4 4",
  file: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5",
  arrow: "M5 12h14m0 0l-6-6m6 6l-6 6",
};

export function icon(name, cls = "icon") {
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${PATHS[name] ?? ""}"/></svg>`;
}

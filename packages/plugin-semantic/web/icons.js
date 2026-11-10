// Inline 24px stroke icons (own drawings), rendered with currentColor.
const PATHS = {
  plus: "M12 5v14M5 12h14",
  back: "M15 18l-6-6 6-6",
  upload: "M12 16V4m0 0l-5 5m5-5l5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  file: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5",
  send: "M4 12l16-8-6 16-2-6z",
  stop: "M8 8h8v8H8z",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
  edit: "M4 20h4L19 9l-4-4L4 16zM14 6l4 4",
  sparkle:
    "M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z",
  panelLeft: "M4 5h16v14H4zM9 5v14",
  panelRight: "M4 5h16v14H4zM15 5v14",
  warning: "M12 4l9 16H3zM12 10v4M12 17v.5",
  download: "M12 4v12m0 0l-5-5m5 5l5-5M4 20h16",
  book: "M4 5a2 2 0 0 1 2-2h5v17H6a2 2 0 0 0-2 2zM20 5a2 2 0 0 0-2-2h-5v17h5a2 2 0 0 1 2 2z",
  check: "M5 12l5 5 9-10",
  up: "M12 19V5m0 0l-6 6m6-6l6 6",
  arrowUp: "M12 19V6m0 0l-6 6m6-6l6 6",
  close: "M6 6l12 12M18 6L6 18",
  copy: "M9 9h10v10H9zM5 15V5h10",
  copyRich: "M9 9h10v10H9zM5 15V5h10M12 13h4M12 16h3",
  quote: "M7 7h4v4c0 3-2 5-4 6M15 7h4v4c0 3-2 5-4 6",
};

export function icon(name, cls = "icon") {
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${PATHS[name] ?? ""}"/></svg>`;
}

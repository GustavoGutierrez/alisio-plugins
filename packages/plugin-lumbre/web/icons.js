// Inline 24px stroke icons, drawn for Lumbre and rendered with currentColor.
const PATHS = {
  plus: "M12 5v14M5 12h14",
  back: "M15 18l-6-6 6-6",
  send: "M12 19V6m0 0l-6 6m6-6l6 6",
  stop: "M8 8h8v8H8z",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
  edit: "M4 20h4L19 9l-4-4L4 16zM14 6l4 4",
  warning: "M12 4l9 16H3zM12 10v4M12 17v.5",
  download: "M12 4v12m0 0l-5-5m5 5l5-5M4 20h16",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  file: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5",
  check: "M5 12l5 5 9-10",
  close: "M6 6l12 12M18 6L6 18",
  copy: "M9 9h10v10H9zM5 15V5h10",
  copyRich: "M9 9h10v10H9zM5 15V5h10M12 13h4M12 16h3",
  play: "M8 5l11 7-11 7z",
  external: "M14 4h6v6M20 4l-9 9M18 14v5H5V6h5",
  refresh: "M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6",
  lock: "M7 11V8a5 5 0 0 1 10 0v3M5 11h14v9H5z",
  history: "M3 12a9 9 0 1 0 3-6.7M3 4v5h5M12 8v5l3 2",
  code: "M9 8l-5 4 5 4M15 8l5 4-5 4",
  eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  diff: "M6 3v12M6 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9v3a4 4 0 0 1-4 4H9",
  chat: "M4 5h16v11H8l-4 4z",
  spark: "M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2z",
  box: "M3 7l9-4 9 4-9 4zM3 7v10l9 4 9-4V7M12 11v10",
};

export function icon(name, cls = "icon") {
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${PATHS[name] ?? ""}"/></svg>`;
}

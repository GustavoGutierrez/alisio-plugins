/**
 * Browser-side code of the probe, kept as plain JavaScript text so no compiler or test transform
 * can change what runs in the page. Each constant is a function expression Playwright evaluates
 * with one argument (spec 11.2).
 */

/** Freeze animations and the caret so captures are repeatable (no fixed sleeps, FID 11.1). */
export const FREEZE_CSS =
  "*{animation:none!important;transition:none!important;caret-color:transparent!important}";

/** Wait for fonts, decoded images and two animation frames; never a fixed delay. */
export const READY_SCRIPT = `async () => {
  await document.fonts.ready;
  await Promise.all(Array.from(document.images).map((img) => (img.decode ? img.decode().catch(() => undefined) : undefined)));
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  return true;
}`;

/** Batch measurement of every located element in one evaluation (FID 15.9). */
export const MEASURE_SCRIPT = `async (args) => {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const rgba = (css) => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = "#000";
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], d[3] / 255];
  };
  const hex = (r, g, b) => "#" + [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("").toUpperCase();
  const background = (el) => {
    for (let node = el; node; node = node.parentElement) {
      const cs = getComputedStyle(node);
      if (cs.backgroundImage !== "none" || cs.filter !== "none" || cs.mixBlendMode !== "normal" || Number(cs.opacity) < 1) return "unknown";
      const c = rgba(cs.backgroundColor);
      if (c[3] === 1) return hex(c[0], c[1], c[2]);
      if (c[3] > 0) return "unknown";
    }
    return "#FFFFFF";
  };
  const clipped = (el) => {
    for (let node = el; node; node = node.parentElement) {
      const cs = getComputedStyle(node);
      const hides = cs.overflowX === "hidden" || cs.overflowX === "clip" || cs.overflowY === "hidden" || cs.overflowY === "clip";
      if (hides && (node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1)) return true;
    }
    return false;
  };
  const lines = (el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const tops = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0).map((r) => r.top).sort((a, b) => a - b);
    let count = 0;
    let last = -Infinity;
    for (const top of tops) {
      if (top - last > 1) count += 1;
      last = top;
    }
    return count;
  };
  const sha = async (url) => {
    const bytes = await (await fetch(url)).arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
  };
  const elements = {};
  for (let i = 0; i < args.ids.length; i += 1) {
    const el = args.handles[i];
    if (!el) {
      elements[args.ids[i]] = null;
      continue;
    }
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const visible = cs.display !== "none" && cs.visibility !== "hidden" && r.width > 0 && r.height > 0;
    const styles = {};
    for (const p of args.styleProps) styles[p] = cs.getPropertyValue(p);
    let covered = false;
    if (visible) {
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      if (cx >= 0 && cy >= 0 && cx < innerWidth && cy < innerHeight) {
        const hit = document.elementFromPoint(cx, cy);
        covered = !hit || !(hit === el || el.contains(hit));
      }
    }
    const left = new Set(Array.from(el.children).filter((c) => c.getBoundingClientRect().width > 0).map((c) => Math.round(c.getBoundingClientRect().left)));
    const out = {
      box: { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height },
      styles,
      text: (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim(),
      lineCount: lines(el),
      clipped: clipped(el),
      visible,
      background: background(el),
      covered,
      columns: left.size,
    };
    if (el.tagName === "IMG") {
      out.naturalSize = [el.naturalWidth, el.naturalHeight];
      try {
        out.assetSha256 = await sha(el.currentSrc || el.src);
      } catch (error) {
        out.assetSha256 = undefined;
      }
    }
    elements[args.ids[i]] = out;
  }
  const maskBoxes = [];
  for (const selector of args.masks) {
    for (const node of Array.from(document.querySelectorAll(selector))) {
      const r = node.getBoundingClientRect();
      maskBoxes.push({ x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height });
    }
  }
  return {
    pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    fonts: Array.from(document.fonts).map((f) => ({ family: f.family, status: f.status })),
    elements,
    maskBoxes,
  };
}`;

/** Hide masked content with visibility hidden so the layout stays the same (spec 11.2). */
export const HIDE_MASKS_SCRIPT = `(selectors) => {
  for (const selector of selectors)
    for (const node of Array.from(document.querySelectorAll(selector))) node.style.visibility = "hidden";
  return selectors.length;
}`;

/** The look of every element without focus: compared with the focused look to find an indicator. */
export const FOCUS_BASELINE_SCRIPT = `(args) => {
  const look = (el) => {
    if (!el) return "";
    const cs = getComputedStyle(el);
    return [cs.outlineStyle, cs.outlineWidth, cs.outlineColor, cs.boxShadow].join("|");
  };
  return args.handles.map(look);
}`;

/** The element holding focus: which contract element it is, whether it is visible and unobscured. */
export const FOCUS_STATE_SCRIPT = `(args) => {
  const active = document.activeElement;
  const look = (el) => {
    const cs = getComputedStyle(el);
    return [cs.outlineStyle, cs.outlineWidth, cs.outlineColor, cs.boxShadow].join("|");
  };
  if (!active || active === document.body) return { body: true };
  const index = args.handles.findIndex((h) => h === active);
  const r = active.getBoundingClientRect();
  const cs = getComputedStyle(active);
  const visible = cs.display !== "none" && cs.visibility !== "hidden" && r.width > 0 && r.height > 0;
  let obscured = false;
  if (visible) {
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    obscured = !hit || !(hit === active || active.contains(hit));
  }
  return {
    body: false,
    elementId: index >= 0 ? args.ids[index] : null,
    visible,
    obscured,
    indicator: index >= 0 ? look(active) !== args.baseline[index] : look(active) !== "none|0px|rgb(0, 0, 0)|none",
  };
}`;

/** The known mutations of calibration, applied to the given elements (spec 11.4 step 3). */
export const MUTATE_SCRIPT = `(args) => {
  const shift = (el, dx, dy) => {
    el.style.transform = "translate(" + dx + "px, " + dy + "px)";
  };
  for (const el of args.handles) {
    if (!el) continue;
    switch (args.mutation) {
      case "translate-x-2": shift(el, 2, 0); break;
      case "translate-y-2": shift(el, 0, 2); break;
      case "translate-x-4": shift(el, 4, 0); break;
      case "translate-y-4": shift(el, 0, 4); break;
      case "translate-x-8": shift(el, 8, 0); break;
      case "translate-y-8": shift(el, 0, 8); break;
      case "font-weight-plus-200": {
        const w = Number.parseInt(getComputedStyle(el).fontWeight, 10) || 400;
        el.style.fontWeight = String(Math.min(900, w + 200));
        break;
      }
      case "color-shift-16": {
        const m = /rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/.exec(getComputedStyle(el).color);
        if (m) el.style.color = "rgb(" + [m[1], m[2], m[3]].map((n) => Math.min(255, Number(n) + 16)).join(",") + ")";
        break;
      }
      case "hide-icons":
        for (const node of Array.from(el.querySelectorAll("img,svg,[role=img]"))) node.style.visibility = "hidden";
        break;
      case "replace-text": {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) node.textContent = node.textContent.replace(/\\S/g, "X");
        break;
      }
    }
  }
  return args.mutation;
}`;

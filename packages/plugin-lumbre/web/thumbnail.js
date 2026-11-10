// The static thumbnail (owner decision A): the project's page drawn inside a shadow root, never
// executed. HTML is parsed into an inert document and stripped of scripts, handlers, embeds, forms
// and external URLs; CSS is rewritten so `html`, `body`, `:root` and `:host` target wrappers INSIDE
// the shadow root; and the host element contains layout and paint, so no generated CSS (not even
// `position: fixed` with a huge z-index) can cover Lumbre's own interface.

export const WIDTH = 1280;
export const HEIGHT = 800;

const DROP = new Set([
  "script",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "link",
  "meta",
  "base",
  "noscript",
  "template",
  "portal",
  "applet",
  "audio",
  "video",
  "source",
  "track",
  "style",
  "title",
  "head",
]);
const URL_ATTRS = new Set([
  "src",
  "href",
  "xlink:href",
  "srcset",
  "poster",
  "background",
  "action",
  "formaction",
  "data",
  "ping",
  "cite",
  "longdesc",
  "lowsrc",
]);
const DROP_ATTRS = new Set([
  "srcdoc",
  "autofocus",
  "popover",
  "popovertarget",
  "contenteditable",
  "tabindex",
]);

/** True for URLs that cannot load anything: same-page fragments and inline images. */
const harmless = (value) =>
  /^#/.test(value) || /^data:image\/(png|gif|jpeg|webp|svg\+xml);/i.test(value);

/**
 * Parses and cleans the page. Returns the inert document, its inline styles (to scope) and the
 * classes of `html` and `body`. `assets` maps relative SVG references to data URIs.
 */
export function sanitizeHtml(html, assets = {}, parser = new DOMParser()) {
  const doc = parser.parseFromString(String(html ?? ""), "text/html");
  const styles = [...doc.querySelectorAll("style")].map((s) => s.textContent ?? "");
  for (const el of [...doc.body.querySelectorAll("*")]) {
    const tag = el.localName.toLowerCase();
    if (DROP.has(tag)) {
      el.remove();
      continue;
    }
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim();
      if (name.startsWith("on") || DROP_ATTRS.has(name)) el.removeAttribute(attr.name);
      else if (URL_ATTRS.has(name)) {
        if (Object.hasOwn(assets, value)) el.setAttribute(attr.name, assets[value]);
        else if (!harmless(value)) el.removeAttribute(attr.name);
      } else if (name === "style" && /url\s*\(|expression\s*\(/i.test(value))
        el.removeAttribute(attr.name);
    }
    if (tag === "form") {
      const div = doc.createElement("div");
      for (const attr of [...el.attributes]) div.setAttribute(attr.name, attr.value);
      div.append(...el.childNodes);
      el.replaceWith(div);
    }
  }
  return {
    doc,
    styles,
    htmlClass: doc.documentElement.getAttribute("class") ?? "",
    bodyClass: doc.body.getAttribute("class") ?? "",
  };
}

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Index of the `}` matching the `{` at `open`, skipping strings. */
function matching(css, open) {
  let depth = 0;
  let quote = "";
  for (let i = open; i < css.length; i++) {
    const c = css[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return css.length;
}

/** Rewrites document-level selectors to the wrappers inside the shadow root. */
export function scopeSelector(selector) {
  return selector
    .replace(/:host-context\([^)]*\)|:host\([^)]*\)|:host\b/g, ".lmb-root")
    .replace(/:root\b/g, ".lmb-root")
    .replace(/(^|[\s,>+~(])html(?=$|[\s,.:#[>+~)])/gi, "$1.lmb-root")
    .replace(/(^|[\s,>+~(])body(?=$|[\s,.:#[>+~)])/gi, "$1.lmb-body");
}

function rules(css) {
  let out = "";
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf("{", i);
    if (open === -1) {
      out += css.slice(i).replace(/@(import)[^;]*;?/gi, "");
      break;
    }
    let prelude = css.slice(i, open);
    // Statements before the rule (layer orders, imports) end at the last semicolon.
    const semi = prelude.lastIndexOf(";");
    if (semi !== -1) {
      out += prelude.slice(0, semi + 1).replace(/@(import|charset|namespace)[^;]*;/gi, "");
      prelude = prelude.slice(semi + 1);
    }
    const close = matching(css, open);
    const body = css.slice(open + 1, close);
    const head = prelude.trim();
    if (/^@(media|supports|layer|container|scope|document|starting-style)\b/i.test(head))
      out += `${prelude}{${rules(body)}}`;
    else if (head.startsWith("@")) out += `${prelude}{${body}}`;
    else out += `${scopeSelector(prelude)}{${body}}`;
    i = close + 1;
  }
  return out;
}

/** CSS safe to put inside the thumbnail's shadow root. */
export function scopeCss(css) {
  return rules(stripComments(String(css ?? "")))
    .replace(/url\(\s*(?!["']?\s*data:)[^)]*\)/gi, "none")
    .replace(/expression\s*\(/gi, "none(");
}

const BASE = `:host{all:initial;display:block}
.lmb-viewport{position:relative;width:${WIDTH}px;height:${HEIGHT}px;overflow:hidden;transform-origin:0 0;contain:strict;background:#fff;color:#000;pointer-events:none;user-select:none}
.lmb-root{all:initial;display:block;min-height:100%;font-family:serif;font-size:16px;line-height:normal;color:#000;color-scheme:light}
.lmb-body{display:block;margin:8px}`;

/**
 * Draws a snapshot into `host` (its shadow root is reused). The host element itself must carry
 * paint containment (see `.thumb-canvas` in style.css). Returns false when there is nothing to draw.
 */
export function renderThumbnail(host, snapshot, doc = host.ownerDocument) {
  const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
  root.replaceChildren();
  if (!snapshot || snapshot.kind === "none" || !snapshot.html) return false;
  const clean = sanitizeHtml(snapshot.html, snapshot.assets ?? {}, new doc.defaultView.DOMParser());
  const style = doc.createElement("style");
  style.textContent = `${BASE}\n${[...(snapshot.css ?? []), ...clean.styles].map(scopeCss).join("\n")}`;
  const viewport = doc.createElement("div");
  viewport.className = "lmb-viewport";
  viewport.setAttribute("inert", "");
  viewport.setAttribute("aria-hidden", "true");
  const page = doc.createElement("div");
  page.className = `lmb-root ${clean.htmlClass}`.trim();
  const body = doc.createElement("div");
  body.className = `lmb-body ${clean.bodyClass}`.trim();
  for (const node of [...clean.doc.body.childNodes]) body.append(doc.importNode(node, true));
  page.append(body);
  viewport.append(page);
  root.append(style, viewport);
  fitThumbnail(host);
  return true;
}

/** Scales the 1280×800 page to the host's width. */
export function fitThumbnail(host) {
  const viewport = host.shadowRoot?.querySelector(".lmb-viewport");
  if (!viewport) return;
  const width = host.clientWidth || WIDTH;
  viewport.style.transform = `scale(${Math.min(1, width / WIDTH)})`;
}

import { extname } from "node:path";

/** Extensions that indicate a UI/template path whose tests need stable test selectors. */
const uiExtensions = new Set([
  ".html",
  ".htm",
  ".xhtml",
  ".jsx",
  ".tsx",
  ".vue",
  ".svelte",
  ".astro",
  ".ejs",
  ".hbs",
  ".handlebars",
  ".mustache",
  ".pug",
  ".jade",
  ".twig",
  ".njk",
  ".liquid",
  ".erb",
  ".haml",
  ".slim",
]);

export function isUiPath(path: string): boolean {
  return uiExtensions.has(extname(path).toLowerCase());
}

/** `feature-element-variant`: at least two lowercase alphanumeric segments joined by hyphens. */
const testIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)+$/;

export function isTestId(id: string): boolean {
  return testIdPattern.test(id);
}

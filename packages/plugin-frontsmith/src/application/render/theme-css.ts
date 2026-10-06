import type { PaletteProfile, PaletteResult } from "../../domain/color/palette.js";

/**
 * The theme CSS file of a solved palette: light on `:root, [data-theme="light"]` and dark on
 * `[data-theme="dark"]`, one custom property per role, each theme declaring its `color-scheme`.
 */
export function renderThemeCss(
  result: Extract<PaletteResult, { ok: true }>,
  profile: PaletteProfile,
): string {
  const blocks = result.themes.map((theme) => {
    const selector =
      theme.theme === "light" ? ':root, [data-theme="light"]' : '[data-theme="dark"]';
    const lines = profile.roles.map(
      (role) => `  ${profile.tokenNames[role]}: ${theme.tokens[role]};`,
    );
    return `${selector} {\n  color-scheme: ${theme.theme};\n${lines.join("\n")}\n}\n`;
  });
  return blocks.join("\n");
}

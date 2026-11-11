import { PASTELS } from "../style.js";
import { labels, text, wrap } from "../svg.js";
import type { FigureComponent } from "../types.js";

/** Two or three overlapping sets, each circle in its own translucent tone. */
export const venn: FigureComponent = (params) => {
  const three = params.sets === 3;
  const width = three ? 300 : 260;
  const height = 180;
  const r = 62;
  let body = "";
  if (three) {
    body += `<circle cx="110" cy="70" r="${r}" fill="${PASTELS[0]}" fill-opacity="0.55"/>`;
    body += `<circle cx="190" cy="70" r="${r}" fill="${PASTELS[1]}" fill-opacity="0.55"/>`;
    body += `<circle cx="150" cy="118" r="${r}" fill="${PASTELS[4]}" fill-opacity="0.55"/>`;
    body += text(66, 40, "A") + text(226, 40, "B") + text(146, 172, "C");
  } else {
    body += `<circle cx="100" cy="90" r="${r}" fill="${PASTELS[0]}" fill-opacity="0.55"/>`;
    body += `<circle cx="160" cy="90" r="${r}" fill="${PASTELS[1]}" fill-opacity="0.55"/>`;
    body += text(58, 50, "A") + text(196, 50, "B");
  }
  const names = labels(params.labels);
  names.forEach((name, index) => {
    body += text(12, 20 + index * 14, name, 11);
  });
  return wrap(width, height, body, "Venn diagram");
};

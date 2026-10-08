#!/usr/bin/env node
/**
 * Regenerates the README example images under `assets/`.
 *
 * Uses only the public renderer entry (`dist/renderer.js`), exactly as an external
 * consumer would. The renderer is deterministic: the same specs, templates, palettes
 * and fonts produce byte-identical PNGs, so this script doubles as a reproducibility
 * check.
 *
 * Usage (from the repository root):
 *   pnpm --filter @alisio/plugin-cardsmith build
 *   node packages/plugin-cardsmith/samples/generate-readme-cards.mjs
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(packageRoot, "assets");
mkdirSync(outDir, { recursive: true });

const { renderCard } = await import(pathToFileURL(join(packageRoot, "dist/renderer.js")).href);

async function writeExample(fileName, input, options = {}) {
  const card = await renderCard(input, options);
  writeFileSync(join(outDir, fileName), card.bytes);
  console.log(
    `${fileName}: ${card.width}x${card.height}, ${card.bytes.length} bytes, warnings: ${card.warnings.length}`,
  );
}

// 1 — Kawaii birthday: pastel palette, rounded Chewy title, smiling sun.
await writeExample("example-birthday-kawaii.png", {
  family: "social",
  templateId: "illustrated-greeting",
  sizeId: "social-square",
  paletteId: "amistad-pastel",
  fontPairId: "playful",
  illustrationId: "sun-smile",
  content: {
    title: "¡Feliz cumpleaños!",
    message: "Que tu día brille tanto como tú.",
    author: "Con cariño",
  },
  format: "png",
});

// 2 — Retro birthday: warm palette, handwritten note, seeded confetti.
await writeExample("example-birthday-retro.png", {
  family: "social",
  templateId: "retro-message",
  sizeId: "social-square",
  paletteId: "retro-calido",
  fontPairId: "handwritten-note",
  illustrationId: "sparkle-cluster",
  content: {
    title: "¡Feliz cumple!",
    message: "Otro año lleno de aventuras te espera.",
    tag: "Hoy se celebra",
  },
  seed: 42,
  format: "png",
});

// 3 — Botanical best wishes: fuchsia flower on cream.
await writeExample("example-good-day.png", {
  family: "social",
  templateId: "illustrated-greeting",
  sizeId: "social-square",
  paletteId: "alegria-botanica",
  fontPairId: "handwritten-readable",
  illustrationId: "flower-happy",
  content: {
    title: "Que tengas un gran día",
    message: "Un detalle hecho a mano, solo para ti.",
    author: "Gustavo",
  },
  format: "png",
});

// 4 — Warm wishes: peach palette and a pair of hearts.
await writeExample("example-muchas-felicidades.png", {
  family: "social",
  templateId: "illustrated-greeting",
  sizeId: "social-square",
  paletteId: "amor-calido",
  fontPairId: "handwritten-readable",
  illustrationId: "heart-pair",
  content: {
    title: "¡Muchas felicidades!",
    message: "Que se cumplan todos tus deseos.",
    author: "Con amor",
  },
  format: "png",
});

// Collage — the four cards on a dark grid, read back from the files just written.
const collagePhotos = [
  "example-birthday-kawaii.png",
  "example-birthday-retro.png",
  "example-good-day.png",
  "example-muchas-felicidades.png",
];
await writeExample(
  "example-collage.png",
  {
    family: "composite",
    templateId: "image-collage",
    sizeId: "social-square",
    paletteId: "alisio-ocean",
    fontPairId: "handwritten-readable",
    images: collagePhotos.map((path, index) => ({ id: `photo${"ABCD"[index]}`, path })),
    content: {
      title: "Cuatro formas de felicitar",
      caption: "Tarjetas de ejemplo renderizadas localmente por Cardsmith",
    },
    format: "png",
  },
  {
    imageData: collagePhotos.map((file, index) => ({
      id: `photo${"ABCD"[index]}`,
      data: readFileSync(join(outDir, file)),
    })),
  },
);

console.log(`done -> ${outDir}`);

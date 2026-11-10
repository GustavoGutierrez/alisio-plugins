// A realistic multi-file landing page (~30 KB) as a model would return it, in the block format
// and in the legacy single-JSON format.

const dishes = [
  ["Pan campesino", "Masa madre de 48 horas, corteza crujiente.", "12.000"],
  ["Croissant de mantequilla", "Laminado a mano cada madrugada.", "6.500"],
  ["Pandebono", "Receta del Valle con queso costeño.", "3.000"],
  ["Almojábana", "Tierna, con cuajada fresca.", "3.200"],
  ["Mogolla integral", "Salvado y miel de caña.", "2.800"],
  ["Torta de zanahoria", "Con nueces y glaseado de queso.", "9.500"],
  ["Roscón de arequipe", "Clásico de la casa.", "4.500"],
  ["Pan de bono relleno", "Con bocadillo veleño.", "3.800"],
];

function section(i: number) {
  const items = dishes
    .map(
      ([name, text, price], j) => `        <article class="dish" id="dish-${i}-${j}">
          <h3>${name}</h3>
          <p>${text} Hecho en Chapinero con ingredientes locales y mucho cariño.</p>
          <p class="price">$${price}</p>
        </article>`,
    )
    .join("\n");
  return `    <section class="menu" aria-labelledby="menu-${i}">
      <h2 id="menu-${i}">Menú ${i + 1}: lo que sale del horno hoy</h2>
      <div class="grid">
${items}
      </div>
    </section>`;
}

export const LANDING: Record<string, string> = {
  "index.html": `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Panadería La Espiga</title>
    <link rel="stylesheet" href="styles.css" />
  </head>
  <body>
    <header class="top"><img src="assets/logo.svg" alt="La Espiga" /><nav><a href="#menu-0">Menú</a><a href="about.html">Nosotros</a></nav></header>
    <main>
      <section class="hero"><h1>Pan de masa madre, cada mañana.</h1><p>Pide por WhatsApp y recógelo caliente. "Siempre fresco" — nuestros vecinos.</p><a class="cta" href="#menu-0">Ver el menú</a></section>
${Array.from({ length: 10 }, (_, i) => section(i)).join("\n")}
    </main>
    <footer><p>Calle 63 #9-41, Bogotá · Lunes a sábado, 6:00–19:00</p></footer>
    <script src="script.js"></script>
  </body>
</html>
`,
  "styles.css": `${Array.from(
    { length: 40 },
    (_, i) =>
      `.dish:nth-child(${i + 1}) {\n  animation-delay: ${i * 40}ms;\n  border-color: hsl(${20 + i} 70% 60%);\n}\n`,
  ).join("")}:root {
  --ink: #2b1d14;
  --paper: #fff7ee;
  --ember: #b8501f;
  font-family: Georgia, serif;
}
body { margin: 0; background: var(--paper); color: var(--ink); }
.top { display: flex; justify-content: space-between; padding: 20px 48px; background: var(--ember); }
.top a { color: #fff; margin-left: 16px; }
.hero { padding: 80px 48px; }
.hero h1 { font-size: clamp(2.5rem, 6vw, 4rem); }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 20px; }
.dish { background: #fff; border-radius: 16px; padding: 20px; border: 2px solid transparent; }
.price { font-weight: 700; color: var(--ember); }
.content { content: "a \\"quoted\\" string with a backslash \\\\ and a brace }"; }
`,
  "script.js": `// Opening hours badge and smooth scrolling.
const now = new Date();
const open = now.getDay() !== 0 && now.getHours() >= 6 && now.getHours() < 19;
document.querySelector(".hero")?.insertAdjacentHTML(
  "beforeend",
  \`<p class="badge">\${open ? "Abierto ahora" : "Cerrado ahora"}</p>\`,
);
for (const link of document.querySelectorAll('a[href^="#"]')) {
  link.addEventListener("click", (event) => {
    event.preventDefault();
    document.querySelector(link.getAttribute("href"))?.scrollIntoView({ behavior: "smooth" });
  });
}
`,
  "about.html": `<!doctype html>
<html lang="es"><head><meta charset="utf-8" /><title>Nosotros</title><link rel="stylesheet" href="styles.css" /></head>
<body><main class="hero"><h1>Desde 1998</h1><p>Tres generaciones horneando en el mismo barrio.</p><p><a href="index.html">Volver</a></p></main></body></html>
`,
  "assets/logo.svg": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="30" fill="#b8501f"/><path d="M32 12c6 10 6 30 0 40c-6-10-6-30 0-40z" fill="#ffd18a"/></svg>
`,
};

export const META = {
  summary: "Bakery landing page",
  delete: ["script-old.js"],
  dependencies: [] as Array<{ name: string; version: string }>,
};
export const MESSAGE = "Listo: creé la página de **La Espiga** con menú, horario y ubicación.";

/** The block format the builder now answers with. */
export function blocks(
  files: Record<string, string> = LANDING,
  options: { meta?: unknown; message?: string; done?: boolean } = {},
) {
  const parts = [
    "<<<LUMBRE-META>>>",
    JSON.stringify(options.meta ?? META),
    "<<<LUMBRE-END>>>",
    "<<<LUMBRE-MESSAGE>>>",
    options.message ?? MESSAGE,
    "<<<LUMBRE-END>>>",
  ];
  for (const [path, content] of Object.entries(files))
    parts.push(`<<<LUMBRE-FILE path="${path}">>>`, content.replace(/\n$/, ""), "<<<LUMBRE-END>>>");
  if (options.done !== false) parts.push("<<<LUMBRE-DONE>>>");
  return parts.join("\n");
}

/** The single-JSON format of Lumbre 0.1.0, still accepted. */
export function legacy(files: Record<string, string> = LANDING) {
  return JSON.stringify({
    message: MESSAGE,
    summary: META.summary,
    files: Object.entries(files).map(([path, content]) => ({ path, content })),
    delete: META.delete,
    dependencies: [],
  });
}

/** A text cut in the middle of `path` (as the output limit would). */
export function cutInside(text: string, path: string, keepChars = 80) {
  const at = text.indexOf(`<<<LUMBRE-FILE path="${path}">>>`);
  if (at === -1) throw new Error(`no block ${path}`);
  return text.slice(0, at + `<<<LUMBRE-FILE path="${path}">>>`.length + 1 + keepChars);
}

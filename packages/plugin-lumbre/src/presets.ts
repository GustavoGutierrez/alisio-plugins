// The five v1 stacks (owner decision C): starter files, Lumbre-owned configuration, pinned
// dependencies with a committed lockfile per preset (decision B), commands and the allowlist of
// extra packages the model may request.
import { readFile } from "node:fs/promises";
import type { Files } from "./safety.js";

export type StackId = "vanilla" | "vite" | "react" | "astro" | "next";
export const STACK_IDS: readonly StackId[] = ["vanilla", "vite", "react", "astro", "next"];

/** Exact versions, each published at least two weeks before it was pinned. */
const V = {
  vite: "8.3.5",
  pluginReact: "6.1.2",
  react: "19.3.1",
  tailwind: "4.3.3",
  astro: "7.4.2",
  next: "16.4.3",
} as const;

/**
 * Extra packages the model may request, by exact name and version (validated, shown in the review
 * and installed with `npm install --ignore-scripts --save-exact` once approved; the resulting
 * lockfile is then frozen per project, so later installs are `npm ci`). Every version was published
 * at least two weeks before it was pinned, and each stack's full set is resolved together by
 * `scripts/update-preset-locks.mjs --check-extras` to prove the peer ranges fit the preset.
 */
const FONTS = {
  // Self-hosted fonts (bundled by Vite/Astro/Next; never loaded from a CDN).
  "@fontsource-variable/inter": "5.3.0",
  "@fontsource-variable/fraunces": "5.3.0",
  "@fontsource-variable/bricolage-grotesque": "5.3.0",
  "@fontsource-variable/instrument-sans": "5.3.0",
  "@fontsource/instrument-serif": "5.3.0",
  "@fontsource/dm-serif-display": "5.3.0",
  "@fontsource-variable/manrope": "5.3.0",
  "@fontsource-variable/playfair-display": "5.3.0",
  "@fontsource-variable/literata": "5.3.0",
  "@fontsource/space-mono": "5.3.0",
} as const;
/** Framework-agnostic helpers (any bundled stack). */
const COMMON_EXTRAS = {
  clsx: "2.1.1",
  "tailwind-merge": "3.7.0",
  "class-variance-authority": "0.7.1",
  zod: "4.6.7",
  "date-fns": "4.4.0",
  ...FONTS,
} as const;
/** The Astro feature that enables React islands (owner decision: only when interactivity needs it). */
export const ASTRO_REACT = { "@astrojs/react": "7.1.1" } as const;

/** Lumbre's own Astro config; React islands add the vetted `@astrojs/react` integration. */
function astroConfig(react: boolean) {
  return `// Managed by Lumbre. The port is passed on the command line.
${react ? 'import react from "@astrojs/react";\n' : ""}import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

export default defineConfig({
  server: { host: "127.0.0.1" },
${react ? "  integrations: [react()],\n" : ""}  vite: { plugins: [tailwindcss()], server: { strictPort: true } },
});
`;
}

/** React stacks (React + Vite, Next.js): icons, motion, forms and a curated set of Radix primitives. */
const REACT_EXTRAS = {
  ...COMMON_EXTRAS,
  "lucide-react": "1.61.0",
  motion: "14.6.0",
  "react-hook-form": "7.91.0",
  "@hookform/resolvers": "5.9.2",
  "@radix-ui/react-slot": "1.5.0",
  "@radix-ui/react-dialog": "1.3.1",
  "@radix-ui/react-dropdown-menu": "2.2.1",
  "@radix-ui/react-tabs": "1.2.1",
  "@radix-ui/react-accordion": "1.3.1",
  "@radix-ui/react-popover": "1.3.1",
  "@radix-ui/react-tooltip": "1.4.1",
  "@radix-ui/react-label": "2.1.17",
} as const;

export interface Command {
  /** Package that ships the CLI and the name of its `bin` entry. */
  pkg: string;
  bin: string;
  args: string[];
}

export interface Stack {
  id: StackId;
  /** True when the project has a package.json and needs `npm ci` (vanilla only with Tailwind). */
  npm: boolean;
  /** Dependency key in `presets/<key>/package-lock.json`. */
  key: string;
  dependencies: Record<string, string>;
  allowlist: Record<string, string>;
  /** Lumbre-owned files written from the preset (read-only for the model and the editor). */
  owned: Files;
  /** Generated files the project must never author (build output inside the source tree). */
  generated: string[];
  starter: Files;
  /** Dev server command for `port`; vanilla is served in-process (with the Tailwind watcher). */
  dev?: (port: number) => Command;
  build?: Command;
  /** Tailwind CLI watcher/build for vanilla + Tailwind. */
  css?: { watch: Command; build: Command };
  /** Where a build writes its static HTML and assets, relative to the work folder. */
  output?: { root: string; html: string[]; urlPrefix?: string; urlRoot?: string };
  /** Minimum Node.js the framework supports. */
  minNode: string;
  label: { en: string; es: string };
  description: { en: string; es: string };
}

const page = {
  title: "Your next idea",
  hero: "Your next idea starts here.",
  lead: "Describe what you want to build and Lumbre will shape it with you.",
};

const plainCss = `:root {
  color-scheme: light;
  --ink: #241b16;
  --paper: #fff8ef;
  --ember: #c4562b;
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  color: var(--ink);
  background: var(--paper);
}
body { margin: 0; }
main { max-width: 960px; margin: 0 auto; padding: 12vh 6vw; }
h1 { font-size: clamp(2.4rem, 7vw, 4.6rem); line-height: 1.05; margin: 0 0 1rem; }
p { font-size: 1.15rem; line-height: 1.6; max-width: 40rem; }
.cta { display: inline-block; margin-top: 1.5rem; padding: 0.9rem 1.4rem; border: 0; border-radius: 999px; background: var(--ember); color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
`;

const twBody = `<main class="mx-auto max-w-4xl px-6 py-24">
      <p class="text-sm font-semibold uppercase tracking-widest text-orange-700">Made with Lumbre</p>
      <h1 class="mt-3 text-5xl font-bold leading-tight text-stone-900 sm:text-6xl">${page.hero}</h1>
      <p class="mt-6 max-w-2xl text-lg leading-relaxed text-stone-600">${page.lead}</p>
      <button id="hello" type="button" class="mt-8 rounded-full bg-orange-700 px-6 py-3 font-semibold text-white hover:bg-orange-800">Say hello</button>
      <p id="message" class="mt-4 text-stone-700" role="status"></p>
    </main>`;
const helloJs = `const button = document.querySelector("#hello");
const message = document.querySelector("#message");
button?.addEventListener("click", () => {
  if (message) message.textContent = "Hello! Tell Lumbre what to build next.";
});
`;

function vanilla(tailwind: boolean): Pick<Stack, "starter" | "generated" | "owned"> {
  if (!tailwind)
    return {
      owned: {},
      generated: [],
      starter: {
        "index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${page.title}</title>
    <link rel="stylesheet" href="styles.css" />
  </head>
  <body>
    <main>
      <p>Made with Lumbre</p>
      <h1>${page.hero}</h1>
      <p>${page.lead}</p>
      <button id="hello" type="button" class="cta">Say hello</button>
      <p id="message" role="status"></p>
    </main>
    <script src="script.js"></script>
  </body>
</html>
`,
        "styles.css": plainCss,
        "script.js": helloJs,
      },
    };
  return {
    owned: {},
    generated: ["styles/tailwind.css"],
    starter: {
      "index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${page.title}</title>
    <link rel="stylesheet" href="styles/tailwind.css" />
  </head>
  <body class="bg-orange-50">
    ${twBody}
    <script src="script.js"></script>
  </body>
</html>
`,
      "styles/input.css": '@import "tailwindcss";\n',
      "script.js": helloJs,
    },
  };
}

const viteConfig = (
  react: boolean,
) => `// Managed by Lumbre. The port is passed on the command line.
${react ? 'import react from "@vitejs/plugin-react";\n' : ""}import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [${react ? "react(), " : ""}tailwindcss()],
  server: { host: "127.0.0.1", strictPort: true },
  preview: { host: "127.0.0.1", strictPort: true },
});
`;

const viteArgs = (port: number) => ["--host", "127.0.0.1", "--port", String(port), "--strictPort"];

function stackFor(id: StackId, tailwind: boolean): Stack {
  if (id === "vanilla") {
    const v = vanilla(tailwind);
    const cli = (args: string[]): Command => ({
      pkg: "@tailwindcss/cli",
      bin: "tailwindcss",
      args,
    });
    const io = ["-i", "styles/input.css", "-o", "styles/tailwind.css"];
    return {
      id,
      npm: tailwind,
      key: tailwind ? "vanilla-tailwind" : "vanilla",
      dependencies: tailwind ? { "@tailwindcss/cli": V.tailwind, tailwindcss: V.tailwind } : {},
      allowlist: {},
      ...v,
      ...(tailwind
        ? { css: { watch: cli([...io, "--watch=always"]), build: cli([...io, "--minify"]) } }
        : {}),
      minNode: "22.12.0",
      label: tailwind
        ? { en: "HTML, CSS and JavaScript + Tailwind", es: "HTML, CSS y JavaScript + Tailwind" }
        : { en: "HTML, CSS and JavaScript", es: "HTML, CSS y JavaScript" },
      description: {
        en: "The simplest start: plain files, no framework. Best for a landing page.",
        es: "El inicio más simple: archivos simples, sin framework. Ideal para una página de aterrizaje.",
      },
    };
  }
  if (id === "vite" || id === "react") {
    const react = id === "react";
    return {
      id,
      npm: true,
      key: id,
      dependencies: {
        vite: V.vite,
        tailwindcss: V.tailwind,
        "@tailwindcss/vite": V.tailwind,
        ...(react
          ? { react: V.react, "react-dom": V.react, "@vitejs/plugin-react": V.pluginReact }
          : {}),
      },
      allowlist: react ? { ...REACT_EXTRAS } : { ...COMMON_EXTRAS },
      owned: { "vite.config.js": viteConfig(react) },
      generated: [],
      starter: react
        ? {
            "index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${page.title}</title>
  </head>
  <body class="bg-orange-50">
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
`,
            "src/main.jsx": `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./index.css";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
`,
            "src/App.jsx": `import { useState } from "react";

export default function App() {
  const [count, setCount] = useState(0);
  return (
    <main className="mx-auto max-w-4xl px-6 py-24">
      <p className="text-sm font-semibold uppercase tracking-widest text-orange-700">Made with Lumbre</p>
      <h1 className="mt-3 text-5xl font-bold leading-tight text-stone-900 sm:text-6xl">${page.hero}</h1>
      <p className="mt-6 max-w-2xl text-lg leading-relaxed text-stone-600">${page.lead}</p>
      <button
        type="button"
        className="mt-8 rounded-full bg-orange-700 px-6 py-3 font-semibold text-white hover:bg-orange-800"
        onClick={() => setCount((n) => n + 1)}
      >
        Clicked {count} {count === 1 ? "time" : "times"}
      </button>
    </main>
  );
}
`,
            "src/index.css": '@import "tailwindcss";\n',
          }
        : {
            "index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${page.title}</title>
  </head>
  <body class="bg-orange-50">
    ${twBody}
    <script type="module" src="/src/main.js"></script>
  </body>
</html>
`,
            "src/main.js": `import "./style.css";\n\n${helloJs}`,
            "src/style.css": '@import "tailwindcss";\n',
          },
      dev: (port) => ({ pkg: "vite", bin: "vite", args: viteArgs(port) }),
      build: { pkg: "vite", bin: "vite", args: ["build"] },
      output: { root: "dist", html: ["index.html"] },
      minNode: "22.12.0",
      label: react
        ? { en: "React + Vite + Tailwind", es: "React + Vite + Tailwind" }
        : { en: "Vite + Tailwind", es: "Vite + Tailwind" },
      description: react
        ? {
            en: "An interactive single-page app with React components.",
            es: "Una aplicación interactiva de una página con componentes de React.",
          }
        : {
            en: "Fast modern tooling with plain JavaScript and Tailwind.",
            es: "Herramientas modernas y rápidas con JavaScript simple y Tailwind.",
          },
    };
  }
  if (id === "astro")
    return {
      id,
      npm: true,
      key: id,
      dependencies: { astro: V.astro, tailwindcss: V.tailwind, "@tailwindcss/vite": V.tailwind },
      allowlist: { ...COMMON_EXTRAS, ...ASTRO_REACT },
      owned: { "astro.config.mjs": astroConfig(false) },
      generated: [],
      starter: {
        "src/styles/global.css": '@import "tailwindcss";\n',
        "src/layouts/Layout.astro": `---
import "../styles/global.css";
const { title } = Astro.props;
---
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{title}</title>
  </head>
  <body class="bg-orange-50">
    <slot />
  </body>
</html>
`,
        "src/pages/index.astro": `---
import Layout from "../layouts/Layout.astro";
---
<Layout title="${page.title}">
  <main class="mx-auto max-w-4xl px-6 py-24">
    <p class="text-sm font-semibold uppercase tracking-widest text-orange-700">Made with Lumbre</p>
    <h1 class="mt-3 text-5xl font-bold leading-tight text-stone-900 sm:text-6xl">${page.hero}</h1>
    <p class="mt-6 max-w-2xl text-lg leading-relaxed text-stone-600">${page.lead}</p>
  </main>
</Layout>
`,
      },
      dev: (port) => ({
        pkg: "astro",
        bin: "astro",
        args: ["dev", "--host", "127.0.0.1", "--port", String(port)],
      }),
      build: { pkg: "astro", bin: "astro", args: ["build"] },
      output: { root: "dist", html: ["index.html"] },
      minNode: "22.23.4",
      label: { en: "Astro + Tailwind", es: "Astro + Tailwind" },
      description: {
        en: "Content-first sites with several pages that load fast.",
        es: "Sitios centrados en contenido, con varias páginas que cargan rápido.",
      },
    };
  return {
    id,
    npm: true,
    key: id,
    dependencies: {
      next: V.next,
      react: V.react,
      "react-dom": V.react,
      tailwindcss: V.tailwind,
      "@tailwindcss/postcss": V.tailwind,
    },
    allowlist: { ...REACT_EXTRAS },
    owned: {
      "next.config.mjs":
        "// Managed by Lumbre.\nexport default { poweredByHeader: false, devIndicators: false };\n",
      "postcss.config.mjs":
        '// Managed by Lumbre.\nexport default { plugins: { "@tailwindcss/postcss": {} } };\n',
      "jsconfig.json": `${JSON.stringify({ compilerOptions: { paths: { "@/*": ["./*"] } } }, null, 2)}\n`,
    },
    generated: [],
    starter: {
      "app/globals.css": '@import "tailwindcss";\n',
      "app/layout.jsx": `import "./globals.css";

export const metadata = { title: "${page.title}", description: "Made with Lumbre" };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className="bg-orange-50">{children}</body>
    </html>
  );
}
`,
      "app/page.jsx": `export default function Page() {
  return (
    <main className="mx-auto max-w-4xl px-6 py-24">
      <p className="text-sm font-semibold uppercase tracking-widest text-orange-700">Made with Lumbre</p>
      <h1 className="mt-3 text-5xl font-bold leading-tight text-stone-900 sm:text-6xl">${page.hero}</h1>
      <p className="mt-6 max-w-2xl text-lg leading-relaxed text-stone-600">${page.lead}</p>
      <p className="mt-6 text-stone-600">
        Try the backend route at <code className="rounded bg-orange-100 px-1">/api/hello</code>.
      </p>
    </main>
  );
}
`,
      "app/api/hello/route.js": `export function GET() {
  return Response.json({ message: "Hello from your Next.js backend" });
}
`,
    },
    dev: (port) => ({
      pkg: "next",
      bin: "next",
      args: ["dev", "--hostname", "127.0.0.1", "--port", String(port)],
    }),
    build: { pkg: "next", bin: "next", args: ["build"] },
    output: {
      root: ".next",
      html: ["server/app/index.html"],
      urlPrefix: "/_next/",
      urlRoot: ".next/",
    },
    minNode: "22.12.0",
    label: { en: "Next.js (full stack)", es: "Next.js (full stack)" },
    description: {
      en: "Pages plus backend API routes in one app.",
      es: "Páginas y rutas de API de backend en una sola aplicación.",
    },
  };
}

export function stack(id: StackId, tailwind = false): Stack {
  return stackFor(id, id === "vanilla" ? tailwind : true);
}

export const isStackId = (value: unknown): value is StackId =>
  typeof value === "string" && (STACK_IDS as readonly string[]).includes(value);

/** The project's package.json, generated by Lumbre (never written by the model). */
/** True when an Astro project has React islands enabled (approved `@astrojs/react`). */
export const astroReact = (s: Stack, extras: Record<string, string>) =>
  s.id === "astro" && Object.hasOwn(extras, "@astrojs/react");

/** The packages a project may add: its stack's list, widened by enabled features. */
export function allowlistFor(
  s: Stack,
  extras: Record<string, string> = {},
): Record<string, string> {
  return astroReact(s, extras) ? { ...s.allowlist, ...REACT_EXTRAS } : s.allowlist;
}

/** Packages added for a feature (React islands bring React itself, at the preset's version). */
function featureDependencies(s: Stack, extras: Record<string, string>): Record<string, string> {
  return astroReact(s, extras) ? { react: V.react, "react-dom": V.react } : {};
}

/** Lumbre-owned files of a project: the preset's, transformed by enabled features. */
export function ownedFiles(s: Stack, extras: Record<string, string> = {}): Record<string, string> {
  return astroReact(s, extras)
    ? { ...s.owned, "astro.config.mjs": astroConfig(true) }
    : { ...s.owned };
}

export function packageJson(s: Stack, extras: Record<string, string> = {}): string {
  const deps = { ...s.dependencies, ...featureDependencies(s, extras), ...extras };
  const scripts: Record<string, string> =
    s.id === "vanilla"
      ? {
          dev: "tailwindcss -i styles/input.css -o styles/tailwind.css --watch",
          build: "tailwindcss -i styles/input.css -o styles/tailwind.css --minify",
        }
      : s.id === "next"
        ? { dev: "next dev", build: "next build", start: "next start" }
        : s.id === "astro"
          ? { dev: "astro dev", build: "astro build", preview: "astro preview" }
          : { dev: "vite", build: "vite build", preview: "vite preview" };
  return `${JSON.stringify(
    {
      name: "lumbre-app",
      version: "0.1.0",
      private: true,
      type: "module",
      scripts,
      dependencies: Object.fromEntries(Object.entries(deps).sort(([a], [b]) => a.localeCompare(b))),
    },
    null,
    2,
  )}\n`;
}

/** The committed lockfile of a preset (decision B), shipped in `presets/`. */
export async function presetLock(s: Stack): Promise<string> {
  return readFile(new URL(`../presets/${s.key}/package-lock.json`, import.meta.url), "utf8");
}

/** Every preset key that needs a lockfile. */
export const LOCK_KEYS = ["vanilla-tailwind", "vite", "react", "astro", "next"] as const;

/** Extra packages a proposal may add: exact name and version from the stack's allowlist. */
export function allowedDependency(
  s: Stack,
  name: unknown,
  version: unknown,
  extras: Record<string, string> = {},
): boolean {
  const list = allowlistFor(s, extras);
  return (
    typeof name === "string" &&
    typeof version === "string" &&
    Object.hasOwn(list, name) &&
    list[name] === version
  );
}

/** Node.js version comparison for `minNode` (major.minor.patch). */
export function nodeAtLeast(current: string, minimum: string): boolean {
  const a = current.replace(/^v/, "").split(".").map(Number);
  const b = minimum.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) > (b[i] ?? 0)) return true;
    if ((a[i] ?? 0) < (b[i] ?? 0)) return false;
  }
  return true;
}

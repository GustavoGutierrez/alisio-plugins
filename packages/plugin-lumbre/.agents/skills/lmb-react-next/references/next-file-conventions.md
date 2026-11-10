# Next.js 16 App Router file conventions (for Lumbre)

Based on the Next.js documentation, MIT License, Copyright (c) Vercel, Inc. (vercel/next.js
`docs/01-app`: getting started > project structure, route handlers, proxy; API reference > file
conventions), checked against the docs shipped with the pinned Next.js 16.4.3. Lumbre projects are
JavaScript: use `.js`/`.jsx`, never `.ts`/`.tsx`.

## Routing files (inside `app/`)

| File | Purpose | Notes |
| --- | --- | --- |
| `layout.jsx` | Shared UI around a segment and its children | The root `app/layout.jsx` must render `<html>` and `<body>`. Receives `children` and `params`. |
| `page.jsx` | The UI of a route; makes the segment publicly reachable | Without a `page.jsx` (or `route.js`) a folder is not a URL. |
| `loading.jsx` | Instant loading UI (a Suspense boundary for the segment) | Server Component by default. |
| `error.jsx` | Error UI for the segment | **Must** start with `"use client"`. Receives `error` and `reset`. Does not catch errors of the `layout.jsx` in the same segment. |
| `global-error.jsx` | Error UI for the root layout | In `app/` root only, `"use client"`, and it must define its own `<html>` and `<body>`. |
| `not-found.jsx` | UI for `notFound()` and unmatched URLs of the segment | |
| `template.jsx` | Like a layout but remounted on every navigation | Use only when state must reset per page. |
| `default.jsx` | Fallback of a parallel-route slot after a full page load | A named slot (`@slot`) without a matching page and without `default.jsx` is an error. |
| `route.js` | Route handler: export `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS` | Cannot sit at the same level as a `page.jsx`. Put APIs under `app/api/…/route.js`. |

`forbidden.jsx` and `unauthorized.jsx` exist but are experimental in 16.x: do not use them.

## Segments and folders

- `app/blog/[slug]/page.jsx`: dynamic segment. `params` is a **Promise**:
  `export default async function Page({ params }) { const { slug } = await params; … }`.
  `searchParams` of a page is a Promise too.
- `[...slug]` catch-all, `[[...slug]]` optional catch-all.
- `(group)`: route group, organizes files without adding a URL segment (for example different
  root layouts). Two groups must not resolve to the same URL.
- `_folder`: private folder, never a route; use it for components and helpers colocated with
  routes (`app/_components/Header.jsx`).
- `@slot`: parallel route slot rendered by the parent layout as a prop; give each slot a
  `default.jsx`.
- Intercepting routes (for example a modal over a list): `(.)folder` matches the same level,
  `(..)folder` one level above, `(..)(..)folder` two levels above and `(...)folder` the `app` root.
  The levels count route segments, not file-system folders. Rarely needed in a small site.
- Files other than the special names above can be colocated safely inside `app/`: they are not
  routes unless named `page` or `route`.

## Metadata files (in `app/` or a segment)

- `icon.svg` (Lumbre projects are text-only, so prefer SVG icons), or `icon.jsx` generating one.
- `opengraph-image.jsx` / `twitter-image.jsx` generating an image with `ImageResponse` from
  `next/og`; static PNG/JPG variants are binary, so not available in Lumbre.
- `sitemap.js` and `robots.js` exporting a default function that returns the object form;
  `manifest.js` for a web app manifest.
- Page metadata: `export const metadata = { title, description }` or `generateMetadata` in a
  `layout.jsx`/`page.jsx` (Server Components only).

## Root-level files

- `proxy.js` (at the project root, next to `app/`): **Next.js 16 deprecated `middleware` and
  renamed it to `proxy`**. The file exports one function, named `proxy` or as the default export,
  plus an optional `export const config = { matcher: … }` (the export is still called `config`).
  Without a `matcher`, proxy runs on every request, including `_next/static`, `_next/image` and the
  files in `public/`, so a redirect or check there can block CSS, JS and images: always give it a
  matcher that excludes them. Only one per project. Never create `middleware.js` in Next.js 16.
- `instrumentation.js` exists for observability; small Lumbre sites do not need it.
- Configuration (`next.config.mjs`, `postcss.config.mjs`, `jsconfig.json`) and `package.json` are
  managed by Lumbre: never write them.

## Server and client

- Every component in `app/` is a Server Component unless its file starts with `"use client"`.
  `error.jsx` and `global-error.jsx` always need it; pages and layouts should not.
- Import client components into server components, not the other way around (pass server-rendered
  content to client components as `children`).

## Other conventions in 16.x

- `public/`: static files served from `/`. Lumbre projects hold text files only, so put SVG images
  there (`public/logo.svg` → `/logo.svg`).
- `src/`: Lumbre's Next.js preset keeps `app/` at the project root; do not move it under `src/`.
- Route segment config (exports such as `runtime`, `maxDuration`, `dynamicParams`): small sites do
  not need them; leave the defaults.
- `instrumentation-client.js` and `mdx-components.js`: not used in Lumbre projects (no MDX package
  in the allowlist).
- `global-not-found.jsx`, `forbidden.jsx`, `unauthorized.jsx`: experimental in 16.x; do not use.

## Sources (canonical index: https://nextjs.org/docs/app/api-reference/file-conventions)

Name the page you relied on when you explain a choice to the person.

| Convention | Documentation |
| --- | --- |
| `default.js` | https://nextjs.org/docs/app/api-reference/file-conventions/default |
| Dynamic segments | https://nextjs.org/docs/app/api-reference/file-conventions/dynamic-routes |
| `error.js`, `global-error.js` | https://nextjs.org/docs/app/api-reference/file-conventions/error |
| `forbidden.js` | https://nextjs.org/docs/app/api-reference/file-conventions/forbidden |
| `instrumentation.js` | https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation |
| `instrumentation-client.js` | https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation-client |
| Intercepting routes | https://nextjs.org/docs/app/api-reference/file-conventions/intercepting-routes |
| `layout.js` | https://nextjs.org/docs/app/api-reference/file-conventions/layout |
| `loading.js` | https://nextjs.org/docs/app/api-reference/file-conventions/loading |
| `mdx-components.js` | https://nextjs.org/docs/app/api-reference/file-conventions/mdx-components |
| `middleware.js` (deprecated) | https://nextjs.org/docs/app/api-reference/file-conventions/middleware |
| `not-found.js`, `global-not-found.js` | https://nextjs.org/docs/app/api-reference/file-conventions/not-found |
| `page.js` | https://nextjs.org/docs/app/api-reference/file-conventions/page |
| Parallel routes | https://nextjs.org/docs/app/api-reference/file-conventions/parallel-routes |
| `proxy.js` | https://nextjs.org/docs/app/api-reference/file-conventions/proxy |
| `public` folder | https://nextjs.org/docs/app/api-reference/file-conventions/public-folder |
| `route.js` | https://nextjs.org/docs/app/api-reference/file-conventions/route |
| Route groups | https://nextjs.org/docs/app/api-reference/file-conventions/route-groups |
| Route segment config | https://nextjs.org/docs/app/api-reference/file-conventions/route-segment-config |
| `src` folder | https://nextjs.org/docs/app/api-reference/file-conventions/src-folder |
| `template.js` | https://nextjs.org/docs/app/api-reference/file-conventions/template |
| `unauthorized.js` | https://nextjs.org/docs/app/api-reference/file-conventions/unauthorized |
| Metadata files | https://nextjs.org/docs/app/api-reference/file-conventions/metadata |
| `favicon`, `icon`, `apple-icon` | https://nextjs.org/docs/app/api-reference/file-conventions/metadata/app-icons |
| `manifest.js` | https://nextjs.org/docs/app/api-reference/file-conventions/metadata/manifest |
| `opengraph-image`, `twitter-image` | https://nextjs.org/docs/app/api-reference/file-conventions/metadata/opengraph-image |
| `robots.js` | https://nextjs.org/docs/app/api-reference/file-conventions/metadata/robots |
| `sitemap.js` | https://nextjs.org/docs/app/api-reference/file-conventions/metadata/sitemap |
| Project structure, private folders | https://nextjs.org/docs/app/getting-started/project-structure |

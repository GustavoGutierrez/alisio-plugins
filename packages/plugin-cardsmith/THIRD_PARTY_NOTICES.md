# Third-party notices

Cardsmith ships one native npm dependency, one vendored QR code generator, five font families
and eleven imported illustration sources. Each keeps its own license; full license texts are
reproduced below or ship inside the package at the path noted in each section (the illustration
sources live under the repository's `vendor/` directory, which is not shipped).

## npm dependency: @napi-rs/canvas 1.0.10 (MIT)

`@napi-rs/canvas` is a Skia-backed native canvas for Node. The package ships platform-specific
prebuilt bindings (for example `@napi-rs/canvas-linux-x64-gnu`), resolved by npm at install time;
no binary is committed to this repository.

**Documented dependency-policy exception.** The repository policy prefers Node built-ins and
`@alisio/sdk` and allows an npm dependency only when its value outweighs its maintenance cost.
Cardsmith intentionally ships this native binary dependency — declared here for auditability —
because professional text shaping (kerning, Unicode coverage, `measureText`) and antialiased
rasterization cannot be met with Node built-ins. Renders are fully local: the dependency performs
no network access.

MIT license text:

```text
MIT License

Copyright (c) 2020 lynweklm@gmail.com

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Vendored QR code generator (`src/vendor/nayuki/`)

The TypeScript port of the Nayuki QR Code generator library is vendored from
https://github.com/nayuki/QR-Code-generator at commit
`3c6d0b3cefb4e049dc337e82237c9644399716a8` (retrieved 2026-10-08) and used to draw QR codes into
generated cards. It is not a runtime npm dependency and performs no network access. Adaptations are
limited to `export` on the three namespace declarations (so the file compiles as an ES module under
`NodeNext`) and a compile-time `// @ts-nocheck` directive for this repository's
`noUncheckedIndexedAccess` setting; no functional changes were made, and the full record is in the
repository file `src/vendor/nayuki/NOTICE.md`. License: MIT, Copyright (c)
Project Nayuki; the license text is preserved in the file's header and reproduced here:

```text
Copyright (c) Project Nayuki. (MIT License)
https://www.nayuki.io/page/qr-code-generator-library

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:
- The above copyright notice and this permission notice shall be included in
  all copies or substantial portions of the Software.
- The Software is provided "as is", without warranty of any kind, express or
  implied, including but not limited to the warranties of merchantability,
  fitness for a particular purpose and noninfringement. In no event shall the
  authors or copyright holders be liable for any claim, damages or other
  liability, whether in an action of contract, tort or otherwise, arising from,
  out of or in connection with the Software or the use or other dealings in the
  Software.
```

## Imported illustrations (`resources/illustrations/`)

Eleven shipped illustrations are derived from third-party sources. Each source file is vendored
under `vendor/` for audit (that directory is excluded from the npm package `files` list); the
shipped asset JSON extracts the source paths and recolors every paint to palette tokens with
`tools/import-svg-asset.mjs`. Provenance tables, including SHA-256 hashes, live in
`vendor/svgrepo/SOURCES.md` and `vendor/twemoji/SOURCES.md`; the asset manifest is
`resources/illustrations/NOTICE.md`.

- SVG Repo assets are dedicated to the public domain under **CC0 1.0 Universal**
  (https://creativecommons.org/publicdomain/zero/1.0/); no attribution is required, recorded here
  for provenance. Sources and per-asset license evidence (Wayback Machine page meta or
  Brave-indexed page content), capture ids and SHA-256 hashes are in `vendor/svgrepo/SOURCES.md`.
  Recolored to palette tokens with `tools/import-svg-asset.mjs`:
  - `apple` (Apple) — https://www.svgrepo.com/svg/530371/apple
  - `avocado` (Avocado) — https://www.svgrepo.com/svg/530365/avocado
  - `cherry` (Cherry) — https://www.svgrepo.com/svg/530361/cherry
  - `chick` (Chick) — https://www.svgrepo.com/svg/404758/baby-chick
  - `electrocardiogram` (Electrocardiogram) — https://www.svgrepo.com/svg/138557/electrocardiogram-inside-heart
  - `flower` (Flower) — https://www.svgrepo.com/svg/282787/flower
  - `ice-cream` (Ice cream) — https://www.svgrepo.com/svg/530623/ice-cream
  - `love-birds` (Love birds) — https://www.svgrepo.com/svg/285034/love-birds-birds
  - `strawberry` (Strawberry) — https://www.svgrepo.com/svg/489698/strawberry
  - `watermelon` (Watermelon) — https://www.svgrepo.com/svg/530362/watermelon
- `cherry-blossom` (Cherry blossom) — "Cherry blossom artwork by Twitter, Inc and other
  contributors (Twemoji), licensed CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/),
  recolored to palette tokens." Vendored from https://github.com/jdecked/twemoji at commit
  `54df6a1340154c4f5bad09c85de8b720c5373c03` (`assets/svg/1f338.svg`); the license text is vendored
  in `vendor/twemoji/LICENSE-GRAPHICS`.

## Fonts (`resources/fonts/`)

Fonts ship as static TTF files; the plugin never downloads a font while rendering and does not
depend on system fonts. Each family's full license text is shipped under
`resources/fonts/licenses/`. `resources/fonts/NOTICE.json` records the source URL, upstream commit,
SHA-256, byte size and modification for every shipped TTF and license file.

| Family | Shipped files | License | License text |
| --- | --- | --- | --- |
| Patrick Hand | `PatrickHand-Regular.ttf` | OFL-1.1 | `resources/fonts/licenses/patrickhand-OFL.txt` |
| Chewy | `Chewy-Regular.ttf` | Apache-2.0 | `resources/fonts/licenses/chewy-LICENSE.txt` |
| Caveat | `Caveat-Regular.ttf`, `Caveat-Bold.ttf` | OFL-1.1 | `resources/fonts/licenses/caveat-OFL.txt` |
| Cormorant Garamond | `CormorantGaramond-Regular.ttf`, `CormorantGaramond-SemiBold.ttf` | OFL-1.1 | `resources/fonts/licenses/cormorantgaramond-OFL.txt` |
| Inter | `Inter-Regular.ttf`, `Inter-SemiBold.ttf`, `Inter-Bold.ttf` | OFL-1.1 | `resources/fonts/licenses/inter-OFL.txt` |

Patrick Hand and Chewy are shipped unmodified. Caveat, Cormorant Garamond and Inter are static
instances produced with `fonttools varLib.instancer` from the upstream variable fonts (weights
400/700, 400/600 and opsz=14 at weights 400/600/700 respectively). None of the OFL copyright lines
declares a Reserved Font Name, so the instances keep the upstream family names; the exact
modification for every file is recorded in `resources/fonts/NOTICE.json`.

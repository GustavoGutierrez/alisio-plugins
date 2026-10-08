# Vendored QR Code generator (Nayuki)

- **Upstream:** https://github.com/nayuki/QR-Code-generator
- **Vendored file:** `src/vendor/nayuki/qrcodegen.ts`, from `typescript-javascript/qrcodegen.ts`
- **Commit:** `3c6d0b3cefb4e049dc337e82237c9644399716a8` (branch `master`, resolved 2026-10-08)
- **Download URL:** https://raw.githubusercontent.com/nayuki/QR-Code-generator/3c6d0b3cefb4e049dc337e82237c9644399716a8/typescript-javascript/qrcodegen.ts
- **Retrieved:** 2026-10-08
- **License:** MIT, Copyright (c) Project Nayuki. The license text is preserved verbatim in the
  file's header comment.
- **Runtime dependency:** none. The file is compiled into `dist/` and performs no network access;
  callers pass the payload and draw the returned module matrix on the local canvas.

## Adaptations to the upstream file

1. `export` was added to the three namespace declarations — `namespace qrcodegen`,
   `namespace qrcodegen.QrCode` and `namespace qrcodegen.QrSegment` — so the file compiles as an
   ES module under this repository's `NodeNext` resolution instead of a global script. No other
   export or import changes were made.
2. A `// @ts-nocheck` directive was added directly after the license header. The repository enables
   `noUncheckedIndexedAccess`, which the upstream file predates (43 reported errors). The directive
   is compile-time only and changes no emitted JavaScript; injecting assertions into 43 vendored
   lines was rejected as a larger and more error-prone adaptation.

No functional or API changes were made. Callers use the upstream API, for example
`qrcodegen.QrCode.encodeText(payload, qrcodegen.QrCode.Ecc.MEDIUM)`.

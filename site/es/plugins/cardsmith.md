---
title: "Cardsmith"
description: "Generates finished card images from chat requests: social cards, certificates, badges, banners, photo composites, charts and dynamic data cards."
pageClass: "plugin-detail"
---

<PluginDetail slug="cardsmith" />

![Cardsmith](https://raw.githubusercontent.com/GustavoGutierrez/alisio-plugins/HEAD/packages/plugin-cardsmith/cover.svg)

> English: [README.md](https://github.com/GustavoGutierrez/alisio-plugins/blob/HEAD/packages/plugin-cardsmith/README.md). Ambos README deben actualizarse en conjunto.

Cardsmith interpreta una solicitud de chat en imágenes de tarjetas validadas y renderizadas
localmente: tarjetas sociales, certificados, insignias, banners, composiciones con fotos, gráficas y
tarjetas de datos dinámicas. El modelo solo escribe texto; las plantillas, las paletas y las fuentes
son recursos locales y el plugin dibuja los píxeles.

## Ejemplos

Cada tarjeta es un renderizado local validado: el modelo solo escribió el texto.

![Tarjeta de cumpleaños kawaii con un sol sonriente](https://raw.githubusercontent.com/GustavoGutierrez/alisio-plugins/HEAD/packages/plugin-cardsmith/assets/example-birthday-kawaii.png)

![Collage de cuatro tarjetas de felicitación sobre una cuadrícula oscura](https://raw.githubusercontent.com/GustavoGutierrez/alisio-plugins/HEAD/packages/plugin-cardsmith/assets/example-collage.png)

Las cuatro tarjetas y el collage provienen de `samples/generate-readme-cards.mjs`; el renderizador es
determinista, así que volver a ejecutar el script reproduce PNG idénticos byte a byte.

## Instalación

```bash
alisio install npm:@alisio/plugin-cardsmith
```

## Herramientas

| Herramienta | Efecto | Qué hace |
| --- | --- | --- |
| `card_catalog` | read | Lista los ids de plantillas con tamaños compatibles, campos requeridos y funciones admitidas, además de paletas, pares de fuentes, tamaños y formatos. |
| `card_design` | write | Valida una especificación de diseño y persiste un borrador con revisión. Todavía no hay píxeles. |
| `card_update` | write | Aplica un parche al borrador con la revisión que viste por última vez (`expectedRevision`); `content` se combina por clave. Determinista y sin llamada al modelo. |
| `card_render` | write | Renderiza `preview` mientras se itera o el `final` exportable; publica un artefacto cuando el host ofrece el puente. |
| `card_export` | write | Copia la imagen final al workspace; `move` elimina el archivo de trabajo solo tras verificar la copia. |

## Un recorrido por el chat

**Usuario.** Haz una tarjeta de cumpleaños para mi hermana Ana.

1. **Diseño.** `card_design` con familia `social`, templateId `illustrated-greeting` y
   `content: { title: "¡Feliz cumpleaños, Ana!", message: "Que tengas un día enorme.", author: "Con cariño" }`.
   Cardsmith responde `draft  revision 1: created social/illustrated-greeting at
   social-portrait 1080x1350, palette alegria-botanica, format png.`
2. **Recolorir.** «Hazla más cálida» se convierte en `card_update` con `expectedRevision: 1` y
   `patch: { paletteId: "amor-calido" }`. Cambiar paleta, tamaño o fuente es determinista y nunca
   requiere otra llamada al modelo ni un renderizado manual.
3. **Renderizar.** `card_render` con `mode: "preview"` muestra una imagen pequeña en el chat;
   cuando la persona está conforme, `mode: "final"` renderiza el PNG exportable (JPEG si se pide).
4. **Guardar.** `card_export` con `path: "assets/ana-birthday.png"` copia la imagen final al workspace.
   Descargar guarda en el navegador; exportar escribe en el servidor de Alisio. `move` se usa solo cuando se solicita.

## Qué incluye

Dieciséis plantillas en cinco familias:

- **social** — `editorial-photo`, `illustrated-greeting`, `retro-message`, `metric-summary`
- **personalized** — `certificate-classic`, `badge-clean`, `banner-promo`
- **composite** — `photo-caption`, `watermark`, `image-collage`
- **chart** — `bar`, `line`, `scatter`, `donut`
- **dynamic** — `inventory-product`, `status-card`

Además, seis paletas, 39 ilustraciones recolorizables — 28 piezas originales propias, más diez
ilustraciones importadas bajo CC0 y una flor de cerezo de Twemoji bajo CC BY 4.0, con atribución en
[THIRD_PARTY_NOTICES.md](https://github.com/GustavoGutierrez/alisio-plugins/blob/HEAD/packages/plugin-cardsmith/THIRD_PARTY_NOTICES.md) —, nueve archivos TTF estáticos en seis pares de
fuentes y un generador de códigos QR integrado. Cada recurso está versionado dentro del paquete,
nada se descarga al renderizar y nunca se usan fuentes del sistema.

## Cómo funciona el renderizado

Las imágenes se renderizan en esta máquina con [`@napi-rs/canvas`](https://github.com/Brooooooklyn/canvas)
(con Skia por debajo). El paquete incluye sus propias plantillas, paletas y fuentes TTF estáticas;
nunca descarga recursos durante el renderizado y no depende de fuentes instaladas en el sistema.

`@napi-rs/canvas` es una excepción deliberada y documentada a la política de dependencias del
repositorio («solo módulos integrados de Node y `@alisio/sdk`»): la composición tipográfica
profesional y la rasterización no se pueden lograr solo con módulos integrados de Node, y el paquete
incluye binarios precompilados para cada plataforma. [THIRD_PARTY_NOTICES.md](https://github.com/GustavoGutierrez/alisio-plugins/blob/HEAD/packages/plugin-cardsmith/THIRD_PARTY_NOTICES.md)
registra esa excepción y audita el conjunto completo de dependencias, incluido el generador de
códigos QR integrado y cada archivo de fuente incluido con su SHA-256.

## Determinismo, caché y límites

- Misma entrada, mismos bytes: un entorno fijo (renderizador, plantilla, fuentes, recursos y bytes
  de las imágenes) reproduce la misma imagen para la misma especificación y semilla. Ninguna marca
  de tiempo llega a la escena.
- Cada render se limita a 12 MP; las imágenes de entrada a 20 MB cada una y 60 MB en total, verificado antes y después de decodificar.
- Los renders se ejecutan de a dos mediante una cola acotada; la caché SHA-256 reutiliza renders idénticos.
- Los códigos QR dibujan módulos enteros con zona de silencio y al menos 4 px por módulo, o fallan
  con `QR_TOO_DENSE`.
- Los borradores, los archivos de trabajo y la caché viven en el directorio de estado del plugin
  (`.alisio/cardsmith` dentro del workspace cuando el host no expone `api.paths`).

## Notas para headless y TUI

Los resultados de las herramientas son texto compacto: ids, revisiones, dimensiones, nombres de
paleta y fuente, advertencias y códigos de error accionables. Las imágenes renderizadas viajan como
partes `image` (base64 en el resultado); ningún diálogo ni widget bloquea la ejecución headless y,
sin el puente de artefactos, `card_render` igualmente devuelve la imagen y reporta la limitación con
precisión.

## Renderizador externo

`@alisio/plugin-cardsmith/renderer` renderiza una especificación de diseño sin Alisio, sin setup del
plugin y sin el SDK, para que una aplicación sirva tarjetas desde su propio endpoint autenticado:

```ts
import { renderCard } from "@alisio/plugin-cardsmith/renderer";

const card = await renderCard({
  family: "dynamic",
  templateId: "inventory-product",
  content: { productName: "Runner 2", price: "89.90", currency: "EUR", sku: "RS-2" },
});
// card.bytes: bytes PNG/JPEG — card.width, card.height, card.mimeType, card.warnings
```

Para un endpoint tipo `GET /api/products/:id/card.png`, `createCardRequestHandler` adapta el
renderizador sobre `node:http`: solo GET y HEAD, `ETag` a partir del hash de la imagen y una política
de caché **privada** (nunca pública, porque los datos lo son), mientras tu `CardEndpoint` controla
autenticación, datos y códigos de error:

```ts
import { createServer } from "node:http";
import { createCardRequestHandler, renderCard, type CardEndpoint } from "@alisio/plugin-cardsmith/renderer";

const endpoint: CardEndpoint = {
  async handle({ url }) {
    const product = await findProduct(url.pathname); // aplicación: auth + datos
    if (product === undefined) return { status: "not-found" };
    return { status: "ok", rendered: await renderCard({
      family: "dynamic", templateId: "inventory-product",
      content: { productName: product.name, price: product.price },
    }) };
  },
};
createServer(createCardRequestHandler(endpoint)).listen(3000);
```

## Desarrollo

```bash
pnpm --filter @alisio/plugin-cardsmith build
pnpm --filter @alisio/plugin-cardsmith typecheck
pnpm --filter @alisio/plugin-cardsmith test
node packages/plugin-cardsmith/samples/generate-readme-cards.mjs  # regenera las imágenes de Ejemplos
pnpm check  # lint, leak, typecheck, test, build y pack:check para todo el repositorio
```

## Estado

`0.1.0`: las cinco familias renderizan imágenes finales y las cinco herramientas permiten diseñar,
actualizar, renderizar y exportar. La publicación de artefactos depende del puente del host para
plugins externos; sin él, la imagen igualmente se renderiza, se exporta al workspace y reporta la
limitación.

## Licencia

MIT. Los componentes de terceros y sus licencias se enumeran en
[THIRD_PARTY_NOTICES.md](https://github.com/GustavoGutierrez/alisio-plugins/blob/HEAD/packages/plugin-cardsmith/THIRD_PARTY_NOTICES.md).

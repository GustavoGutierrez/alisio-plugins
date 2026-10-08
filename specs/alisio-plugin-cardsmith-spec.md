# Cardsmith — especificación de @alisio/plugin-cardsmith

Fecha de investigación: 8 de octubre de 2026. Estado: propuesta de implementación; no representa un plugin ya construido ni publicado.

## 1. Producto y alcance

Cardsmith convierte solicitudes del chat en imágenes mediante plantillas, fuentes y recursos locales. La IA interpreta la intención y redacta textos si se solicita; el código valida, compone, renderiza y exporta. No genera código de dibujo mediante el LLM en cada ejecución.

Nombre: **Cardsmith**. Paquete oficial: **@alisio/plugin-cardsmith**. ID: **alisio.cardsmith**. Si se publica fuera de los paquetes oficiales, usar un scope propio: la guía reserva `@alisio/plugin-*` para first-party.

El primer lanzamiento incluye cinco familias funcionales:

| Familia | Tipos incluidos | Datos principales | Plantillas iniciales |
| --- | --- | --- | --- |
| social | Tarjetas sociales, frases, felicitaciones y estadísticas | Título, mensaje, autor, imagen, logo, CTA, métricas | editorial-photo, illustrated-greeting, retro-message, metric-summary |
| personalized | Certificados, credenciales y banners | Nombre, entidad, motivo, fecha, cargo, foto, identificador, QR | certificate-classic, badge-clean, banner-promo |
| composite | Composición de imágenes, texto y marcas de agua | Imágenes, recorte, logo, texto, posición, opacidad | photo-caption, watermark, image-collage |
| chart | Gráficas exportadas | Series, categorías, ejes, unidades y título | bar, line, scatter, donut |
| dynamic | Tarjetas vinculadas a datos y reutilizables desde endpoint | Datos tipados, identificador, fecha de actualización | inventory-product, status-card |

La familia dynamic produce una instantánea en chat y un contrato reutilizable para una aplicación consumidora. Un QR con URL no convierte por sí solo una tarjeta estática en una tarjeta dinámica.

## 2. Evidencia sobre Alisio y límites reales

Fuentes consultadas: sitio oficial, guía del catálogo, SDK y host de plugins de la rama main. La página principal consultada presenta Alisio 0.5.1; el código de main y el SDK publicado pueden diferir. Antes de implementar, fijar un commit del core y la versión realmente publicada del SDK.

Capacidades observadas:

- `definePlugin`, `api.tools.register`, comandos, recursos de skills/prompts, estado, `api.paths` opcional y `api.views` opcional.
- `api.ui.select` y `api.ui.askQuestions` permiten selección interactiva, pero no son un registro de widgets HTML arbitrarios.
- `ToolResult` acepta texto, imagen base64 y bloques UI tipados. `UiBlock` incluye `artifact`.
- `ToolContext.artifacts.publish({ source, title })` publica archivos, pero el host elimina `artifacts` del contexto de plugins externos. Un paquete first-party instalado como plugin externo no recibe privilegios de builtin por su nombre.
- No se encontró un registro público de rutas HTTP mutables ni un widget de paleta en `PluginAPI`. `api.views` es de lectura: no usarlo para mutaciones.
- La capacidad `mcpApps` existe en el contrato de salud, pero eso no demuestra que un plugin ordinario pueda registrar una MCP App mediante `api.ui`.
- La guía exige Node built-ins y `@alisio/sdk` como únicas dependencias. `@napi-rs/canvas` exige una excepción documentada a esa política; no afirmar que ya cumple.

### Decisiones de integración

1. **Ajustar la política del catálogo** para admitir la dependencia gráfica nativa declarada y auditada. Esto es un cambio de política del repositorio, no una supuesta restricción técnica de Node.
2. **Abrir un publicador de artefactos mediado por el host** a herramientas de plugins autorizadas con efecto write. Mantener la validación y copia del host; no exponer su base de datos ni permitir construir ArtifactRef a mano.
3. **Agregar un widget nativo declarativo de diseño**, con paletas, orientación y botones. Esta es una ampliación propuesta, no una API existente. Para hosts anteriores, mostrar una lámina de paletas como imagen y usar `ui.select`; los resultados descargables completos requieren el puente de artefactos.
4. **Resolver endpoints con una exportación de renderer reutilizable**, consumida por la aplicación del usuario. No levantar un servidor ni editar su proyecto sin que lo solicite. No añadir un servidor MCP obligatorio para cinco operaciones locales.

Estas decisiones satisfacen el alcance completo sin importar `@alisio/core`, sin tratar el plugin como builtin y sin inventar registros SDK existentes.

## 3. Experiencia en chat

Ejemplo: «Crea una tarjeta vertical para desear un buen día, con una flor y colores alegres».

1. El agente llama `card_design` con family, templateId, texto y campos conocidos. Si faltan dimensiones, usar social-portrait; si falta paleta, usar la recomendada por la plantilla.
2. Cardsmith crea un draft persistido con revisión y devuelve un resumen compacto. Solo preguntar datos realmente indispensables, como el nombre de un certificado.
3. El chat muestra un configurador con miniaturas de plantillas, muestras de color, nombres y HEX, formato, tipografía, ilustración y texto editable. La elección actual siempre debe ser visible.
4. Cambiar paleta, orientación o tipografía actualiza el draft y la vista previa mediante acciones deterministas. **No requiere otra inferencia del modelo.**
5. Generar publica el PNG de resolución final y muestra la imagen dentro del chat. Debajo: Descargar PNG/JPEG, Editar y Guardar en workspace. El certificado permite además generar otra orientación; PDF queda fuera de este lanzamiento.
6. «Guárdala en assets/social» ejecuta una copia mediada al workspace activo. «Muévela» exporta y elimina la copia de trabajo solo después de verificar el destino; mantiene la copia publicada del chat.

Descargar guarda en el equipo del navegador; exportar al workspace escribe en el servidor de Alisio. La interfaz debe explicar la diferencia al elegir destino remoto.

TUI: resumen y ruta/enlace del artefacto, selección textual. Headless: entradas completas o defaults, JSON compacto, ningún diálogo pendiente. Las operaciones de render/export respetan permisos write.

## 4. Diseño inspirado en las referencias

Las imágenes adjuntas muestran: personajes simples y expresivos, contornos negros, fondos claros, tipografías informales, textos breves, ondas retro multicolor, pequeñas decoraciones y un protagonista central. No permiten identificar con certeza la fuente exacta.

| Estilo | Composición | Tratamiento gráfico | Uso |
| --- | --- | --- | --- |
| botanical-greeting | Frase superior, flor protagonista, remate inferior | Fondo crema, fucsia, amarillo y verde, contorno oscuro | Buenos días y felicitaciones |
| retro-message | Título fuerte, objeto central, mensaje sobre bandas | Ondas amarillas, oliva, naranja y rosa; grano discreto | Mensajes positivos y campañas |
| kawaii-friends | Título corto y pareja de personajes | Pasteles, caras simples y pequeñas figuras repetidas | Amistad y celebraciones |
| warm-love | Texto superior e inferior con cactus central | Fondo durazno, verde cálido y corazón rojo | Dedicatorias |
| editorial-photo | Foto dominante, titular y autor separados | Jerarquía clara, logo discreto y fondo sólido | Noticias, perfiles y anuncios |

Crear recursos originales equivalentes en lenguaje visual, sin redistribuir las imágenes de referencia como ilustraciones del plugin. No copiar automáticamente firmas o handles. Mantener un manifiesto de licencia y atribución por recurso.

### Reglas deterministas de composición

- Un protagonista visual y un mensaje principal. Títulos decorativos breves; datos y texto secundario en fuente legible.
- Máximo dos familias tipográficas por plantilla; máximo tres pesos.
- Unidad `u = min(width,height) / 100`. Margen base 6u; separaciones de 2–4u. Cada preset puede ampliar zonas seguras.
- Plantillas horizontales y verticales tienen layouts propios; no estirar una composición ni simplemente rotarla. Si una combinación no existe, devolver alternativas compatibles.
- Ajustar texto con `measureText`, quiebres explícitos y búsqueda binaria de tamaño. Medir alto real y límites de glifos. Títulos no se truncarán silenciosamente.
- Texto curvo: medir y colocar grafemas con tangente a un arco; reservarlo a frases cortas y fuentes compatibles. Texto corrido se renderiza como línea completa para preservar shaping.
- Recursos gráficos en paths vectoriales internos o PNG transparentes. SVG externos no se aceptan en v1; así se evita añadir un sanitizador y recursos remotos ocultos.
- Efectos de grano y variaciones manuales usan seed fija guardada. El resultado debe ser reproducible dentro del mismo entorno de renderizado.
- En gráficas de barras, eje de magnitud comienza en cero. Líneas y scatter muestran unidades; cambios de dominio nunca son invisibles. Donut solo para valores no negativos y total positivo.

## 5. Presets de tamaño

Estos son presets de diseño del plugin, no una garantía de límites o aceptación de cada red social. Los presets de plataforma se versionan separados de las plantillas y se revisan antes de publicar.

| ID | Dimensiones px | Relación | Uso |
| --- | --- | --- | --- |
| social-square | 1080 × 1080 | 1:1 | Publicación cuadrada |
| social-portrait | 1080 × 1350 | 4:5 | Tarjeta vertical, default social |
| social-tall | 1080 × 1440 | 3:4 | Vertical alternativa |
| story-vertical | 1080 × 1920 | 9:16 | Historias y estados |
| social-landscape | 1200 × 630 | ≈1.91:1 | Banner y tarjeta de enlace |
| video-landscape | 1920 × 1080 | 16:9 | Banner horizontal |
| certificate-a4-landscape | 3508 × 2480 | A4 | Imagen para impresión a 300 ppp |
| certificate-a4-portrait | 2480 × 3508 | A4 | Certificado vertical |
| badge-landscape | 1011 × 638 | ≈1.585:1 | Credencial nominal 85.6 × 54 mm a 300 ppp |

PPi y tamaño físico deben quedar registrados en metadata; confirmar resolución y manejo de metadata antes de prometer una impresión exacta. No son archivos PDF ni salida CMYK.

Story: zona segura propia para mensajes centrales; propuesta inicial 250 px arriba y abajo y 80 px a los lados. Son márgenes conservadores de plantilla, configurables, no dimensiones oficiales universales.

## 6. Fuentes locales

Empaquetar archivos TTF estáticos y licencias. Cargar con `GlobalFonts.registerFromPath` usando nombres propios del plugin. No descargar fuentes durante el render ni depender de las instaladas en el sistema.

| Fuente | Uso propuesto |
| --- | --- |
| Patrick Hand | Mensajes informales de tarjetas ilustradas |
| Caveat Regular/Bold | Dedicatorias y frases de aspecto manual |
| Chewy | Títulos redondeados, juguetones y breves |
| Inter Regular/Semibold/Bold | Datos, estadísticas, credenciales y texto secundario |
| Cormorant Garamond Regular/Semibold | Certificados y composiciones elegantes |

Estas son alternativas propuestas, no identificación de las fuentes originales. Patrick Hand está documentada como manuscrita. Verificar licencia del archivo exacto: no asumir que todas usan OFL; Chewy se distribuye en el directorio Apache del repositorio Google Fonts. Mantener NOTICE y hash por archivo.

Español e inglés en la interfaz. Pruebas de ñ, áéíóú, ¿¡, símbolos monetarios y nombres largos. No usar emoji del sistema como ilustraciones: su apariencia varía y algunas fuentes no los cubren.

## 7. Paletas como recursos independientes

Cada paleta define tokens semánticos, etiquetas y combinaciones de texto aprobadas. Nunca convertir automáticamente cada color en color de texto sobre cualquier fondo.

| ID | Fondo | Texto | Principal | Secundario | Acento |
| --- | --- | --- | --- | --- | --- |
| alegria-botanica | #FFF6ED | #181818 | #F600A9 | #00A884 | #FFC400 |
| retro-calido | #FFF3DE | #17140F | #E95026 | #D64293 | #F8C53F |
| amistad-pastel | #FFF8EF | #313139 | #FF82A7 | #8BD0CB | #FFE071 |
| amor-calido | #FFD59A | #241A16 | #90AD63 | #B79A80 | #EC3B49 |
| alisio-ocean | #071C2C | #F4FBFF | #01A5F7 | #60E0F9 | #A7DBED |
| certificado-marfil | #FFFCF5 | #23313D | #264A66 | #B59048 | #E7D9BE |

Retro incluye oliva #8D8D35 como color decorativo adicional. Estos valores son aproximaciones de diseño, no extracción exacta de las referencias.

El widget muestra swatches, nombre, tokens y selección por teclado; color elegido con texto e icono, no solo un borde cromático. Validar contraste de texto normal con objetivo 4.5:1 y texto grande 3:1; los colores decorativos no quedan restringidos de la misma forma. QR usa tinta oscura y fondo claro propios.

## 8. Arquitectura desacoplada

Separar **generadores de familia**, **plantillas**, **paletas**, **assets**, **renderer** y **adaptadores de Alisio**. Preferir interfaces y composición; no jerarquías extensas de herencia.

```text
packages/cardsmith/
  src/index.ts
  src/core/registry.ts
  src/core/design-spec.ts
  src/core/layout.ts
  src/core/typography.ts
  src/core/scene.ts
  src/core/cache.ts
  src/generators/social.ts
  src/generators/personalized.ts
  src/generators/composite.ts
  src/generators/chart.ts
  src/generators/dynamic.ts
  src/renderers/skia.ts
  src/integrations/alisio-tools.ts
  src/integrations/alisio-artifacts.ts
  src/integrations/widget-actions.ts
  src/integrations/http-renderer.ts
  resources/templates/<template-id>/template.json
  resources/palettes/*.json
  resources/fonts/
  resources/illustrations/
  resources/skills/cardsmith/SKILL.md
  resources/prompts/
  vendor/nayuki/qrcodegen.ts
  vendor/nayuki/LICENSE
  tests/
```

```ts
// Interfaces del dominio propuestas; no son API existente de Alisio.
type Family = 'social' | 'personalized' | 'composite' | 'chart' | 'dynamic';

interface DesignGenerator {
  readonly family: Family;
  validate(spec: DesignSpec): ValidationResult;
  compose(spec: DesignSpec, resources: ResourceResolver): Scene;
}

interface DesignTemplate {
  id: string;
  version: number;
  family: Family;
  layouts: Partial<Record<'square' | 'portrait' | 'landscape', LayoutSpec>>;
  fields: FieldSpec[];
  defaultPalette: string;
  defaultFontPair: string;
}

interface ImageRenderer {
  render(scene: Scene, format: 'png' | 'jpeg'): Promise<Uint8Array>;
}
```

`Scene` contiene operaciones tipadas: rect, path, image, text y group. No contiene JavaScript, HTML ni eval. Para una plantilla nueva, agregar JSON validado y assets; para una familia nueva, implementar la interfaz y registrarla.

Extensibilidad inicial: recursos JSON del usuario, cargados desde una carpeta configurada. No importar otros plugins ni ejecutar TS arbitrario del workspace. Nuevos generadores de código se incorporan mediante release del paquete. Si después se desea extensión entre paquetes, agregar un contrato SDK público; no simularlo accediendo a objetos internos.

## 9. Dependencias y recursos

- `@alisio/sdk`: peer + dev, fijar versión publicada compatible.
- `@napi-rs/canvas`: única dependencia funcional externa propuesta, después de modificar la política del catálogo. Usa addon nativo; sus paquetes binarios específicos de plataforma y su peso deben incluirse en la auditoría. «Sin dependencias de sistema» no significa «JavaScript puro» o «sin binarios».
- QR: incluir el port TypeScript original de Nayuki, con commit y licencia MIT registrados. No añadir `qrcode`: su package.json declara dependencias adicionales.
- Validación de schemas: reutilizar el contrato del host y validadores de dominio propios; no añadir otra librería solo para comprobar cinco familias acotadas.
- Hash, filesystem, paths, HTTP, worker threads e Intl: Node built-ins.
- Gráficas: primitives del renderer para barras, líneas, scatter y donut. No incluir D3, Chart.js, navegador headless, Python ni Sharp en el runtime básico.

No generar un PDF ni un SVG editable si solo existe un renderer raster. Añadir exportadores como otra implementación cuando se amplíe el alcance. PNG es default; JPEG requiere fondo opaco explícito.

## 10. QR dentro de cualquier familia compatible

Nayuki produce una matriz booleana. El renderer la pinta con rectángulos alineados a píxeles enteros en el mismo canvas.

- Payload: URL o texto UTF-8. Validar tamaño y versión final; no afirmar que un QR comprueba autenticidad.
- Corrección M por defecto; Q configurable. Logo dentro del QR fuera de v1.
- Quiet zone obligatoria de cuatro módulos a cada lado.
- Módulo de al menos 4 px en presets digitales como regla interna. Si no cabe, ampliar caja o devolver `QR_TOO_DENSE`.
- Sin interpolación, deformación, esquinas decorativas ni transparencia de fondo.
- No usar color principal de la paleta sin comprobar legibilidad; negro sobre blanco por defecto.
- Una URL no se consulta para generar su QR. No hay llamadas externas ni servicio de QR remoto.

```ts
// Adaptar import/export al port TypeScript vendorizado y conservar licencia.
const qr = qrcodegen.QrCode.encodeText(payload, qrcodegen.QrCode.Ecc.MEDIUM);
const totalModules = qr.size + 8;
const modulePx = Math.floor(boxSize / totalModules);
if (modulePx < 4) throw new Error('QR_TOO_DENSE');
const actualSize = totalModules * modulePx;
ctx.fillStyle = '#ffffff';
ctx.fillRect(x, y, actualSize, actualSize);
ctx.fillStyle = '#111111';
for (let row = 0; row < qr.size; row++) {
  for (let col = 0; col < qr.size; col++) {
    if (qr.getModule(col, row)) {
      ctx.fillRect(x + (col + 4) * modulePx, y + (row + 4) * modulePx,
        modulePx, modulePx);
    }
  }
}
```

## 11. Contrato de herramientas y ahorro de tokens

| Herramienta lógica | Efecto | Función |
| --- | --- | --- |
| card_catalog | read | Lista filtrada de plantillas, fuentes, formatos y paletas |
| card_design | write | Crea draft desde spec validada |
| card_update | write | Aplica patch al draft con revisión esperada |
| card_render | write | Renderiza preview o final y publica artefacto |
| card_export | write | Copia/mueve working file al workspace activo |

El host añadirá el prefijo de nombres de plugins externos. Las acciones del widget usan estas mismas operaciones por un despachador autorizado, **sin pasar por el modelo**. Ese despachador es parte de la ampliación del host.

`card_catalog` devuelve solo IDs, descripción corta, compatibilidad y campos requeridos; no toda la biblioteca de layouts. La skill enseña una sola secuencia y reglas de defaults, no cientos de ejemplos.

```json
{
  "family": "social",
  "templateId": "illustrated-greeting",
  "sizeId": "social-portrait",
  "paletteId": "alegria-botanica",
  "fontPairId": "handwritten-readable",
  "content": {
    "title": "¡Espero que hoy sea",
    "message": "un día espectacular!",
    "author": "Gustavo"
  },
  "illustrationId": "flower-happy",
  "qr": { "payload": "https://example.com", "ecc": "M" },
  "seed": 42,
  "format": "png"
}
```

Salida textual mínima para el agente: draftId, revision, artifactId, dimensiones, formato y warnings accionables. No incluir base64, píxeles, fuentes, puntos de paths ni todos los datos de gráfica en contexto del modelo.

La imagen se muestra al usuario por artefacto. La proyección textual del loop conserva metadata y suprime el contenido binario. Auditar la ruta real de ToolResult antes de usar imagen base64 como fallback: que el tipo exista no garantiza un coste nulo de visión ni download persistente.

No usar `api.model.complete` durante render, export o cambio de paleta. Reescribir un mensaje sí puede usar el modelo por petición del usuario, separada de la operación de dibujo.

## 12. Estado, cache y determinismo

- Guardar drafts y un manifiesto de working files en el directorio state del plugin cuando `api.paths` esté disponible. Usar escrituras atómicas, IDs generados por el código y versiones.
- Cache: SHA-256 de spec normalizada + versiones del renderer, plantilla, fuentes, recursos, tamaño, locale y datos. Incluir hash del contenido de las imágenes; la ruta sola no basta.
- Metadata: contenido efectivo, seed, fecha explícita si se dibuja, hashes y versión. No introducir la hora actual en escena ni metadatos de imagen si se busca igualdad binaria.
- Igual input en el mismo entorno fijado debe producir la misma escena y los mismos bytes. Entre plataformas y versiones de Skia, exigir equivalencia visual medida, no igualdad binaria universal.
- Preview a resolución menor; final desde la misma escena lógica. No servir preview como archivo final.
- Worker de render separado del loop principal. Límite inicial de 2 renders concurrentes, cola acotada y cancelación mediante `AbortSignal` y terminación del worker si procede. Worker no es sandbox.
- Límite inicial por render: 12 millones de píxeles, 20 MB por imagen de entrada y 60 MB de archivos de entrada sumados. Validar además dimensiones decodificadas para evitar grandes asignaciones con archivos comprimidos pequeños.
- Cache con presupuesto configurable y limpieza LRU; documentos finales publicados dependen de la retención de artefactos del host.

## 13. Publicación, descarga y exportación

Flujo final: render escribe working file → publicador del host valida y copia → devuelve ArtifactRef real → ToolResult entrega bloque artifact → el chat presenta preview y descarga.

```ts
// Utiliza tipos reales del SDK. Requiere el puente del host para plugins externos.
if (!context.artifacts) {
  return textResult('Este host no permite publicar artefactos de plugins. Actualiza Alisio.', true);
}
const artifact = await context.artifacts.publish({
  source: renderedFile,
  title: 'Tarjeta de felicitación',
});
return {
  content: [
    { type: 'text', text: `Imagen ${width}×${height} generada.` },
    { type: 'ui', block: { kind: 'artifact', artifact } },
  ],
};
```

Guardar: destino relativo bajo `context.workspace`, resuelto con `context.resolvePath` cuando exista; validar también realpaths y symlinks. Elegir `card-<id>.png` por default. No sobrescribir sin petición inequívoca; ofrecer nombre distinto. El path de herramientas no sustituye la validación de write.

Mover: copiar de forma atómica, verificar hash, registrar destino y solo entonces borrar working file. No borrar el artefacto publicado ni archivos fuente del usuario. Manejar fallo de copia y fallo de borrado de manera diferenciada.

## 14. Widget de paletas: contrato propuesto

Agregar al SDK un bloque UI de diseño con `draftId`, `revision`, `palettes`, `selectedPaletteId`, `formats`, `fonts`, `previewArtifactId` y acciones permitidas. El nombre definitivo del bloque queda definido al implementar el cambio SDK; no incluirlo como si existiera hoy.

El host renderiza componentes propios y despacha acciones a una herramienta registrada del plugin propietario. No ejecuta HTML/JS enviado por el modelo. Validar sesión, plugin, draft y revision en cada acción, aplicar permisos e invalidar eventos de widgets antiguos. Descarga y navegación por catálogos no requieren escritura; generar y guardar sí.

Si se requiere interoperabilidad MCP Apps en otro cliente, agregar después un adaptador externo sobre el mismo dominio. El estándar usa recursos `ui://`, metadata `_meta.ui.resourceUri`, iframe aislado y mensajería JSON-RPC; eso no es equivalente a devolver HTML en textResult. No implementar a mano un MCP parcial para ahorrar unas pocas dependencias.

## 15. Tarjetas dinámicas y endpoints

Exportar un subpath público del mismo paquete, por ejemplo `@alisio/plugin-cardsmith/renderer`, que reciba una DesignSpec validada y devuelva bytes + MIME. Debe poder utilizarse sin iniciar Alisio ni ejecutar setup del plugin.

La aplicación consumidora proporciona datos y su endpoint autenticado. Un adaptador Node HTTP opcional demuestra la integración; no se añade framework para este caso. En el repositorio del usuario, el agente puede crear el handler para Hono, Express o Next usando el stack existente cuando lo solicite.

Ejemplo de contrato propuesto: `GET /api/products/:id/card.png`. El servidor busca producto y permisos, forma la spec con templateId fijo, llama renderer y devuelve `Content-Type: image/png` con ETag basado en hash. Datos privados: Cache-Control privado; no usar cache público universal.

No admitir paths, layouts ejecutables, URLs de imágenes arbitrarias ni expresiones SQL desde query params. El template y campos permitidos pertenecen al servidor. Una fecha visible se recibe como dato explícito; TTL e invalidación no modifican el diseño sin un cambio de contenido.

En chat, dynamic puede usar datos JSON proporcionados por el usuario o una vista autorizada de datos ya existente. No asumir conexión a la base de inventario ni añadir una dependencia de base de datos al plugin.

## 16. Verificación y aceptación

Pruebas necesarias, usando node:test y fixtures locales:

1. Cada familia: un caso válido, un input inválido y una combinación de orientación compatible/incompatible.
2. Texto: español, título demasiado largo, nombre largo, ausencia de fuente y medidas sin overflow. Nunca exportar un certificado con nombre recortado.
3. QR: quiet zone y módulos enteros, rechazo por densidad y decodificación real de PNG con un decoder usado solo en desarrollo.
4. Exportación: traversal, symlink fuera del workspace, colisión de nombre, fallo de copia y move sin pérdida de working file.
5. Gráficas: escala, valores faltantes, serie vacía, donut negativo y suma cero.
6. Determinismo: mismo hash/bytes en CI fijado; regresión visual de fixtures entre releases, con revisión humana de cambios.
7. Alisio Web: imagen visible, descarga idéntica al final, selección por teclado, acciones sin llamada al LLM y aislamiento entre sesiones. Reiniciar y comprobar acceso al artefacto persistido.
8. Headless sin bloqueo; TUI con alternativa textual; host sin puente devuelve limitación precisa.
9. Empaquetado: binarios correspondientes, TTF, licencias, plantillas, recursos, dist y declaraciones incluidos. Smoke test de paquete construido en Windows, Linux y macOS que se declaren soportados.

## 17. Orden de implementación

1. Fijar versiones y actualizar política de dependencias; implementar publicador mediado y widget de acciones en el host. Son precondiciones para prometer la experiencia completa de chat.
2. Implementar spec, registry, fuentes, paletas, assets originales, medidas y renderer con QR.
3. Entregar las cinco familias y sus plantillas iniciales, incluyendo export renderer para dynamic.
4. Integrar herramientas, widget, publicación, descarga y exportación al workspace.
5. Completar pruebas, documentación ES/EN y tarball. Instalar mediante `alisio install npm:@alisio/plugin-cardsmith@<version>` y verificar con `alisio plugins doctor`.

Primer release funcional termina cuando las cinco familias producen imágenes finales y el chat permite configurarlas, verlas, descargarlas y guardarlas. No dejar el puente de artefactos para después y llamar completo a un plugin que solo imprime rutas.

Posteriores: carruseles y lotes, packs de marca, PDF, SVG editable, nuevos generadores, recorte interactivo y adaptador MCP Apps. No incluir esas funciones como promesas del primer release.

## 18. Fuentes de investigación

- Alisio: https://gustavogutierrez.github.io/alisio/
- Contrato y política de plugins: https://gustavogutierrez.github.io/alisio-plugins/developing-plugins
- SDK consultado: https://raw.githubusercontent.com/GustavoGutierrez/alisio/main/packages/sdk/src/index.ts
- Host consultado: https://raw.githubusercontent.com/GustavoGutierrez/alisio/main/packages/core/src/plugins/host.ts
- Canvas/Skia: https://github.com/Brooooooklyn/canvas
- Nayuki, API y ausencia de dependencias: https://www.nayuki.io/page/qr-code-generator-library
- Dependencias de qrcode: https://github.com/soldair/node-qrcode/blob/master/package.json
- Margen QR, DENSO WAVE: https://www.qrcode.com/en/howto/code.html
- MCP Apps: https://modelcontextprotocol.io/extensions/apps/overview
- Fuentes y licencias: https://github.com/google/fonts ; https://github.com/google/fonts/blob/main/ofl/patrickhand/METADATA.pb ; https://github.com/google/fonts/blob/main/ofl/caveat/DESCRIPTION.en_us.html ; https://raw.githubusercontent.com/google/fonts/main/apache/chewy/LICENSE.txt

Los tamaños, paletas, interfaces de dominio, widget y orden de ejecución son decisiones de esta propuesta. No se atribuyen como APIs existentes o recomendaciones oficiales de las redes sociales. Las cuatro referencias adjuntas se inspeccionaron visualmente.

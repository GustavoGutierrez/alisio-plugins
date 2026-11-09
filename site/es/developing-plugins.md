# Desarrollo de plugins de Alisio

Español · [English](../developing-plugins.md)

Esta guía cubre paquetes propios en este monorepo **y** plugins independientes publicados desde otro
repositorio. Elige primero la ruta; el contrato del plugin y los límites de seguridad aplican a ambas.
La referencia canónica upstream del SDK y de `PluginAPI` es la documentación de plugins de Alisio.
Esta guía del catálogo se centra en el empaquetado, la publicación y la inclusión en el catálogo, sin
duplicar la referencia completa de la API.

Todo en esta guía se verificó contra el código fuente upstream
(`docs/plugins.md`, `packages/sdk/src/index.ts`, `packages/core/src/plugins/host.ts`,
`packages/core/src/runtime/modules.ts`, `packages/core/src/plugins/install.ts`). Cuando la
documentación upstream y el código discrepan, esta guía sigue al código y lo señala como una
**advertencia de documentación**.

- [Elige tu ruta](#elige-tu-ruta)
- [Ruta rápida de terceros](#ruta-rapida-de-terceros)
- [Inclusión en el catálogo](#inclusion-en-el-catalogo)
- [JSON del catálogo](#json-del-catalogo)
- [Ruta rápida de primera parte](#ruta-rapida-de-primera-parte)
- [El contrato](#el-contrato)
- [Superficie de capacidades](#superficie-de-capacidades)
- [Límites duros: hasta dónde llegan los plugins](#limites-duros-hasta-donde-llegan-los-plugins)
- [Los errores más probables](#los-errores-mas-probables)
- [Forma y publicación del paquete](#forma-y-publicacion-del-paquete)
- [Instalación y pruebas de humo](#instalacion-y-pruebas-de-humo)
- [Fijación de la versión del SDK](#fijacion-de-la-version-del-sdk)
- [Pruebas en este repositorio](#pruebas-en-este-repositorio)
- [Advertencias de documentación](#advertencias-de-documentacion)

## Elige tu ruta

| Vas a crear… | ¿Trabajas aquí? | Lanzamiento y catálogo |
| --- | --- | --- |
| Un paquete oficial de primera parte `@alisio/plugin-*` | Sí: crea `packages/<nombre>/`. | Aplican las comprobaciones del workspace, Changesets, las herramientas de lanzamiento y el descubrimiento automático local. |
| Un plugin independiente de tu equipo | No: usa tu propio repositorio y publícalo en npm. | Eliges tus herramientas y lanzamiento. Es instalable tras publicarlo; aparecer en el catálogo requiere revisión de mantenimiento y un pull request al registro. |

Las **recomendaciones universales del ecosistema** se señalan más abajo. Las reglas descritas como
**solo de primera parte** las impone este workspace y no son requisitos de todos los plugins externos.

## Ruta rápida de terceros

Usa esta ruta cuando el paquete pertenezca a otro repositorio; no exige un fork de este monorepo.

1. Crea un paquete Node ESM e implementa el export por defecto `definePlugin(...)` descrito en
   [el contrato](#el-contrato).
2. Compila JavaScript y declaraciones en `dist`, prueba el paquete compilado e inspecciona el tarball.
3. Publica en npm; instala su versión publicada con Alisio y ejecuta `plugins doctor`.
4. Para aparecer aquí, sigue [Inclusión en el catálogo](#inclusion-en-el-catalogo). Publicar en npm
   por sí solo **no** añade un paquete a este catálogo.

### Base de un paquete externo

Estos son valores compatibles y recomendados para un plugin publicado de forma independiente. El host
exige la keyword `alisio-plugin` para reconocer un paquete npm; el resto son recomendaciones de calidad,
salvo que la política de tu propio paquete los haga obligatorios.

| Aspecto | Base recomendada para un paquete externo |
| --- | --- |
| Nombre | Prefiere `@tu-scope/alisio-plugin-<nombre>`. `@alisio/plugin-*` se reserva para primera parte; el registro puede listar cualquier nombre npm válido. |
| Metadatos | Declara `description`, `license`, `repository`, `homepage` y `bugs` para evaluación de usuarios y mantenedores. |
| SDK del host | Incluye `@alisio/sdk` en `peerDependencies` y `devDependencies`; no importes `@alisio/core` ni otro plugin. |
| Runtime y módulos | Usa ESM (`"type": "module"`), Node `>=22.16` y expone `./dist/index.js` junto con `./dist/index.d.ts`. |
| Contenido publicado | Incluye `dist`, `README.md` conciso con instalación/uso, `LICENSE` MIT (u alternativa declarada claramente), y cada recurso o cover registrado. |
| Calidad | Mantén tests unitarios; cubre una ruta feliz y una ruta de error/límite por escenario funcional. |
| Confianza y datos | Los plugins se ejecutan en proceso, no en sandbox. Valida nombres, rutas y salida de sesiones hijas no confiables; persiste datos duraderos de forma atómica; evita credenciales y rutas locales. Las integraciones integradas opcionales deben fallar de forma abierta y estar delimitadas por capacidades. |

Parte de esta forma de manifiesto y adapta versiones, scripts y el gestor de paquetes a tu repositorio:

```json
{
  "name": "@your-scope/alisio-plugin-example",
  "version": "0.1.0",
  "description": "A concise description of the plugin.",
  "keywords": ["alisio-plugin"],
  "license": "MIT",
  "repository": { "type": "git", "url": "https://github.com/OWNER/REPOSITORY.git" },
  "homepage": "https://github.com/OWNER/REPOSITORY#readme",
  "bugs": { "url": "https://github.com/OWNER/REPOSITORY/issues" },
  "type": "module",
  "engines": { "node": ">=22.16" },
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "files": ["dist", "README.md", "LICENSE", "cover.svg", "icon.svg"],
  "peerDependencies": { "@alisio/sdk": ">=0.1.0-alpha.10 <0.2.0" },
  "devDependencies": { "@alisio/sdk": "0.1.0-alpha.10" }
}
```

### Lista de lanzamiento de terceros

- [ ] `npm pack --dry-run` muestra `dist/index.js`, `dist/index.d.ts`, `README.md`, `LICENSE` y recursos registrados.
- [ ] Pasan lint, tipos, tests y build de tu repositorio; escanea el tarball por credenciales y rutas locales.
- [ ] El paquete tiene la keyword `alisio-plugin` y un entry que Alisio puede resolver.
- [ ] Publica con el flujo npm autorizado de tu equipo; Changesets y `publish-*` de este monorepo son **solo de primera parte**.
- [ ] Verifica el registro: `npm view <package> version`.
- [ ] Verifica consumo: `alisio install npm:<package>@<version>` y después `alisio plugins doctor`.
- [ ] Si aplica, confirma que credenciales configuradas permanezcan en Alisio/el entorno y documenta el runtime mínimo compatible.

## Inclusión en el catálogo

Este catálogo **no descubre npm automáticamente**. Los paquetes locales bajo `packages/*` se descubren
automáticamente; uno externo aparece solo después de que un mantenedor acepte un pull request a este
repositorio que lo añada a [`registry/plugins.json`](https://github.com/GustavoGutierrez/alisio-plugins/blob/main/registry/plugins.json).
No hay formulario de issue separado ni endpoint de envío automático en este repositorio.

Después de publicar, abre un pull request contra
[`GustavoGutierrez/alisio-plugins`](https://github.com/GustavoGutierrez/alisio-plugins) que edite
`registry/plugins.json` e incluya la información de revisión de abajo. Mantenimiento ejecuta el escáner
y confirma la caché/páginas generadas; no edites a mano los archivos generados del catálogo.

El esquema exige **solo** `package`. Sus campos opcionales son `title`, `npmUrl`, `repository`,
`homepage`, `cover`, `icon`, `categories` y `featured`, según
[`registry/plugins.schema.json`](https://github.com/GustavoGutierrez/alisio-plugins/blob/main/registry/plugins.schema.json).

```json
{
  "package": "@your-scope/alisio-plugin-example",
  "categories": ["tools"],
  "cover": "cover.svg"
}
```

| Información para revisión de mantenimiento | Cómo se usa o verifica |
| --- | --- |
| Nombre npm y versión publicada; comando de instalación | `package` es el único campo obligatorio. El catálogo deriva `alisio install npm:<package>` y lee la última versión npm. Incluye en el PR la versión probada. |
| URL de repositorio, homepage, URL de bugs, descripción y licencia | El escáner lee metadatos npm; `repository` y `homepage` pueden sustituir valores ausentes/incorrectos del packument. `bugs`, descripción y licencia no tienen sustitución. |
| Categoría y capacidades | `categories` es opcional. Usa solo: `model-provider`, `methodology-harness`, `memory`, `subagents`, `search`, `tools`, `security`, `analytics`, `mcp`, `storage`, `ui`, `decisions`. Explica capacidades reales en el PR; no son un campo del esquema. |
| Rango peer SDK, compatibilidad Node, evidencia de tests y validación | Son evidencia de revisión, no campos del registro. Incluye rango de `@alisio/sdk`, `engines.node`, comandos/resultados y versión publicada instalada con Alisio. |
| Detalles de seguridad e integración | Explica red/proceso/escritura, credenciales, datos duraderos, integraciones opcionales y recursos. El escáner nunca importa ni ejecuta código de terceros. |
| Cover y presentación | `cover` es opcional: una ruta del paquete como `cover.svg`, o `/...` para un archivo confirmado bajo `site/public`. Si no, el escáner busca `alisio.cover` y después `cover.svg`, `.png`, `.jpg`, `.jpeg`, `.webp` en la raíz. Prefiere SVG 16:9 de 1600×900 bajo 512 KB e inclúyelo en el tarball npm. Un `icon` cuadrado opcional sigue las mismas reglas de ruta, después `alisio.icon` en `package.json` y, si falta, se busca `icon.svg`, `.png` o `.webp` en la raíz. Consulta [Arte de cover e icono](#arte-de-cover-e-icono). |

`npmUrl`, `title` y `featured` son sustituciones de presentación, no sustitutos de evidencia. El escáner
obtiene metadatos npm y, solo para encontrar un cover, lee el tarball publicado sin ejecutarlo. Un
mantenedor puede rechazar o posponer un cambio si paquete, metadatos, seguridad o evidencia son insuficientes.

### Arte de cover e icono

Cada plugin puede incluir dos imágenes: un **cover** ancho para la tarjeta y la página de detalle
del catálogo, y un **icono** cuadrado para listas compactas, el JSON del catálogo y la interfaz del
host. Ambos son opcionales, pero los paquetes propios incluyen los dos. Colócalos en la raíz del
paquete como `cover.svg` e `icon.svg` y agrégalos a `files` en `package.json`, para que el escáner
los encuentre en local y en el tarball publicado. Declara también el icono en `package.json` para
que Alisio (>= 0.11.2) lo muestre en un plugin instalado aunque no haya una entrada de catálogo:

```json
{
  "files": ["dist", "README.md", "LICENSE", "cover.svg", "icon.svg"],
  "alisio": { "icon": "icon.svg" }
}
```

`alisio.icon` debe ser una ruta de imagen dentro del paquete; el host rechaza archivos de más de
256 KB. El escáner del catálogo respeta el mismo campo, después de un `icon` del registro y antes de
la convención `icon.*` en la raíz.

| Propiedad | Cover | Icono |
| --- | --- | --- |
| Relación de aspecto | **16:9** | **1:1** (cuadrado) |
| Tamaño recomendado | **1600 × 900** | **512 × 512** |
| Tamaño mínimo (raster) | **640 × 360** | **128 × 128** |
| `viewBox` SVG | `0 0 1600 900` | `0 0 512 512` |
| Formatos, en orden de búsqueda | `svg`, `png`, `jpg`, `jpeg`, `webp` | `svg`, `png`, `webp` |
| Tamaño máximo de archivo | **512 KB** | **64 KB** |
| Nombre por defecto | `cover.<ext>` | `icon.<ext>` |
| Si falta | Se usa el cover por defecto | `icon: null`; sin respaldo |
| Publicado en el sitio en | `/covers/<slug>.<ext>` | `/icons/<slug>.<ext>` |

Reglas de diseño para iconos:

- Incluye el fondo en el archivo: un cuadrado redondeado a sangre (`rx` ≈ 112 en un viewBox de 512).
  Los hosts muestran el icono tal cual, en temas claros y oscuros.
- Usa un solo glifo marcado que siga siendo legible a **32 px**. Evita texto, trazos finos y detalle menudo.
- Toma colores y motivo del cover del plugin para que ambos se lean como la misma marca.
- Mantén los SVG autocontenidos: sin `<image>`, scripts, referencias externas ni fuentes web, y
  prefija los ids de gradientes y filtros con el nombre del plugin para poder incrustar varios
  iconos en una misma página.
- Un plugin que integra un proveedor o librería concreta (por ejemplo OpenAI, Atlassian o Brave)
  puede usar la marca oficial de ese proveedor, sin alterar su forma ni sus proporciones y con los
  colores que permitan sus guías de marca, sobre el fondo del icono. Indica el titular y el origen
  de la marca en un comentario XML al inicio del archivo. Nunca sugieras un respaldo más allá de la
  integración en sí.

## JSON del catálogo

Cada compilación del sitio publica un catálogo minificado y legible por máquina en
`https://gustavogutierrez.github.io/alisio-plugins/catalog.json`. La aplicación de escritorio de Alisio
lo lee para listar, buscar, filtrar e instalar plugins sin la CLI. Se deriva de la caché confirmada,
por lo que solo cambia cuando se actualiza la caché. Las URLs de imagen se construyen a partir de la
URL del sitio, definida una sola vez en `scripts/lib/catalog.mjs`; define `ALISIO_SITE_URL` (una URL
https absoluta) al compilar para publicar bajo otro dominio.

El nivel superior incluye `schemaVersion` (`1`), `generatedAt` (el `publishedAt` más reciente, o
`null`), `site`, `categories` (`{ id, count }` por cada categoría conocida en uso) y `plugins`,
ordenados por `slug`. Cada plugin incluye:

| Campo | Significado |
| --- | --- |
| `id`, `slug`, `name` | Id del plugin (o `null`), slug de URL y nombre visible. |
| `package`, `version` | Paquete npm que se instala y su versión en el catálogo. |
| `description` | Resumen de una línea. |
| `categories`, `tags` | Facetas de filtrado: ids de categorías conocidas y keywords sin `alisio-plugin` ni ids de categoría. |
| `cover`, `icon` | URLs absolutas de imagen, o `null`. |
| `sdk` | Rango peer de `@alisio/sdk`, o `null`. |
| `author`, `license`, `homepage`, `npmUrl`, `repository` | Metadatos visibles; los enlaces son http(s) o `null`. |
| `publishedAt`, `featured`, `source` | Fecha de publicación, marca de promoción, `local` o `third-party`. |

## Ruta rápida de primera parte


```bash
corepack enable
pnpm install
pnpm check                 # lint, tipos, tests, build y pack check
pnpm diagrams:check        # los SVG confirmados son más recientes que sus fuentes
```

Esta es la ruta **solo de primera parte**. Crea el paquete bajo `packages/<nombre>/` siguiendo las convenciones del
[README](https://github.com/GustavoGutierrez/alisio-plugins/blob/main/README.es.md) raíz y de
[CONTRIBUTING.md](https://github.com/GustavoGutierrez/alisio-plugins/blob/main/CONTRIBUTING.md).

## El contrato

Un plugin es un módulo ES cuyo **export por defecto** es un objeto `Plugin`. Usa el helper
`definePlugin` del SDK (una función identidad que solo añade tipado) y `textResult` para construir
resultados de herramienta.

```ts
import { definePlugin, textResult } from "@alisio/sdk";

export default definePlugin({
  id: "acme.hello",
  name: "Acme Hello",
  description: "Añade una herramienta de saludo",
  version: "0.1.0",
  apiVersion: 1,
  setup(api) {
    api.tools.register({
      name: "hello",
      description: "Saluda al usuario.",
      effect: "read",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async execute() {
        return textResult("¡Hola!");
      },
    });
  },
});
```

El host valida y hace cumplir este contrato:

| Miembro | Obligatorio | Regla |
| --- | --- | --- |
| `id` | sí | Coincide con `^[a-z0-9][a-z0-9.-]{0,63}$`, por ejemplo `acme.hello`. |
| `version` | sí | Semver estricto: `^\d+\.\d+\.\d+(?:-[\w.-]+)?$` (se permite un sufijo de prelanzamiento; no se permite metadato de build). |
| `apiVersion` | sí | Exactamente `1`. |
| `setup(api)` | sí | Una función; puede ser asíncrona. Registra todo. |
| `name`, `description` | no | Texto de catálogo no vacío y legible usado por `/plugins`. |
| `categories` | no | Categorías de catálogo opcionales: `model-provider` o `methodology-harness`. El host valida el valor de forma estricta (ver abajo) y también deriva `model-provider` de los registros de proveedores. |
| `extensions` | no | Proveedores de extensión declarativos, registrados con prioridad `0` antes de que se ejecute `setup`. |
| `dispose()` | no | Libera recursos cuando Alisio se cierra. |

Lo que el host garantiza:

- **Los ids duplicados se rechazan** (`Duplicate plugin: <id>`).
- **La validación del contrato ocurre antes de `setup`.** Un id, una versión o un `apiVersion`
  inválidos hacen fallar la carga.
- **Si `setup` falla, se revierte cada registro y luego se llama a `dispose()`.** Cada llamada
  `register`/`on` devuelve una función para desregistrar; el host revierte todas al fallar y después
  espera a `dispose()` antes de relanzar el error.
- **Todo lo que un plugin registra se elimina automáticamente cuando se descarga.**

### Categorías de catálogo y compatibilidad con el host

`categories` es uno de los pocos campos que el host valida contra un conjunto cerrado (el
`PluginCategory` del SDK). La validación es estricta: un host que no conoce un valor declarado
**hace fallar la carga** con un error de contrato en lugar de ignorar el valor desconocido. Los
valores conocidos son `model-provider` (el valor original) y `methodology-harness` (`@alisio/sdk`
`0.1.0-alpha.10` / `@alisio/core` `0.1.0-alpha.15` y posteriores).

Un plugin no puede expresar una dependencia de la versión del host. Los plugins dependen solo de
`@alisio/sdk`, nunca de `@alisio/core`, y el rango peer del SDK no es una versión del host que este
haga cumplir. Por eso, declarar una categoría introducida en un SDK más nuevo hace fallar la carga en
hosts antiguos, y ningún campo del manifiesto lo evita. Documenta el runtime mínimo de Alisio en tu
README y da el comando de actualización
(`npm install -g @alisio/alisio-code@<versión>`, o `pnpm add -g` / `bun add -g`).

## Superficie de capacidades

Cada namespace que un plugin recibe en `api`, qué ofrece, cómo se delimitan los nombres y cómo
aplica el modelo de efecto/permisos.

| Namespace | Qué ofrece | Nombres / namespacing | Efecto y permisos |
| --- | --- | --- | --- |
| `api.tools.register(tool)` | Herramientas que el modelo puede llamar. | Los plugins externos reciben `p_<hex-10>_<nombre>` (10 caracteres hex del SHA-256 del id del plugin); los integrados quedan sin prefijo. Debe coincidir con `^[a-zA-Z0-9_-]{1,64}$` **después** del prefijo. | Lleva `effect` (`read`/`write`/`process`/`external`/`internal`). `read` siempre está permitido; `write`/`process`/`external` pasan por la política o la aprobación. |
| `api.commands.register(name, handler, options?)` | Comandos de barra. | Externos: `<plugin id>:<nombre>` (por ejemplo `/acme.hello:name` o `/command acme.hello:name`); los integrados quedan sin prefijo. Los nombres duplicados lanzan error. | No pasa por `effect`; igualmente se ejecuta en proceso con todos los privilegios. |
| `api.events.on(handler)` | Observa los `RunEvent` versionados (`schemaVersion`, `runId`, `sessionId`, `seq`, `type`, `timestamp`, `data`). | Por plugin. | Solo lectura; un observador que lanza no puede romper la ejecución. |
| `api.context.register(provider)` | Texto `() => Promise<string>` añadido al contexto del modelo. | Por plugin. | Sin barrera. |
| `api.resources.skills(path)` / `.prompts(path)` / `.agents(path)` | Registran directorios de recursos relativos al archivo del plugin. | Los directorios se etiquetan con el id del plugin. | Sin barrera. Las skills y las plantillas de prompt son visibles para el host en el mismo arranque; las **definiciones de agentes no** (ver límites duros). |
| `api.resources.list(kind)` | Los directorios que cada plugin registró para `skills`, `prompts` o `agents`, con el id del plugin propietario. | — | Vista de solo lectura. |
| `api.state.get(key)` / `.set(key, value)` | Estado JSON pequeño por plugin, persistido en la base de datos de la sesión. | Delimitado al id del plugin. | Sin barrera. |
| `api.storage.sqlite(path)` | Un archivo SQLite privado (`0600`), creando los directorios padre (`0700`). Devuelve el puerto síncrono `SqlDatabase` (`exec`, `prepare`, `transaction`, `close`; sentencias preparadas en caché por texto SQL; FTS5 disponible). | Ruta indicada por quien llama. | Sin barrera; la base de datos se cierra al descargar el plugin, salvo que el plugin la haya cerrado antes. |
| `api.compaction.register({ beforeCompact, afterCompact })` | Aporta instrucciones, campos de salida, contexto inyectado y un informe a la compactación del núcleo. | Por plugin. | Timeout del host de 15 s; un fallo o timeout se registra como fallo del plugin y el núcleo continúa. |
| `api.session.onStart(handler)` | Texto inyectado una vez al inicio de una sesión nueva y vacía (persistido). | Por plugin. | Timeout del host de 15 s; fallos aislados. |
| `api.session.onEnd(handler)` | Se llama cuando termina una sesión interactiva (`/clear`, `/exit`, salida). | Por plugin. | Timeout del host de 10 s; los manejadores corren en paralelo; fallos aislados. |
| `api.model.complete(request)` | Completado de texto agnóstico del proveedor. Los plugins nunca importan SDKs de proveedores. | Por plugin. | Timeout duro de 120 s; no cuenta contra `limits.maxTokens`. |
| `api.models.list(signal?)` / `.resolve(reference, signal?)` | Acceso sin credenciales a los modelos configurados en `/connect`; resuelve `provider/model` canónico o un id simple inequívoco. | Por plugin. | Sin barrera. |
| `api.providers.register(provider)` | Añade metadatos y una fábrica de proveedor de modelos seleccionable. Los registros coexisten; `/connect` elige uno. | Único por id de proveedor. | No pasa por `effect`; las credenciales del proveedor permanecen en el host. |
| `api.sessions.*` (spawn, create, run, get, children, ancestors, cancel, enqueue, isRunning, capabilities, model, workspace, setStatus) | Sesiones hijas: conversaciones separadas y persistidas con contexto fresco y permisos **reducidos**. | — | Una sesión hija nunca puede superar a su padre; abortar un padre aborta a sus descendientes en ejecución. |
| `api.ui.status(key, text, detail?)` / `.panel(id, provider)` / `.select(req)` / `.askQuestions(req)` / `.open(sessionId)` / `.interactive()` | Texto de estado, paneles de árbol y preguntas interactivas. | El estado se indexa como `plugin:key`; los paneles como `plugin:id`. | Solo con interfaz interactiva; en modo headless resuelven a `undefined`/`false` y nunca se cuelgan. |
| `api.extensions.register(point, provider, options?)` | Reemplaza un punto de extensión tipado del host: `mascot`, `startup-screen` o `websearch`. | Resolución: mayor `priority`, luego id del plugin, luego orden de registro. | No pasa por `effect`; un proveedor lento o que lanza vuelve al valor por defecto. |
| `api.apps?.register(app)` (Alisio >= 0.11.5) | Una **app de plugin** a página completa: un iframe aislado que reemplaza el área central del chat, listado en el grupo Apps del panel izquierdo, más acciones tipadas que el frame invoca. Devuelve una función para quitar el registro. | `app.id` cumple `^[a-z][a-z0-9-]{0,39}$`, único por plugin; nombres de acción `^[A-Za-z][A-Za-z0-9_.-]{0,63}$`. | Cada acción declara `effect` (`read`/`write`/`process`) y un `inputSchema`; el host valida la entrada y aplica el control de efectos de la sesión. Un efecto no concedido se rechaza con `not_permitted`, sin pedir aprobación. Consulta [Apps de plugins](#apps-de-plugins). |

**La regla de namespacing en una frase:** los plugins externos se delimitan (nombres de herramientas
con prefijo, comandos bajo `<plugin id>:`) y su efecto `internal` se degrada a `external`; los
plugins integrados quedan sin prefijo y pueden declarar `internal`.

### Apps de plugins

`api.apps` (Alisio >= 0.11.5) permite que un plugin abra una página completa en el área principal
del host. Usa una app cuando las personas necesitan una superficie de trabajo propia (un editor, un
estudio, un panel); usa una herramienta cuando debe actuar el modelo, un comando para una acción
puntual y una vista para resultados de solo lectura en el chat.

**Detecta la capacidad y declara el host mínimo.** `api.apps` es opcional. Registra primero todo lo
demás y agrega la app solo si existe; nunca abras una interfaz aparte como alternativa. Un plugin que
no funciona sin su app fija su rango peer en `@alisio/sdk >=0.11.5 <0.12.0`.

```ts
export default definePlugin({
  id: "acme.notes",
  setup(api) {
    // Primero herramientas, comandos y vistas, para que funcionen en cualquier host.
    if (!api.apps) return; // Explica en /help que el estudio requiere Alisio >= 0.11.5.
    api.apps.register({
      id: "notes",
      label: { en: "Notes", es: "Notas" },
      html: () => renderAppHtml(), // autocontenido, <= 8 MiB
      actions: {
        "notes.list": {
          effect: "read",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
          handler: async (_input, ctx) => listNotes(ctx.workspace, ctx.signal),
        },
      },
      busy: () => jobs.running(),
      dispose: () => jobs.cancelAll(), // síncrono e idempotente
    });
  },
});
```

**Ciclo de vida.** Registra en `setup` y ejecuta inferencia solo después, dentro de los handlers. El
host quita la app y llama a `dispose` cuando el plugin se cierra o cuando `setup` falla. Guarda el
estado por activación del plugin, sin disposers globales compartidos entre workspaces. Devuelve
`true` en `busy` mientras haya trabajo en segundo plano para que el workspace no se descargue.

**Acciones.** El host valida `input` contra `inputSchema` (no se admiten `$ref`, `$id` ni `$async`)
y aplica el mismo control de efectos que a las herramientas. La sesión sale de la ruta autenticada,
nunca de la entrada. Cada llamada vence a los **30 s** y aborta `ctx.signal`: el trabajo largo
devuelve enseguida un id de tarea y el frame lo consulta. Los resultados deben poder serializarse a
JSON y los errores nunca repiten entradas ni secretos. Dentro de los handlers usa `api.models`,
`api.model.complete` y `api.sessions`; llega a otros plugins solo mediante una sesión hija con una
lista explícita de herramientas permitidas. Límites del host (`PLUGIN_APP_LIMITS`): HTML de 8 MiB,
solicitud de 37 MiB, resultado de 90 MiB y 8 solicitudes simultáneas.

**El frame.** El HTML corre en un iframe aislado con **origen opaco**
(`allow-scripts allow-downloads allow-modals allow-popups`) bajo una CSP estricta:

| Regla | Consecuencia |
| --- | --- |
| `script-src 'nonce-…'` | Cada `<script>` en línea lleva `nonce="__ALISIO_NONCE__"`; el host lo reemplaza en cada carga. |
| Sin `allow-forms`, `form-action 'none'` | Enviar un `<form>` no hace nada; usa botones y manejadores de la tecla Enter. |
| `default-src 'none'`, `connect-src blob:` | Sin fetch, XHR ni URLs externas de scripts, estilos o fuentes; incrusta todo y usa `data:`/`blob:` para los recursos. Todos los datos pasan por acciones. |
| Sin `'unsafe-eval'` ni `'wasm-unsafe-eval'` | Sin `eval`, `new Function` ni WebAssembly. Los workers deben ser URLs `blob:`. |
| Sin `allow-same-origin` | Sin cookies, sin credenciales y sin acceso al DOM padre. |

**Transporte.** Al cargar, el host envía `{ type: "alisio.app.connect", locale, visible }` con un
`MessagePort`. Acepta solo el primero y solo cuando `event.source === window.parent`. Envía
`{ type: "request", id, action, input?, idempotencyKey? }` por el puerto y empareja
`{ type: "response", id, result }` o `{ type: "response", id, error }`. Códigos de error:
`not_found`, `invalid_input`, `not_permitted`, `timeout`, `failed`, `too_large`,
`too_many_requests`, `unauthorized`, `network`. Muestra un estado "no disponible" ante `not_found`
(el plugin se desactivó o se quitó).

**Idioma y visibilidad.** Las etiquetas aceptan `{ en, es }` con `en` como respaldo. Sigue los
mensajes `{ type: "locale" }` del host en vez de incluir un selector de idioma, y pausa las
consultas periódicas ante `{ type: "visibility", visible: false }`.

**Comportamiento del host.** Abrir una app oculta el chat pero lo mantiene montado, así que los
borradores se conservan. Los frames siguen montados mientras están ocultos; cada proyecto tiene su
propia instancia y sesión. Una recarga completa pierde el texto sin guardar, así que persiste mediante
acciones y avisa con `beforeunload` mientras haya cambios pendientes.

**Aún no disponible:** navegación declarativa, iconos o rutas profundas, una API de tareas del host o
SSE, `model.stream`, un SDK de navegador y manejadores de archivos. Desactivar un plugin bloquea las
acciones nuevas, pero no cierra un puerto abierto ni cancela tareas en curso.

**Pruebas.** Prueba unitariamente los handlers de acciones y el generador de HTML: cada `<script>`
tiene el marcador del nonce, no hay URLs externas ni `<form>`. Revisa la página visualmente con
`alisio serve` de Alisio 0.11.5 o posterior.

## Límites duros: hasta dónde llegan los plugins

Esta es la sección que hay que leer antes de cargar código que no escribiste.

| Límite | Qué significa |
| --- | --- |
| **Sin sandbox.** | Los plugins se ejecutan en proceso con todos los privilegios del usuario. El campo `effect` es *metadato de disponibilidad*, no aislamiento. Un manifiesto o un subproceso no son un sandbox. |
| **`--read-only` desactiva los plugins externos por completo.** | No se cargan. También desactiva escrituras, procesos, herramientas de red y MCP. Los plugins integrados no se ven afectados. Cuando una plantilla de prompt de barra requiere una capacidad que `--read-only` no concede, la CLI imprime la bandera exacta de capacidad (`--allow-write` / `--allow-process`) y le dice al usuario que ejecute sin `--read-only`; la instalación se rechaza de plano. |
| **Las sesiones hijas solo reducen.** | Una sesión hija nunca puede ganar una capacidad que su padre no tiene. Un padre de solo lectura **envenena a todos los descendientes**: `readOnly` se hereda (`parent.readOnly || spec.readOnly`). |
| **Los nombres externos se reescriben; `internal` se degrada.** | Los nombres de herramientas externas reciben el prefijo `p_<hash>_`; el efecto `internal` de un plugin externo pasa a `external`. |
| **Omitir `effect` significa `external`, no `read`.** | En el runner, `effect` es `external` por defecto (`t.effect ?? "external"`). Declara `read` solo para herramientas sin efectos secundarios. |
| **`paths()` no es una barrera de escritura.** | El resultado de `paths(input)` de una herramienta alimenta la resolución de contexto (`context.beforePaths`), de modo que se cargan instrucciones anidadas. No restringe lo que la herramienta puede tocar. |
| **Cualquier plugin externo auto-habilita la política `external`.** | Cuando se carga al menos un plugin externo (o se registra cualquier herramienta con prefijo `p_`), la política de runtime `external` se activa. Habilitar un plugin amplía de verdad lo que el modelo puede hacer. |
| **Los timeouts de hook los impone el host, pero no pueden interrumpir código síncrono.** | Hooks de compactación e inicio de sesión: 15 s. Hooks de fin de sesión: 10 s. `model.complete`: timeout duro de 120 s. Un timeout aborta la espera y la `AbortSignal`, pero no puede detener código síncrono bloqueante. |
| **El renderizado de extensiones está acotado.** | Un proveedor tiene un presupuesto de renderizado de 250 ms, 12 líneas para `mascot` y 60 para `startup-screen`. El renderizado es síncrono, así que un proveedor lento se reemplaza por el valor por defecto *después* de retornar; no se puede interrumpir. |
| **Los nombres de herramienta o comando duplicados lanzan error.** | `Duplicate tool: <nombre>` y `Duplicate command <clave>`. Los nombres de herramienta deben caber en `^[a-zA-Z0-9_-]{1,64}$` después del prefijo. |
| **Los plugins no pueden importar otro plugin ni `@alisio/core`.** | Depende solo de los módulos integrados de Node y de `@alisio/sdk`. |
| **Los recursos de agentes externos no están en el catálogo de subagentes integrado en el mismo arranque.** | El plugin integrado `subagents` lee `api.resources.list("agents")` durante su propio `setup`, que ocurre antes de que se activen los plugins externos. Las skills y las plantillas de prompt se recopilan después de que todos los plugins se activan, así que *sí* son visibles. Solución: ejecuta sesiones hijas directamente con `api.sessions.create`/`.run` y carga tú mismo los archivos de agentes/skills empaquetados; el plugin de referencia `@alisio/plugin-wayfinder` hace exactamente esto. |
| **Las llamadas de UI en headless nunca se cuelgan.** | `ui.select` y `ui.askQuestions` resuelven a `undefined` (y cada id de pregunta a `undefined`); `ui.open` devuelve `false`; `ui.interactive()` devuelve `false`. |
| **La instalación ejecuta npm con tus privilegios.** | `alisio install` ejecuta `npm install --prefix …`, que puede lanzar los scripts de ciclo de vida del paquete. La herramienta `plugin_install` que usa el agente tiene efecto `process` y no está disponible bajo `--read-only`. |

## Los errores más probables

| Síntoma | Causa | Solución |
| --- | --- | --- |
| `Error: Child sessions are not available yet` / `Model resolution is not available yet` / `Model completion is not available yet` | `api.sessions.*`, `api.models.*` y `api.model.complete` se vinculan **después** de que los plugins se activan. Llamarlos directamente dentro de `setup()` lanza error. | Difiere esas llamadas a la ejecución de una herramienta, a un manejador de comando o a un hook de ciclo de vida; cualquier cosa que corra después del arranque. |
| `Capability denied: external` en una herramienta que claramente solo lee | Omitiste `effect`, así que quedó `external`, y la política de externos está apagada. | Declara `effect: "read"` para herramientas sin efectos secundarios. |
| `Duplicate tool: …` / `Duplicate command …` al cargar | Dos registros colisionan, o un nombre de herramienta externo supera los 64 caracteres tras el prefijo `p_<hash>_`. | Haz únicos los nombres; mantén la longitud con prefijo dentro de 64 caracteres. |
| La herramienta funciona en local pero falta tras instalar | Al paquete le falta `"keywords": ["alisio-plugin"]`, o `exports["."]`/`main`/`./index.js` no resuelve al entry compilado. | Añade la keyword y publica `dist` con un entry resoluble. |
| Las definiciones de agentes nunca aparecen en el catálogo de subagentes | Los recursos de agentes externos no son visibles en el mismo arranque (ver límites duros). | Regístralos para interoperabilidad del catálogo, pero ejecuta las sesiones hijas directamente y carga tú mismo los archivos. |
| Un hook parece ejecutarse dos veces / el estado se duplica | `setup` se llama una vez por activación; volver a registrar al recargar es esperado. Todo se desregistra al descargar. | Registra de forma idempotente o confía en la limpieza al descargar. |
| La comprobación de diagramas falla en CI sin cambios | `diagrams:check` compara mtimes, no hashes; un checkout nuevo puede hacer que todos los archivos compartan la misma marca de tiempo. | Es una ayuda local de autoría, no una barrera de CI. Vuelve a renderizar con `pnpm diagrams`. |

## Forma y publicación del paquete

| Requisito | Detalle |
| --- | --- |
| Nombre del paquete | **Solo de primera parte:** `@alisio/plugin-*`. Para un paquete externo, usa un nombre npm propio (por ejemplo `@tu-scope/alisio-plugin-*`); el host y el registro no exigen ese patrón. |
| Keyword | `alisio-plugin` es **obligatoria**; un paquete sin ella se rechaza, así que un error tipográfico no puede cargar un paquete no relacionado. |
| Formato de módulo | ESM. Los plugins publicados **deben incluir JavaScript** (más declaraciones). |
| Resolución del entry | `exports["."]` (`import`, luego `node`, luego `default`), después `main`, después `./index.js`. |
| Node objetivo | `>=22.16`. |
| `alisio-plugin.json` | Obligatorio cuando el plugin es un **directorio dado como ruta**: `{ "apiVersion": 1, "entry": "./index.js" }`, y el entry debe permanecer dentro del directorio. Opcional para un paquete npm (un paquete también puede incluirlo). |
| Dependencias | Solo módulos integrados de Node y `@alisio/sdk`. `@alisio/sdk` permanece en **ambos**, `peerDependencies` y `devDependencies`. Nunca importes otro plugin ni `@alisio/core`. |
| Archivos publicados | JavaScript y declaraciones de `dist`, README, `LICENSE` MIT y cada recurso registrado (por ejemplo `.agents`, `assets`). |
| Versionado aquí | **Solo de primera parte:** Changesets. Sube un paquete con `pnpm bump-one -- <nombre> <patch\|minor\|major> --summary "<texto>"`, o ejecuta `pnpm changeset` y luego `pnpm run version` (que además corre `scripts/sync-versions.mjs`). `pnpm publish-one -- <nombre>` y `pnpm publish-all` son ensayos; añade `--publish` para una publicación intencional. |

Ninguna versión de primera parte se publica sin autorización explícita y autenticación de npm. Este repositorio no
almacena secretos; consulta [SECURITY.md](https://github.com/GustavoGutierrez/alisio-plugins/blob/main/SECURITY.md).

La herramienta de publicación de **primera parte** ejecuta un preflight por paquete: autenticación de npm (`npm login` o
`NPM_TOKEN`), árbol de trabajo limpio y confirmado, `package.json`/`src/version.ts` coincidentes, un
tarball empaquetado sin rutas locales de la máquina ni credenciales (`pnpm pack:check`, que ejecuta el
escáner de fugas sobre cada tarball), y una versión que no esté ya en el registro. Los dist-tags por
defecto son `latest`, o `next` para versiones de prelanzamiento. `pnpm release:changesets` es el flujo
nativo de Changesets que crea etiquetas git y lo usa la CI; `pnpm publish-all` es el flujo explícito con
preflight.

Los paquetes publicados de primera parte no contienen rutas específicas de la máquina ni credenciales. La misma garantía
se aplica en cada pull request mediante `pnpm check`: `leak:check` escanea cada archivo rastreado y
`pack:check` escanea cada tarball empaquetado, así que ambas superficies quedan cubiertas antes de
integrar.

## Instalación y pruebas de humo

`alisio install` instala un paquete npm en el directorio **global** de plugins de Alisio y registra
el **nombre** del paquete (nunca la ruta resuelta) en el arreglo `plugins` de la configuración
global.

```bash
alisio install npm:@alisio/plugin-x            # última versión
alisio install npm:@alisio/plugin-x@1.2.3      # fijada
alisio install @alisio/plugin-x                # nombre simple: igual que npm:
alisio install npm:@alisio/plugin-x --update   # refresca a @latest, conserva el nombre
alisio install npm:@alisio/plugin-x -y         # omite la confirmación previa
alisio install npm:@alisio/plugin-x --trust-plugin  # igual que --yes
```

| Aspecto | Comportamiento |
| --- | --- |
| Specs aceptadas | `npm:<paquete>[@<versión>]`, o un nombre de paquete simple. Los nombres permiten letras, dígitos, `.`, `_`, `-`, más `/` para nombres con scope y `@` para una versión. |
| Specs rechazadas | Prefijos desconocidos (`git:`, `file:`, `registry:`, URLs), rutas absolutas o con `..`, y metacaracteres de shell. Una instalación fallida nunca vuelve a ejecutar npm en silencio. |
| Dónde queda | `<config home>/plugins/node_modules/<paquete>`; el nombre se añade a `<config home>/config.json` (escritura atómica, campos no relacionados preservados, sin duplicados). |
| Privilegios | `npm install` puede ejecutar los scripts de ciclo de vida del paquete con tus privilegios de usuario. En una terminal interactiva Alisio advierte y pide confirmación; las ejecuciones headless deben pasar `--yes`/`--trust-plugin` o fallan antes de ejecutar npm. |
| Bajo `--read-only` | La instalación se rechaza y el plugin nunca se carga. |

Para probar una compilación local:

```bash
alisio --plugin ./dist/index.js                 # confianza explícita para este entry
alisio plugins list                             # plugins instalados/conocidos
alisio plugins doctor --plugin ./dist/index.js  # herramientas, comandos, extensiones, integrados
```

`alisio plugins install`, `alisio plugins remove` y `alisio plugins validate` **no existen**.
Instalar es `alisio install`; eliminar es editar la configuración global y el directorio de plugins;
la validación ocurre al cargar y se muestra con `alisio plugins doctor`.

## Fijación de la versión del SDK

El `@alisio/sdk` publicado es **`0.1.0-alpha.10`** al momento de escribir esto. Verifica la versión
actual antes de fijarla:

```bash
npm view @alisio/sdk version
```

El ejemplo de la documentación upstream fija `^0.1.0-alpha.16`, que está **desactualizado** y por
delante de lo publicado. Prefiere un rango que este repositorio sí usa:

```json
{
  "peerDependencies": { "@alisio/sdk": ">=0.1.0-alpha.10 <0.2.0" },
  "devDependencies": { "@alisio/sdk": "0.1.0-alpha.10" }
}
```

## Pruebas en este repositorio

- **Los tests unitarios son obligatorios** para cada paquete de plugin.
- Cubre **al menos un camino feliz y un camino infeliz por escenario funcional** (positivo, y
  negativo/error/límite/alternativa válida).
- **El TDD estricto es una decisión de proyecto opcional y registrada explícitamente**, no un valor
  por defecto. Registrarlo es una convención del plugin de referencia, no una precondición del
  repositorio; un flujo de cobertura primero es aceptable cuando la decisión queda escrita.
- Los tests corren como parte de `pnpm check` (`pnpm -r test`), así que un test que falla bloquea la
  revisión.

## Advertencias de documentación

Cuando la documentación upstream y el código discrepan, esta guía sigue al código:

1. **El ejemplo de fijación del SDK está desactualizado.** La documentación upstream muestra
   `^0.1.0-alpha.16`; la versión publicada es `0.1.0-alpha.10` (compruébalo con
   `npm view @alisio/sdk version`).
2. **`extensions.register` cubre más de lo que dice la tabla de la API.** La tabla de `PluginAPI`
   lista `(mascot, startup-screen)`, pero el mapa tipado `ExtensionPoints` del SDK también incluye
   `websearch`, y la tabla de puntos de extensión lo documenta. Sigue al tipo del SDK.
3. **`ui.askQuestions` falta en la tabla de la API upstream.** Existe en el SDK (`PluginAPI.ui`) y
   resuelve cada id de pregunta a `undefined` cuando no hay interfaz interactiva.
4. **El rollback de `setup` también llama a `dispose`.** El texto upstream del "objeto Plugin" dice
   que los registros parciales se revierten; el host primero revierte cada registro y luego llama a
   `dispose()` antes de relanzar.

---

Esta guía y su espejo en inglés se mantienen sincronizados y deben actualizarse juntos. Las dos
versiones deben describir siempre el mismo comportamiento.

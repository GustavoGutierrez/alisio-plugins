# Desarrollo de plugins de Alisio

Español · [English](../developing-plugins.md)

Esta guía cubre la **autoría de plugins para este repositorio**: la forma del paquete, el contrato
del plugin, la superficie de capacidades, los límites duros, el empaquetado y cómo instalar y probar
una compilación. La referencia canónica upstream del SDK y de `PluginAPI` es la
[documentación de plugins de Alisio](https://gustavogutierrez.github.io/alisio/es/plugins) (inglés:
[`/plugins`](https://gustavogutierrez.github.io/alisio/plugins)); enlázala en lugar de duplicar la
referencia completa aquí.

Todo en esta guía se verificó contra el código fuente upstream
(`docs/plugins.md`, `packages/sdk/src/index.ts`, `packages/core/src/plugins/host.ts`,
`packages/core/src/runtime/modules.ts`, `packages/core/src/plugins/install.ts`). Cuando la
documentación upstream y el código discrepan, esta guía sigue al código y lo señala como una
**advertencia de documentación**.

- [Ruta rápida](#ruta-rápida)
- [El contrato](#el-contrato)
- [Superficie de capacidades](#superficie-de-capacidades)
- [Límites duros: hasta dónde llegan los plugins](#límites-duros-hasta-dónde-llegan-los-plugins)
- [Los errores más probables](#los-errores-más-probables)
- [Empaquetado y publicación](#empaquetado-y-publicación)
- [Instalación y pruebas de humo](#instalación-y-pruebas-de-humo)
- [Fijación de la versión del SDK](#fijación-de-la-versión-del-sdk)
- [Pruebas en este repositorio](#pruebas-en-este-repositorio)
- [Advertencias de documentación](#advertencias-de-documentación)

## Ruta rápida

```bash
corepack enable
pnpm install
pnpm check                 # lint, tipos, tests, build y pack check
pnpm diagrams:check        # los SVG confirmados son más recientes que sus fuentes
```

Luego crea el paquete bajo `packages/<nombre>/` siguiendo las convenciones del
[README](../../README.es.md) raíz y de [CONTRIBUTING.md](../../CONTRIBUTING.md).

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
| `categories` | no | `model-provider` opcional; el host también deriva esa categoría de los registros de proveedores. |
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

**La regla de namespacing en una frase:** los plugins externos se delimitan (nombres de herramientas
con prefijo, comandos bajo `<plugin id>:`) y su efecto `internal` se degrada a `external`; los
plugins integrados quedan sin prefijo y pueden declarar `internal`.

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

## Empaquetado y publicación

| Requisito | Detalle |
| --- | --- |
| Nombre del paquete | `@alisio/plugin-*`. |
| Keyword | `alisio-plugin` es **obligatoria**; un paquete sin ella se rechaza, así que un error tipográfico no puede cargar un paquete no relacionado. |
| Formato de módulo | ESM. Los plugins publicados **deben incluir JavaScript** (más declaraciones). |
| Resolución del entry | `exports["."]` (`import`, luego `node`, luego `default`), después `main`, después `./index.js`. |
| Node objetivo | `>=22.16`. |
| `alisio-plugin.json` | Obligatorio cuando el plugin es un **directorio dado como ruta**: `{ "apiVersion": 1, "entry": "./index.js" }`, y el entry debe permanecer dentro del directorio. Opcional para un paquete npm (un paquete también puede incluirlo). |
| Dependencias | Solo módulos integrados de Node y `@alisio/sdk`. `@alisio/sdk` permanece en **ambos**, `peerDependencies` y `devDependencies`. Nunca importes otro plugin ni `@alisio/core`. |
| Archivos publicados | JavaScript y declaraciones de `dist`, README, `LICENSE` MIT y cada recurso registrado (por ejemplo `.agents`, `assets`). |
| Versionado aquí | Changesets. Ejecuta `pnpm changeset`, luego `pnpm version` (que además corre `scripts/sync-versions.mjs`). `pnpm publish-one -- <nombre>` es un ensayo; añade `--publish` para una publicación intencional. `pnpm publish-all` comprueba y publica las versiones preparadas. |

Ninguna versión se publica sin autorización explícita y autenticación de npm. Este repositorio no
almacena secretos; consulta [SECURITY.md](../../SECURITY.md).

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

El `@alisio/sdk` publicado es **`0.1.0-alpha.9`** al momento de escribir esto. Verifica la versión
actual antes de fijarla:

```bash
npm view @alisio/sdk version
```

El ejemplo de la documentación upstream fija `^0.1.0-alpha.16`, que está **desactualizado** y por
delante de lo publicado. Prefiere un rango que este repositorio sí usa:

```json
{
  "peerDependencies": { "@alisio/sdk": ">=0.1.0-alpha.9 <0.2.0" },
  "devDependencies": { "@alisio/sdk": "0.1.0-alpha.9" }
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
   `^0.1.0-alpha.16`; la versión publicada es `0.1.0-alpha.9` (compruébalo con
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

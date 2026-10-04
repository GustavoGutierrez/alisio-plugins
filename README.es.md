# Plugins de Alisio

Español · [English](./README.md)

El monorepo oficial de paquetes `@alisio/plugin-*` publicados de forma independiente que extienden
el agente de programación [Alisio](https://github.com/GustavoGutierrez/alisio). Cada paquete se
instala por separado y se versiona por separado; nada de esto es un framework que debas adoptar.

## Ruta rápida

**Instalar un plugin en Alisio**

```bash
alisio install npm:@alisio/plugin-wayfinder   # global, por usuario
alisio plugins list                           # confirma que quedó instalado
```

Para desarrollo local, compila el paquete y cárgalo desde una ruta:

```bash
pnpm --dir packages/wayfinder build
alisio --plugin ./packages/wayfinder/dist/index.js
```

**Empezar a desarrollar un plugin**

```bash
corepack enable
pnpm install
pnpm check          # lint, tipos, tests, build y pack check
```

Después lee [site/es/developing-plugins.md](./site/es/developing-plugins.md): es la referencia de
autoría completa para este repositorio. El contrato canónico upstream está en la
[documentación de plugins de Alisio](https://gustavogutierrez.github.io/alisio/es/plugins).

## Estructura del repositorio

| Ruta | Qué contiene |
| --- | --- |
| `packages/` | Un paquete publicable `@alisio/plugin-*` por directorio. |
| `diagrams/` | Fuentes Mermaid `.mmd`, un directorio por objetivo de diagrama. |
| `site/` | Sitio del catálogo en VitePress y guías del repositorio (`site/developing-plugins.md`); ejecuta `pnpm docs:dev`. |
| `registry/` | Registros de plugins de terceros para el catálogo (`registry/plugins.json`). |
| `scripts/` | Herramientas del repositorio: renderizador de diagramas, escaneo del catálogo, pack check, ayudas de publicación. |
| `.agents/skills/` | Skills del proyecto que guían a las personas contribuyentes y a los agentes. |
| `assets/` | SVG generados para los documentos a nivel de repositorio (no es un paquete). |

## Cómo funcionan los plugins

![Arquitectura de un plugin: fuentes confiables, validación del contrato, la frontera api, los registros de capacidades y el effect gate](./assets/plugin-architecture.svg)

`plugin-architecture.svg` es la vista estática: qué fuentes pueden cargar un plugin, qué valida el
host antes de ejecutar código de plugin, dónde queda la frontera `api` entre host y plugin, y cómo
la llamada a una herramienta del modelo llega al effect gate que decide si se ejecuta.

![Ciclo de vida de un plugin en tiempo de ejecución: resolución, validación, activación, registro, rollback y desmontaje](./assets/plugin-runtime-lifecycle.svg)

`plugin-runtime-lifecycle.svg` sigue a un plugin desde una fuente confiable, pasando por la
validación del contrato y la activación, hasta sus registros de capacidades, el rollback si falla y
el desmontaje final.

![Flujo de desarrollo de un plugin: andamiaje, implementación, comprobaciones, changeset, publicación, instalación y prueba de humo](./assets/plugin-development-flow.svg)

`plugin-development-flow.svg` sigue un cambio desde el andamiaje del paquete hasta su publicación y
la prueba de humo del resultado instalado.

## Qué puede y qué no puede hacer un plugin

| Un plugin puede… | Un plugin no puede… |
| --- | --- |
| Registrar herramientas, comandos, observadores de eventos, proveedores de contexto y recursos. | Ejecutarse en un sandbox. Se ejecuta en proceso con todos los privilegios del usuario. |
| Guardar estado pequeño y abrir una base de datos SQLite privada. | Aislarse del host mediante `effect`; ese campo es solo metadato de disponibilidad. |
| Engancharse a la compactación y al inicio/fin de sesión, y llamar a `model.complete`. | Interrumpir código síncrono bloqueante con un timeout de hook. |
| Crear sesiones hijas con capacidades reducidas. | Otorgar a una sesión hija una capacidad que su padre no tiene. |
| Proveer proveedores de modelos y puntos de extensión (`mascot`, `startup-screen`, `websearch`). | Importar otro plugin o `@alisio/core`. |
| Aportar skills y plantillas de prompt. | Hacer que sus definiciones de agentes aparezcan en el catálogo de subagentes integrado en el mismo arranque. |

La superficie completa de capacidades, los límites duros y los errores más frecuentes están en
[site/es/developing-plugins.md](./site/es/developing-plugins.md).

## Paquetes

| Paquete | Categoría | Propósito |
| --- | --- | --- |
| [`@alisio/plugin-wayfinder`](packages/wayfinder#readme) | `methodology-harness` | Coordina un flujo de desarrollo guiado por especificaciones y duradero con sesiones hijas acotadas. |
| [`@alisio/plugin-thesis`](packages/plugin-thesis#readme) | `methodology-harness` | Planifica, investiga, redacta y compone tesis universitarias con evidencia verificada y compuertas de calidad deterministas. |

`methodology-harness` es una categoría de catálogo estricta que valida el host. Requiere un runtime de
Alisio que incluya `@alisio/core` `0.1.0-alpha.15` o posterior; un plugin no puede declarar esa
dependencia por sí mismo, así que cada paquete documenta su runtime mínimo (ver el README de Wayfinder).

## Convenciones de paquete

- Nombra cada paquete publicable `@alisio/plugin-*` e incluye la keyword `alisio-plugin`.
- Mantén cada plugin instalable de forma independiente y autocontenido; nunca importes otro plugin ni
  `@alisio/core`.
- Publica JavaScript ESM y declaraciones desde `dist`, apunta a Node `>=22.16` y mantén
  `@alisio/sdk` como dependencia peer y de desarrollo.
- Cada paquete necesita una descripción, un README, su propio `LICENSE` MIT y tests unitarios.

## Comprobaciones obligatorias

| Comando | Qué verifica |
| --- | --- |
| `pnpm check` | Lint, comprobación de fugas, tipos, tests, build y el pack check (nombres, metadatos, exports, archivos, licencias, READMEs, JS/tipos compilados, recursos empaquetados y un escaneo de fugas de cada tarball empaquetado). |
| `pnpm diagrams:check` | Que cada SVG confirmado sea más reciente que su fuente `.mmd`. Es una ayuda local de autoría, no una barrera de CI. |

Ejecuta `pnpm check` antes de abrir una revisión. Usa Changesets para las versiones; nunca publiques
a mano.

## Publicación

Las publicaciones son explícitas y con ensayo previo por defecto; nada se publica sin un operador
autorizado y autenticación de npm vigente (`npm login`, o `NPM_TOKEN` con permisos de publicación
sobre el scope `@alisio`).

```bash
pnpm bump-one -- @alisio/plugin-<nombre> patch --summary "Resumen público del cambio"
pnpm publish-one -- @alisio/plugin-<nombre>             # ensayo (dry run)
pnpm publish-one -- @alisio/plugin-<nombre> --publish   # publicación real
pnpm publish-all                                        # ensayo para todos los paquetes
pnpm publish-all --publish                              # publicación real de todos
```

La herramienta se niega a publicar desde un árbol sucio, una versión que ya está en el registro o un
paquete cuyo `package.json` y `src/version.ts` no coinciden. Además empaqueta cada paquete y escanea el
tarball en busca de rutas locales de la máquina y credenciales (`pnpm pack:check`, que ejecuta el
escáner de fugas sobre cada tarball), así que los paquetes publicados no contienen ninguna de las dos
cosas. Los dist-tags por defecto son `latest`, y `next` para versiones de prelanzamiento.
`pnpm release:changesets` es el flujo nativo de Changesets que crea etiquetas git y lo usa la CI;
`pnpm publish-all` es el flujo explícito con preflight.

## Contribución y soporte

- [CONTRIBUTING.md](./CONTRIBUTING.md) — cómo añadir un plugin, las comprobaciones y las expectativas de PR.
- [SECURITY.md](./SECURITY.md) — el modelo de código confiable y cómo reportar una vulnerabilidad.
- [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md) — el Contributor Covenant y el contacto de aplicación.
- [site/es/developing-plugins.md](./site/es/developing-plugins.md) — la guía de autoría de plugins.
- [Documentación upstream de plugins de Alisio](https://gustavogutierrez.github.io/alisio/es/plugins) —
  la referencia canónica del SDK y de `PluginAPI`.

---

Este README y su espejo en inglés se mantienen sincronizados y deben actualizarse juntos.

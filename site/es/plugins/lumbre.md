---
title: "Lumbre"
description: "Describe a landing page or a small web app and let your Alisio model build it, with reviewed changes and a live preview."
pageClass: "plugin-detail"
---

<PluginDetail slug="lumbre" />

[English](https://github.com/GustavoGutierrez/alisio-plugins/blob/HEAD/packages/plugin-lumbre/README.md). Ambos README deben actualizarse juntos.

Describe con tus propias palabras una página de aterrizaje o una pequeña aplicación web; el modelo
de Alisio que elijas la construye, revisas cada cambio antes de aplicarlo y la abres en vivo en tu
navegador. Lumbre sigue el idioma de Alisio (inglés o español) y su tema claro u oscuro.

## Requisitos

- Alisio **0.11.6 o posterior dentro de 0.11.x** (el estudio usa la API de aplicaciones de plugins
  y su aviso de aprobación). En versiones anteriores solo funcionan la herramienta de solo lectura
  `lumbre_projects` y el comando de ayuda.
- Un proveedor de modelos conectado (`/connect`). Lumbre no pide credenciales propias.
- Acceso a internet la primera vez que se instala una base con paquetes.
- Node.js es el que incluye Alisio. Astro necesita Node.js 22.23.4 o posterior; Lumbre lo indica si
  el de Alisio es anterior.

## Uso

1. Abre **Lumbre · Creador web** en el grupo Aplicaciones de tu proyecto.
2. Describe lo que quieres, elige cómo se debe construir y, si quieres, un modelo. Selecciona
   **Empezar a construir**.
3. Sigue la tarjeta de progreso: cada paso se muestra ("Pensando en el diseño…", "Escribiendo
   index.html…", "Instalando dependencias…", "Compilando…", "Iniciando la vista previa…"), con el
   tiempo transcurrido y un botón **Cancelar**. Cuando Alisio pide permiso, Lumbre muestra
   "Esperando tu aprobación en Alisio…".
4. Revisa los cambios: archivos nuevos, modificados y eliminados, una comparación por archivo y
   cualquier paquete que haya pedido el modelo. Aplícalos todos, solo los que marques, o descártalos.
5. Abre **Vista previa**: una miniatura estática de tu página, más **Iniciar vista previa en vivo**
   y **Abrir en vivo en tu navegador**. La vista previa en vivo se recarga sola cuando aplicas
   cambios.
6. Sigue conversando para cambiarla. Si una compilación falla, Lumbre le envía el error al modelo y
   te propone una corrección para revisar, como máximo dos veces seguidas.
7. Usa **Exportar** para copiar el proyecto a una carpeta nueva de tu espacio de trabajo, o
   descarga un ZIP.

**Código** muestra cada archivo (puedes editar los tuyos; los que administra Lumbre son de solo
lectura) e **Historial** conserva las últimas 40 versiones, y puedes restaurar cualquiera.

## Bases

| Base | Qué obtienes | Vista previa en vivo |
| --- | --- | --- |
| HTML, CSS y JavaScript (Tailwind opcional) | Archivos simples; Tailwind se compila con su CLI | Servidor local propio de Lumbre con recarga automática |
| Vite + Tailwind | Módulos de JavaScript simple | Servidor de desarrollo de Vite |
| React + Vite + Tailwind | Una aplicación de una página con React | Servidor de desarrollo de Vite |
| Astro + Tailwind | Páginas de contenido | Servidor de desarrollo de Astro |
| Next.js (full stack) | Páginas y rutas de API | Servidor de desarrollo de Next.js |

Las versiones están fijadas y cada base incluye un archivo de bloqueo confirmado, así que las
instalaciones usan `npm ci`. El modelo solo puede pedir algunos paquetes adicionales de una lista
permitida por base (nombre y versión exactos), y tú apruebas cada uno en la revisión. Lumbre
escribe `package.json`, los archivos de bloqueo y los de configuración; ni el modelo ni el editor
pueden cambiarlos.

## Seguridad y límites

- **Las aplicaciones generadas se ejecutan como tú, sin aislamiento.** Las instalaciones, las
  compilaciones y los servidores de desarrollo son procesos reales en este equipo con los permisos
  de tu cuenta, y solo se inician después de la aprobación de procesos de Alisio. Revisa el código
  antes de ejecutarlo o publicarlo, y no le pongas datos reales de clientes ni credenciales.
- npm siempre se ejecuta con `--ignore-scripts`. Los procesos hijos reciben un entorno mínimo, sin
  tus claves de proveedores ni tokens.
- Los servidores de desarrollo escuchan en `127.0.0.1` en un puerto que elige Lumbre, con puerto
  estricto. Una vista previa se detiene tras 20 minutos sin actividad en Lumbre. Los servidores que
  queden tras un cierre inesperado se detienen la próxima vez que se abre Lumbre, solo después de
  comprobar que pertenecen al proyecto.
- La miniatura nunca ejecuta los scripts de tu página y sus estilos quedan contenidos en ella.
- Un proyecto admite hasta 150 archivos de texto y 3 MB de código. Como máximo se ejecutan tres
  trabajos y tres vistas previas en vivo a la vez.

## Datos

Los proyectos, su historial y el chat se guardan en el estado privado del plugin en Alisio, una
carpeta por proyecto y por espacio de trabajo, así que un proyecto dañado nunca afecta a los demás.
Las dependencias se instalan dentro de esa carpeta (un proyecto con framework suele ocupar entre
100 y 400 MB). **Exportar** solo escribe en una carpeta nueva o vacía de tu espacio de trabajo.

## Por qué npm es una dependencia

La aplicación de escritorio de Alisio ejecuta los plugins dentro de su propio entorno, donde no se
garantiza que existan `node` ni `npm`. Por eso Lumbre depende de `npm` 11.9.0 y lo ejecuta con el
Node de Alisio. Añade unos 2,4 MB a la descarga y 9,8 MB (1797 archivos) una vez instalado.

## Desarrollo

```sh
pnpm install
pnpm --filter @alisio/plugin-lumbre test
pnpm --filter @alisio/plugin-lumbre build
```

`LUMBRE_INTEGRATION=1 pnpm --filter @alisio/plugin-lumbre exec vitest run test/integration.test.ts`
instala, compila y sirve cada base de verdad (requiere red). Después de cambiar una versión fijada,
compila y ejecuta `node scripts/update-preset-locks.mjs` para regenerar los archivos de bloqueo.

## Recursos y licencia

Agente `lmb-builder`; habilidades `lmb-web` y `lmb-fix` (también son las instrucciones del
constructor); herramienta de solo lectura `lumbre_projects`; comando `help`. MIT. Los proyectos
generados usan las licencias de sus frameworks.

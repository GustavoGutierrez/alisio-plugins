---
layout: home
pageClass: catalog-page
title: Alisio Plugins
description: El catálogo de paquetes @alisio/plugin-* instalables de forma independiente para Alisio.
hero:
  name: Alisio Plugins
  text: Extensiones instalables por separado
  tagline: Descubre, instala e inspecciona los plugins que extienden el agente de programación Alisio. Cada paquete se instala por su cuenta y se versiona por su cuenta.
  image:
    src: /assets/logo.png
    alt: Logotipo de Alisio
  actions:
    - theme: brand
      text: Ver todos los plugins
      link: '#all-plugins'
    - theme: alt
      text: Desarrollar plugins
      link: /es/developing-plugins
features:
  - title: Instalación en un comando
    details: Cada plugin es un paquete npm con la palabra clave alisio-plugin, instalable con `alisio install npm:<paquete>`.
  - title: Versionado independiente
    details: Nada de esto es un framework que debas adoptar. Cada plugin se publica con su propio ritmo.
  - title: Revisado antes de instalar
    details: Los plugins se ejecutan con tus privilegios y no están en un sandbox, así que el catálogo muestra el origen y los metadatos antes de instalar.
---

<RecentlyPublished />

<PluginCatalog />

## Cómo se instalan los plugins

`alisio install` añade un paquete npm al directorio global de plugins de Alisio y registra el nombre
del paquete en tu configuración global. Por ejemplo:

```bash
alisio install npm:@alisio/plugin-wayfinder
alisio plugins list
```

El mismo comando acepta una versión explícita (`npm:@alisio/plugin-wayfinder@0.1.1`) y la opción
`--update` actualiza un plugin instalado conservando su nombre.

## Qué puede hacer un plugin

Un plugin es un módulo ES cuyo export por defecto es un objeto de plugin. Puede registrar
herramientas, comandos de barra, proveedores de modelos, proveedores de contexto, hooks de ciclo de
vida, recursos y puntos de extensión. Cada capacidad declara un efecto, y el host aplica espacios de
nombres a los plugins externos.

La documentación upstream de plugins de Alisio es la referencia canónica del SDK y de `PluginAPI`.
La [guía de desarrollo](./developing-plugins) de este catálogo cubre el empaquetado y la publicación
de las entradas listadas aquí.

## Confianza y seguridad

Los plugins ejecutan código en proceso con tus privilegios de usuario. El campo `effect` de Alisio
describe qué hace una capacidad; **no** es un sandbox. Lee el repositorio y el paquete antes de
instalar un plugin de terceros.

## Más información

- [Índice de plugins](./plugins/) — una lista estática de todos los plugins, legible sin JavaScript.
- [Desarrollar plugins](./developing-plugins) — la guía de autoría de este repositorio, con el
  contrato completo, el empaquetado y la publicación.

Los recursos de marca de este sitio provienen de la documentación de Alisio y se usan bajo la
licencia MIT.

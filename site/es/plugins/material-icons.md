---
title: "Material Icon Theme"
description: "Material Icon Theme icons for the web UI"
pageClass: "plugin-detail"
---

<PluginDetail slug="material-icons" />

![Material Icon Theme](https://raw.githubusercontent.com/GustavoGutierrez/alisio-plugins/HEAD/packages/plugin-material-icons/cover.webp)

> English: [README.md](https://github.com/GustavoGutierrez/alisio-plugins/blob/HEAD/packages/plugin-material-icons/README.md). Ambos README deben actualizarse en conjunto.

Material Icon Theme para la interfaz web de Alisio. Aporta un proveedor `icon-theme`
(`material-icon-theme`) al host, que sirve el manifiesto y los SVG del tema activo para que el panel
de archivos muestre el icono correcto de cada archivo y cada carpeta.

El paquete es autocontenido: incluye los SVG de Material Icon Theme (`icons/`, 1251 archivos) y el
manifiesto con formato de VSCode (`material-icons.json`) dentro de su propio directorio, y registra
rutas absolutas hacia ellos. No depende del paquete npm `material-icon-theme`.

## Instalación

```bash
alisio install npm:@alisio/plugin-material-icons
```

Después elige **Material Icon Theme** en la interfaz web, en **Ajustes → Apariencia → Tema de iconos**.

## Iconos incluidos

El paquete incluye **1251 iconos** y el manifiesto con formato de VSCode que asocia nombres de
archivo y de carpeta a cada uno. Una muestra de la hoja que usa la interfaz:

![Una muestra de los iconos incluidos, cada uno con el nombre que asocia el manifiesto](https://raw.githubusercontent.com/GustavoGutierrez/alisio-plugins/HEAD/packages/plugin-material-icons/icon-sheet.webp)

Cada icono es un SVG plano dentro de `icons/`; `material-icons.json` es el manifiesto que lee el host.

## Licencia de los iconos

Los iconos y el manifiesto incluidos provienen de
[Material Icon Theme](https://github.com/material-extensions/vscode-material-icon-theme), de Material
Extensions, y se usan bajo la licencia MIT (ver `LICENSE.material-icon-theme`).

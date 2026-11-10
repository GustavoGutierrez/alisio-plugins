---
title: "Material Icon Theme"
description: "Material Icon Theme icons for the web UI"
pageClass: "plugin-detail"
---

<PluginDetail slug="material-icons" />

![Material Icon Theme](https://raw.githubusercontent.com/GustavoGutierrez/alisio-plugins/HEAD/packages/plugin-material-icons/cover.webp)

> Español: [README.es.md](https://github.com/GustavoGutierrez/alisio-plugins/blob/HEAD/packages/plugin-material-icons/README.es.md). The two READMEs must be updated together.

Material Icon Theme for the Alisio web UI. It contributes one `icon-theme` provider
(`material-icon-theme`) to the host, which serves the active theme's manifest and SVGs so the file
dock shows the right icon per file and folder.

The package is self-contained: it ships the Material Icon Theme SVGs (`icons/`, 1251 files) and the
VSCode-style manifest (`material-icons.json`) under its own directory, and registers absolute paths
to them. There is no dependency on the `material-icon-theme` npm package.

## Install

```bash
alisio install npm:@alisio/plugin-material-icons
```

Then pick **Material Icon Theme** in the web UI under **Settings → Appearance → Icon theme**.

## Bundled icons

The package ships **1251 icons** and the VSCode-style manifest that maps file and folder names to
them. A sample of the worksheet the UI picks up:

![A sample of the bundled file and folder icons, each with the name the manifest matches](https://raw.githubusercontent.com/GustavoGutierrez/alisio-plugins/HEAD/packages/plugin-material-icons/icon-sheet.webp)

Every icon is a plain SVG under `icons/`; `material-icons.json` is the manifest the host reads.

## Icon license

The bundled icons and manifest come from
[Material Icon Theme](https://github.com/material-extensions/vscode-material-icon-theme) by Material
Extensions, used under the MIT License (see `LICENSE.material-icon-theme`).

# @alisio/plugin-material-icons

Material Icon Theme for the Alisio web UI. It contributes one `icon-theme` provider (`material-icon-theme`)
to the host, which serves the active theme's manifest and SVGs so the file dock shows the right
icon per file and folder.

The package is self-contained: it ships the Material Icon Theme SVGs (`icons/`, 1251 files) and the
VSCode-style manifest (`material-icons.json`) under its own directory, and registers absolute paths
to them. There is no dependency on the `material-icon-theme` npm package.

## Install

```bash
alisio install npm:@alisio/plugin-material-icons
```

Then pick **Material Icon Theme** in the web UI under **Settings → Appearance → Icon theme**.

## Icon license

The bundled icons and manifest come from
[Material Icon Theme](https://github.com/material-extensions/vscode-material-icon-theme) by Material
Extensions, used under the MIT License (see `LICENSE.material-icon-theme`).

---
layout: home
pageClass: catalog-page
title: Alisio Plugins
description: The catalog of independently installable @alisio/plugin-* packages for Alisio.
hero:
  name: Alisio Plugins
  text: Independently installable extensions
  tagline: Discover, install and inspect the plugins that extend the Alisio coding agent. Every package installs on its own and is versioned on its own.
  image:
    src: /assets/logo.png
    alt: Alisio logo
  actions:
    - theme: brand
      text: Browse all plugins
      link: '#all-plugins'
    - theme: alt
      text: Developing plugins
      link: /developing-plugins
features:
  - title: Install with one command
    details: Every plugin is an npm package with the alisio-plugin keyword, installed with `alisio install npm:<package>`.
  - title: Independently versioned
    details: Nothing here is a framework you must adopt. Each plugin ships on its own release cadence.
  - title: Reviewed before install
    details: Plugins run with your privileges and are not sandboxed, so the catalog shows the source and metadata before you install.
---

<RecentlyPublished />

<PluginCatalog />

## How plugins are installed

`alisio install` adds an npm package to Alisio's global plugins directory and records the package
name in your global config. For example:

```bash
alisio install npm:@alisio/plugin-wayfinder
alisio plugins list
```

The same command works with an explicit version (`npm:@alisio/plugin-wayfinder@0.1.1`) and the
`--update` flag refreshes an installed plugin while keeping its name.

## What a plugin can do

A plugin is an ES module whose default export is a plugin object. It can register tools, slash
commands, model providers, context providers, lifecycle hooks, resources and extension points. Each
capability is declared with an effect, and external plugins are namespaced by the host.

The upstream Alisio plugin documentation is the canonical SDK and `PluginAPI` reference. This
catalog's [developing guide](./developing-plugins) covers the packaging and publishing workflow for
entries listed here.

## Trust and security

Plugins execute code in-process with your user privileges. Alisio's `effect` field describes what a
capability does; it is **not** a sandbox. Read the repository and the package before installing a
third-party plugin.

## Learn more

- [Plugin index](./plugins/) — a static list of every plugin, readable without JavaScript.
- [Developing plugins](./developing-plugins) — the authoring guide for this repository, including the
  full plugin contract, packaging and publishing.

Brand assets on this site come from the Alisio documentation site and are used under the MIT
License.

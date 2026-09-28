# Security Policy

## Supported versions

This repository is in **0.x pre-release**. Support follows the published packages, which are versioned
independently:

| Version | Supported |
| --- | --- |
| Latest `0.x` release of any `@alisio/plugin-*` package | Yes |
| Older `0.x` releases | No — upgrade to the latest release |
| Anything not published to npm | No |

`0.x` means the API and behaviour may change between minor versions. Review the changelog before
upgrading.

## Reporting a vulnerability

Private vulnerability reporting is **not enabled** on this repository, so please **do not** open a
public issue containing exploit details. Instead:

1. Open a **minimal public issue** at
   <https://github.com/GustavoGutierrez/alisio-plugins/issues> that describes the affected package and
   the general area, **without** reproduction steps, payloads, or exploit details.
2. Ask in that issue for a private channel, or contact the maintainer through their GitHub profile:
   <https://github.com/GustavoGutierrez>.

Include, once a private channel is available:

- the affected package and version;
- a description of the impact;
- minimal reproduction steps;
- any suggested fix or mitigation.

Do not include real credentials, tokens, or other people's data. You will get an acknowledgement as
soon as the maintainer can respond; there is no paid bounty program.

## Scope: the trusted-code model

This section describes what this project does and does not defend against. Read it before loading any
plugin.

- **Plugins are trusted code.** A plugin runs **in-process** with the full privileges of the Alisio
  user. It can read and write files, spawn processes, and reach the network with those privileges.
- **There is no sandbox.** A plugin manifest, a subprocess, and the plugin `effect` field are **not**
  isolation. `effect` is availability metadata used by the permission policy; it does not confine a
  plugin.
- **Loading is explicit trust.** Alisio loads plugins only from sources you trusted: `--plugin`,
  a trusted configuration file, the global plugins directory, or (with `--trust-project`) a project
  plugins directory.
- **`--read-only` narrows the host, not a plugin.** It disables writes, processes, network tools, MCP,
  and external plugins entirely. It is a host policy, not a sandbox for code that still runs.
- **Installation runs npm.** `alisio install` runs `npm install --prefix …`, which **may run the
  package's lifecycle scripts** (`preinstall`, `install`, `postinstall`) with your user privileges.
  Alisio warns and asks for confirmation on an interactive terminal; headless runs require `--yes`
  or `--trust-plugin`. Only install packages you trust.
- **Capability narrowing is not containment.** Child sessions can only narrow their parent, and a
  read-only parent poisons its descendants, but this reduces what the model is *allowed* to call. It
  does not confine the plugin process itself.
- **What this repository owns.** This repository ships no runtime. It owns its plugins
  (`packages/*`) and its build and release tooling (`scripts/*`). Report vulnerabilities in this
  repository's own plugin code, packaging, or tooling here.
- **What belongs upstream.** Vulnerabilities in the plugin *runtime*, the host, the CLI, the
  permission policy, model providers, or install/resolution and rollback belong to the Alisio
  project: <https://github.com/GustavoGutierrez/alisio>. Report them there, so the code that can fix
  them receives them.
- **What is not a vulnerability.** A malicious plugin doing exactly what a trusted plugin is
  permitted to do is a trust decision, not a vulnerability in this project.

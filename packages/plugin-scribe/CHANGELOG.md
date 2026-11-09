# @alisio/plugin-scribe

## 0.3.2

### Patch Changes

- f70d57a: Name the missing permission (write or process) and how to grant it when Alisio rejects a studio action.
- Require Alisio 0.11.6, whose studio actions ask for approval like the chat; use the host's denied `effect`, wait for approval prompts (up to 10 minutes), and show the cover in the README.
- Show "Waiting for your approval in Alisio…" while a write or process action waits on the approval prompt.

## 0.3.1

### Patch Changes

- Add the Scribe studio on the shipped Alisio 0.11.5 plugin apps API, with a static Tectonic engine that builds PDFs on any x86_64 Linux.

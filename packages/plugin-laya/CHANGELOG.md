# @alisio/plugin-laya

## 0.1.2

### Patch Changes

- Recommend the Yes pre-selection when asking the host to activate Laya (core 0.4.3 or newer; older cores ignore it) and correct the documentation with measured disk sizes, activation flow and troubleshooting.

## 0.1.1

### Patch Changes

- Fix a live setup job being marked `interrupted` when another Alisio process loads the plugin (the job record now stores its owner and is only interrupted when the owner is dead; `/laya:status` reports a job running in another process). Add automatic activation after a successful setup on Alisio core 0.4.2 or newer, plus `/laya:activate` to retry it; older cores keep the manual `decisions.provider` instruction.

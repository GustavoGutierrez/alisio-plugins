---
"@alisio/plugin-laya": patch
---

Fix `/laya:setup --uninstall` failing with `ENOTEMPTY` when a queued job-record write landed in
`runtime/jobs` during removal: the job now settles pending writes before removing the runtime, and
removal retries transient `ENOTEMPTY`/`EBUSY` errors. Widen the `@alisio/sdk` peer range to
`>=0.9.0 <0.12.0`.

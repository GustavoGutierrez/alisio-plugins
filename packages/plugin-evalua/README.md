# @alisio/plugin-evalua

Evalúa helps a teacher prepare printable school math exams through a short, guided interview.

> Status: early release. This version ships the foundation only: the teacher profile, the workspace
> layout, exam numbering and the interview. Exam generation and PDF output arrive in later releases.

## Install

```sh
alisio plugins install @alisio/plugin-evalua
```

Requires Node 22.16 or newer and `@alisio/sdk` `>=0.3.0 <0.7.0`.

## Basic usage

| Command | What it does |
| --- | --- |
| `/evalua:init [dir] [--edit]` | Creates the workspace (default folder `evalua/`) and asks for the teacher profile once. `--edit` re-asks with current values preselected. |
| `/evalua:new [topic]` | Runs the exam interview (topic, grade, level, item types, count, same exam or bank, columns, page limit, time, closing text). The profile is asked first only if `teacher.yaml` is missing. |
| `/evalua:status` | Shows the profile, any pending interview round, the exam draft and the exam folders. |

In a headless session the pending round is stored in the workspace state. Continue with
`/evalua:new id=value ...` (free text goes in `<id>:text=...`).

Tools for agents: `evalua_profile` (get or set the profile), `evalua_answer` (answer the pending
round), `evalua_status` (read-only state as JSON).

## Workspace layout

```
<workspace>/
  .alisio/evalua/state.json     machine-owned state (atomic writes)
  evalua/
    teacher.yaml                teacher profile, safe to edit by hand
    assets/logo.png             optional logo (PNG, JPEG or WebP, up to 2 MB; SVG is rejected)
    exams/NN-slug/              created only after the teacher approves the exam spec
```

Exam numbers are consecutive and never reused, even if a folder is deleted by hand.

## Profile fields

`teacherName`, `institution` (printed upper-case), optional `logo`, `subject` (default
Matemáticas), `language` (default `es`) and `paper` (`letter` or `a4`, default `letter`).

## License

MIT

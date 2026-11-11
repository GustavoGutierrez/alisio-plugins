# @alisio/plugin-reportforge

## 0.1.1

### Patch Changes

- e3418e3: ReportForge generates reports more reliably and lets you manage them from the studio.
  
  - Model answers are read more robustly: reasoning blocks, code fences and text around the report
    no longer break it. A cut-off, unreadable or incomplete answer gets one automatic retry that asks
    for a compact report, invalid components are left out (the studio says how many) instead of
    failing the whole report, and the output budget follows the model's catalog.
  - Failed generations now explain why (answer too long, unreadable, without enough valid components,
    unfinished, or a model provider error), in English and Spanish.
  - Choose or change the model of an open report before generating again. If the saved model is no
    longer available, the studio says so and uses the Alisio default model; a model list that cannot
    be loaded is shown as a note instead of silently offering only the default.
  - Delete a report, with confirmation, from the list or the open report. A generation in progress is
    stopped first, and the report and its sources are removed together.
  - The studio shows the ReportForge icon next to its name.

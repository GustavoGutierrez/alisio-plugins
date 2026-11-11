# @alisio/plugin-reportforge

## 0.1.2

### Patch Changes

- 876a9a3: Fix the PDF export. Clicking **PDF / Imprimir** failed inside Alisio's app frame (the preview's print
  dialog was blocked). The button is now **↓ PDF**: ReportForge creates the PDF with a Chromium-family
  browser installed on your machine (Chrome, Chromium, Edge, Brave, Vivaldi or Opera) and downloads
  it, named after the report's title, with the report's page size, margins and one-page fit. The
  browser runs headless, offline and with a temporary profile, and you can cancel it. The session
  must allow running programs; if it does not, or no browser is found, the studio says so and
  **↓ HTML** remains available.
  
  Chart cards now fill their column (they were narrower than their space), and the donut chart stays
  visible in narrow cards, with its legend moving below the ring when space is short.

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

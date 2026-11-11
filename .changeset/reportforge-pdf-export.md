---
"@alisio/plugin-reportforge": patch
---

Fix the PDF export. Clicking **PDF / Imprimir** failed inside Alisio's app frame (the preview's print
dialog was blocked). The button is now **↓ PDF**: ReportForge creates the PDF with a Chromium-family
browser installed on your machine (Chrome, Chromium, Edge, Brave, Vivaldi or Opera) and downloads
it, named after the report's title, with the report's page size, margins and one-page fit. The
browser runs headless, offline and with a temporary profile, and you can cancel it. The session
must allow running programs; if it does not, or no browser is found, the studio says so and
**↓ HTML** remains available.

Chart cards now fill their column (they were narrower than their space), and the donut chart stays
visible in narrow cards, with its legend moving below the ring when space is short.

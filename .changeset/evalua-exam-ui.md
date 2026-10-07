---
"@alisio/plugin-evalua": patch
---

Exam sheet polish. The header data table sits in a rounded frame (16px radius, `#D2D2D2`, exposed as
the new `infoBorder` token) with a left and right margin, so its right border is no longer clipped at
the page edge; the teacher, student and date rows own their line and span the full row width, and the
date is a single-line mask `____ / ____ / ____`. Each question number is now a filled badge (the new
`badgeBg` and `badgeText` tokens, black on white by default) instead of a bare `1.`. The intro and the
closing quote or verse each sit in their own rounded frame. The duration uses a singular form, so a
60-minute exam reads "1 hora" instead of "1 horas".

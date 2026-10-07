---
"@alisio/plugin-evalua": patch
---

Geometric figures are filled with soft tones again. Every figure picks one of five print-safe pastels
(`#FFDA64`, `#A3D084`, `#F4B281`, `#E3E3E3`, `#8FA9DA`) from its own spec, so a figure keeps its colour
across rebuilds and two different figures rarely match. The Venn circles keep their own tones with a
translucent overlap and the fraction bar keeps its white bar so its shading still carries the
fraction. Fixes two defects the fill exposed: a measured circle radius was read as pixels, so
`radius: 4` drew a dot, and the cone was not a closed silhouette, so its fill distorted the shape.

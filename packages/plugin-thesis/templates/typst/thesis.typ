// Thesis template (spec 10.3). `make` returns the functions main.typ uses; it never reads the
// workspace. Layout values come from a presentation profile (profiles/*.typ); text labels from the
// i18n strings. Generated main.typ calls: setup, cover, front, body-mode, annex-mode, t-figure,
// t-table and references.

#let font-stacks = (
  serif: ("Libertinus Serif", "New Computer Modern"),
  sans: ("Liberation Sans", "Arimo", "DejaVu Sans", "Libertinus Serif"),
  institutional: ("Libertinus Serif",),
)

#let make(meta, profile, strings) = {
  let paper = if meta.paper == "a4" { "a4" } else { "us-letter" }
  let size = profile.font-size
  let multiple = if meta.lineSpacing != none { meta.lineSpacing } else { profile.line-spacing }
  // Typst's default leading (0.65em) is single spacing; each extra line of spacing adds ~1.2em.
  let leading = 0.65em + (multiple - 1) * 1.2em
  let body-fonts = {
    let base = font-stacks.at(meta.fontProfile, default: font-stacks.serif)
    let named = if meta.bodyFont != none { meta.bodyFont } else { profile.font.body }
    if named != none { (named,) + base } else { base }
  }
  let lang = meta.languageCode
  let region = if "region" in meta { meta.region } else { none }
  let margins = profile.margins
  let heading-font = if profile.font.headings != none { (profile.font.headings,) + body-fonts } else { body-fonts }

  let page-footer(fmt) = context {
    if fmt == none { none } else {
      align(profile.page-numbers.position, counter(page).display(fmt))
    }
  }

  let page-header() = context {
    if profile.header == none { none } else {
      let here-page = here().page()
      let starts = query(heading.where(level: 1)).any(h => h.location().page() == here-page)
      let current = query(heading.where(level: 1).before(here()))
      if starts or current.len() == 0 { none } else {
        set text(size: 0.85 * size, style: "italic")
        align(right, current.last().body)
        v(-0.4em)
        line(length: 100%, stroke: 0.4pt)
      }
    }
  }

  // Float numbers are computed by the emitter and passed in as (chapter, index-in-chapter,
  // sequence): numbering functions that read counters would be evaluated at the reference site.
  let float-label(number) = {
    let (chapter, index, sequence) = number
    if profile.captions.per-chapter and chapter != none { [#chapter.#index] } else { [#sequence] }
  }
  let float-numbering(number) = _ => float-label(number)
  let num-eq(chapter, index, sequence) = _ => [(#float-label((chapter, index, sequence)))]

  // Heading numbers follow the pattern of each level (for example `1.1.1`).
  let heading-number(..nums) = {
    let level = calc.min(nums.pos().len(), 4)
    numbering(profile.headings.at(level - 1).numbering, ..nums)
  }

  let heading-style(it) = {
    let level = calc.min(it.level, 4)
    let spec = profile.headings.at(level - 1)
    let titled = if spec.case == "upper" { upper(it.body) } else if spec.case == "lower" { lower(it.body) } else { it.body }
    let number = if it.numbering != none { [#counter(heading).display(it.numbering)#h(0.6em)] }
    if spec.run-in {
      // Run-in heading: inline output joins the first line of the following paragraph.
      text(size: spec.size, weight: spec.weight, hyphenate: false, font: heading-font)[#number#titled#spec.ends-with#h(0.4em)]
    } else {
      if level == 1 and spec.new-page { pagebreak(weak: true) }
      block(width: 100%, above: spec.above, below: spec.below, sticky: true)[
        #set text(size: spec.size, weight: spec.weight, hyphenate: false, font: heading-font)
        #set align(spec.align)
        #set par(first-line-indent: 0pt, justify: false)
        #number#titled
      ]
    }
  }

  let setup(body) = {
    set document(title: meta.title, author: meta.authors)
    set text(lang: lang, region: region, font: body-fonts, size: size, hyphenate: true)
    set par(
      justify: profile.paragraph.justify,
      leading: leading,
      spacing: profile.paragraph.spacing,
      first-line-indent: profile.paragraph.indent,
    )
    set page(paper: paper, margin: margins)
    set heading(numbering: heading-number, supplement: strings.section)
    set math.equation(supplement: strings.equation)
    set figure.caption(separator: profile.captions.separator)
    show figure.where(kind: image): set figure(supplement: strings.figure)
    show figure.where(kind: table): set figure(supplement: strings.table)
    show figure.where(kind: table): set figure.caption(position: profile.captions.table)
    show figure.where(kind: image): set figure.caption(position: profile.captions.figure)
    show figure.caption: it => {
      set par(justify: false, first-line-indent: 0pt)
      set text(size: size * 0.9)
      if profile.captions.label-style == "plain" { it } else {
        let label = [#it.supplement#sym.space.nobreak#context it.counter.display(it.numbering)#it.separator]
        if profile.captions.label-style == "bold" { strong(label) } else { emph(label) }
        it.body
      }
    }
    show footnote.entry: set text(size: profile.footnote-size * 1pt)
    show raw: it => if profile.font.mono != none {
      set text(font: (profile.font.mono, "DejaVu Sans Mono", "Liberation Mono"))
      it
    } else { it }
    show figure: set block(breakable: false)
    show heading: heading-style
    show raw.where(block: true): it => block(fill: luma(245), inset: 8pt, radius: 2pt, width: 100%, it)
    show link: set text(fill: rgb("#0b4f8a"))
    show quote.where(block: true): set pad(left: 1cm)
    show table: set text(size: size * 0.9)
    show table: set par(justify: false, first-line-indent: 0pt)
    set table(
      stroke: (x, y) => (
        top: if y == 0 { 0.8pt } else if y == 1 { 0.5pt } else { 0pt },
        bottom: 0.8pt,
      ),
      inset: (x: 6pt, y: 4pt),
    )
    body
  }

  // Source line next to a figure or table, below it or inside the caption (profile choice).
  let with-source(content, source) = if source == none { content } else {
    set text(size: size * 0.9)
    set par(first-line-indent: 0pt, justify: false)
    align(left, source)
  }

  // The source line either sits below the float (inside its body) or closes the caption. In the
  // second case it is marked <float-source> so the lists of figures and tables can leave it out.
  let float(body, caption, source, number, kind) = {
    let numbering = float-numbering(number)
    if source != none and profile.captions.source-below {
      figure(stack(spacing: 0.8em, body, with-source(none, source)), caption: caption, kind: kind, numbering: numbering)
    } else if source != none {
      figure(body, caption: [#caption #box(source) <float-source>], kind: kind, numbering: numbering)
    } else {
      figure(body, caption: caption, kind: kind, numbering: numbering)
    }
  }
  let t-figure(body, caption: none, source: none, number: (none, 1, 1)) = float(body, caption, source, number, image)
  let t-table(body, caption: none, source: none, number: (none, 1, 1)) = float(body, caption, source, number, table)

  // A vector image at its natural size, shrunk to the text block when it would overflow.
  let t-image(path, natural) = layout(size => align(center, image("/" + path, width: calc.min(size.width, natural))))

  let cover() = {
    let org = meta.institution
    let place = if profile.cover.layout == "left" { left } else { center }
    let cline(content, ..args) = if content != none and content != "" {
      align(place, text(..args, content))
      v(0.6em)
    }
    // Fields in the same group stay together; the gaps between groups stretch.
    let groups = (institution: 0, faculty: 0, program: 0, title: 1, subtitle: 1, workType: 2, authors: 2, advisors: 2, cityYear: 3)
    let gaps = (2fr, 1.5fr, 2fr)
    let field(name) = {
      if name == "institution" { cline(org.name, size: 1.15 * size, weight: "bold") }
      else if name == "faculty" { cline(org.faculty, size: size) }
      else if name == "program" { cline(org.program, size: size) }
      else if name == "title" { align(place, text(size: 1.7 * size, weight: "bold", meta.title)) }
      else if name == "subtitle" { if meta.subtitle != none { v(0.8em); cline(meta.subtitle, size: 1.2 * size) } }
      else if name == "workType" { cline(strings.at("work_" + meta.workType, default: meta.workType), size: size) }
      else if name == "authors" { for author in meta.authors { cline(author, size: 1.1 * size, weight: "bold") } }
      else if name == "advisors" { for advisor in meta.advisors { cline([#strings.advisor: #advisor.name], size: size) } }
      else if name == "cityYear" { cline(if org.city != none { [#org.city, #meta.year] } else { str(meta.year) }, size: size) }
    }
    page(numbering: none, margin: margins, header: none, footer: none)[
      #set par(first-line-indent: 0pt, justify: false, leading: 0.65em)
      #set text(hyphenate: false)
      #v(1fr)
      #{
        let previous = none
        for name in profile.cover.fields {
          let group = groups.at(name)
          if previous != none and group != previous { v(gaps.at(calc.min(previous, 2))) }
          previous = group
          field(name)
        }
      }
    ]
  }

  let unnumbered(title, body, outlined: true) = {
    heading(level: 1, numbering: none, outlined: outlined, title)
    body
  }

  let list-of(title, kind) = context {
    if query(figure.where(kind: kind)).len() > 0 {
      pagebreak(weak: true)
      heading(level: 1, numbering: none, outlined: false, title)
      {
        show <float-source>: none
        outline(title: none, target: figure.where(kind: kind))
      }
    }
  }

  let front(dedication: none, acknowledgments: none, ai-declaration: none, abstracts: ()) = {
    let fmt = profile.page-numbers.front
    set page(numbering: fmt, footer: page-footer(fmt), header: none)
    if profile.page-numbers.restart-front { counter(page).update(1) }
    set par(first-line-indent: 0pt)
    let parts = (
      dedication: () => if dedication != none { unnumbered(strings.dedication, dedication, outlined: false) },
      acknowledgments: () => if acknowledgments != none { unnumbered(strings.acknowledgments, acknowledgments) },
      ai-declaration: () => if ai-declaration != none { unnumbered(strings.ai_declaration, ai-declaration) },
      abstract: () => for a in abstracts {
        set text(lang: a.lang)
        unnumbered(a.title, {
          a.body
          if a.keywords.len() > 0 [
            #v(0.6em)
            #strong[#a.keywords-label:] #a.keywords.join(", ")
          ]
        })
      },
      toc: () => {
        heading(level: 1, numbering: none, outlined: false, strings.contents)
        if profile.toc-page-label { align(right, strong(strings.page_abbr)) }
        outline(title: none, depth: profile.toc-depth)
        pagebreak(weak: true)
        list-of(strings.list_of_figures, image)
        list-of(strings.list_of_tables, table)
      },
    )
    for name in profile.front-order {
      (parts.at(name))()
    }
  }

  let body-mode(body) = {
    let fmt = profile.page-numbers.body
    set page(numbering: fmt, footer: page-footer(fmt), header: page-header())
    if profile.page-numbers.restart-body { counter(page).update(1) }
    set par(first-line-indent: profile.paragraph.indent)
    body
  }

  let annex-mode(body) = {
    set heading(numbering: profile.annex-numbering, supplement: strings.annex)
    pagebreak(weak: true)
    counter(heading).update(0)
    body
  }

  let references(style) = {
    pagebreak(weak: true)
    set par(first-line-indent: 0pt, justify: false)
    set heading(numbering: none)
    show bibliography: set par(spacing: 1.2em)
    bibliography("/references.bib", style: style, title: strings.references)
  }

  (
    setup: setup,
    cover: cover,
    front: front,
    body-mode: body-mode,
    annex-mode: annex-mode,
    t-figure: t-figure,
    t-table: t-table,
    t-image: t-image,
    num-eq: num-eq,
    references: references,
  )
}

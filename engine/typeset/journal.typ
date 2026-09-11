// DocFlow journal layout for translated MinerU articles.
// The generated main file defines `doc-title`, `doc-date` and `doc-abstract`
// before this preamble and appends the article body after it.

#import "@preview/mitex:0.2.7": mi, mimath

#let cjk-serif = (
  "Source Han Serif", "Source Han Serif SC", "Noto Serif CJK SC", "Songti SC",
  "STSong", "SimSun", "Source Han Sans", "Noto Sans CJK SC", "PingFang SC",
  "Microsoft YaHei",
)
#let cjk-sans = (
  "Source Han Sans", "Source Han Sans SC", "Noto Sans CJK SC", "PingFang SC",
  "Microsoft YaHei", "Heiti SC", "SimHei", "Source Han Serif",
)
#let body-font = ((name: "Libertinus Serif", covers: "latin-in-cjk"), ..cjk-serif)
#let muted = luma(38%)

#set document(title: doc-title)
#set page(
  paper: "a4",
  margin: (top: 25mm, bottom: 22mm, x: 20mm),
  header: context {
    if counter(page).get().first() > 1 {
      set text(font: cjk-sans, size: 7pt, fill: muted)
      set par(first-line-indent: 0em, justify: false)
      block(width: 100%, inset: (bottom: 2mm), stroke: (bottom: 0.4pt + luma(65%)))[
        #box(width: 100%, clip: true, height: 1.2em, doc-title)
      ]
    }
  },
  footer: context {
    set align(center)
    set text(font: body-font, size: 7.5pt, fill: muted)
    counter(page).display("1 / 1", both: true)
  },
)
#set text(font: body-font, size: 10.5pt, lang: "zh", region: "cn")
#set par(justify: true, leading: 0.82em, spacing: 0.95em, first-line-indent: 2em)
#set list(indent: 0.6em, body-indent: 0.5em)
#set enum(indent: 0.6em, body-indent: 0.5em)

#show heading: it => block(above: 1em, below: 0.5em, sticky: true, text(size: 10.5pt, weight: "bold", it.body))
#show heading.where(level: 3): it => block(above: 1.1em, below: 0.6em, sticky: true, text(size: 11.5pt, weight: "bold", it.body))
#show heading.where(level: 2): it => block(above: 1.3em, below: 0.7em, sticky: true, text(size: 13pt, weight: "bold", it.body))
#show heading.where(level: 1): it => block(
  width: 100%, above: 1.5em, below: 0.8em, sticky: true,
  inset: (bottom: 0.3em), stroke: (bottom: 0.6pt + luma(40%)),
  text(size: 15pt, weight: "bold", it.body),
)
#show raw: set text(font: ("DejaVu Sans Mono", ..cjk-sans), size: 0.86em)
#show raw.where(block: false): box.with(fill: luma(94%), inset: (x: 2pt), outset: (y: 2pt), radius: 1.5pt)
#show raw.where(block: true): it => block(
  width: 100%, fill: luma(97%), stroke: 0.4pt + luma(75%), inset: 8pt, radius: 2pt,
  { set par(justify: false, first-line-indent: 0em); text(size: 8.2pt, it) },
)
#show link: it => underline(offset: 1.5pt, stroke: 0.45pt, it)
#show math.equation: set text(font: ("New Computer Modern Math", ..cjk-serif))
#show math.equation.where(block: true): set block(above: 0.9em, below: 0.9em)
#show table: set text(size: 8.75pt)
#show table: set par(justify: false, first-line-indent: 0em, leading: 0.6em)
#show footnote.entry: set text(size: 8pt)

// Formula wrappers carry an index so a formula that MiTeX cannot convert can
// be located in the diagnostics and replaced by its LaTeX source.
#let dm(index, source) = mi(source)
#let dmb(index, source) = mimath(source)
#let dmraw(source) = raw(source)
#let dmrawb(source) = align(center, raw(block: false, source))

#let docquote(body) = block(
  width: 100%, inset: (left: 10pt, y: 5pt), stroke: (left: 1.5pt + luma(55%)), fill: luma(97%),
  { set text(fill: luma(25%)); set par(first-line-indent: 0em); body },
)
#let docimage(path, width) = align(center, block(above: 1.1em, below: 1.1em, breakable: false, image(path, width: width)))
#let docrule() = line(length: 100%, stroke: 0.4pt + luma(55%))
#let doccaption(body) = align(center, block(above: 0.4em, below: 0.9em, { set par(first-line-indent: 0em); text(size: 8.5pt, fill: luma(30%), body) }))
#let doctable(header-rows, ..args) = align(center, block(above: 1em, below: 1.2em, table(
  stroke: (x, y) => (
    top: if y == 0 { 0.8pt + luma(20%) } else if y == header-rows and header-rows > 0 { 0.5pt + luma(35%) } else { 0.3pt + luma(80%) },
  ),
  fill: (x, y) => if y < header-rows { luma(95%) },
  inset: (x: 0.45em, y: 0.38em),
  ..args,
  table.hline(stroke: 0.8pt + luma(20%)),
)))

// Title block
#align(center)[
  #set par(first-line-indent: 0em, justify: false)
  #text(font: cjk-sans, size: 7.5pt, weight: "bold", tracking: 0.16em, fill: muted)[DOCFLOW ACADEMIC EDITION]
  #v(2.5mm)
  #block(width: 88%, text(size: 19pt, weight: "bold", doc-title))
  #v(1.5mm)
  #text(font: cjk-sans, size: 8pt, tracking: 0.05em, fill: muted)[生成日期 #doc-date · A4 学术排版]
]
#v(3mm)
#line(length: 100%, stroke: 0.45pt + luma(60%))
#if doc-abstract != none {
  block(
    width: 100%, above: 5mm, below: 7mm, inset: (x: 5.5mm, y: 4.5mm), fill: luma(98%),
    stroke: (top: 0.6pt + luma(20%), bottom: 0.6pt + luma(20%)),
    {
      set par(first-line-indent: 0em, leading: 0.75em)
      set text(size: 9.25pt)
      text(weight: "bold")[摘要]
      h(0.75em)
      doc-abstract
    },
  )
} else {
  v(4mm)
}

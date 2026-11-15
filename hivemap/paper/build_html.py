#!/usr/bin/env python3
"""Build index.html (a Barron-style paper page) from hivemap.tex + refs.bib.

Handles only the LaTeX subset used in hivemap.tex: sections, subsections,
paragraph leads, itemize/enumerate, figure/figure*, table/table* (tables are
included from tables/<name>.html), \\cite (author-year), \\ref, \\emph,
\\textbf, \\texttt, \\url, \\cond and inline math (rendered by KaTeX).

    python3 build_html.py
"""
import html
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = 'https://itzsid.github.io'
PAGE_URL = f'{SITE}/hivemap/paper/'
DEMO_URL = '../'
CODE_URL = 'https://github.com/itzsid/itzsid.github.io/tree/master/hivemap'
PDF_URL = 'hivemap.pdf'

# --------------------------------------------------------------- bibliography
ACCENTS = {"'": '\u0301', '"': '\u0308', '`': '\u0300', '^': '\u0302', '~': '\u0303', 'c': '\u0327', 'v': '\u030c', 'H': '\u030b'}


def detex_accents(s):
    import unicodedata

    def rep(m):
        acc, ch = m.group(1), m.group(2)
        return unicodedata.normalize('NFC', ch + ACCENTS[acc])
    s = re.sub(r"\{\\([\"'`^~])\{?([A-Za-z])\}?\}", rep, s)
    s = re.sub(r"\{\\([cvH])\{([A-Za-z])\}\}", rep, s)
    s = re.sub(r"\\([\"'`^~])\{?([A-Za-z])\}?", rep, s)
    s = s.replace('{\\i}', 'i').replace('\\i ', 'i')
    return s


def parse_bib(path):
    src = open(path, encoding='utf8').read()
    entries = {}
    i = 0
    while True:
        m = re.compile(r'@(\w+)\s*\{\s*([^,\s]+)\s*,').search(src, i)
        if not m:
            break
        kind, key = m.group(1).lower(), m.group(2)
        depth, j = 1, m.end()
        while depth and j < len(src):
            if src[j] == '{':
                depth += 1
            elif src[j] == '}':
                depth -= 1
            j += 1
        body = src[m.end():j - 1]
        fields = {}
        k = 0
        while True:
            fm = re.compile(r'\s*(\w+)\s*=\s*').match(body, k)
            if not fm:
                break
            name, k = fm.group(1).lower(), fm.end()
            if body[k] == '{':
                depth, s0 = 1, k + 1
                k += 1
                while depth:
                    if body[k] == '{':
                        depth += 1
                    elif body[k] == '}':
                        depth -= 1
                    k += 1
                val = body[s0:k - 1]
            elif body[k] == '"':
                e = body.index('"', k + 1)
                val, k = body[k + 1:e], e + 1
            else:
                e = re.compile(r'[,\n]').search(body, k)
                val, k = body[k:e.start()].strip(), e.start()
            fields[name] = re.sub(r'\s+', ' ', detex_accents(val)).strip()
            cm = re.compile(r'\s*,').match(body, k)
            if cm:
                k = cm.end()
        fields['_kind'] = kind
        entries[key] = fields
        i = j
    return entries


def strip_braces(s):
    return s.replace('{', '').replace('}', '').replace('--', '–').replace('\\&', '&')


def authors_of(e):
    out = []
    for a in re.split(r'\s+and\s+', e.get('author', '')):
        a = strip_braces(a).strip()
        if not a:
            continue
        if a == 'others':
            out.append(('others', 'others'))
            continue
        if ',' in a:
            last, first = [x.strip() for x in a.split(',', 1)]
        else:
            parts = a.split()
            last, first = parts[-1], ' '.join(parts[:-1])
        out.append((first, last))
    return out


def venue_of(e):
    v = e.get('booktitle') or e.get('journal') or ''
    v = strip_braces(v)
    m = re.search(r'\(([A-Z][A-Za-z0-9\-/ ]+)\)\s*$', v)
    if m:
        v = m.group(1)
    if not v and e.get('eprint'):
        v = f"arXiv:{e['eprint']}"
    if not v and 'arxiv' in (e.get('howpublished', '') + e.get('note', '')).lower():
        v = 'arXiv preprint'
    return v


def tag_of(e):
    au = authors_of(e)
    y = e.get('year', '')
    if not au:
        return f'{y}'
    if len(au) == 1:
        return f'{au[0][1]}, {y}'
    if len(au) == 2 and au[1][1] != 'others':
        return f'{au[0][1]} & {au[1][1]}, {y}'
    return f'{au[0][1]} et al., {y}'


# --------------------------------------------------------------- tex -> html
def esc(s):
    return html.escape(s, quote=False)


class Ctx:
    def __init__(self, bib):
        self.bib = bib
        self.cited = []
        self.labels = {}       # label -> (kind, number)
        self.toc = []
        self.teaser = ''


def find_group(s, i):
    """s[i] == '{' -> (content, index after closing brace)."""
    assert s[i] == '{', s[i:i + 30]
    depth, j = 1, i + 1
    while depth:
        if s[j] == '{' and s[j - 1] != '\\':
            depth += 1
        elif s[j] == '}' and s[j - 1] != '\\':
            depth -= 1
        j += 1
    return s[i + 1:j - 1], j


def inline(s, ctx):
    """Convert inline LaTeX to HTML. Math ($...$) is passed through for KaTeX."""
    out, i = [], 0
    while i < len(s):
        c = s[i]
        if c == '$':
            j = s.index('$', i + 1)
            out.append('<span class="math">$' + esc(s[i + 1:j]) + '$</span>')
            i = j + 1
            continue
        if c == '\\':
            m = re.compile(r'\\([A-Za-z]+)\*?').match(s, i)
            if not m:   # \, \% \& \{ etc.
                nxt = s[i + 1]
                out.append({',': '\u2009', '%': '%', '&': '&amp;', '{': '{', '}': '}', '_': '_', ' ': ' ', '\\': '<br>', '#': '#'}.get(nxt, nxt))
                i += 2
                continue
            cmd, j = m.group(1), m.end()
            opt = None
            if j < len(s) and s[j] == '[':
                k = s.index(']', j)
                opt, j = s[j + 1:k], k + 1
            if cmd in ('emph', 'textit'):
                g, j = find_group(s, j)
                out.append('<em>' + inline(g, ctx) + '</em>')
            elif cmd == 'textbf':
                g, j = find_group(s, j)
                out.append('<strong>' + inline(g, ctx) + '</strong>')
            elif cmd == 'texttt':
                g, j = find_group(s, j)
                out.append('<code>' + inline(g, ctx) + '</code>')
            elif cmd == 'textsc' or cmd == 'cond':
                g, j = find_group(s, j)
                out.append('<span class="cond">' + inline(g, ctx) + '</span>')
            elif cmd == 'url':
                g, j = find_group(s, j)
                out.append(f'<a href="{esc(g)}">{esc(g.replace("https://", ""))}</a>')
            elif cmd == 'href':
                u, j = find_group(s, j)
                g, j = find_group(s, j)
                out.append(f'<a href="{esc(u)}">{inline(g, ctx)}</a>')
            elif cmd == 'cite':
                g, j = find_group(s, j)
                keys = [k.strip() for k in g.split(',')]
                parts = []
                for k in keys:
                    if k not in ctx.bib:
                        raise SystemExit(f'unknown cite key {k}')
                    if k not in ctx.cited:
                        ctx.cited.append(k)
                    parts.append(f'<a href="#bib-{k}" class="cite-link" data-bib="{k}">{esc(ctx.bib[k]["_tag"])}</a>')
                # drop a preceding non-breaking space: "(Author, 2017)" reads better after a word
                if out and out[-1] == '&nbsp;':
                    out[-1] = ' '
                out.append('(' + '; '.join(parts) + ')')
            elif cmd in ('ref', 'eqref'):
                g, j = find_group(s, j)
                kind, num = ctx.labels.get(g, ('?', '??'))
                out.append(f'<a href="#{g}" class="xref">{num}</a>')
            elif cmd == 'label':
                g, j = find_group(s, j)
            elif cmd in ('footnote',):
                g, j = find_group(s, j)
                out.append(f' ({inline(g, ctx)})')
            elif cmd == 'ldots':
                out.append('…')
            elif cmd == 'times':
                out.append('×')
            else:
                raise SystemExit(f'unhandled command \\{cmd} near: {s[i:i + 60]!r}')
            i = j
            continue
        if s.startswith('---', i):
            out.append('—'); i += 3; continue
        if s.startswith('--', i):
            out.append('–'); i += 2; continue
        if s.startswith('``', i):
            out.append('“'); i += 2; continue
        if s.startswith("''", i):
            out.append('”'); i += 2; continue
        if c == '`':
            out.append('‘'); i += 1; continue
        if c == "'":
            out.append('’'); i += 1; continue
        if c == '~':
            out.append('&nbsp;'); i += 1; continue
        if c in '{}':
            i += 1; continue
        out.append(esc(c))
        i += 1
    return ''.join(out)


def strip_comments(s):
    return '\n'.join(re.sub(r'(?<!\\)%.*$', '', line) if not line.lstrip().startswith('%') else '' for line in s.split('\n'))


def env_body(s, name, start):
    """Return (opt/arg string, body, end index) of \\begin{name} at start."""
    b = f'\\begin{{{name}}}'
    e = f'\\end{{{name}}}'
    j = s.index(e, start)
    return s[start + len(b):j], j + len(e)


def img_src(name):
    base, ext = os.path.splitext(name)
    if ext in ('.pdf', '.svg', ''):
        return base + '.png', base + ('.svg' if os.path.exists(os.path.join(HERE, 'figs', base + '.svg')) else '.png')
    if os.path.exists(os.path.join(HERE, 'figs', base + '_web' + ext)):
        return base + '_web' + ext, name
    return name, name


def figure_html(body, ctx, kind):
    cap = ''
    m = re.search(r'\\caption\{', body)
    if m:
        cap, _ = find_group(body, m.end() - 1)
    lab = re.search(r'\\label\{([^}]+)\}', body)
    lab = lab.group(1) if lab else ''
    num = ctx.labels.get(lab, (kind, ''))[1]
    inner = []
    for gm in re.finditer(r'\\includegraphics(\[[^\]]*\])?\{([^}]+)\}', body):
        show, full = img_src(gm.group(2))
        inner.append(f'<a href="figs/{full}" class="fig-zoom"><img src="figs/{show}" alt="{esc(re.sub(r"[^A-Za-z0-9 ,.:-]", "", cap)[:120])}" loading="lazy" class="fig-img"></a>')
    for tm in re.finditer(r'\\input\{tables/([^}]+?)(\.tex)?\}', body):
        inner.append(open(os.path.join(HERE, 'tables', tm.group(1) + '.html'), encoding='utf8').read())
    label = 'Figure' if kind == 'fig' else 'Table'
    capd = f'<figcaption><span class="fig-label">{label} {num}.</span> {inline(cap, ctx)}</figcaption>'
    cls = 'paper-figure' if kind == 'fig' else 'table-card'
    if kind == 'tab':
        return f'<figure class="{cls}" id="{lab}">{capd}<div class="table-scroll">{"".join(inner)}</div></figure>'
    return f'<figure class="{cls}" id="{lab}">{"".join(inner)}{capd}</figure>'


def list_html(body, ctx, ordered):
    items = re.split(r'\\item\s*', body)[1:]
    tag = 'ol' if ordered else 'ul'
    return f'<{tag} class="paper-list">' + ''.join(f'<li>{inline(it.strip(), ctx)}</li>' for it in items) + f'</{tag}>'


def number_labels(body, ctx):
    sec = sub = fig = tab = 0
    for m in re.finditer(r'\\(section|subsection)\*?\{|\\begin\{(figure\*?|table\*?)\}|\\label\{([^}]+)\}', body):
        if m.group(1) == 'section':
            sec += 1; sub = 0; cur = ('sec', str(sec))
        elif m.group(1) == 'subsection':
            sub += 1; cur = ('sec', f'{sec}.{sub}')
        elif m.group(2):
            if m.group(2).startswith('figure'):
                fig += 1; cur = ('fig', str(fig))
            else:
                tab += 1; cur = ('tab', str(tab))
        elif m.group(3):
            ctx.labels[m.group(3)] = cur


def convert_body(body, ctx):
    number_labels(body, ctx)
    out = []
    sec = sub = 0
    i = 0
    para = []

    def flush():
        txt = ' '.join(x.strip() for x in para).strip()
        para.clear()
        if txt:
            out.append('<p>' + inline(txt, ctx) + '</p>')

    lines = body.split('\n')
    k = 0
    while k < len(lines):
        line = lines[k]
        st = line.strip()
        if not st:
            flush(); k += 1; continue
        m = re.match(r'\\(section|subsection)\*?\{', st)
        if m:
            flush()
            raw, e = find_group(st, m.end() - 1)
            lm = re.match(r'\s*\\label\{([^}]+)\}', st[e:])
            title = inline(raw, ctx)
            lab = lm.group(1) if lm else re.sub(r'[^a-z0-9]+', '-', raw.lower()).strip('-')
            if m.group(1) == 'section':
                sec += 1; sub = 0
                out.append(f'<h2 id="{lab}" class="section-heading"><span class="sec-num">{sec}.</span> {title}<a class="heading-anchor" href="#{lab}" title="Permalink">#</a></h2>')
                ctx.toc.append((lab, f'{sec}. {re.sub("<[^>]+>", "", title)}'))
            else:
                sub += 1
                out.append(f'<h3 id="{lab}" class="subsec-heading"><span class="sec-num">{sec}.{sub}</span> {title}<a class="heading-anchor" href="#{lab}" title="Permalink">#</a></h3>')
            k += 1
            continue
        m = re.match(r'\\begin\{(figure\*?|table\*?|itemize|enumerate)\}', st)
        if m:
            flush()
            name = m.group(1)
            depth, buf = 0, []
            while True:
                l2 = lines[k]
                depth += l2.count(f'\\begin{{{name}}}') - l2.count(f'\\end{{{name}}}')
                buf.append(l2)
                k += 1
                if depth == 0:
                    break
            blk = '\n'.join(buf)
            inner = blk[blk.index('}') + 1:blk.rindex('\\end')]
            if name.startswith('figure'):
                fh = figure_html(inner, ctx, 'fig')
                if 'fig:teaser' in inner:
                    ctx.teaser = fh.replace('class="paper-figure"', 'class="paper-figure teaser"', 1)
                else:
                    out.append(fh)
            elif name.startswith('table'):
                out.append(figure_html(inner, ctx, 'tab'))
            else:
                out.append(list_html(inner, ctx, name == 'enumerate'))
            continue
        para.append(line)
        k += 1
    flush()
    return '\n'.join(out)


def bib_html(ctx):
    items = []
    keys = sorted(ctx.cited, key=lambda k: (authors_of(ctx.bib[k])[0][1].lower() if authors_of(ctx.bib[k]) else k, ctx.bib[k].get('year', '')))
    for k in keys:
        e = ctx.bib[k]
        au = authors_of(e)
        names = [f'{f} {l}'.strip() if l != 'others' else 'et al.' for f, l in au]
        if names and names[-1] == 'et al.':
            astr = ', '.join(names[:-1]) + ', et al.'
        elif len(names) > 2:
            astr = ', '.join(names[:-1]) + ', and ' + names[-1]
        else:
            astr = ' and '.join(names)
        title = strip_braces(e.get('title', ''))
        url = ''
        if e.get('doi'):
            url = f"https://doi.org/{e['doi']}"
        elif e.get('eprint'):
            url = f"https://arxiv.org/abs/{e['eprint']}"
        elif e.get('url'):
            url = e['url']
        ttl = f'<a href="{esc(url)}" target="_blank" rel="noopener">{esc(title)}</a>' if url else esc(title)
        ven = venue_of(e)
        items.append(f'<li id="bib-{k}" class="bib-item"><span class="bib-tag">[{esc(e["_tag"])}]</span> <span class="bib-authors">{esc(astr)}.</span> <span class="bib-title">{ttl}.</span> <span class="bib-venue"><em>{esc(ven)}</em>, {esc(e.get("year", ""))}.</span></li>')
    return '<ol class="bib-list">' + ''.join(items) + '</ol>'


BIBTEX = """@misc{choudhary2026talkormap,
  title  = {Talk or Map? What Should Robot Teams Share?},
  author = {Choudhary, Siddharth},
  year   = {2026},
  note   = {Preprint},
  url    = {https://itzsid.github.io/hivemap/paper/}
}"""


def main():
    tex = open(os.path.join(HERE, 'hivemap.tex'), encoding='utf8').read()
    tex = strip_comments(tex)
    bib = parse_bib(os.path.join(HERE, 'refs.bib'))
    # author-year tags, with a/b suffixes for clashes
    tags = {}
    for k, e in bib.items():
        e['_tag'] = tag_of(e)
        tags.setdefault(e['_tag'], []).append(k)
    for t, ks in tags.items():
        if len(ks) > 1:
            for n, k in enumerate(sorted(ks)):
                bib[k]['_tag'] = re.sub(r'(\d{4})$', lambda m: m.group(1) + 'abcdefgh'[n], t)
    ctx = Ctx(bib)
    title = re.search(r'\\title\{(.*?)\}', tex).group(1)
    abstract = tex[tex.index('\\begin{abstract}') + 16:tex.index('\\end{abstract}')]
    body = tex[tex.index('\\end{abstract}'):]
    body = body[body.index('\n'):body.index('\\bibliographystyle')]
    body = body.replace('\\maketitle', '')
    body_html = convert_body(body, ctx)
    abstract_html = inline(' '.join(abstract.split()), ctx)
    desc = re.sub(r'<[^>]+>', '', abstract_html)
    desc = html.unescape(desc)
    short = 'Should a team of robots with language-model agents talk to each other or share a map? A controlled comparison in Hivemap, a browser-based multi-robot testbed.'
    toc = ''.join(f'<li><a href="#{a}">{esc(t)}</a></li>' for a, t in ctx.toc) + '<li><a href="#references">References</a></li><li><a href="#bibtex">BibTeX</a></li>'
    page = TEMPLATE.format(
        title=esc(title), title_html=inline(title, ctx).replace('?', '?'), short=esc(short), page_url=PAGE_URL,
        toc=toc, abstract=abstract_html, body=body_html, teaser=ctx.teaser, refs=bib_html(ctx), bibtex=esc(BIBTEX), bibtex_attr=html.escape(BIBTEX, quote=True),
        demo=DEMO_URL, code=CODE_URL, pdf=PDF_URL)
    open(os.path.join(HERE, 'index.html'), 'w', encoding='utf8').write(page)
    print(f'index.html: {len(page) // 1024} KB, {len(ctx.cited)} references, {len(ctx.toc)} sections')


TEMPLATE = r"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{title}</title>
  <meta name="author" content="Siddharth Choudhary">
  <meta name="description" content="{short}">
  <link rel="canonical" href="{page_url}">
  <meta property="og:title" content="{title}">
  <meta property="og:description" content="{short}">
  <meta property="og:type" content="article">
  <meta property="og:url" content="{page_url}">
  <meta property="og:image" content="{page_url}figs/teaser_web.jpg">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="{title}">
  <meta name="twitter:description" content="{short}">
  <meta name="twitter:image" content="{page_url}figs/teaser_web.jpg">
  <meta name="citation_title" content="{title}">
  <meta name="citation_author" content="Choudhary, Siddharth">
  <meta name="citation_publication_date" content="2026/11/15">
  <meta name="citation_pdf_url" content="{page_url}hivemap.pdf">
  <link rel="icon" href="../../images/favicon.svg" type="image/svg+xml">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Lato:ital,wght@0,400;0,700;1,400&family=JetBrains+Mono:wght@400&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css" crossorigin="anonymous">
  <link rel="stylesheet" href="paper.css">
</head>
<body>
  <div class="page-layout">
    <aside class="toc-sidebar">
      <div class="toc-header">Contents</div>
      <ul class="toc-list" id="toc-list">{toc}</ul>
    </aside>

    <main class="paper-main">
      <nav class="paper-nav">
        <a href="../../">← itzsid.github.io</a>
        <div class="paper-nav-links">
          <a href="{pdf}">pdf</a> /
          <a href="{demo}">live demo</a> /
          <a href="{code}">code</a> /
          <a href="#bibtex" id="copy-bibtex-btn" data-bibtex="{bibtex_attr}">copy bibtex</a>
        </div>
      </nav>

      <header class="paper-header">
        <h1 class="paper-title">{title_html}</h1>
        <div class="paper-authors"><a href="../../">Siddharth Choudhary</a></div>
        <div class="paper-venue">Preprint · November 2026</div>
      </header>

      {teaser}

      <section class="abstract-box" id="abstract">
        <div class="abstract-title">Abstract</div>
        <p>{abstract}</p>
      </section>

{body}

      <h2 id="references" class="section-heading">References<a class="heading-anchor" href="#references" title="Permalink">#</a></h2>
      {refs}

      <h2 id="bibtex" class="section-heading">BibTeX<a class="heading-anchor" href="#bibtex" title="Permalink">#</a></h2>
      <pre class="bibtex-block">{bibtex}</pre>

      <footer class="paper-footer">Page layout after <a href="https://jonbarron.info/">Jon Barron</a>'s <a href="https://github.com/jonbarron/jonbarron.github.io/tree/master/tex_to_html">tex_to_html</a>. Built from the paper's LaTeX source.</footer>
    </main>

    <div class="layout-spacer" aria-hidden="true"></div>
  </div>

  <div id="hover-popover" role="tooltip"></div>
  <div id="lightbox" hidden><img alt=""></div>

  <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js" crossorigin="anonymous"></script>
  <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.min.js" crossorigin="anonymous"></script>
  <script defer src="paper.js"></script>
</body>
</html>
"""

if __name__ == '__main__':
    main()

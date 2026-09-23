#!/usr/bin/env python3
"""Render demo/council-demo.gif, a sped-up replay of a real council run.

What is real: the question is the run's own, verbatim; the stages, models, agent count and duration
come from demo/run-facts.json (copied from the run's record); every report line is quoted verbatim
from council-workspace/sample-report-gil.md, with "…" marking every cut. What is staged: the run was
started through the workflow's arguments, so the "/council " prefix and the typing are shown for
illustration, and the pacing is synthetic. The GIF says it is a replay in its title bar. Glyphs the
font lacks (✅ ❌) are drawn as coloured ✓ ✗, and the premises table is laid out as rows.

    python3 demo/make_demo.py        # needs Pillow; uses JetBrains Mono if installed, else Menlo
"""
import glob
import json
import os
import re

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
FACTS = json.load(open(os.path.join(HERE, 'run-facts.json')))
REPORT = open(os.path.join(ROOT, 'council-workspace', 'sample-report-gil.md')).read().splitlines()
OUT = os.path.join(HERE, 'council-demo.gif')

W, H, SIZE, LINE_H, PAD_X, TOP = 960, 600, 16, 23, 22, 48
BG, BAR, FG, DIM, TITLE = (22, 24, 33), (38, 41, 54), (222, 225, 230), (132, 138, 154), (170, 176, 190)
GREEN, RED, AMBER, CYAN, PURPLE = (126, 231, 135), (255, 123, 114), (227, 179, 65), (121, 192, 255), (210, 168, 255)
WPS = 4.5          # skim speed the holds are sized for, in words per second (capped, since the GIF loops)


def font(pattern, fallback):
    hits = sorted(glob.glob(os.path.expanduser(f'~/Library/Fonts/{pattern}')))
    return ImageFont.truetype(hits[0] if hits else fallback, SIZE)


REG = font('JetBrainsMonoNerdFontMono-Regular.ttf', '/System/Library/Fonts/Menlo.ttc')
BOLD = font('JetBrainsMonoNerdFontMono-Bold.ttf', '/System/Library/Fonts/Menlo.ttc')
MENLO = ImageFont.truetype('/System/Library/Fonts/Menlo.ttc', SIZE)
SMALL = font('JetBrainsMonoNerdFontMono-Regular.ttf', '/System/Library/Fonts/Menlo.ttc').font_variant(size=13)
CW = REG.getlength('M')
COLS = int((W - 2 * PAD_X) // CW)
VIEW = (H - TOP - 14) // LINE_H
_NOTDEF, _has = {}, {}


def has_glyph(f, ch):
    key = (id(f), ch)
    if key not in _has:
        if id(f) not in _NOTDEF:
            _NOTDEF[id(f)] = bytes(f.getmask('\U0010FFFD'))
        _has[key] = ch == ' ' or bytes(f.getmask(ch)) != _NOTDEF[id(f)]
    return _has[key]


# ---------------------------------------------------------------- styled text
# A line is a list of (text, colour, bold) segments.
def inline(text, colour=FG):
    """**bold** and `code` spans; emoji the font lacks become coloured marks."""
    text = text.replace('✅', '✓').replace('❌', '✗')
    segs, pos = [], 0
    for m in re.finditer(r'\*\*(.+?)\*\*|`(.+?)`', text):
        if m.start() > pos:
            segs.append((text[pos:m.start()], colour, False))
        segs.append((m.group(1), colour, True) if m.group(1) else (m.group(2), CYAN, False))
        pos = m.end()
    if pos < len(text):
        segs.append((text[pos:], colour, False))
    return segs


def wrap(segs, indent=0, width=COLS):
    """Word-wrap styled segments to `width` columns, continuation lines indented."""
    words = []
    for text, col, bold in segs:
        for tok in re.split(r'(\s+)', text):
            if tok:
                words.append((tok, col, bold))
    lines, cur, n = [], [], 0
    for tok, col, bold in words:
        if n + len(tok) > width and tok.strip():
            lines.append(cur)
            cur, n = [(' ' * indent, FG, False)], indent
        if not tok.strip() and n == indent and lines:
            continue
        cur.append((tok, col, bold))
        n += len(tok)
    if cur:
        lines.append(cur)
    return lines


def cut(text, n):
    """First n characters at a word boundary, with … when anything was cut."""
    if len(text) <= n:
        return text
    return text[:n].rsplit(' ', 1)[0].rstrip(' ,;:') + ' …'


ELLIPSIS = [[('…', DIM, False)]]


def md(s):
    """One report line -> wrapped styled lines."""
    if s == '…':
        return ELLIPSIS
    if s.startswith('### '):
        return [[(s[4:], PURPLE, True)]]
    if s.startswith('**Council verdict:'):
        m = re.match(r'\*\*(Council verdict: [^*]+)\*\*(.*)', s)
        return wrap([(m.group(1), AMBER, True)] + inline(m.group(2)))
    if re.match(r'^\d+\. ', s):
        return wrap(inline(s), indent=3)
    if s.startswith('_') and s.endswith('_'):
        return wrap(inline(s.strip('_'), DIM))
    return wrap(inline(s)) if s else [[]]


def premise_row(row):
    """A premises-table row as: mark, claim, then its Basis column (verbatim, clipped)."""
    claim, verdict, basis = [c.strip() for c in row.strip('|').split('|')][:3]
    mark = verdict.replace('✅', '✓').replace('❌', '✗')
    col = GREEN if '✓' in mark else RED if '✗' in mark else AMBER
    return wrap([('  ' + mark.ljust(16), col, True)] + inline(claim) + [('  — ' + cut(basis, 70), DIM, False)], indent=18)


def words(lines):
    return sum(len(t.split()) for line in lines for t, _, _ in line)


# ---------------------------------------------------------------- the report, one section per screen
def find(prefix):
    return next(i for i, l in enumerate(REPORT) if l.startswith(prefix))


def pages():
    out = []
    # 1: the verdict and its confidence
    out.append(md(REPORT[0]) + md(REPORT[1]))
    # 2: what the council understood the question to be (Answer, Why and Options follow in the report)
    out.append(md(REPORT[find('**What you asked:**')]) + [[]] + ELLIPSIS)
    # 3: the premises, each row with its basis (the report's next sections are cut)
    p = find('### Your premises, checked')
    lines = md(REPORT[p])
    for row in [l for l in REPORT[p + 3:] if l.startswith('| ')][:4]:
        lines += premise_row(row)
    out.append(lines + [[]] + ELLIPSIS)
    # 4: the minority report (first three sentences) and the footer
    m = find('### Minority report')
    dissent = REPORT[m + 1]
    end = [x.end() for x in re.finditer(r'\. ', dissent)][2]
    out.append(md(REPORT[m]) + md(dissent[:end].rstrip() + ' …') + [[]] + ELLIPSIS + [[]] + md(REPORT[-1]))
    return out


# ---------------------------------------------------------------- drawing
def draw_segs(d, x, y, segs):
    for text, col, bold in segs:
        f = BOLD if bold else REG
        for ch in text:
            d.text((x, y), ch, font=f if has_glyph(f, ch) else MENLO, fill=col)
            x += CW
    return x


def frame(lines, cursor=False, page=None):
    img = Image.new('RGB', (W, H), BG)
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, W, 32], fill=BAR)
    for i, c in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
        d.ellipse([14 + i * 20, 11, 26 + i * 20, 23], fill=c)
    title = 'claude · /council · replay of a real run, sped up'
    d.text(((W - SMALL.getlength(title)) / 2, 8), title, font=SMALL, fill=TITLE)
    if page:
        d.text((W - SMALL.getlength(page) - 14, 8), page, font=SMALL, fill=TITLE)
    y, x_end = TOP, PAD_X
    for segs in lines[-VIEW:]:
        x_end = draw_segs(d, PAD_X, y, segs)
        y += LINE_H
    if cursor:
        d.rectangle([x_end + 1, y - LINE_H + 3, x_end + CW - 1, y - 4], fill=FG)
    return img


frames, durations = [], []


def add(lines, ms, **kw):
    frames.append(frame(lines, **kw))
    durations.append(int(ms))


def hold(lines, floor=4000, ceiling=12000):
    return min(ceiling, max(floor, 1000 * words(lines) / WPS))


# Scene 1: the question (the run's own, verbatim) as you would type it.
prompt = FACTS['prompt']
for n in list(range(0, len(prompt), 6)) + [len(prompt)]:
    add(wrap([('❯ ', GREEN, True), (prompt[:n], FG, False)], indent=2), 40, cursor=True)
typed = wrap([('❯ ', GREEN, True), (prompt, FG, False)], indent=2)
add(typed, 4500)

# Scene 2: the council runs (stages from the run's record).
head = typed + [[], [('● ', AMBER, True), (f"Council convened · {FACTS['mode']} mode", FG, True)]]
add(head, 900)
shown = []
for name, detail in FACTS['stages']:
    label = f'  {name:<11}' if name else ' ' * 13
    shown += wrap([('  ✓' if name else '   ', GREEN, True), (label, CYAN, True), (detail, FG, False)], indent=16)
    add(head + shown, 1200)
done = head + shown + [[('  ✓ ', GREEN, True), (f"done in {FACTS['duration']} · {FACTS['agents']} agents", DIM, False)]]
add(done, 3000)

# Scene 3: the report, one section per screen, each held long enough to read.
ps = pages()
for i, lines in enumerate(ps, 1):
    add(lines, hold(lines), page=f'report {i}/{len(ps)}')

# A fixed palette of the theme colours and their anti-aliasing blends over the backgrounds keeps
# hues exact across frames (a palette sampled from one frame loses colours absent from it).
theme = [BG, BAR, FG, DIM, TITLE, GREEN, RED, AMBER, CYAN, PURPLE, (255, 95, 86), (255, 189, 46), (39, 201, 63)]
blend = [tuple(round(b + (c - b) * t) for b, c in zip(base, col)) for col in theme for base in (BG, BAR) for t in (0.2, 0.4, 0.6, 0.8, 1.0)]
flat = [v for c in dict.fromkeys(blend) for v in c]
palette = Image.new('P', (1, 1))
palette.putpalette(flat + [0] * (768 - len(flat)))
pal = [f.quantize(palette=palette, dither=Image.Dither.NONE) for f in frames]
pal[0].save(OUT, save_all=True, append_images=pal[1:], duration=durations, loop=0, optimize=True, disposal=1)
print(f'{OUT}: {len(frames)} frames, {sum(durations) / 1000:.1f}s, {os.path.getsize(OUT) / 1e6:.2f} MB, {COLS} cols, {VIEW} rows')
for i, lines in enumerate(ps, 1):
    print(f'  report {i}: {words(lines)} words, {len(lines)} lines, held {hold(lines) / 1000:.1f}s')

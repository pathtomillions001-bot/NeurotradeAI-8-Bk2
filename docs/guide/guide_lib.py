"""Drawing helpers for the NeuroTrade AI user guide.

Schematics are rendered with ReportLab canvas primitives so the PDF is
self-contained. If a real screenshot exists at `shots/<name>.png` it is used
instead of the schematic automatically — that is how you swap captures in.
"""

from __future__ import annotations

import os

from reportlab.lib import colors
from reportlab.lib.colors import HexColor
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.platypus import Flowable, Paragraph, Spacer

# ── palette ───────────────────────────────────────────────────────────────────
INK = HexColor("#0f172a")
MUTED = HexColor("#5b6b7f")
LINE = HexColor("#d7dee7")
ACCENT = HexColor("#0e7490")      # cyan-700, print-safe
ACCENT_SOFT = HexColor("#e6f6f9")
GOOD = HexColor("#15803d")
WARN = HexColor("#b45309")
BAD = HexColor("#b91c1c")
AMBER_SOFT = HexColor("#fdf3e3")

# panel colours used to mimic the app's dark UI inside schematics
P_BG = HexColor("#0b1220")
P_CARD = HexColor("#111c2e")
P_CARD2 = HexColor("#16233a")
P_LINE = HexColor("#25344d")
P_TXT = HexColor("#c7d3e3")
P_DIM = HexColor("#7c8ca3")

SHOTS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "shots")


# ── text helpers ──────────────────────────────────────────────────────────────
def wrap_text(text: str, font: str, size: float, max_w: float) -> list[str]:
    """Greedy word wrap measured with the actual font metrics."""
    words, lines, cur = text.split(), [], ""
    for w in words:
        trial = f"{cur} {w}".strip()
        if pdfmetrics.stringWidth(trial, font, size) <= max_w or not cur:
            cur = trial
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def para(c, x: float, y: float, text: str, size: float = 5.4, *, font="Helvetica",
         color=P_TXT, max_w: float = 40 * mm, leading: float = 1.22, limit: int = 6):
    """Draw small wrapped text inside a schematic; returns the y after the block."""
    c.setFont(font, size)
    c.setFillColor(color)
    lines = wrap_text(text, font, size, max_w)[:limit]
    for i, ln in enumerate(lines):
        c.drawString(x, y - i * size * leading, ln)
    return y - len(lines) * size * leading


# ── schematic primitives ──────────────────────────────────────────────────────
def panel(c, x, y, w, h, *, fill=P_BG, stroke=P_LINE, r=3.2, lw=0.6):
    c.setFillColor(fill)
    c.setStrokeColor(stroke)
    c.setLineWidth(lw)
    c.roundRect(x, y, w, h, r, stroke=1, fill=1)


def card(c, x, y, w, h, title="", lines=(), *, fill=P_CARD, accent=None,
         title_size=5.6, body_size=5.0, badge=None):
    panel(c, x, y, w, h, fill=fill, stroke=P_LINE)
    if accent:
        c.setFillColor(HexColor(accent))
        c.roundRect(x, y + h - 1.6, w, 1.6, 0.8, stroke=0, fill=1)
    ty = y + h - 4.6
    if title:
        c.setFont("Helvetica-Bold", title_size)
        c.setFillColor(P_TXT)
        c.drawString(x + 3.4, ty, title[:60])
        ty -= 5.6
    for ln in lines:
        if not ln:
            ty -= 3.4
            continue
        ty = para(c, x + 3.4, ty, ln, body_size, max_w=w - 6.8, limit=99)
        ty -= 1.4
    if badge:
        callout(c, x + 4.2, y + h - 4.2, badge)
    return ty


def callout(c, x, y, n, *, r=3.6):
    """Numbered circle used to key a legend to the diagram."""
    c.setFillColor(HexColor("#0e7490"))
    c.setStrokeColor(colors.white)
    c.setLineWidth(0.7)
    c.circle(x, y, r, stroke=1, fill=1)
    c.setFont("Helvetica-Bold", 5.0)
    c.setFillColor(colors.white)
    tw = c.stringWidth(str(n), "Helvetica-Bold", 5.0)
    c.drawCentredString(x, y - 1.7, str(n))


def _col(v):
    return HexColor(v) if isinstance(v, str) else v


def chip(c, x, y, text, *, fg=P_DIM, bg=P_CARD2, size=4.6, pad=1.9):
    tw = pdfmetrics.stringWidth(text, "Helvetica-Bold", size)
    w = tw + pad * 2
    c.setFillColor(_col(bg))
    c.setStrokeColor(P_LINE)
    c.setLineWidth(0.5)
    c.roundRect(x, y, w, size + 3.0, 1.8, stroke=1, fill=1)
    c.setFont("Helvetica-Bold", size)
    c.setFillColor(_col(fg))
    c.drawString(x + pad, y + 1.6, text)
    return w


def arrow(c, x1, y1, x2, y2, *, color=MUTED, lw=0.8, head=2.4):
    c.setStrokeColor(color)
    c.setLineWidth(lw)
    c.line(x1, y1, x2, y2)
    import math
    ang = math.atan2(y2 - y1, x2 - x1)
    p = c.beginPath()
    p.moveTo(x2, y2)
    p.lineTo(x2 - head * math.cos(ang - 0.42), y2 - head * math.sin(ang - 0.42))
    p.lineTo(x2 - head * math.cos(ang + 0.42), y2 - head * math.sin(ang + 0.42))
    c.setFillColor(color)
    c.drawPath(p, stroke=0, fill=1)


def window_chrome(c, x, y, w, h, url: str):
    """Browser chrome so the schematic reads as 'this is a screen in the app'."""
    panel(c, x, y, w, h, fill=P_BG, stroke=LINE, r=4)
    bar = 8.6
    c.setFillColor(HexColor("#16233a"))
    c.roundRect(x, y + h - bar, w, bar, 4, stroke=0, fill=1)
    c.rect(x, y + h - bar, w, bar / 2, stroke=0, fill=1)
    for i, dot in enumerate(["#e06c75", "#e5c07b", "#61afef"]):
        c.setFillColor(HexColor(dot))
        c.circle(x + 5 + i * 4.2, y + h - bar / 2, 1.3, stroke=0, fill=1)
    c.setFillColor(HexColor("#0f192b"))
    c.roundRect(x + 19, y + h - bar + 1.6, min(w - 26, 78), bar - 3.4, 1.6, stroke=0, fill=1)
    c.setFont("Helvetica", 4.2)
    c.setFillColor(P_DIM)
    c.drawString(x + 22, y + h - bar + 2.5, url[:52])
    return y + h - bar - 1.8  # top of the content area


# ── flowables ─────────────────────────────────────────────────────────────────
class Diagram(Flowable):
    """A schematic drawn by `paint(c, x, y, w, h)`.

    Draws a caption strip saying it is a schematic (never a fake screenshot).
    """

    def __init__(self, width, height, paint, caption, note=None):
        self._w, self._h, self._paint = width, height, paint
        self.caption, self.note = caption, note
        self.pad_top = 13.5 if note else 8.5
        self.height = height + self.pad_top

    def wrap(self, availWidth, availHeight):
        self.width = min(self._w, availWidth)
        self.scale = self.width / self._w
        return (self.width, self.height)

    def draw(self):
        c = self.canv
        h = self.height - self.pad_top
        c.saveState()
        self._paint(c, 0, 0, self.width, h)
        c.restoreState()
        c.setFont("Helvetica-Bold", 7.4)
        c.setFillColor(INK)
        c.drawString(0, h + 9.0, self.caption)
        if self.note:
            c.setFont("Helvetica", 6.4)
            c.setFillColor(MUTED)
            c.drawString(0, h + 2.2, self.note)


class Shot(Flowable):
    """Embeds shots/<name>.png if present, otherwise falls back to the schematic.

    This keeps the guide buildable today with diagrams and automatically
    upgrades to real captures the moment PNGs are dropped in.
    """

    def __init__(self, name, width, height, paint, caption, note=None):
        self.name = name
        self._w, self._h = width, height
        self.paint, self.caption, self.note = paint, caption, note
        self.png = os.path.join(SHOTS_DIR, f"{name}.png")
        self.has_shot = os.path.exists(self.png)
        self.img_h = 0
        if self.has_shot:
            from PIL import Image
            iw, ih = Image.open(self.png).size
            self.img_h = min(width * ih / iw, height * 1.35)
        self.height = self.img_h + (24 if self.has_shot else height + (11 if note else 7))

    def wrap(self, availWidth, availHeight):
        self.width = min(self._w, availWidth)
        self.keepWithNext = 0
        if self.has_shot:
            from PIL import Image
            iw, ih = Image.open(self.png).size
            self.img_h = self.width * ih / iw
            self.height = self.img_h + 24
        return (self.width, self.height)

    def draw(self):
        c = self.canv
        if self.has_shot:
            c.setStrokeColor(LINE)
            c.setLineWidth(0.6)
            c.roundRect(0, self.height - self.img_h - 16, self.width, self.img_h + 6, 3, stroke=1, fill=0)
            c.drawImage(self.png, 3, self.height - self.img_h - 13,
                        width=self.width - 6, height=self.img_h,
                        preserveAspectRatio=True, anchor="nw", mask="auto")
            c.setFont("Helvetica-Bold", 7.0)
            c.setFillColor(GOOD)
            c.drawString(0, self.height - self.img_h - 11.5, "● screenshot")
            c.setFont("Helvetica-Bold", 7.4)
            c.setFillColor(INK)
            c.drawString(28, self.height - self.img_h - 11.5, self.caption)
            return
        pad = 13.5 if self.note else 8.5
        h = self.height - pad
        self.paint(c, 0, 0, self.width, h)
        c.setFont("Helvetica-Bold", 7.4)
        c.setFillColor(INK)
        c.drawString(0, h + 9.0, self.caption)
        c.setFont("Helvetica", 6.4)
        c.setFillColor(MUTED)
        note = self.note or ("Schematic of the live UI — not a screenshot. "
                             "Drop a PNG at docs/guide/shots/%s.png and rebuild to replace it." % self.name)
        c.drawString(0, h + 2.2, note)


# ── document furniture ────────────────────────────────────────────────────────
def styles() -> dict[str, ParagraphStyle]:
    s = {}
    s["h1"] = ParagraphStyle("h1", fontName="Helvetica-Bold", fontSize=17, leading=20,
                             textColor=INK, spaceAfter=2)
    s["h2"] = ParagraphStyle("h2", fontName="Helvetica-Bold", fontSize=11.6, leading=14,
                             textColor=INK, spaceBefore=9, spaceAfter=3.4)
    s["h3"] = ParagraphStyle("h3", fontName="Helvetica-Bold", fontSize=9.2, leading=12,
                             textColor=ACCENT, spaceBefore=6, spaceAfter=2)
    s["body"] = ParagraphStyle("body", fontName="Helvetica", fontSize=8.9, leading=12.6,
                               textColor=INK, spaceAfter=4)
    s["small"] = ParagraphStyle("small", fontName="Helvetica", fontSize=7.6, leading=10.2,
                                 textColor=MUTED, spaceAfter=3)
    s["cell"] = ParagraphStyle("cell", fontName="Helvetica", fontSize=7.5, leading=9.6,
                               textColor=INK)
    s["cellb"] = ParagraphStyle("cellb", fontName="Helvetica-Bold", fontSize=7.5, leading=9.6,
                                textColor=INK)
    s["cellh"] = ParagraphStyle("cellh", fontName="Helvetica-Bold", fontSize=7.3, leading=9,
                                textColor=colors.white)
    s["li"] = ParagraphStyle("li", parent=s["body"], leftIndent=10, bulletIndent=1,
                             spaceAfter=2.6)
    s["call"] = ParagraphStyle("call", fontName="Helvetica", fontSize=8.2, leading=11.4,
                               textColor=INK, leftIndent=2, rightIndent=2)
    s["callb"] = ParagraphStyle("callb", fontName="Helvetica-Bold", fontSize=8.2, leading=11.4,
                                textColor=INK)
    return s


def callout_box(text, *, kind="warn", title=None):
    """A boxed inline caution (the guide's only warning mechanism)."""
    fill, bar = {"warn": (AMBER_SOFT, WARN), "tip": (ACCENT_SOFT, ACCENT),
                 "stop": (HexColor("#fdecec"), BAD)}[kind]
    st = styles()
    body = Paragraph(f'<b>{title}</b><br/>{text}' if title else text, st["call"])
    from reportlab.platypus import Table, TableStyle
    t = Table([[body]], colWidths=[None])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), fill),
        ("LINEBEFORE", (0, 0), (0, -1), 2.4, bar),
        ("BOX", (0, 0), (-1, -1), 0.4, HexColor("#e3e8ef")),
        ("LEFTPADDING", (0, 0), (-1, -1), 7),
        ("RIGHTPADDING", (0, 0), (-1, -1), 7),
        ("TOPPADDING", (0, 0), (-1, -1), 5.5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5.5),
    ]))
    return t


def table(data, widths=None, *, header=True, zebra=True):
    from reportlab.platypus import Table, TableStyle
    if widths is None:
        return data  # already-built flowable (cells() built it)
    t = Table(data, colWidths=widths, repeatRows=1 if header else 0, hAlign="LEFT")
    cmds = [
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("LINEBELOW", (0, 0), (-1, -2), 0.35, HexColor("#e8edf3")),
        ("BOX", (0, 0), (-1, -1), 0.45, HexColor("#d9e1ea")),
    ]
    if header:
        cmds += [("BACKGROUND", (0, 0), (-1, 0), INK),
                 ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                 ("VALIGN", (0, 0), (-1, 0), "MIDDLE")]
    if zebra:
        start = 1 if header else 0
        for i in range(start, len(data)):
            if (i - start) % 2 == 1:
                cmds.append(("BACKGROUND", (0, i), (-1, i), HexColor("#f6f9fb")))
    t.setStyle(TableStyle(cmds))
    return t


def gap(h=5):
    return Spacer(1, h)

"""Build the NeuroTrade AI quick-start guide (PDF).

Usage:  python3 docs/guide/build_user_guide.py
Real screenshots are picked up automatically from docs/guide/shots/<name>.png.
"""

from __future__ import annotations

import os
import sys

from reportlab.lib import colors
from reportlab.lib.colors import HexColor
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.platypus import (BaseDocTemplate, Frame, NextPageTemplate, PageBreak,
                                PageTemplate, Paragraph, Spacer, Table, TableStyle)

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from guide_lib import (ACCENT, BAD, GOOD, INK, LINE, MUTED, P_BG, P_CARD, P_CARD2, P_DIM,
                       P_LINE, P_TXT, WARN, callout, callout_box, card, chip, gap, styles,
                       table, window_chrome, arrow, para, panel, Shot, SHOTS_DIR)

PAGE_W, PAGE_H = A4
M = 16 * mm
CW = PAGE_W - 2 * M                      # content width
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "NeuroTrade-AI-User-Guide.pdf")

S = styles()
from reportlab.lib.styles import ParagraphStyle as _PS
S["num"] = _PS("num", parent=S["li"], bulletFontName="Helvetica-Bold", bulletFontSize=8.9,
               bulletColor=ACCENT, leftIndent=13, bulletIndent=1)
story = []


def h1(t): story.append(Paragraph(t, S["h1"]))
def h2(t): story.append(Paragraph(t, S["h2"]))
def h3(t): story.append(Paragraph(t, S["h3"]))
def p(t): story.append(Paragraph(t, S["body"]))
def small(t): story.append(Paragraph(t, S["small"]))
def li(t): story.append(Paragraph(t, S["li"], bulletText="•"))


def numli(n, t):
    story.append(Paragraph(t, S["num"], bulletText=f"{n}."))


def cells(rows, widths=None):
    data = [[Paragraph(f"<b>{c}</b>", S["cellh"]) for c in rows[0]],
            *[[Paragraph(c, S["cell"]) for c in r] for r in rows[1:]]]
    return table(data, widths)


# ══════════════════════════════════════════════════════════════════════════════
#  SCHEMATICS
# ══════════════════════════════════════════════════════════════════════════════

def bolt(c, cx, cy, s, fill="#ffffff"):
    """A filled lightning bolt, drawn as a polygon (no emoji font needed)."""
    pts = [(0.10, 0.52), (0.46, 0.52), (0.34, 0.86), (0.62, 0.86),
           (0.22, 1.00), (0.34, 0.66), (0.06, 0.66)]
    p = c.beginPath()
    p.moveTo(cx + (pts[0][0] - 0.34) * s, cy + (0.78 - pts[0][1]) * s)
    for x, y in pts[1:]:
        p.lineTo(cx + (x - 0.34) * s, cy + (0.78 - y) * s)
    p.lineTo(cx + (pts[0][0] - 0.34) * s, cy + (0.78 - pts[0][1]) * s)
    c.setFillColor(HexColor(fill))
    c.drawPath(p, stroke=0, fill=1)


def paint_arbiter(c, x, y, w, h):
    panel(c, x, y, w, h, fill=colors.white, stroke=LINE, r=4)
    c.setFillColor(INK)
    c.setFont("Helvetica-Bold", 8.4)
    c.drawString(x + 5, y + h - 12, "Three engines, one account, one lock")

    lanes = [("Main autonomous engine", "13-agent pipeline · Dashboard → START ENGINE", "autonomous", "#0e7490"),
             ("NeuroAI Quantum FAB", "floating bolt button · 1-tick scans", "neuroai", "#7c3aed"),
             ("AI Bot Arena", "5 single-contract specialists", "bots", "#b45309")]
    bw, bh = w * 0.34, h * 0.2
    for i, (t, sub, owner, acc) in enumerate(lanes):
        yy = y + h - 22 - (i + 1) * (bh + 6)
        card(c, x + 6, yy, bw, bh, t, [sub], accent=acc, title_size=6.4, body_size=5.4)
        c.setFont("Helvetica", 5.0)
        c.setFillColor(P_DIM)
        c.drawString(x + 9, yy + 2.2, f'owner "{owner}"')

    mx = x + 6 + bw + 16
    mw = w * 0.26
    my = y + h * 0.5 - h * 0.17
    mh = h * 0.34
    card(c, mx, my, mw, mh, "Engine\narbiter", ["acquire()", "ownership", "blocks trade", "execution only"],
         fill=HexColor("#0f192b"), accent="#0e7490", title_size=6.4, body_size=5.2)
    for i in range(3):
        yy = y + h - 22 - (i + 1) * (bh + 6) + bh / 2
        arrow(c, x + 6 + bw + 2, yy, mx - 2, my + mh / 2, color=HexColor("#94a3b8"), lw=0.7)

    rx = mx + mw + 14
    rw = w - (rx - x) - 7
    rh = h * 0.17
    card(c, rx, y + h - 22 - rh, rw, rh, "Shared recovery ledger", ["one account-global debt state",
         "every engine writes wins/losses here"], accent="#e5c07b", title_size=6.2, body_size=5.2)
    card(c, rx, y + h - 22 - rh * 2 - 7, rw, rh, "Deriv account", ["live orders or paper log",
         "balance, stakes, payouts"], accent="#61afef", title_size=6.2, body_size=5.2)
    arrow(c, mx + mw + 2, my + mh * 0.72, rx - 2, y + h - 22 - rh * 0.5, color=HexColor("#94a3b8"), lw=0.7)
    arrow(c, mx + mw + 2, my + mh * 0.3, rx - 2, y + h - 22 - rh * 1.5 - 7, color=HexColor("#94a3b8"), lw=0.7)

    c.setFont("Helvetica-Oblique", 5.6)
    c.setFillColor(WARN)
    tw = c.stringWidth("Starting a second engine will be refused until the first one stops. Status, scanning and analysis keep working.", "Helvetica-Oblique", 5.6)
    c.drawString(x + w - tw - 6, y + 6, "Starting a second engine will be refused until the first one stops. Status, scanning and analysis keep working.")


def paint_dashboard(c, x, y, w, h):
    top = window_chrome(c, x, y, w, h, "localhost:5000/#/  ·  Dashboard")
    nav_w = w * 0.17
    panel(c, x + 3, y + 3, nav_w, top - y - 6, fill=HexColor("#0a1120"))
    c.setFont("Helvetica-Bold", 5.6)
    c.setFillColor(ACCENT)
    c.drawString(x + 7, top - 5, "NEUROTRADE")
    items = ["Dashboard", "Markets", "AI Bots", "Journal", "Analytics", "Intelligence",
             "Risk Calc", "Settings", "Connect"]
    for i, it in enumerate(items):
        yy = top - 14 - i * 7.6
        c.setFillColor(HexColor("#0e7490") if i == 0 else HexColor("#0a1120"))
        c.roundRect(x + 5.5, yy - 2.2, nav_w - 6, 6.2, 1.6, stroke=0, fill=1)
        c.setFont("Helvetica-Bold" if i == 0 else "Helvetica", 5.0)
        c.setFillColor(P_TXT if i == 0 else P_DIM)
        c.drawString(x + 8, yy - 0.4, it)
    callout(c, x + nav_w + 1.5, y + 9, 9)

    cx = x + nav_w + 9
    cw = w - nav_w - 12
    # header row
    c.setFont("Helvetica-Bold", 8.2)
    c.setFillColor(P_TXT)
    c.drawString(cx, top - 8, "Dashboard")
    c.setFont("Helvetica", 5.0)
    c.setFillColor(GOOD)
    c.drawString(cx, top - 13.6, "● ENGINE ONLINE • AUTONOMOUS MODE · PAPER")
    card(c, cx + cw - 46, top - 16, 46, 13.5, "", ["USD 1,000.00", "Demo · 101234"], fill=P_CARD2)
    c.setFont("Helvetica", 5.0)
    callout(c, cx + 118, top - 11.5, 1)
    callout(c, cx + cw - 3, top - 9, 2)

    # cooldown banner
    card(c, cx, top - 33, cw, 14, "", ["Engine in Cooldown — 4 losses in a row · 00:47 until auto-resume · [ Resume Now ]"],
         fill=HexColor("#2a1f0c"), accent="#e5c07b", body_size=5.2)
    callout(c, cx + 3.5, top - 26, 3)

    # stat strip
    stats = [("WIN RATE", "58.2%"), ("TODAY'S PROFIT", "+42.10"), ("STREAK", "+3"),
             ("RECOVERY", "debt 1.24"), ("TOTAL TRADES", "83")]
    sw = (cw - 4 * 3.2) / 5
    for i, (t, v) in enumerate(stats):
        sx = cx + i * (sw + 3.2)
        card(c, sx, top - 58, sw, 22)
        c.setFont("Helvetica", 4.6)
        c.setFillColor(P_DIM)
        c.drawString(sx + 3.4, top - 58 + 15.2, t)
        c.setFont("Helvetica-Bold", 8.0)
        c.setFillColor(GOOD if i in (1, 2) else HexColor("#7dd3fc") if i == 3 else P_TXT)
        c.drawString(sx + 3.4, top - 58 + 6.2, v)
    callout(c, cx - 1.5, top - 47, 4)

    # daily target + flash card
    jw = cw * 0.33
    card(c, cx, top - 90, jw, 28, "DAILY TARGET", ["+42.10 / $5,000", "[progress bar]  0.8%"], body_size=5.2)
    card(c, cx + jw + 4, top - 90, cw - jw - 4, 28, "TOP OPPORTUNITY — VOLATILITY 100 INDEX",
         ["DIGITOVER 1 · 74% confidence · EV +0.031 · stake $1.00 · 5t · [ Analyse market ]"],
         accent="#0e7490", body_size=5.2)
    callout(c, cx + 3.6, top - 66, 5)
    callout(c, cx + jw + 7.6, top - 66, 6)

    # engine card
    eh = top - 94 - (y + 6)
    ey = y + 6
    card(c, cx, ey, cw, eh, "AI ENGINE — 13 AGENTS",
         ["Running 4-group parallel tournament…   Next trade in 1s   [ STOP ENGINE ]"],
         accent="#0e7490", body_size=5.2)
    callout(c, cx + cw - 8, ey + eh - 4.4, 7)
    gx, gy, gw, gh = cx + 4, ey + 8, cw - 8, eh - 26
    c.setFillColor(HexColor("#0d1526"))
    c.setStrokeColor(P_LINE)
    c.roundRect(gx, gy, gw, 12, 2, stroke=1, fill=1)
    c.setFont("Helvetica", 4.6)
    c.setFillColor(P_DIM)
    c.drawString(gx + 3, gy + 7.4, "PARALLEL GROUP SCANNER — direction · over/under · even/odd · match/differ  (winner executes)")
    c.drawString(gx + 3, gy + 2.4, "skipped: entropy gate · z 0.41 < 0.75 break-even margin")
    cols, rows = 7, 2
    aw, ah = (gw - (cols - 1) * 2.4) / cols, (gh - 12 - 3 - (rows - 1) * 2.4) / rows
    names = ["Market Scanner", "Tick Intel", "Digit Prob", "Rise/Fall", "Regime", "Exec Timing",
             "Confidence", "Recovery", "Risk Intel", "Portfolio", "Learning", "Patterns", "Explain"]
    for i, n in enumerate(names):
        r, col = divmod(i, cols)
        ax, ay = gx + col * (aw + 2.4), gy + 12 + 3 + (rows - 1 - r) * (ah + 2.4)
        acc = ["#0e7490", "#e5c07b", "#e06c75"][i % 3] if i % 5 else "#61afef"
        c.setFillColor(HexColor("#0d1526"))
        c.setStrokeColor(HexColor(acc))
        c.setLineWidth(0.6)
        c.roundRect(ax, ay, aw, ah, 1.6, stroke=1, fill=1)
        c.setFont("Helvetica-Bold", 4.3)
        c.setFillColor(P_TXT)
        c.drawString(ax + 2.4, ay + ah - 6, n)
        c.setFont("Helvetica", 4.0)
        c.setFillColor(HexColor(acc))
        c.drawString(ax + 2.4, ay + 2.4, f"{52 + i * 3}%")
    callout(c, cx + 3.6, ey + 4, 8)


def paint_fab(c, x, y, w, h):
    panel(c, x, y, w, h, fill=HexColor("#0a1120"), stroke=LINE, r=4)

    # the floating button, drawn at the corner it actually occupies
    r = 10
    bx, by = x + w - r - 9, y + r + 7
    c.setFillColor(HexColor("#0e7490"))
    c.setStrokeColor(HexColor("#67e8f9"))
    c.setLineWidth(1.2)
    c.circle(bx, by, r, stroke=1, fill=1)
    bolt(c, bx, by, 22)
    c.setFont("Helvetica-Bold", 5.0)
    c.setFillColor(HexColor("#67e8f9"))
    c.drawCentredString(bx, by + r + 3.2, "the button")
    for i, (t, col) in enumerate([("badge: STANDBY", "#7c8ca3"), ("LIVE · Locked on R_100", "#7dd3fc"),
                                  ("STOPPED", "#f87171")]):
        c.setFont("Helvetica-Bold", 4.8)
        c.setFillColor(HexColor(col))
        c.drawRightString(bx - r - 4, by + 4 - i * 6.4, t)

    steps = [
        ("1 · CONFIG", ["Normal strategy family", "Over & Under · Rise & Fall",
                        "Even & Odd · Differs", "Barriers  OVER 1 · UNDER 8", "",
                        "Recovery families + auto", "Base stake · Take profit · Stop loss",
                        "Locked asset vs Smart switching", "Multiplier · Max steps"], "#0e7490"),
        ("2 · QUANTUM SCAN", ["Scanning 20 markets…", "", "Bayesian Markov tensor",
                              "Shannon entropy gate", "Run-length hazard + fatigue",
                              "Lag-1 autocorrelation", "+EV micro-gating"], "#7c3aed"),
        ("3 · SCAN RESULT", ["Edge found → deployable", "  green “Statistical Edge Verified”", "",
                             "No edge → refuses", "  amber “No Decisive Edge Found”", "",
                             "Normal 68% · Sniper 61%", "Entropy 0.42",
                             "[ Trade Locked · Smart Switch ]", "[ Re-Scan Markets ]"], "#15803d"),
        ("4 · RUNNING", ["Strict Contract Lock", "Entry re-checked each tick", "",
                          "Win → journal + ledger", "Loss → sniper recovery",
                          "4-window concurrence", "15t / 30t / 60t / 100t", "",
                          "[ STOP ] releases the lock"], "#b45309"),
    ]
    fw = 74
    avail = w - 12 - fw
    pw = (avail - 3 * 5) / 4
    ph = h - 12
    for i, (t, lines, acc) in enumerate(steps):
        px = x + 6 + i * (pw + 5)
        py = y + 6
        card(c, px, py, pw, ph, "", [], accent=acc, fill=HexColor("#0d1526"))
        c.setFont("Helvetica-Bold", 6.4)
        c.setFillColor(HexColor(acc))
        c.drawString(px + 3.6, py + ph - 9.4, t)
        yy = py + ph - 17.4
        for ln in lines:
            if not ln:
                yy -= 3.2
                continue
            bold = ln.startswith("[") or ln.startswith("Edge") or ln.startswith("No edge")
            c.setFont("Helvetica-Bold" if bold else "Helvetica", 5.1)
            c.setFillColor(P_TXT if not ln.startswith("  ") else P_DIM)
            c.drawString(px + 3.6, yy, ln[:34])
            yy -= 7.2
        if i < 3:
            arrow(c, px + pw + 0.8, py + ph / 2, px + pw + 4.2, py + ph / 2, color=HexColor("#94a3b8"))


def paint_bots(c, x, y, w, h):
    panel(c, x, y, w, h, fill=HexColor("#0a1120"), stroke=LINE, r=4)
    c.setFont("Helvetica-Bold", 6.2)
    c.setFillColor(HexColor("#67e8f9"))
    c.drawString(x + 6, y + h - 10, "AI BOT ARENA")
    c.setFont("Helvetica", 5.2)
    c.setFillColor(P_DIM)
    c.drawString(x + 6, y + h - 16.4, "one bot may run at a time · each locked to one contract family")
    chip(c, x + w - 44, y + h - 15, "Active Bot  +12.40", bg=HexColor("#0e7490"), fg="#e0f7ff", size=4.6)

    bots = [("Parity Sentinel", "Even / Odd", "≈50% · 1.95×", "#0e7490", "BOT-EVENODD"),
            ("Differ Guardian", "Differs", "≈96% · 1.09×", "#15803d", "BOT-DIFF"),
            ("Match Sniper", "Matches", "≈11% · 8.93×", "#b45309", "BOT-MATCH"),
            ("Barrier Architect", "Over / Under", "10–90% · 1.09–8.93×", "#7c3aed", "BOT-OVERUNDER"),
            ("Vector Momentum", "Rise / Fall", "≈50% · 1.92×", "#be123c", "BOT-RISEFALL")]
    bw = (w - 12 - 4 * 3.4) / 5
    bh = 30
    for i, (n, fam, wr, acc, code) in enumerate(bots):
        bx = x + 6 + i * (bw + 3.4)
        by = y + h - 16.4 - bh - 4
        card(c, bx, by, bw, bh, "", [], accent=acc)
        c.setFont("Helvetica-Bold", 5.6)
        c.setFillColor(P_TXT)
        c.drawString(bx + 3.4, by + bh - 7.6, n)
        c.setFont("Helvetica", 4.6)
        c.setFillColor(P_DIM)
        c.drawString(bx + 3.4, by + bh - 13.4, fam)
        c.setFillColor(HexColor(acc))
        c.setFont("Helvetica-Bold", 4.8)
        c.drawString(bx + 3.4, by + bh - 19.4, wr)
        cw2 = chip(c, bx + 3.4, by + 2.4, "Deploy", bg=HexColor(acc), fg="#ffffff", size=4.0)
        c.setFont("Helvetica", 3.7)
        c.setFillColor(HexColor("#4a5b73"))
        c.drawString(bx + 6.4 + cw2, by + 3.7, code)

    # console
    cy = y + 5
    ch = by - 5 - cy
    card(c, x + 6, cy, w - 12, ch, "", [], accent="#0e7490", fill=HexColor("#0d1526"))
    c.setFont("Helvetica-Bold", 6.0)
    c.setFillColor(HexColor("#67e8f9"))
    c.drawString(x + 10, cy + ch - 9, "DEPLOY CONSOLE")
    c.setFont("Helvetica", 4.8)
    c.setFillColor(P_DIM)
    c.drawString(x + 74, cy + ch - 9, "— opens when you press Deploy on a card")
    blocks = [("Side mode", ["Even & Odd · Even only · Odd only", "arbitration picks the favoured side"]),
              ("Barrier / digit", ["OVER digit · UNDER digit", "or digit lock (Match, Differ)"]),
              ("Risk", ["Base stake · Take profit · Stop loss"]),
              ("Recovery", ["Recovery mode · multiplier · max steps", "bot markup on debt (default 10%)"]),
              ("Actions", ["Scan markets (SSE progress)", "Deploy · Stop · Re-scan"])]
    bwx = (w - 12 - 8 - 4 * 3) / 5
    for i, (t, lines) in enumerate(blocks):
        bx = x + 10 + i * (bwx + 3)
        byy = cy + 4
        c.setFillColor(HexColor("#0d1526"))
        c.setStrokeColor(P_LINE)
        c.roundRect(bx, byy, bwx, ch - 16, 2, stroke=1, fill=1)
        c.setFont("Helvetica-Bold", 5.2)
        c.setFillColor(P_TXT)
        c.drawString(bx + 3, byy + ch - 22, t)
        yy = byy + ch - 30
        for ln in lines:
            yy = para(c, bx + 3, yy, ln, 4.6, max_w=bwx - 6, limit=2, color=P_DIM)
            yy -= 1.5


# ══════════════════════════════════════════════════════════════════════════════
#  COVER
# ══════════════════════════════════════════════════════════════════════════════
def paint_cover(c, doc):
    c.saveState()
    c.setFillColor(HexColor("#0b1220"))
    c.rect(0, PAGE_H - 46 * mm, PAGE_W, 46 * mm, stroke=0, fill=1)
    for i, col in enumerate(["#0e7490", "#155e75", "#164e63", "#083344"]):
        c.setFillColor(HexColor(col))
        c.rect(i * 6 * mm, PAGE_H - 46 * mm, 6 * mm, 46 * mm, stroke=0, fill=1)
    c.setFillColor(colors.white)
    c.setFont("Helvetica-Bold", 26)
    c.drawString(M, PAGE_H - 20 * mm, "NeuroTrade AI")
    c.setFont("Helvetica", 12.4)
    c.setFillColor(HexColor("#a5f3fc"))
    c.drawString(M, PAGE_H - 27.4 * mm, "User Guide — Quick Start")
    c.setFont("Helvetica", 8.2)
    c.setFillColor(HexColor("#7dd3fc"))
    c.drawString(M, PAGE_H - 33.6 * mm,
                 "The main autonomous engine, the NeuroAI Quantum FAB, the five AI Bots, manual trading and every menu")
    c.setFont("Helvetica", 7)
    c.setFillColor(HexColor("#94a3b8"))
    c.drawString(M, PAGE_H - 38.6 * mm, "Written against the code and live defaults in this repository · 3 September 2026")
    c.restoreState()


h1("What this app is")
p("NeuroTrade AI places and manages synthetic-index trades (Deriv volatility and jump indices) through three "
  "selectable engines and one journal. It is not a charting platform: every screen exists to answer one question — "
  "<b>is there a statistical edge in this market right now, and how big a stake does that edge justify?</b>")
p("You can let the app trade by itself, run one of the specialist bots, drive the Quantum FAB, or trade manually with the "
  "AI telling you which side it favours. All four paths write to the same journal and the same recovery ledger.")
gap(3)

gap(6)
story.append(Shot("architecture", CW, 58 * mm, paint_arbiter,
                  "Figure 1 — how the three engines share one account"))
gap(2)

h2("Start here — the first-run checklist")
for i, t in enumerate([
    "Open <b>Connect</b> and attach a Deriv account. OAuth2 (the primary button) or a pasted Personal Access Token both work.",
    "Confirm you are on a <b>Demo</b> account, not <b>Real</b>. The badge next to your login ID says which.",
    "Go to <b>Settings → Engine Configuration</b> and turn <b>Paper Trade Mode ON</b>. It ships switched off.",
    "Set <b>Risk Amount</b>, <b>Daily Loss Limit</b> and <b>Max Stake Per Trade</b> to numbers that suit the balance you connected.",
    "Run the <b>Dashboard → START ENGINE</b> once, watch a few scans, then stop it and try the bolt-button FAB and one bot.",
    "Only after you trust the settings: switch to a real account, and change at most one of those five things at a time.",
], 1):
    numli(i, t)

gap(4)
story.append(callout_box(
    "Only one engine can place trades at a time. If the autonomous engine is running, the FAB and the bots will refuse to "
    "start until it stops — and vice versa. This is deliberate: recovery debt is account-level, and two engines trading one "
    "account against two private recovery states produced real accounting failures before the lock existed.",
    kind="warn", title="One engine at a time"))

gap(5)
h2("In this guide")
story.append(table(cells([
    ["§", "Section", "§", "Section"],
    ["1", "First run, and the nine menus", "5", "The AI Bots — five specialists"],
    ["2", "The Dashboard, region by region", "6", "Manual mode, Markets, reviewing results"],
    ["3", "Running the autonomous engine", "7", "Settings reference and troubleshooting"],
    ["4", "The NeuroAI Quantum FAB", "", ""],
], [7 * mm, 60 * mm, 7 * mm, CW - 74 * mm])))

story.append(PageBreak())

# ══════════════════════════════════════════════════════════════════════════════
#  1 — CONNECT
# ══════════════════════════════════════════════════════════════════════════════
h1("1 · First run, and what the menus are")
p("<b>Before an account exists the app shows a landing page.</b> That is a gate, not a bug: it keeps a new visitor out of a "
  "half-connected dashboard. Press the entry button and you land on <b>/connect</b>. Once an account is attached the normal "
  "interface opens on every route.")

h3("Connecting an account (Connect)")
li("<b>OAuth2 login (primary).</b> The main button starts an OAuth2 + PKCE flow against Deriv and returns to "
   "<i>/connect?code=…</i>. It asks for no secrets from you directly.")
li("<b>Bearer / Personal Access Token (fallback).</b> Paste an OAuth bearer token or a Deriv PAT to connect without the "
   "redirect. Useful when the OAuth app is not configured (the app needs <code>DERIV_APP_ID</code> for that path).")
li("<b>Demo vs Real.</b> Every account row carries an <b>Demo</b> (virtual) or <b>Real</b> badge, and the account switcher in "
   "the header lets you move between them — switching is a live action, so it is the one click to be deliberate about.")
gap(3)
story.append(callout_box(
    "<b>Paper Trade Mode defaults to OFF</b> (Settings → Engine Configuration). With it off, an engine that is running sends "
    "live orders the moment it finds an entry it likes. Turn it on first: trades are then journalled exactly like real ones, "
    "with no order sent to Deriv.", kind="stop", title="Do this before you start any engine"))

h3("Where the numbers come from")
p("Ticks arrive over Deriv's public WebSocket. If that socket cannot connect, the app does not go blank — it starts a "
  "simulated price feed and stamps the dashboard header with <b>SIM DATA</b>. Trades are still recorded, and in simulation "
  "their win/loss outcome is weighted by the AI's own confidence rather than a settled contract. So a session showing "
  "<b>SIM DATA</b> tells you how the engine behaves, not how the market treated you.")
gap(4)

h2("The nine menus")
story.append(table(cells([
    ["Menu", "What it is", "Reach for it when"],
    ["<b>Dashboard</b>", "The main autonomous engine: status, 13 agents, performance today, recovery state, daily target.",
     "You want the app to run itself, or to check on it."],
    ["<b>Markets</b>", "Ranked list of the synthetic markets with quality, confidence, risk and trend scores.",
     "You want to pick or inspect an instrument."],
    ["<b>AI Bots</b>", "The AI Bot Arena: five single-contract specialists with their own deploy consoles.",
     "You want one trade type handled by an expert model."],
    ["<b>Journal</b>", "Trade-by-trade record of what was placed, on which contract, at what stake, and the result.",
     "You are reviewing what actually happened."],
    ["<b>Analytics</b>", "All-time performance: win rate, payout mix, market-level breakdowns.",
     "You want history rather than today."],
    ["<b>Intelligence</b>", "Post-trade learning: missed opportunities, threshold tuning, generated reports.",
     "You want to know what the app learned and what it skipped."],
    ["<b>Risk Calc</b>", "Standalone sizing calculator — stake, recovery steps, exposure.",
     "Before you commit to a multiplier or a stake."],
    ["<b>Settings</b>", "Risk, daily limits, engine behaviour, recovery mode, barriers, contract mode.",
     "Any time behaviour needs changing."],
    ["<b>Connect</b>", "Account connection, tokens, Demo/Real switching.", "Setup and account changes."],
], [28 * mm, 62 * mm, CW - 90 * mm])))
gap(4)
small("Everything below assumes you are on a Demo account with Paper Trade Mode on.")
story.append(PageBreak())

# ══════════════════════════════════════════════════════════════════════════════
#  2 — DASHBOARD
# ══════════════════════════════════════════════════════════════════════════════
h1("2 · The Dashboard, region by region")
p("The dashboard is the main engine's cockpit. Nothing on it is decorative — every block is either an output of the "
  "13-agent pipeline or a safety switch.")
gap(2)
gap(6)
story.append(Shot("dashboard", CW, 96 * mm, paint_dashboard,
                  "Figure 2 — Dashboard layout (the numbered markers key to the table below)"))
gap(3)
story.append(table(cells([
    ["#", "Region", "What it tells you"],
    ["1", "<b>Status line</b>", "<font color='#0e7490'><b>ENGINE ONLINE</b></font> / <b>ENGINE STANDBY</b> / <b>COOLDOWN</b>, then "
     "<b>AUTONOMOUS</b> or <b>MANUAL</b> mode, plus <b>PAPER</b> and <b>SIM DATA</b> tags when those apply. Read this first, every time."],
    ["2", "<b>Account chip</b>", "Login shown as currency and balance. If it is absent the app has no account and the engine has nothing to trade."],
    ["3", "<b>Cooldown banner</b>", "Appears after the consecutive-loss limit, with the stop reason and a countdown to auto-resume. <b>Resume Now</b> restarts early."],
    ["4", "<b>Performance strip</b>", "Today's win rate, profit, streak, recovery state and trade count. Day-scoped on purpose — all-time numbers live in Analytics."],
    ["5", "<b>Daily target</b>", "Progress toward the profit target with the limit that halts trading. If the loss limit is hit you get <i>Loss limit hit — trading paused</i>."],
    ["6", "<b>Top opportunity</b>", "The best current setup as a 3D flash card: market, contract, confidence, EV, suggested stake and duration."],
    ["7", "<b>START / STOP ENGINE</b>", "The master switch for the autonomous engine, with today's executed-trade count next to it."],
    ["8", "<b>Scanner + agent grid</b>", "The four contract groups racing for the next trade, then each agent's live confidence."],
    ["9", "<b>Navigation rail</b>", "The nine menus. Kept highlighted for the section you are in."],
], [8 * mm, 34 * mm, CW - 42 * mm])))
gap(4)
h3("Reading the agent grid")
p("Thirteen tiles, coloured by their own confidence: <font color='#15803d'><b>70 and above</b></font> is calm green, "
  "<font color='#b45309'><b>50–70</b></font> is amber, <font color='#b91c1c'><b>below 50</b></font> is red. A single red tile is "
  "normal — the pipeline is a consensus, not a veto — but a floor of reds means the engine is being held back by the tape, "
  "not by your settings.")
story.append(PageBreak())

# ══════════════════════════════════════════════════════════════════════════════
#  3 — RUNNING THE ENGINE
# ══════════════════════════════════════════════════════════════════════════════
h1("3 · Running the main autonomous engine")
for i, t in enumerate([
    "<b>Press START ENGINE.</b> The status line flips to ENGINE ONLINE • AUTONOMOUS MODE and the scan bar appears.",
    "<b>Watch one tournament.</b> The bar cycles <i>Scanning markets… → Running 4-group parallel tournament… → Executing: &lt;group&gt;</i>, "
    "with <i>Next trade in Ns</i> driven by your Scan Interval (default 1 s).",
    "<b>Let it skip.</b> Most loops end in no trade. The scanner line and the red “skipped” reasons are the product working, "
    "not failing — with <i>Require Positive EV</i> on, no entry is good enough far more often than a live trader expects.",
    "<b>Check the journal, not the hype.</b> Trades land in the Journal with contract, stake, payout and result. Today's roll-up is in the performance strip.",
    "<b>Stop it with STOP ENGINE</b> when you want the machine back. Ownership of the account is released, so the FAB or a bot can then start.",
], 1):
    numli(i, t)
gap(3)

h2("What the 13 agents actually do")
p("Each scan runs a staged pipeline. Agents that can work in parallel do; the decision at the end consumes all of them.")
story.append(table(cells([
    ["Stage", "Agents", "Job, in plain words"],
    ["1", "Feature Engineering", "Turns the raw tick stream into the windows, streaks and digit matrices everything else reads."],
    ["2", "Market Scanner · Tick Intelligence · Market Regime", "Is this market worth trading, what are the last ticks really doing, and is the tape trending, choppy or violent?"],
    ["3", "Digit Probability · Rise/Fall · Portfolio Manager · Recovery Intelligence", "Per-contract maths: digit and direction odds, how a stake fits the account, and what the open recovery debt demands."],
    ["3.5", "Duration Optimizer", "Chooses the tick count for the contract rather than always using the default."],
    ["4", "EV Calculator", "Converts probability and payout into expected value, and that into a stake."],
    ["5", "Risk Intelligence · Execution Timing · Learning Agent", "Circuit-breakers, whether this instant is the right instant, and what past results say."],
    ["6", "Pattern Discovery · Confidence Fusion", "Recurring shapes in the tape, then one weighted confidence number from every opinion above."],
    ["7", "Trade Explainability", "The human-readable “why this trade”, shown on the card and in the journal."],
    ["8", "Master Decision", "Trade or pass — the only component that fires."],
], [12 * mm, 52 * mm, CW - 64 * mm])))
gap(4)
h3("Limits that stop it for you")
story.append(table(cells([
    ["Setting (default)", "Effect when reached"],
    ["<b>Daily Loss Limit</b> (2,999)", "Trading halts for the day; the dashboard says <i>Loss limit hit — trading paused</i>."],
    ["<b>Daily Profit Target</b> (5,000)", "Stops on target. Note the default assumes a large account — lower it before a small one runs live."],
    ["<b>Consecutive Loss Limit</b> (4)", "Cooldown starts, then auto-resume; the banner explains why."],
    ["<b>Max Drawdown</b> (10 %)", "Stops if the portfolio drops by this percentage."],
    ["<b>Min Confidence Threshold</b> (50)", "Any signal below this is discarded. The Intelligence page can raise it automatically from your realised win rate."],
    ["<b>Max Stake Per Trade</b> (500)", "Hard cap per trade regardless of balance or recovery maths."],
], [52 * mm, CW - 52 * mm])))
gap(3)
story.append(callout_box(
    "Recovery is <b>on by default</b> (Recovery Mode, multiplier 1.62, 3 steps). In <b>Auto</b> calculator mode the multiplier is "
    "not even read — the stake is recomputed from live debt and the live payout. Switch to <b>Manual</b> and that 1.62 becomes "
    "literal and compounding: ×1.62, then ×2.62, then ×4.23 of base stake. Do not flip that switch until you have watched a "
    "session in Auto.", kind="warn", title="Recovery defaults"))
story.append(PageBreak())

# ══════════════════════════════════════════════════════════════════════════════
#  4 — FAB
# ══════════════════════════════════════════════════════════════════════════════
h1("4 · The NeuroAI Quantum FAB")
p("The lightning-bolt button pinned to the bottom-right of every screen opens a self-contained fast engine — a separate, more "
  "aggressive strategy that scans, decides and executes on a one-tick rhythm. It keeps its own settings inside the panel "
  "(it does not read the Dashboard's engine settings for its own risk numbers) and it competes for the same single "
  "execution lock, so the main engine must be stopped first.")
gap(2)
gap(6)
story.append(Shot("fab", CW, 47 * mm, paint_fab, "Figure 3 — the FAB panel through its four steps"))
gap(4)
h3("The controls, and what they change")
story.append(table(cells([
    ["Control", "What it does"],
    ["<b>Normal Trade Strategy</b>", "Which contract family it hunts for ordinary trades: <b>Over &amp; Under</b> (digit barriers), "
     "<b>Rise &amp; Fall</b> (direction), <b>Even &amp; Odd</b> (parity) or <b>Differs</b> (cold-digit avoidance, ~96 % win rate at a 1.09× payout)."],
    ["<b>Normal barriers</b>", "The OVER and UNDER digits when that family is armed. The default OVER 1 / UNDER 8 sits near an ~80 % hit rate for a small payout."],
    ["<b>Sniper Recovery Strategy</b>", "Which families may be used while recovering, separately from the normal choice — including <b>Matches</b> at 8.93×, which is the fastest way out of a small debt and the fastest way to grow a big one."],
    ["<b>Recovery auto mode</b>", "On = the stake is computed from live debt and live payout. Off = your multiplier, compounded per step."],
    ["<b>Base stake / Take profit / Stop loss</b>", "Session risk for the FAB alone. Base stake has a 0.35 floor to stay above Deriv's minimum."],
    ["<b>Market mode</b>", "<b>Locked</b> trades one chosen asset only; <b>Smart switching</b> lets the engine rotate to wherever the edge is."],
], [42 * mm, CW - 42 * mm])))
gap(3)
h3("How it decides — one paragraph, no marketing")
p("The scan blends a second-order Bayesian Markov model over digit transitions (with a Dirichlet prior so a cold digit is "
  "not trusted on two appearances), Shannon entropy to reject noise-shaped streams, a geometric hazard model that asks "
  "whether a run of repeated digits is <i>due to break</i> rather than whether it is long, lag-1 autocorrelation and "
  "micro-tick acceleration for direction, and an expected-value gate that requires the blended probability to clear the "
  "contract's own break-even. Recovery adds a four-window concurrence check — the same edge has to appear over 15, 30, 60 "
  "and 100 ticks — before an escalated stake is allowed.")
gap(2)
story.append(callout_box(
    "If the result screen says <b>No Decisive Edge Found</b>, the honest move is <b>Re-Scan</b> or walk away. Deploying anyway "
    "converts a statistical engine into a coin flip with a house margin.", kind="tip", title="The scan result is allowed to say no"))
story.append(PageBreak())

# ══════════════════════════════════════════════════════════════════════════════
#  5 — BOTS
# ══════════════════════════════════════════════════════════════════════════════
h1("5 · The AI Bots — five single-contract specialists")
p("Each bot trades exactly one contract family and spends its whole analysis budget there. That is the entire premise: "
  "a generalist splits its statistics across six families, so a specialist gets sharper estimates for the one it owns — "
  "and the app copies the FAB's formulas rather than reusing its session, so a bot's numbers stay comparable to the FAB's "
  "without inheriting its execution.")
gap(2)
gap(6)
story.append(Shot("bots", CW, 40 * mm, paint_bots, "Figure 4 — the arena and a deploy console"))
gap(4)
story.append(table(cells([
    ["Bot", "Contract", "Nominal odds", "The specific edge it buys"],
    ["<b>Parity Sentinel</b>", "Even / Odd", "≈50 % · 1.95×", "Reads parity as its own two-state process instead of summing five cells of a ten-state digit matrix — about five times the evidence per state — and a runs test says whether the stream clusters or alternates, which decides <i>which side</i>."],
    ["<b>Differ Guardian</b>", "Differs", "≈96 % · 1.09×", "At 1.09× the break-even win rate is 91.7 %, so the loss side is everything: digits are ranked by the <i>upper</i> confidence bound of their appearance rate and any digit whose worst case still breaks even is refused. A digit seen three times in six ticks is never traded against."],
    ["<b>Match Sniper</b>", "Matches", "≈11 % · 8.93×", "Hunts the digit whose dormancy has reached its own historical breaking point, fitted from that digit's gap history — and only believes a digit that survives a false-discovery-rate correction across all ten candidates."],
    ["<b>Barrier Architect</b>", "Over / Under", "10–90 % · 1.09–8.93×", "Analyses the tail-membership series rather than raw digits, scores how fragile the tail edge is (one digit carrying it is penalised) and watches mass sitting just on the losing side of the barrier for near-miss instability."],
    ["<b>Vector Momentum</b>", "Rise / Fall", "≈50 % · 1.92×", "Estimates a Hurst exponent by rescaled-range analysis and reads a lag-1..3 autocorrelation vector, so a two-cycle tape is not mistaken for a trend — then refuses flat, dead-chop markets outright."],
], [30 * mm, 22 * mm, 26 * mm, CW - 78 * mm])))
gap(4)
h3("Deploy console, in order")
numli(1, "<b>Side mode.</b> Bots with two sides offer <i>both</i> (analyse each, execute the favoured one) or lock to a single side. Digit bots offer a <b>digit lock</b>: auto-pick, or force one digit.")
numli(2, "<b>Barriers / digits.</b> Only shown where the family has them (OVER/UNDER digits for Barrier Architect).")
numli(3, "<b>Risk.</b> Base stake, take profit, stop loss — session-scoped, like the FAB.")
numli(4, "<b>Recovery.</b> Mode, multiplier, max steps, plus the bot's recovery markup on debt (default <b>10 %</b>): a recovery stake is sized so one win clears all debt <i>plus</i> that percentage as profit, instead of using the general recovery target that suits high-payout contracts badly.")
numli(5, "<b>Scan markets.</b> Scores the candidate markets live (progress streams while it works), then <b>Deploy</b> starts the session; <b>Stop</b> ends it and releases the lock.")
gap(3)
story.append(callout_box(
    "Every bot entry is measured against the contract's <b>break-even</b> win rate (1 ÷ payout), never against 50 %. A 60 % "
    "hit rate on a 1.09× Differs is a long-term loss. The gates are deliberately strict — parity and momentum need "
    "0.75 σ of margin over break-even, a 1-digit barrier tail needs 1.25 σ, and Matches need 1.5 σ because picking the "
    "best of ten digits flatters the estimate. Few, late, boring trades are the intended behaviour.",
    kind="tip", title="Why a bot may do nothing for a long time"))
gap(7)

# ══════════════════════════════════════════════════════════════════════════════
#  6 — MANUAL
# ══════════════════════════════════════════════════════════════════════════════
h1("6 · Manual mode, Markets, and reading your results")
h3("Manual mode")
p("The status line reads <b>MANUAL MODE</b> whenever no engine holds execution — that is the whole definition. Nothing is "
  "placed for you, but the analysis keeps running, which is the point: manual mode is for taking the machine's read and "
  "pulling the trigger yourself.")
numli(1, "Open <b>Markets</b> and pick a market (or press <b>Analyse market</b> on the dashboard's top-opportunity card).")
numli(2, "On the market page, the contract buttons carry the pipeline's opinion directly: <font color='#15803d'><b>AI FAVOURS · 5t</b></font> "
         "on the favoured side, plus the recommended duration.")
numli(3, "Clicking Rise/Fall or Even/Odd <b>auto-fills the stake and tick count</b> from the agent output, so you confirm a size rather than compute one.")
numli(4, "The per-market panel shows signal strength and the AI signal sentence, and a manual trade is scored by the same "
         "assist path the engines use — <i>trades/assist</i> runs the Quantum timing on your chosen entry so the outcome lands in the same journal and the same recovery ledger.")
gap(3)
h3("Markets and the market page")
p("The market list is sorted by the scanner's ranking, so the top row is where the engine is looking. Each row shows the "
  "quality, confidence and risk scores and the detected trend; opening a market gives the live tick stream, the digit "
  "distribution, and the contract-by-contract read. This is also where you sanity-check what an engine is doing before "
  "blaming the settings.")
gap(3)
h3("Journal · Analytics · Intelligence · Risk Calc")
story.append(table(cells([
    ["Screen", "Use it for"],
    ["<b>Journal</b>", "The factual record: every trade with market, contract, stake, payout, result, which engine placed it, and whether it was part of a recovery sequence. Start any review here."],
    ["<b>Analytics</b>", "All-time aggregates, so you can see whether today was noise or a trend — and separate performance by contract family and market."],
    ["<b>Intelligence</b>", "What the app learned from your trades: missed opportunities it would have taken, the confidence threshold it recommends from realised win rate, and generated reports. This is the page that argues with your settings."],
    ["<b>Risk Calc</b>", "Sizing arithmetic on its own: stake per trade and what a recovery ladder costs. Use it before you accept a multiplier, not after."],
], [28 * mm, CW - 28 * mm])))
gap(6)
h2("Choosing how to trade — the four paths side by side")
story.append(table(cells([
    ["", "Autonomous engine", "NeuroAI FAB", "AI Bots", "Manual"],
    ["<b>Who places the trade</b>", "The 13-agent pipeline, every scan interval",
     "The bolt panel, tick by tick", "One specialist, its own loop", "You, from the market page"],
    ["<b>Contract choice</b>", "Any family you allow in Settings", "One normal family you pick in the panel",
     "Hard-locked to that bot's single family", "Whatever you click"],
    ["<b>Stake source</b>", "Risk Amount / Percentage in Settings", "Base stake in the panel",
     "Base stake in the console", "You set it, auto-filled on request"],
    ["<b>Recovery</b>", "Shared ledger, Auto calculator by default", "Shared ledger, its own multiplier fields",
     "Shared ledger + bot markup on debt", "Recorded into the same ledger"],
    ["<b>Best used for</b>", "Hands-off sessions; the broadest market coverage",
     "Fast, focused action on one family", "Squeezing one contract type properly", "Learning what the AI sees, at your own pace"],
    ["<b>Watch out for</b>", "It inherits the global Daily Limits", "Its panel risk values are separate",
     "May idle for a long time — by design", "Nothing pauses for you; limits are yours"],
], [26 * mm, (CW - 26 * mm) / 4, (CW - 26 * mm) / 4, (CW - 26 * mm) / 4, (CW - 26 * mm) / 4])))
gap(4)
story.append(callout_box(
    "Whichever path you choose, the same three numbers decide whether a bad day stays survivable: <b>Daily Loss Limit</b>, "
    "<b>Max Stake Per Trade</b> and whether <b>Paper Trade Mode</b> is still on. Change one at a time, and give each change a "
    "full session before the next.", kind="warn", title="The only three settings that matter on day one"))

story.append(PageBreak())

# ══════════════════════════════════════════════════════════════════════════════
#  7 — SETTINGS + FAQ
# ══════════════════════════════════════════════════════════════════════════════
h1("7 · Settings reference, then troubleshooting")
p("The six cards, with the shipped defaults read from this install. Values are stored per browser session, which is why a "
  "fresh profile starts at these numbers.")
story.append(table(cells([
    ["Setting (card · field)", "Default", "What it does / when to touch it"],
    ["<b>Risk Profile</b> · Profile preset", "Moderate", "Feeds the stake-sizing multiplier. A preset, not an override."],
    ["Risk Amount Type / Value", "Fixed · 1.00", "Per-trade risk as a fixed amount or a percentage of the connected balance."],
    ["Max Stake Per Trade", "500", "Hard cap per trade, regardless of balance or recovery maths."],
    ["<b>Daily Limits</b> · Profit Target / Loss Limit", "5,000 / 2,999", "Stop on target; halt for the day on limit. Both are scaled for a large account — <b>reduce them first</b>."],
    ["Max Drawdown · Consecutive Losses · Cooldown", "10 % · 4 · 1 min", "Portfolio stop, then a timed pause with a countdown and <i>Resume Now</i>."],
    ["<b>Engine Config</b> · Paper Trade Mode", "<font color='#b91c1c'><b>OFF</b></font>", "<b>Turn ON first.</b> Off means an engine sends live orders the moment it finds an entry."],
    ["Require Positive EV · Min Confidence Threshold", "ON · 50", "The two quality dials. Raise the threshold for fewer, better trades; lower it for more noise."],
    ["Scan Interval · Trade Duration · Scan All Markets", "1 s · 5 t · ON", "How often it re-evaluates, default contract length (the Duration Optimizer may override), and market scope."],
    ["<b>Recovery</b> · Enable · Calculator mode", "ON · Auto", "One global, account-level debt state shared by all three engines. Auto sizes the stake from live debt and payout — <b>the multiplier field is not read</b>."],
    ["Recovery Method · Max Recovery Steps", "Split · 3", "Split never stakes more than one base stake per attempt and carries debt forward; Instant tries to clear it in one win."],
    ["Recovery Multiplier (Manual mode only)", "1.62×", "Used literally and compounded per step: ×1.62 → ×2.62 → ×4.23 of base stake."],
    ["<b>Barriers</b> · Normal OVER / UNDER", "1 / 8", "≈80 % hit rate for a small payout. Recovery uses OVER 3 / UNDER 6 with live proposals beating the fallback."],
    ["<b>Contract Mode</b>", "All selected", "All selected lets the AI pick the best contract per opportunity; Selective restricts it to your categories."],
], [52 * mm, 24 * mm, CW - 76 * mm])))
gap(5)
h2("Troubleshooting")
story.append(table(cells([
    ["Symptom", "What it means"],
    ["Engine will not start; error mentions another engine", "Another engine owns execution. Stop the FAB or the bot (or the main engine) and retry."],
    ["Header shows <b>SIM DATA</b>", "No live tick socket. Prices are simulated; the UI works, but results are not market-settled."],
    ["“Connect Deriv Account” badge stays in the header", "No account attached to this browser session, so nothing can trade."],
    ["Lots of “skipped”, no trades", "Working as intended: EV and confidence gates. Lower <i>Min Confidence Threshold</i> only if you want more noise."],
    ["Cooldown banner right after starting", "You are resuming into an open streak. Check the loss limit and the recovery settings before resuming again."],
    ["Trades look identical to a bad day last week", "Recovery debt persists across engines. The recovery card on the dashboard can clear it deliberately."],
], [46 * mm, CW - 46 * mm])))
gap(5)
h2("Replacing these diagrams with real screenshots")
p("The figures above are drawn schematics, labelled as such — they match the live layout but they are not captures of it. "
  "To swap in real screenshots, run the capture script from the repository root on a machine with a browser and the dev "
  "server up:")
code = Table([[Paragraph(
    "<font face='Courier-Bold'>npm i -D playwright &amp;&amp; npx playwright install chromium</font><br/>"
    "<font face='Courier-Bold'>node docs/guide/capture-screenshots.mjs</font>", S["call"])],
    [Paragraph("It writes <font face='Courier'>docs/guide/shots/&lt;name&gt;.png</font> for each screen. Re-run "
               "<font face='Courier'>python3 docs/guide/build_user_guide.py</font> and every diagram that has a matching PNG is "
               "replaced by that screenshot, with a green “● screenshot” tag so the guide always says which is which.", S["call"])]],
    colWidths=[CW])
code.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), HexColor("#f6f9fb")),
                          ("BOX", (0, 0), (-1, -1), 0.5, LINE),
                          ("INNERGRID", (0, 0), (-1, -1), 0.4, HexColor("#e8edf3")),
                          ("LEFTPADDING", (0, 0), (-1, -1), 8), ("RIGHTPADDING", (0, 0), (-1, -1), 8),
                          ("TOPPADDING", (0, 0), (-1, -1), 6), ("BOTTOMPADDING", (0, 0), (-1, -1), 6)]))
story.append(code)
gap(4)
small("Figure slots in this edition: <font face='Courier'>dashboard</font> · "
      "<font face='Courier'>fab</font> · <font face='Courier'>bots</font> · "
      "<font face='Courier'>architecture</font>. The capture script also saves the other screens, ready for new figures.")

# ══════════════════════════════════════════════════════════════════════════════
#  BUILD
# ══════════════════════════════════════════════════════════════════════════════
def _footer(c, doc, first=False):
    c.saveState()
    if not first:
        c.setStrokeColor(HexColor("#e3e8ef"))
        c.setLineWidth(0.5)
        c.line(M, 12.4 * mm, PAGE_W - M, 12.4 * mm)
    c.setFont("Helvetica", 6.8)
    c.setFillColor(MUTED)
    c.drawString(M, 9 * mm, "NeuroTrade AI — User Guide · quick start")
    c.drawRightString(PAGE_W - M, 9 * mm, f"page {doc.page}")
    c.restoreState()


class Doc(BaseDocTemplate):
    def afterFlowable(self, flowable):
        pass


doc = Doc(OUT, pagesize=A4, leftMargin=M, rightMargin=M, topMargin=M, bottomMargin=20 * mm,
          title="NeuroTrade AI — User Guide (Quick Start)", author="NeuroTrade AI")


def on_page(c, d):
    _footer(c, d, first=(d.page == 1))


def on_cover(c, d):
    paint_cover(c, d)
    _footer(c, d, first=True)


frame = Frame(M, 20 * mm, CW, PAGE_H - M - 20 * mm, id="body")
cover_frame = Frame(M, 20 * mm, CW, PAGE_H - 48 * mm - 20 * mm, id="cover")
doc.addPageTemplates([PageTemplate(id="cover", frames=[cover_frame], onPage=on_cover),
                      PageTemplate(id="body", frames=[frame], onPage=on_page)])

story.insert(0, NextPageTemplate("body"))
doc.build(story)
print("built:", OUT, "| pages:", doc.page)

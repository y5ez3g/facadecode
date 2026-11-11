#!/usr/bin/env python3
"""Rebuild Facade's robot icons (CONFIGURATION-2.4, LIFECYCLE-2.2).

A robot is a round face in a gradient with two black eyes; `"icon": "facade-<id>"`
picks one, and a custom entry without an icon shows facade-pearl. Each of ROBOTS is
drawn twice from the one drawing below:

- media/agents/robot-<id>.svg, the image pickers show; a card shows the same face as
  robot-<id>-face.svg with media/agents/robot-eyes.svg over it, so that its eyes can
  look toward the pointer;
- a glyph of media/robots.woff, the icon a terminal tab shows, as a tab takes only
  font icons. COLR v1 keeps its gradient, shine and eyes; its outline - the face with
  its eyes cut out - is the monochrome fallback.

ROBOTS is src/base/robot.ts's ROBOTS, in its order. Asset maintenance only; neither
packaging nor runtime needs Python. In a temporary venv install fonttools==4.60.1,
then run this file. The robot is Facade Code's own drawing; no other font is used.
"""

import math
from pathlib import Path

from fontTools.colorLib.builder import buildCOLR, buildCPAL
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.cu2quPen import Cu2QuPen
from fontTools.pens.reverseContourPen import ReverseContourPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib.tables import otTables as ot

ROOT = Path(__file__).resolve().parent.parent
# Each robot's gradient, from its top left to its bottom right
ROBOTS = [
    ("red", "#F87171", "#DC2626"), ("orange", "#FB923C", "#EA580C"), ("amber", "#FCD34D", "#F59E0B"),
    ("lime", "#BEF264", "#65A30D"), ("green", "#4ADE80", "#16A34A"), ("teal", "#5EEAD4", "#0D9488"),
    ("sky", "#7DD3FC", "#0284C7"), ("blue", "#93C5FD", "#2563EB"), ("violet", "#C4B5FD", "#7C3AED"),
    ("pink", "#F9A8D4", "#DB2777"), ("aurora", "#7C3AED", "#06B6D4"), ("sunset", "#FF6B6B", "#FECA57"),
    ("ocean", "#10B981", "#0EA5E9"), ("orchid", "#F472B6", "#8B5CF6"), ("pearl", "#FAFAFA", "#A1A1AA"),
    ("graphite", "#71717A", "#27272A"),
]
# Every robot's eyes, black on any of its colors
EYE = "#141414"
WHITE = "#FFFFFF"
# The drawing, 32 units across: each eye's center, its width and length and its tilt; the shine's center and reach
EYES = [(14.2, 15.0), (20.6, 13.4)]
EYE_WIDTH, EYE_LENGTH, TILT = 3.8, 8.4, 24
SHINE = (0.32, 0.26, 0.75)
SHINE_ALPHA = 0.38
# The glyph box of Facade's other icon fonts: 1024 units wide, 896 above the baseline and 128 below, shown in a 16px slot
CENTER = (512, 384)
RADIUS = 480
SCALE = RADIUS / 16
FIRST = 0xE200
K = 0.5522847498


def channels(color):
    return tuple(int(color[at:at + 2], 16) for at in (1, 3, 5))


def eyes_svg():
    """The two eyes alone, where the face has them: what a card moves over the face."""
    return "".join(f'<rect x="{x - EYE_WIDTH / 2:.2f}" y="{y - EYE_LENGTH / 2:.2f}" width="{EYE_WIDTH}" height="{EYE_LENGTH}" rx="{EYE_WIDTH / 2}" '
                   f'fill="{EYE}" transform="rotate(-{TILT} {x} {y})"/>' for x, y in EYES)


def svg(top, bottom, eyes=True):
    return ('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><defs>'
            f'<linearGradient id="fill" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="{top}"/><stop offset="1" stop-color="{bottom}"/></linearGradient>'
            f'<radialGradient id="shine" cx="{SHINE[0]}" cy="{SHINE[1]}" r="{SHINE[2]}"><stop offset="0" stop-color="#FFFFFF" stop-opacity="{SHINE_ALPHA}"/>'
            '<stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/></radialGradient></defs>'
            f'<circle cx="16" cy="16" r="16" fill="url(#fill)"/><circle cx="16" cy="16" r="16" fill="url(#shine)"/>{eyes_svg() if eyes else ""}</svg>\n')


def circle(pen):
    """The face: four cubic quarters, clockwise from its top, as TrueType fills an outline."""
    x, y = CENTER
    r, k = RADIUS, K * RADIUS
    pen.moveTo((x, y + r))
    pen.curveTo((x + k, y + r), (x + r, y + k), (x + r, y))
    pen.curveTo((x + r, y - k), (x + k, y - r), (x, y - r))
    pen.curveTo((x - k, y - r), (x - r, y - k), (x - r, y))
    pen.curveTo((x - r, y + k), (x - k, y + r), (x, y + r))
    pen.closePath()


def eye(pen, center):
    """An eye: a pill, clockwise, tilted as the image tilts it - the image's y runs down, the font's up."""
    cx = CENTER[0] + (center[0] - 16) * SCALE
    cy = CENTER[1] - (center[1] - 16) * SCALE
    a = EYE_WIDTH / 2 * SCALE
    b = (EYE_LENGTH - EYE_WIDTH) / 2 * SCALE
    turn = math.radians(TILT)

    def at(x, y):
        return (round(cx + x * math.cos(turn) - y * math.sin(turn), 2), round(cy + x * math.sin(turn) + y * math.cos(turn), 2))
    k = K * a
    pen.moveTo(at(a, b))
    pen.lineTo(at(a, -b))
    pen.curveTo(at(a, -b - k), at(k, -b - a), at(0, -b - a))
    pen.curveTo(at(-k, -b - a), at(-a, -b - k), at(-a, -b))
    pen.lineTo(at(-a, b))
    pen.curveTo(at(-a, b + k), at(-k, b + a), at(0, b + a))
    pen.curveTo(at(k, b + a), at(a, b + k), at(a, b))
    pen.closePath()


def main():
    for robot, top, bottom in ROBOTS:
        (ROOT / "media" / "agents" / f"robot-{robot}.svg").write_text(svg(top, bottom), encoding="utf-8")
        (ROOT / "media" / "agents" / f"robot-{robot}-face.svg").write_text(svg(top, bottom, eyes=False), encoding="utf-8")
    (ROOT / "media" / "agents" / "robot-eyes.svg").write_text(
        f'<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">{eyes_svg()}</svg>\n', encoding="utf-8")

    built = {".notdef": TTGlyphPen(None).glyph()}
    face = TTGlyphPen(None)
    circle(Cu2QuPen(face, 0.5))
    built["face"] = face.glyph()
    eyes = TTGlyphPen(None)
    for center in EYES:
        eye(Cu2QuPen(eyes, 0.5), center)
    built["eyes"] = eyes.glyph()
    cut = TTGlyphPen(None)
    circle(Cu2QuPen(cut, 0.5))
    for center in EYES:
        eye(ReverseContourPen(Cu2QuPen(cut, 0.5)), center)
    built["cut"] = cut.glyph()

    palette = []

    def index(color):
        if color not in palette:
            palette.append(color)
        return palette.index(color)
    # The image's box, in font units: its gradient runs from the top left to the bottom right, its shine sits up to the left
    left, right, top_y, bottom_y = CENTER[0] - RADIUS, CENTER[0] + RADIUS, CENTER[1] + RADIUS, CENTER[1] - RADIUS
    span = 2 * RADIUS
    shine_x, shine_y, shine_r = left + SHINE[0] * span, top_y - SHINE[1] * span, SHINE[2] * span
    paints = {}
    mapping = {}
    for number, (robot, top, bottom) in enumerate(ROBOTS):
        name = f"robot.{robot}"
        fallback = TTGlyphPen(built)
        fallback.addComponent("cut", (1, 0, 0, 1, 0, 0))
        built[name] = fallback.glyph()
        white = index(WHITE)
        paints[name] = {
            "Format": ot.PaintFormat.PaintColrLayers,
            "Layers": [
                {"Format": ot.PaintFormat.PaintGlyph, "Glyph": "face", "Paint": {
                    "Format": ot.PaintFormat.PaintLinearGradient,
                    "ColorLine": {"ColorStop": [{"StopOffset": 0.0, "PaletteIndex": index(top), "Alpha": 1.0},
                                                {"StopOffset": 1.0, "PaletteIndex": index(bottom), "Alpha": 1.0}]},
                    # From the top left to the bottom right, its colors constant across that line: p2 at a right angle to p0p1
                    "x0": left, "y0": top_y, "x1": right, "y1": bottom_y, "x2": right, "y2": top_y + span}},
                {"Format": ot.PaintFormat.PaintGlyph, "Glyph": "face", "Paint": {
                    "Format": ot.PaintFormat.PaintRadialGradient,
                    "ColorLine": {"ColorStop": [{"StopOffset": 0.0, "PaletteIndex": white, "Alpha": SHINE_ALPHA},
                                                {"StopOffset": 1.0, "PaletteIndex": white, "Alpha": 0.0}]},
                    "x0": round(shine_x), "y0": round(shine_y), "r0": 0, "x1": round(shine_x), "y1": round(shine_y), "r1": round(shine_r)}},
                {"Format": ot.PaintFormat.PaintGlyph, "Glyph": "eyes", "Paint": {
                    "Format": ot.PaintFormat.PaintSolid, "PaletteIndex": index(EYE), "Alpha": 1.0}},
            ],
        }
        mapping[FIRST + number] = name

    font = FontBuilder(832, isTTF=True)
    font.setupGlyphOrder(list(built))
    font.setupCharacterMap(mapping)
    font.setupGlyf(built)
    font.setupHorizontalMetrics({name: (1024, getattr(glyph, "xMin", 0)) for name, glyph in built.items()})
    font.setupHorizontalHeader(ascent=896, descent=-128)
    font.setupNameTable({
        "familyName": "Facade Robots", "styleName": "Regular", "uniqueFontIdentifier": "FacadeRobots-2",
        "fullName": "Facade Robots", "psName": "FacadeRobots", "copyright": "Robot icons by Facade Code"
    })
    font.setupOS2(sTypoAscender=896, sTypoDescender=-128, usWinAscent=896, usWinDescent=128)
    font.setupPost()
    font.font["COLR"] = buildCOLR(paints, version=1, glyphMap=font.font.getReverseGlyphMap())
    font.font["CPAL"] = buildCPAL([[tuple(channel / 255 for channel in channels(color)) + (1.0,) for color in palette]])
    font.font["head"].created = font.font["head"].modified = 3786912000
    font.font.recalcTimestamp = False
    font.font.flavor = "woff"
    font.save(ROOT / "media" / "robots.woff")
    print("wrote", len(ROBOTS), "robots: media/agents/robot-*.svg, their faces, robot-eyes.svg and media/robots.woff from", hex(FIRST))


if __name__ == "__main__":
    main()

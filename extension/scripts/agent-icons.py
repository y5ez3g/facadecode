#!/usr/bin/env python3
"""Rebuild the terminal icon font from the shipped logos (LIFECYCLE-2.2).

Asset maintenance only; neither packaging nor runtime needs Python. In a temporary
venv install fonttools==4.60.1 and pillow==11.3.0, then run this file. COLR v0 keeps
brand colors; palette index 0xffff uses the native theme's foreground. The glyf
outlines also provide a monochrome fallback. PNG sources become 64px color layers,
four times the normal tab icon size, without a platform-specific bitmap table.
"""

from pathlib import Path
import xml.etree.ElementTree as ET

from fontTools.colorLib.builder import buildCOLR, buildCPAL
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.cu2quPen import Cu2QuPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.svgLib.path import parse_path
from PIL import Image, ImageColor

ROOT = Path(__file__).resolve().parent.parent
SOURCES = ROOT / "media" / "agents"
# Each icon's shipped logo, the dark theme's where it has two, in the font's order. A PNG is drawn
# from its pixels, an SVG from its paths.
LOGOS = {
    "claude": "claude.svg",
    "codex": "codex-dark.svg",
    "agy": "antigravity.png",
    "muse": "muse.png",
    "opencode": "opencode-dark.svg",
    "pi": "pi.svg",
    "devin": "devin-dark.svg",
    "agent": "cursor-dark.svg",
    "kiro-cli": "kiro.svg",
    "qoder": "qoder.svg",
    "omp": "omp.png",
    "copilot": "copilot-dark.svg",
}
ICONS = list(LOGOS)
# The one-color logos, drawn in the theme's foreground.
MONOCHROME = ("codex", "devin", "agent", "copilot")
# A color that each logo draws in the theme's foreground instead.
FOREGROUND = {"opencode": "#FFFFFF"}
GLYPHS = {".notdef": TTGlyphPen(None).glyph()}
LAYERS = {}
PALETTE = []


def palette(color):
    if color is None:
        return 0xffff
    rgba = tuple(channel / 255 for channel in color)
    if rgba not in PALETTE:
        PALETTE.append(rgba)
    return PALETTE.index(rgba)


def glyph(icon):
    """A glyph name of letters, digits and periods only."""
    return icon.replace("-", "_")


def layer(icon, pen, color):
    name = f"{glyph(icon)}.{len(LAYERS[icon])}"
    GLYPHS[name] = pen.glyph()
    LAYERS[icon].append((name, palette(color)))


def vector(icon, filename):
    svg = ET.parse(SOURCES / filename).getroot()
    x, y, width, height = map(float, svg.attrib["viewBox"].split())
    scale = 1024 / max(width, height)
    # A view box narrower or shorter than it is long sits in the middle of the glyph's square.
    across, down = (1024 - width * scale) / 2, (1024 - height * scale) / 2
    transform = (scale, 0, 0, -scale, across - x * scale, 896 - down + y * scale)
    for node in svg.findall("{http://www.w3.org/2000/svg}path"):
        pen = TTGlyphPen(None)
        parse_path(node.attrib["d"], TransformPen(Cu2QuPen(pen, 0.5, reverse_direction=True), transform))
        fill = node.attrib.get("fill", svg.attrib.get("fill"))
        color = ImageColor.getrgb(fill) + (255,)
        if icon in MONOCHROME or fill == FOREGROUND.get(icon):
            color = None
        elif icon == "opencode":
            color = (128, 128, 128, 255)
        layer(icon, pen, color)


def bitmap(icon, filename):
    source = Image.open(SOURCES / filename).convert("RGBA").resize((64, 64), Image.Resampling.LANCZOS)
    pixels = source.quantize(colors=128, method=Image.Quantize.FASTOCTREE).convert("RGBA")
    pens = {}
    for y in range(64):
        x = 0
        while x < 64:
            color = pixels.getpixel((x, y))
            end = x + 1
            while end < 64 and pixels.getpixel((end, y)) == color:
                end += 1
            if color[3]:
                pen = pens.setdefault(color, TTGlyphPen(None))
                left, right, top, bottom = x * 16, end * 16, 896 - y * 16, 880 - y * 16
                pen.moveTo((left, bottom))
                pen.lineTo((left, top))
                pen.lineTo((right, top))
                pen.lineTo((right, bottom))
                pen.closePath()
            x = end
    for color, pen in pens.items():
        layer(icon, pen, color)


for icon in ICONS:
    LAYERS[icon] = []
    if LOGOS[icon].endswith(".png"):
        bitmap(icon, LOGOS[icon])
    else:
        vector(icon, LOGOS[icon])
    fallback = TTGlyphPen(GLYPHS)
    for name, _ in LAYERS[icon]:
        fallback.addComponent(name, (1, 0, 0, 1, 0, 0))
    GLYPHS[glyph(icon)] = fallback.glyph()

# Native terminal labels render contributed glyphs at 13px, but reserve the same
# 16px icon slot used by image logos. Keep the original viewBox at 16px in that slot.
font = FontBuilder(832, isTTF=True)
font.setupGlyphOrder(list(GLYPHS))
font.setupCharacterMap({0xe001 + i: glyph(icon) for i, icon in enumerate(ICONS)})
font.setupGlyf(GLYPHS)
font.setupHorizontalMetrics({name: (1024, getattr(glyph, "xMin", 0)) for name, glyph in GLYPHS.items()})
font.setupHorizontalHeader(ascent=896, descent=-128)
    font.setupNameTable({"familyName": "Facade Agent Icons", "styleName": "Regular", "uniqueFontIdentifier": "FacadeAgentIcons-1", "fullName": "Facade Agent Icons", "psName": "FacadeAgentIcons"})
font.setupOS2(sTypoAscender=896, sTypoDescender=-128, usWinAscent=896, usWinDescent=128)
font.setupPost()
font.font["COLR"] = buildCOLR({glyph(icon): layers for icon, layers in LAYERS.items()}, version=0, glyphMap=font.font.getReverseGlyphMap())
font.font["CPAL"] = buildCPAL([PALETTE])
font.font["head"].created = font.font["head"].modified = 3786912000
font.font.recalcTimestamp = False
font.font.flavor = "woff"
font.save(ROOT / "media" / "agent-icons.woff")

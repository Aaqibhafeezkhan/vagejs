"""Embeds a subset of Space Grotesk Bold into the VAGE JS logo SVG.

Maintainer tool (not shipped). Usage:
  python -I scripts/brand/embed-logo-font.py <SpaceGrotesk[wght].ttf> <logo-in.svg> <logo-out.svg>
Requires fontTools and brotli. Font: SIL Open Font License 1.1 (assets/brand/fonts/OFL.txt).
"""
import base64
import io
import re
import sys

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

font_path, svg_in, svg_out = sys.argv[1:4]
svg = open(svg_in, encoding="utf-8").read()

# Only the characters the logo text uses.
text = "".join(re.findall(r">([^<>]+)<", svg.split("<text", 1)[1]))
chars = "".join(sorted(set(text.strip())))

font = instancer.instantiateVariableFont(TTFont(font_path), {"wght": 700})
options = subset.Options()
options.flavor = "woff2"
options.name_IDs = ["*"]  # keep copyright / license names (OFL requirement)
options.name_languages = ["*"]
options.layout_features = ["*"]
subsetter = subset.Subsetter(options)
subsetter.populate(text=chars)
subsetter.subset(font)
buf = io.BytesIO()
font.flavor = "woff2"
font.save(buf)
data = base64.b64encode(buf.getvalue()).decode()

style = (
    "<style>/* Space Grotesk Bold, subset to \"" + chars + "\". Copyright 2020 The Space Grotesk Project Authors. "
    "SIL Open Font License 1.1: https://openfontlicense.org */"
    "@font-face{font-family:'Space Grotesk';font-weight:700;src:url(data:font/woff2;base64," + data + ") format('woff2')}</style>"
)
# Modifying the file invalidates the embedded C2PA signature, so the stale manifest is removed.
svg = re.sub(r"<metadata>.*?</metadata>", "", svg, flags=re.S)
svg = re.sub(r'\s*xmlns:c2pa="[^"]*"', "", svg)
svg = svg.replace(">", ">" + style, 1)
open(svg_out, "w", encoding="utf-8").write(svg)
print(f"embedded {len(buf.getvalue())} bytes of WOFF2 for {chars!r}")

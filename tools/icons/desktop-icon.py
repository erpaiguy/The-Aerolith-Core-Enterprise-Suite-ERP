# Draws the desktop app's Windows icon (apps/desktop/build/icon.ico) from the mark in apps/web/public/icon.svg, so the
# installer, the app, its shortcuts and the browser app all carry the same picture. Pillow only; no SVG renderer.
# If icon.svg changes, change the shapes below to match and run: python3 tools/icons/desktop-icon.py
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
S = 2048  # drawn at four times the SVG's 512 units, then scaled down for smooth edges
k = S / 512
img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
d.rounded_rectangle([0, 0, S - 1, S - 1], radius=96 * k, fill='#1f3a5f')
# The SVG path: the "A", then the triangle cut out of it.
outer = [(256, 96), (400, 416), (336, 416), (308, 348), (204, 348), (176, 416), (112, 416)]
hole = [(256, 224), (222, 308), (290, 308)]
d.polygon([(x * k, y * k) for x, y in outer], fill='#f4f6f8')
d.polygon([(x * k, y * k) for x, y in hole], fill='#1f3a5f')
sizes = [16, 24, 32, 48, 64, 128, 256]
img.resize((256, 256), Image.LANCZOS).save(
    ROOT / 'apps/desktop/build/icon.ico', sizes=[(s, s) for s in sizes]
)

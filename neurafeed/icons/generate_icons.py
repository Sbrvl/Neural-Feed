"""
generate_icons.py — Run this once to generate placeholder PNG icons.
Place the output PNG files in this icons/ directory.

Usage:  python generate_icons.py
Requires: pip install Pillow
"""

from PIL import Image, ImageDraw, ImageFont
import os

def make_icon(size, output_path):
    img = Image.new('RGBA', (size, size), (26, 115, 232, 255))  # Google Blue
    draw = ImageDraw.Draw(img)

    # Brain emoji approximation: white circle + text
    margin = size // 8
    draw.ellipse(
        [margin, margin, size - margin, size - margin],
        fill=(255, 255, 255, 40),
    )

    # Text "N" in center
    font_size = size // 2
    try:
        font = ImageFont.truetype('arial.ttf', font_size)
    except Exception:
        font = ImageFont.load_default()

    bbox = draw.textbbox((0, 0), 'N', font=font)
    text_w = bbox[2] - bbox[0]
    text_h = bbox[3] - bbox[1]
    draw.text(
        ((size - text_w) // 2, (size - text_h) // 2 - 2),
        'N',
        fill='white',
        font=font,
    )

    img.save(output_path, 'PNG')
    print(f"Generated {output_path}")

if __name__ == '__main__':
    script_dir = os.path.dirname(os.path.abspath(__file__))
    for size in [16, 48, 128]:
        make_icon(size, os.path.join(script_dir, f'icon{size}.png'))
    print("Done. Copy the PNG files to neurafeed/icons/")

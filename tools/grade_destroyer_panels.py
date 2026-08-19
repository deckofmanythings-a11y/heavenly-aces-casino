"""
Generate per-palette recolours of Destroyer's console art.

WHY A GRADE AND NOT A REDRAW OR A REGENERATION
----------------------------------------------
The panel is photoreal weathered steel -- pitted, scratched, with bolted bezels that
cast their own contact shadows. CSS cannot reproduce that; a redraw would be flat
gradients standing in for painted metal, a clear downgrade.

An AI img2img pass could recolour it beautifully but would MOVE things. Destroyer's
36 firing cells and every UI region are calibrated to pixel offsets measured against
this exact art (see the region tables in destroyer.html). Any regeneration invalidates
that calibration silently -- the board would still look right and the hitboxes would
be wrong.

A colour grade changes only colour. Every edge, bolt and bezel stays on its exact
pixel, so the calibration remains valid by construction.

WHAT IS AND ISN'T RECOLOURED
----------------------------
The metal ground is heavily DESATURATED; the CRT screens and the FIRE button are
strongly SATURATED. That difference is the mask. Low-saturation pixels get pushed to
the palette's hue; saturated pixels are left alone, so the screens stay green and the
FIRE button stays red across every palette -- they read as lit hardware, not decor,
and a burgundy FIRE button would look broken rather than themed.

The mask is a smooth ramp, not a hard cut, so there is no visible fringe where a
bezel's edge highlight crosses the saturation threshold.
"""
import numpy as np
from PIL import Image
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent

# hue      -- target hue for the metal, degrees 0-360
# sat      -- how much colour the metal takes (0 = stays grey)
# gain     -- overall brightness multiplier
# gamma    -- <1 lifts shadows (needed for the light boards), >1 deepens them
PALETTES = {
    'ivory':    dict(hue=42,  sat=0.30, gain=1.72, gamma=0.72),
    'emerald':  dict(hue=150, sat=0.26, gain=1.06, gamma=0.98),
    'obsidian': dict(hue=265, sat=0.08, gain=0.80, gamma=1.10),
    'sapphire': dict(hue=214, sat=0.30, gain=1.02, gamma=0.98),
    'burgundy': dict(hue=348, sat=0.30, gain=1.00, gamma=1.00),
    'rose':     dict(hue=14,  sat=0.24, gain=1.78, gamma=0.68),
}

PANELS = ['DestroyerPanel_bg_new.webp', 'DestroyerPanel_bg_setup_new.webp']

# Saturation band over which a pixel stops counting as "metal". Below LO it is fully
# graded, above HI fully preserved, and it ramps smoothly between.
SAT_LO, SAT_HI = 0.20, 0.42


def grade(img: Image.Image, hue, sat, gain, gamma) -> Image.Image:
    rgb = np.asarray(img.convert('RGB'), dtype=np.float32) / 255.0
    mx, mn = rgb.max(-1), rgb.min(-1)
    v = mx
    d = mx - mn
    s = np.where(mx > 1e-6, d / np.maximum(mx, 1e-6), 0.0)

    # 1 = fully metal (grade it), 0 = saturated hardware (leave it be)
    m = 1.0 - np.clip((s - SAT_LO) / (SAT_HI - SAT_LO), 0.0, 1.0)

    # Rebuild the metal from its own luminance so the grade cannot introduce colour
    # noise from whatever faint tint the original steel already had.
    lv = np.clip(np.power(np.clip(v, 0, 1), gamma) * gain, 0.0, 1.0)
    h = (hue % 360) / 360.0
    i = int(np.floor(h * 6.0) % 6)
    f = h * 6.0 - np.floor(h * 6.0)
    p, q, t = lv * (1 - sat), lv * (1 - f * sat), lv * (1 - (1 - f) * sat)
    # The target hue is a single constant for the whole image, so the HSV sector is
    # picked once rather than per pixel.
    tinted = [np.stack([lv, t, p], -1), np.stack([q, lv, p], -1),
              np.stack([p, lv, t], -1), np.stack([p, q, lv], -1),
              np.stack([t, p, lv], -1), np.stack([lv, p, q], -1)][int(i)]

    m3 = m[..., None]
    out = tinted * m3 + rgb * (1.0 - m3)
    return Image.fromarray((np.clip(out, 0, 1) * 255).astype(np.uint8))


def main():
    for panel in PANELS:
        src = HERE / panel
        if not src.exists():
            print('MISSING', src)
            continue
        base = Image.open(src)
        stem = panel.rsplit('.', 1)[0]
        for name, cfg in PALETTES.items():
            out = HERE / f'{stem}_{name}.webp'
            grade(base, **cfg).save(out, 'WEBP', quality=90, method=6)
            print(f'{out.name}  {out.stat().st_size // 1024} KB')


if __name__ == '__main__':
    main()

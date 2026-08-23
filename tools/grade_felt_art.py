"""
Per-palette recolours of the Roulette layout and the I Luv Suits felt.

THE RULE: SHIFT HUE, PRESERVE LUMINANCE
---------------------------------------
Only pixels already in the GREEN band are retinted, and each keeps its own
brightness. Two consequences, both deliberate:

  * Roulette's red, black AND green number cells are all preserved -- they are
    the game's colour language, not decor. Red/black sit outside the hue band and
    are never touched. The green 0/00 cells DO sit inside the band (they are the
    same green as the felt), so they are protected by an explicit keep-region over
    the 0/00 column instead: on every palette a 0 or 00 stays casino green, exactly
    as it must on a real wheel, no matter what colour the surrounding felt becomes.

  * A themed felt stays a FELT. Ivory does not turn the table cream; it turns it
    tan, at the same depth as the original green. That matters because I Luv Suits
    has white paytable text and gold rules text baked into the art -- lifting the
    ground to cream would make both vanish, and there is no stylesheet that can
    reach text inside a photograph.

Everything desaturated is excluded by the SAT_MIN floor, so white text, silver
chips and black outlines pass through untouched. Saturated non-green ink -- the
blue ANTE/PLAY chips, the red heart in the logo, gold lettering -- is outside the
hue band and likewise survives.

Keep-regions (the roulette 0/00 column, the I Luv Suits brand mark) are given in
fractions of the image so they survive a re-export at another size.
"""
import numpy as np
from PIL import Image
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent

# target hue in degrees, and how much colour the felt carries
PALETTES = {
    'ivory':    dict(hue=40,  sat=0.42),
    'emerald':  dict(hue=150, sat=0.62),
    'obsidian': dict(hue=265, sat=0.16),
    'sapphire': dict(hue=214, sat=0.52),
    'burgundy': dict(hue=348, sat=0.50),
    'rose':     dict(hue=8,   sat=0.34),
}

JOBS = [
    dict(src='roulett_felt.webp', keep=(0.0, 0.0, 0.083, 0.615)),   # green 0/00 column

    dict(src='iLuvSuits_Felt.webp', keep=(0.71, 0.14, 0.98, 0.34)),   # I LOVE SUITS mark
    dict(src='iLuvSuits_port.webp', keep=None),
]

HUE_LO, HUE_HI = 80.0, 185.0   # the green band, degrees
HUE_FEATHER = 18.0             # soft edges so there is no banding at the boundary
SAT_MIN = 0.12                 # below this a pixel is grey/white/black -- never retinted


def rgb_to_hsv(rgb):
    mx, mn = rgb.max(-1), rgb.min(-1)
    d = mx - mn
    s = np.where(mx > 1e-6, d / np.maximum(mx, 1e-6), 0.0)
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    h = np.zeros_like(mx)
    nz = d > 1e-6
    h = np.where(nz & (mx == r), ((g - b) / np.maximum(d, 1e-6)) % 6, h)
    h = np.where(nz & (mx == g), ((b - r) / np.maximum(d, 1e-6)) + 2, h)
    h = np.where(nz & (mx == b), ((r - g) / np.maximum(d, 1e-6)) + 4, h)
    return (h * 60.0) % 360.0, s, mx


def hsv_to_rgb(h, s, v):
    h = (h % 360.0) / 60.0
    i = np.floor(h).astype(np.int32) % 6
    f = h - np.floor(h)
    p, q, t = v * (1 - s), v * (1 - f * s), v * (1 - (1 - f) * s)
    out = np.zeros(v.shape + (3,), dtype=np.float32)
    for k, (a, b, c) in enumerate([(v, t, p), (q, v, p), (p, v, t), (p, q, v), (t, p, v), (v, p, q)]):
        m = i == k
        out[m] = np.stack([a, b, c], -1)[m]
    return out


def ramp(x, lo, hi, feather):
    return np.clip((x - (lo - feather)) / feather, 0, 1) * np.clip(((hi + feather) - x) / feather, 0, 1)


def grade(img: Image.Image, hue, sat, keep):
    src = img.convert('RGBA')
    a = np.asarray(src, dtype=np.float32) / 255.0
    rgb, alpha = a[..., :3], a[..., 3:]
    h, s, v = rgb_to_hsv(rgb)

    m = ramp(h, HUE_LO, HUE_HI, HUE_FEATHER) * np.clip((s - SAT_MIN) / 0.10, 0, 1)
    if keep is not None:
        H, W = m.shape
        x0, y0, x1, y1 = keep
        m[int(y0 * H):int(y1 * H), int(x0 * W):int(x1 * W)] = 0.0

    # v is carried through untouched -- that is the luminance-preserving half of the rule.
    tinted = hsv_to_rgb(np.full_like(h, hue), np.clip(s * (sat / 0.62), 0, 1), v)
    m3 = m[..., None]
    out = tinted * m3 + rgb * (1.0 - m3)
    return Image.fromarray((np.clip(np.concatenate([out, alpha], -1), 0, 1) * 255).astype(np.uint8))


def main():
    for job in JOBS:
        src = HERE / job['src']
        if not src.exists():
            print('MISSING', src)
            continue
        base = Image.open(src)
        stem, ext = job['src'].rsplit('.', 1)
        for name, cfg in PALETTES.items():
            out = HERE / f'{stem}_{name}.{ext}'
            grade(base, keep=job['keep'], **cfg).save(out, 'WEBP', quality=90, method=6)
            print(f'{out.name}  {out.stat().st_size // 1024} KB')


if __name__ == '__main__':
    main()

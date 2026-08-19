"""
Darkened copies of UTH / Blackjack bet-module art, for the two LIGHT palettes only.

WHY ONLY TWO PALETTES
---------------------
These modules are printed for a dark felt: the bet circles and their labels are pale
outlines. On the five dark boards they read exactly as uploaded, so those palettes use
the ORIGINAL files untouched -- no variant, no quality loss, no divergence. Only Ivory
and Rose need anything, because a near-white outline on a cream ground is invisible.

WHAT IS NEVER TOUCHED
---------------------
Brand marks. The Ultimate Texas Hold'em logo, PAIR UP, SWEET 17 and Fortune are
trademarks, not decor -- a recoloured logo reads as broken rather than themed, the same
reason Destroyer's FIRE button keeps its red on every palette. Two protections:

  1. Whole files that are nothing but brand art are never processed at all.
  2. In files that mix art and branding, a rectangular KEEP region is excluded, given
     in fractions of the image so it survives any future re-export at another size.

Everything outside that is darkened only where it is BOTH light and desaturated -- the
outline strokes. Saturated ink (the gold Trips diamond) keeps its hue, since gold still
reads on cream.

Alpha is carried through untouched, so the soft antialiased edges of each circle stay
soft and nothing gains a halo.
"""
import numpy as np
from PIL import Image
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent

# target ink per light palette -- matches --ink in felt-themes.css
TARGETS = {'ivory': (43, 24, 6), 'rose': (67, 32, 42)}

# keep: (x0, y0, x1, y1) as fractions of width/height -- never recoloured.
JOBS = [
    dict(src='uth_felt_bets.webp', keep=(0.44, 0.00, 1.00, 0.36)),   # UTH logo, top-right
    dict(src='dealer_bet_trim.png', keep=None),
    dict(src='player_bet_full_trim.png', keep=None),
]
# Nothing but branding -- deliberately absent from JOBS rather than listed with a
# full-image keep, so it is obvious they are untouched by design.
BRAND_ONLY = ['side_bets_trim.png', 'fortune_trim.png']

LIGHT_MIN = 0.55   # only strokes at least this bright are candidates
SAT_MAX = 0.35     # ...and no more colourful than this


def darken(img: Image.Image, target, keep) -> Image.Image:
    src = img.convert('RGBA')
    a = np.asarray(src, dtype=np.float32) / 255.0
    rgb, alpha = a[..., :3], a[..., 3:]

    mx, mn = rgb.max(-1), rgb.min(-1)
    sat = np.where(mx > 1e-6, (mx - mn) / np.maximum(mx, 1e-6), 0.0)
    light = mx

    m = ((light >= LIGHT_MIN) & (sat <= SAT_MAX)).astype(np.float32)

    if keep is not None:
        h, w = m.shape
        x0, y0, x1, y1 = keep
        m[int(y0 * h):int(y1 * h), int(x0 * w):int(x1 * w)] = 0.0

    # Map a light stroke to the palette ink, keeping its own relative brightness so the
    # stroke's internal shading survives instead of flattening to one solid colour.
    tgt = np.array(target, dtype=np.float32) / 255.0
    shade = np.clip((light - LIGHT_MIN) / (1.0 - LIGHT_MIN), 0.0, 1.0)[..., None]
    inked = tgt * (0.75 + 0.25 * shade)

    m3 = m[..., None]
    out = inked * m3 + rgb * (1.0 - m3)
    return Image.fromarray((np.clip(np.concatenate([out, alpha], -1), 0, 1) * 255).astype(np.uint8))


def main():
    for name in BRAND_ONLY:
        print(f'skipped (brand art, used as uploaded on every palette): {name}')
    for job in JOBS:
        src = HERE / job['src']
        if not src.exists():
            print('MISSING', src)
            continue
        base = Image.open(src)
        stem, ext = job['src'].rsplit('.', 1)
        for pal, tgt in TARGETS.items():
            out = HERE / f'{stem}_{pal}.{ext}'
            darken(base, tgt, job['keep']).save(out)
            print(f'{out.name}  {out.stat().st_size // 1024} KB')


if __name__ == '__main__':
    main()

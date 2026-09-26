# Tamber brand mark

## Concept

The Tamber mark is a **speech orb**: a glowing circle with its bottom-left corner squared off, so it reads as a speech bubble, sending out two ripples of sound. Together they say "a voice, speaking". The name comes from *timbre*, the character of a voice, and here that character spreads outward. One violet-to-cyan gradient runs the same way as the sound: warm violet at the speaker, cool cyan at the outer ripple. A soft violet glow and a glassy highlight on the orb suggest motion and depth on the near-black tile. For 16 and 32 px there is a separate small-size master (`icon-small.svg`) with bolder ripples aligned to a 16 px pixel grid, so the mark stays readable in favicons and the browser toolbar.

## Colors

| Token | Hex | Use |
|---|---|---|
| Violet (gradient start) | `#A855F7` | Orb / gradient start; accent on dark UI (4.9:1 on `#0F0D1C`) |
| Cyan (gradient end) | `#22D3EE` | Outer ripple / gradient end; secondary accent on dark UI (10.6:1 on `#0F0D1C`) |
| Gradient midpoint | `#6594F2` | Single-color fallback when a gradient isn't possible |
| Deep violet (glow / light-UI accent) | `#7C3AED` | Background glow (42% opacity); buttons, links and focus rings on light UI (5.7:1 on white, white text on it 5.7:1) |
| Lavender (dark-UI text accent) | `#C084FC` | Links and small accent text on dark UI (7.3:1 on `#0F0D1C`) |
| Teal (light-UI cyan text) | `#0E7490` | Use this instead of cyan for text on white (cyan on white is only 1.8:1) |
| Background top-left | `#1A1631` | Icon tile gradient start |
| Background bottom-right | `#07070D` | Icon tile gradient end |
| Background solid | `#0F0D1C` | Android `adaptiveIcon.backgroundColor`, splash background, PWA `theme_color` / `background_color` |

### CSS

```css
:root {
  --tamber-violet: #A855F7;
  --tamber-cyan: #22D3EE;
  --tamber-bg: #0F0D1C;
  --tamber-gradient: linear-gradient(62deg, #A855F7 0%, #22D3EE 100%);      /* the mark gradient */
  --tamber-tile: linear-gradient(135deg, #1A1631 0%, #07070D 100%);         /* the icon background */
}

/* A gradient mark on any background, using glyph.svg as a mask */
.tamber-mark {
  width: 24px; aspect-ratio: 1;
  background: var(--tamber-gradient);
  -webkit-mask: url(/glyph.svg) center / contain no-repeat;
          mask: url(/glyph.svg) center / contain no-repeat;
}
```

Light or dark UI: the app icon has its own dark tile, so it works on both. For a mark with no tile, use `glyph.svg`. It is filled with `currentColor`: set `color` to `#7C3AED` (or near-black) on light surfaces and to `#FFFFFF` / `#C084FC` on dark ones, or use the gradient mask above on either.

## Files

### Vector masters

| File | ViewBox | What it is |
|---|---|---|
| `icon.svg` | 1024 × 1024 | Master app icon: rounded square (rx 228), gradient mark, glow, highlight. Use from 48 px up. |
| `icon-small.svg` | 1024 × 1024 | Small-size master for **16–32 px only**: bolder ripples aligned to a 16 px grid. |
| `icon-fullbleed.svg` | 1024 × 1024 | `icon.svg` with square corners, for platforms that apply their own mask (iOS, App Store). |
| `icon-maskable.svg` | 1024 × 1024 | Full-bleed tile. The mark is about 48% of the canvas, with its farthest point 27% from center, well inside the 40% maskable safe zone. |
| `glyph.svg` | 64 × 64 | The mark only, transparent, a single path with `fill="currentColor"`. For UI, CSS masks and Safari `mask-icon`. |
| `adaptive-foreground.svg` | 1024 × 1024 | The mark only (gradient), transparent, about 44% of the canvas. Source for the Android adaptive foreground. |

### Raster exports

| File | Pixels | Source | Notes |
|---|---|---|---|
| `favicon.ico` | 16, 32, 48 | icon-small (16/32), icon (48) | PNG-compressed ICO entries |
| `png/icon-16.png` | 16 × 16 | icon-small.svg | transparent corners |
| `png/icon-32.png` | 32 × 32 | icon-small.svg | transparent corners |
| `png/icon-48.png` | 48 × 48 | icon.svg | transparent corners |
| `png/icon-128.png` | 128 × 128 | icon.svg | transparent corners |
| `png/icon-180.png` | 180 × 180 | icon-fullbleed.svg | opaque RGB, no alpha channel (iOS rounds it) |
| `png/icon-192.png` | 192 × 192 | icon.svg | transparent corners |
| `png/icon-512.png` | 512 × 512 | icon.svg | transparent corners |
| `png/icon-maskable-512.png` | 512 × 512 | icon-maskable.svg | opaque RGB |
| `png/icon-1024.png` | 1024 × 1024 | icon-fullbleed.svg | opaque RGB, **no alpha channel** (App Store rule) |
| `png/adaptive-foreground-1024.png` | 1024 × 1024 | adaptive-foreground.svg | transparent. Pair it with background `#0F0D1C`. |
| `png/adaptive-monochrome-1024.png` | 1024 × 1024 | adaptive-foreground.svg | White mark on transparent, for Android 13+ themed icons |

## Where each file goes

| Target | Copy to | Reference |
|---|---|---|
| **web**: favicon (legacy) | `favicon.ico` → `web/public/favicon.ico` | `<link rel="icon" href="/favicon.ico" sizes="32x32">` |
| **web**: favicon (modern) | `icon-small.svg` → `web/public/favicon.svg` | `<link rel="icon" href="/favicon.svg" type="image/svg+xml">` (use the small master here, not `icon.svg`, because it is drawn for 16 px) |
| **web**: iOS home screen | `png/icon-180.png` → `web/public/apple-touch-icon.png` | `<link rel="apple-touch-icon" href="/apple-touch-icon.png">` |
| **web**: PWA manifest | `png/icon-192.png`, `png/icon-512.png`, `png/icon-maskable-512.png` → `web/public/` | `"icons": [{"src":"/icon-192.png","sizes":"192x192","type":"image/png"}, {"src":"/icon-512.png","sizes":"512x512","type":"image/png"}, {"src":"/icon-maskable-512.png","sizes":"512x512","type":"image/png","purpose":"maskable"}]`, `"theme_color": "#0F0D1C"`, `"background_color": "#0F0D1C"` |
| **web**: in-app logo | `glyph.svg` (recolor with CSS) or `icon.svg` | header, about page, loading states |
| **web**: Safari pinned tab (optional) | `glyph.svg` → `web/public/mask-icon.svg` | `<link rel="mask-icon" href="/mask-icon.svg" color="#A855F7">` |
| **extension**: icons | `png/icon-16.png`, `icon-32.png`, `icon-48.png`, `icon-128.png` → `extension/public/icons/` | manifest.json: `"icons": {"16":"icons/icon-16.png","32":"icons/icon-32.png","48":"icons/icon-48.png","128":"icons/icon-128.png"}` and `"action": {"default_icon": {"16":"icons/icon-16.png","32":"icons/icon-32.png"}}` |
| **extension**: in-popup logo | `glyph.svg` | inline or `<img>` |
| **mobile**: app icon (iOS + fallback) | `png/icon-1024.png` → `mobile/assets/icon.png` | app.json `"icon": "./assets/icon.png"` |
| **mobile**: Android adaptive icon | `png/adaptive-foreground-1024.png` → `mobile/assets/adaptive-icon.png`, `png/adaptive-monochrome-1024.png` → `mobile/assets/adaptive-monochrome.png` | `"android": {"adaptiveIcon": {"foregroundImage": "./assets/adaptive-icon.png", "monochromeImage": "./assets/adaptive-monochrome.png", "backgroundColor": "#0F0D1C"}}` |
| **mobile**: splash | `png/adaptive-foreground-1024.png` → `mobile/assets/splash-icon.png` | `expo-splash-screen` plugin: `{"image": "./assets/splash-icon.png", "imageWidth": 288, "backgroundColor": "#0F0D1C"}` (or legacy `"splash": {"image": ..., "resizeMode": "contain", "backgroundColor": "#0F0D1C"}`) |
| **mobile**: Expo web favicon | `png/icon-48.png` → `mobile/assets/favicon.png` | `"web": {"favicon": "./assets/favicon.png"}` |

## Usage rules

- Don't use `icon.svg` below 48 px. Use `icon-small.svg`, `icon-16.png` or `icon-32.png` there.
- Don't recolor the gradient or reverse its direction. Violet always sits at the orb and cyan at the outer ripple.
- Keep clear space around the glyph of at least the gap between the orb and the first ripple.
- Don't add a third ripple. A dimmed third arc reads as a volume meter.

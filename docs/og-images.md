# Social preview images

```ts
import { renderAndStoreOgImage } from '@reptiles-ge/img-compression';
import { createStorageFromEnv } from '@reptiles-ge/img-compression/storage';

const preview = await renderAndStoreOgImage({
  key: 'species/vipera-lebetina.jpg',
  source: originalBytes,
  alt: 'A blunt-nosed viper coiled on limestone',
  storage: createStorageFromEnv(),
});
```

`preview.descriptor` is ready to hand to Next.js:

```ts
export const metadata = {
  openGraph: { images: [preview.descriptor] },
  twitter: { card: 'summary_large_image', images: [preview.descriptor] },
};
```

For anything that is not Next.js, `ogImageMetaTags(descriptor)` returns the
full tag list, including the Twitter vocabulary.

## Why this one is JPEG and not AVIF

This is the only part of the pipeline where the modern formats are the wrong
answer, and it is worth being explicit about why, because the instinct to
optimise everything is exactly what breaks link previews.

An `og:image` is not fetched by a browser. It is fetched by a link unfurler —
Facebook, LinkedIn, X, WhatsApp, Slack, Discord, iMessage, Telegram — and those
crawlers decode far less than a browser does.

| Format | Unfurler support                                                     | Verdict                               |
| ------ | -------------------------------------------------------------------- | ------------------------------------- |
| JPEG   | Universal                                                            | What this module emits                |
| PNG    | Universal, but much larger for photographs                           | Fine for flat graphics, wasteful here |
| WebP   | Broad but not complete; reports of scrapers silently failing persist | Not worth the risk                    |
| AVIF   | Only a handful render it; the rest drop the card                     | Never                                 |
| SVG    | Not supported anywhere                                               | Never                                 |

The asymmetry that settles it: a preview is fetched once and **cached by the
platform**, often for weeks. A format that usually works produces a card that is
sometimes permanently blank, and you find out from a colleague pasting a link.
The bytes saved by AVIF here are a rounding error next to that.

The rest of the site still gets AVIF and WebP. Only the preview opts out.

## The size, and why the budget is 300 KB

Output is exactly **1200×630**, the 1.91:1 card every major platform renders at
full width. It is also wide enough for Google Discover, which wants at least
1200 px.

The byte budget is **300 KB**, which is not the largest any platform accepts —
Facebook allows 8 MB — but it is the point where WhatsApp stops showing a
preview at all. WhatsApp is one of the most-used unfurlers, so its limit is the
one that matters.

Quality starts at 82 and steps down until the file fits. The image is resized
once and only the encode is repeated, so the search is cheap. If even the floor
of 62 cannot reach the budget, the image is still returned with
`withinBudget: false` rather than throwing: a slightly heavy preview beats no
preview, and the caller can decide.

## Dimensions must match the tags

`og:image:width` and `og:image:height` are declarations a platform may trust
without measuring. If they disagree with the file, the card is letterboxed or
cropped wrongly.

For this reason the renderer always produces exactly the configured size, and
`ogImageDescriptor` takes the dimensions from the rendered image rather than
from a constant. Building the tags from the descriptor makes the mismatch
impossible.

This is worth checking on any existing setup. At the time this was written,
`reptiles.ge/gvelebi/saxeoebebi` declared `1200×630` while serving a file that
was actually 1024×585 — and named `.png` while being a JPEG.

## Enlargement is allowed here

The rest of the pipeline never upscales. This module does, because the card is
a fixed size: a 900 px source still has to fill 1200×630, and a slightly soft
preview is much better than a broken one.

The result reports `enlarged: true` so you can find the assets that deserve a
better source. Both of the site's current preview images are 1024 px wide and
are enlarged.

## Colour and metadata

The image is converted to sRGB and stripped of everything else.

Unfurlers do not colour-manage, so a CMYK or greyscale source has to be
converted rather than merely tagged, or the card renders with wrong colours.
Metadata is dropped because EXIF would otherwise carry GPS coordinates into a
file whose entire purpose is to be shared widely — which matters more than
usual for photographs of protected species at identifiable locations.

Transparency is composited onto `background`, white by default, since JPEG has
no alpha channel.

## Cropping

Sources are rarely 1.91:1, so something gets cut. The default `attention`
strategy asks libvips for the region with the most going on, which for wildlife
photography keeps the animal in frame far more reliably than a centre crop.

Set `crop: 'centre'` for designed graphics where the composition is deliberate,
or `crop: 'entropy'` for the busiest region rather than the most salient one.

## Configuration

| Variable               | Default     | Meaning                                   |
| ---------------------- | ----------- | ----------------------------------------- |
| `OG_IMAGE_WIDTH`       | `1200`      | Card width.                               |
| `OG_IMAGE_HEIGHT`      | `630`       | Card height. Use `675` for a 16:9 X card. |
| `OG_IMAGE_QUALITY`     | `82`        | Starting JPEG quality.                    |
| `OG_IMAGE_MIN_QUALITY` | `62`        | Floor for the budget search.              |
| `OG_IMAGE_MAX_BYTES`   | `300000`    | The WhatsApp ceiling.                     |
| `OG_IMAGE_CROP`        | `attention` | `attention`, `entropy` or `centre`.       |
| `OG_IMAGE_BACKGROUND`  | `#ffffff`   | Used when flattening transparency.        |
| `OG_IMAGE_PREFIX`      | `og`        | Where previews are stored.                |

These are resolved separately from the main image settings on purpose: changing
the preview quality does not alter the derivative fingerprint, so it will not
invalidate every AVIF and WebP the site has already produced.

## Measured on the site's own images

Rendered with the defaults from what `reptiles.ge` serves today:

| Source                    |                 Now |            Preview | Notes                                |
| ------------------------- | ------------------: | -----------------: | ------------------------------------ |
| `og-landing.jpg`          |  190 KB at 1024×541 | 148 KB at 1200×630 | Correct card size for the first time |
| `snake-species-cover`     |  157 KB at 1024×585 | 112 KB at 1200×630 | Declared size now matches the file   |
| `elaphe-dione-mobile.jpg` | 171 KB at 1800×1200 | 101 KB at 1200×630 |                                      |
| `landing-cta-cover.jpeg`  |  139 KB at 1200×800 |  99 KB at 1200×630 |                                      |
| `regions/adjara.jpg`      |  194 KB at 1200×767 | 160 KB at 1200×630 |                                      |

Every result is inside the 300 KB budget at the default quality.

## Before you ship a preview

The crawler fetches with no cookies and caches what it finds, so it is worth
one check:

- Absolute `https://` URL. A relative path is dropped everywhere.
- Publicly fetchable: no signed URL, no login, no hotlink protection.
- Tags rendered server-side. Injected client-side, they do not exist to a bot.
- The URL is stable. Platforms re-fetch later, so it has to stay put.

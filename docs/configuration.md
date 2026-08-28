# Configuration

Every value lives in `src/config.ts`. Nothing that affects output is hard-coded
anywhere else.

Precedence is **defaults → environment → explicit overrides**, and the result is
validated, so a nonsensical setting fails loudly at startup rather than
producing quietly wrong images.

```ts
import { resolveImageConfig } from '@reptiles-ge/img-compression';

const config = resolveImageConfig(); // defaults + environment
const preview = resolveImageConfig({ maxWidth: 800 }); // ...with an override
```

## Processing

| Variable                        | Default | Meaning                                                                   |
| ------------------------------- | ------- | ------------------------------------------------------------------------- |
| `IMAGE_PROCESSING_ENABLED`      | `true`  | When false, originals are stored and nothing is derived.                  |
| `IMAGE_MAX_WIDTH`               | `2400`  | Largest derivative width. Sources narrower than this are never upscaled.  |
| `IMAGE_ADDITIONAL_WIDTHS`       | `1200`  | Comma-separated smaller widths, so `srcSet` has something to choose from. |
| `IMAGE_AVIF_QUALITY`            | `60`    | 1–100. See [benchmarks](benchmarks.md) before changing.                   |
| `IMAGE_AVIF_EFFORT`             | `4`     | 0–9. Higher is slower and slightly smaller.                               |
| `IMAGE_AVIF_CHROMA_SUBSAMPLING` | `4:4:4` | `4:4:4` or `4:2:0`.                                                       |
| `IMAGE_WEBP_QUALITY`            | `82`    | 1–100.                                                                    |
| `IMAGE_WEBP_EFFORT`             | `5`     | 0–6.                                                                      |

Changing any of these changes the settings fingerprint, so the next migration
run regenerates the affected derivatives. Changing anything else does not.

## Limits on untrusted input

These bound what a hostile upload can cost you. They do not affect output.

| Variable                           | Default            | Meaning                                                                             |
| ---------------------------------- | ------------------ | ----------------------------------------------------------------------------------- |
| `IMAGE_MAX_INPUT_BYTES`            | `41943040` (40 MB) | Payload cap, applied before any decode.                                             |
| `IMAGE_MAX_INPUT_PIXELS`           | `80000000` (80 MP) | Decoded-pixel cap. The main decompression-bomb guard.                               |
| `IMAGE_MAX_DIMENSION`              | `20000`            | Per-side cap, catching pathological aspect ratios that slip under the pixel budget. |
| `IMAGE_PROCESSING_TIMEOUT_SECONDS` | `60`               | Wall-clock ceiling per image, bounding CPU.                                         |

## Layout

| Variable                 | Default     | Meaning                                  |
| ------------------------ | ----------- | ---------------------------------------- |
| `IMAGE_ORIGINAL_PREFIX`  | `original`  | Where canonical sources live.            |
| `IMAGE_OPTIMIZED_PREFIX` | `optimized` | Where derivatives and the manifest live. |

Both must be relative, slash-separated paths. A leading slash is stripped
rather than rejected; a traversal segment is rejected.

## Storage

| Variable                       | Default        | Meaning                                                                 |
| ------------------------------ | -------------- | ----------------------------------------------------------------------- |
| `IMAGE_STORAGE_DRIVER`         | `local`        | `local` or `bunny`.                                                     |
| `IMAGE_LOCAL_STORAGE_ROOT`     | `public/media` | Directory for the local driver.                                         |
| `IMAGE_LOCAL_STORAGE_BASE_URL` | `/`            | URL prefix the root is served from.                                     |
| `BUNNY_STORAGE_ZONE`           | —              | Storage zone name. Required for `bunny`.                                |
| `BUNNY_STORAGE_ACCESS_KEY`     | —              | Storage zone password. Required for `bunny`.                            |
| `BUNNY_STORAGE_REGION`         | `de`           | `de`, `uk`, `ny`, `la`, `sg`, `se`, `br`, `jh` or `syd`.                |
| `BUNNY_CDN_BASE_URL`           | —              | Pull-zone origin, e.g. `https://cdn.reptiles.ge`. Required for `bunny`. |

`BUNNY_STORAGE_ACCESS_KEY` is a credential. It must stay server-side: never
give it a `NEXT_PUBLIC_` prefix, and never pass it into a client component. It
is not logged and is not included in error messages.

HTTP cache headers are not set per object because on Bunny they belong to the
pull zone. Derivative names are content-addressed by width and are only
rewritten when the settings change, so a long `max-age` at the pull zone is
appropriate.

## Choosing a maximum width

`2400` suits full-bleed species photography on a 2x display. If the largest
rendered box on the site is genuinely smaller, lowering this saves more than
any quality change will.

Check what the layout actually needs before adjusting it, and remember that
raising it will not improve anything for sources that are already narrower —
the pipeline never upscales.

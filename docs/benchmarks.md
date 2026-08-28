# Benchmarks

Every number here was measured, not estimated. Reproduce them with:

```bash
npm run images:benchmark             # the table below
npm run images:benchmark -- --sweep  # the quality sweep
npm run images:measure-live          # the live-site comparison
```

The subjects are thirteen of the site's own photographs, chosen to span the
characteristics it actually publishes: close-up scale and feather detail, fur,
dense foliage, smooth sky gradients, wide landscapes and a PNG source. They are
cached into the git-ignored `benchmarks/fixtures/` on first run and are not
committed.

**Measured on:** sharp 0.35.4, libvips 8.18.6, Node 22.23.1, macOS arm64.
Encoded sizes are deterministic across machines; SSIM is too.

## Shipped settings

AVIF quality 60, effort 4, 4:4:4 chroma. WebP quality 82, effort 5. Widths
1200 and 2400.

SSIM compares each derivative against the resized-but-unencoded image, which
isolates what the codec lost from what the resize lost.

| Subject                    |  Source | Dimensions |   AVIF |   WebP | Saved | SSIM AVIF | SSIM WebP |
| -------------------------- | ------: | ---------: | -----: | -----: | ----: | --------: | --------: |
| Lizard close-up            |  514 KB |  1944×1944 | 382 KB | 601 KB |   26% |    0.9912 |    0.9903 |
| Snake scales, fine detail  |  101 KB |   1393×960 |  92 KB | 121 KB |    9% |    0.9937 |    0.9795 |
| Slow worm in foliage       |  160 KB |   1024×768 |  53 KB |  66 KB |   67% |    0.9793 |    0.9760 |
| Viper close-up, PNG source | 1.08 MB |   1224×816 |  35 KB |  45 KB |   97% |    0.9849 |    0.9823 |
| Bird, feather detail       |  407 KB |  1920×1280 | 158 KB | 234 KB |   61% |    0.9830 |    0.9823 |
| Bird in flight, smooth sky | 8.18 MB |  2666×4000 | 349 KB | 542 KB |   96% |    0.9754 |    0.9763 |
| Mammal, fur detail         | 5.03 MB |  3440×2664 | 177 KB | 248 KB |   97% |    0.9762 |    0.9764 |
| Mammal in grass            |  578 KB |  1920×1280 | 299 KB | 413 KB |   48% |    0.9589 |    0.9432 |
| Amphibian, warty skin      |  299 KB |  2048×1536 |  74 KB | 103 KB |   75% |    0.9775 |    0.9752 |
| Amphibian, high contrast   |  182 KB |   1024×768 |  60 KB |  98 KB |   67% |    0.9858 |    0.9873 |
| Habitat landscape          |  192 KB |  1920×1440 | 160 KB | 187 KB |   17% |    0.9913 |    0.9800 |
| Habitat landscape, foliage |  194 KB |   1200×767 | 158 KB | 238 KB |   18% |    0.9910 |    0.9897 |
| Wide cover image           |  139 KB |   1200×800 | 112 KB | 153 KB |   19% |    0.9885 |    0.9804 |

**Totals:** 16.99 MB of originals become 2.06 MB of AVIF (87.9% smaller) or
2.98 MB of WebP (82.5% smaller). Mean SSIM is 0.9828 for AVIF and 0.9784 for
WebP.

Two representative large originals, the case this pipeline exists for:

```
Bird in flight    8.18 MB  2666×4000  ->  AVIF 349 KB at 2400×3602   24:1
Mammal, fur       5.03 MB  3440×2664  ->  AVIF 177 KB at 2400×1859   29:1
```

The per-image savings vary enormously, and that is expected: a source that is
already a small, well-compressed 1200px JPEG has little left to give, while a
5 MB camera original has a great deal.

## How the quality defaults were chosen

Each row varies one axis and holds the rest at the defaults. Sizes are the mean
across all thirteen subjects at full output width.

| Candidate          |  Mean size |  Mean SSIM |
| ------------------ | ---------: | ---------: |
| AVIF q45 4:4:4     |      88 KB |     0.9574 |
| AVIF q50 4:4:4     |     109 KB |     0.9674 |
| AVIF q55 4:4:4     |     132 KB |     0.9760 |
| **AVIF q60 4:4:4** | **162 KB** | **0.9828** |
| AVIF q65 4:4:4     |     181 KB |     0.9856 |
| AVIF q55 4:2:0     |     128 KB |     0.9758 |
| AVIF q60 4:2:0     |     157 KB |     0.9827 |
| WebP q75           |     175 KB |     0.9680 |
| WebP q80           |     216 KB |     0.9758 |
| **WebP q82**       | **235 KB** | **0.9784** |
| WebP q85           |     267 KB |     0.9823 |

The q82 row comes from the shipped-settings table above rather than the sweep,
which steps in fives.

**AVIF 60** is where mean SSIM crosses 0.98, the level usually treated as
visually transparent for photographs. Quality 55 saves a further 19% but drops
to 0.976, and 65 costs 12% more for 0.003 of SSIM. Given that this site exists
to show the animals clearly, 60 is the right side of that curve.

**4:4:4 chroma** is kept even though 4:2:0 is 3% smaller at the same quality.
The saving is small, and SSIM is computed on luma alone, so it is structurally
incapable of measuring the harm 4:2:0 does to the saturated greens and reds
that dominate these photographs. A 3% gain is not worth a risk the metric
cannot see.

**WebP 82** sits above the customary 80 on purpose. WebP is only served to
browsers that cannot decode AVIF, and leaving that minority with a visibly
worse image to save bytes on a small fraction of traffic is a poor trade.

**Effort** stays at sharp's default of 4 for AVIF and 5 for WebP. Higher effort
buys a few percent for a large increase in encode time, which matters when a
migration is encoding hundreds of images.

## Against what the site serves today

`npm run images:measure-live` downloads the images each page references and
re-encodes them with these settings. This compares against the site's _current_
CDN assets, most of which are already WebP, not against camera originals — so
these percentages are much more conservative than the table above, and they are
the honest ones to quote for a redeploy.

| Page                 | Sample           | Currently served |             AVIF |             WebP |
| -------------------- | ---------------- | ---------------: | ---------------: | ---------------: |
| Homepage             | 20 of 20 images  |          4285 KB | 2314 KB (−46.0%) | 3218 KB (−24.9%) |
| Snake species index  | 25 of 210 images |          6707 KB | 3167 KB (−52.8%) | 4381 KB (−34.7%) |
| Lizard species index | 25 of 126 images |          8656 KB | 5300 KB (−38.8%) | 7750 KB (−10.5%) |

The species index pages reference far more images than the sample; the figures
describe the sampled subset, not the whole page.

## What has not been measured

Lighthouse before-and-after on the live site. A meaningful "after" requires the
application to be deployed rendering these derivatives, and the application
lives in a different repository. What can be said from the data above is that
the image bytes on a representative page fall by roughly 40–50%, and that the
LCP hero specifically drops from a 175 KB WebP to a comparable AVIF; what the
resulting Core Web Vitals scores are should be measured after deploy rather
than predicted here.

The public PageSpeed Insights API was tried for a baseline and returned a
per-day quota error without a project key, so no Lighthouse figures are quoted.

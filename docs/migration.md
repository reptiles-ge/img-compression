# Optimising images that already exist

The migration reads originals from storage and writes derivatives beside them.
It never rewrites, moves or deletes an original, and it never touches anything
outside the optimized prefix.

## Before you start

The command reads from `IMAGE_ORIGINAL_PREFIX` (`original/` by default). If the
site's existing assets sit at the root of the bucket rather than under that
prefix, point the setting at where they actually are, or move them first —
deliberately, not as a side effect of this tool.

## Look before you leap

```bash
npm run images:optimize -- --dry-run
```

A dry run reads each original and reports what would be created, without
encoding or writing anything. It costs one download and one header parse per
image, so it is cheap enough to run first every time.

`npm run images:validate` is the same thing under a shorter name.

## Run it

```bash
npm run images:optimize
```

Start small on a large library:

```bash
npm run images:optimize -- --limit 20                    # first twenty only
npm run images:optimize -- --prefix species/             # one section
npm run images:optimize -- --concurrency 2               # gentler on CPU
```

Output looks like:

```
Storage: bunny. Widths: 1200, 2400. AVIF q60, WebP q82.
Found 214 original image(s).
[1/214] processed          species/vipera-lebetina.jpg 4.512 MB -> 331 KB (92.7% smaller)
[2/214] skipped            species/natrix-natrix.jpg
...
Processed 212, skipped 1, failed 1 of 214 image(s).
Originals 812.40 MB, AVIF at full width 74.18 MB (90.9% smaller).
Derivatives occupy 121.55 MB in storage.
```

The command exits non-zero if anything failed, so it is safe to put in a
pipeline.

## Running it twice is free

A second run re-encodes nothing. Each image is skipped when its source hash,
the encoder settings fingerprint, and the presence of the original and every
derivative all still agree with `optimized/manifest.json`.

That means the interesting cases behave the way you would hope:

| Situation                             | Next run                                    |
| ------------------------------------- | ------------------------------------------- |
| Nothing changed                       | Skips everything, writes nothing            |
| An original was replaced              | Regenerates that image only                 |
| A derivative was deleted from the CDN | Regenerates that image only                 |
| Quality or widths changed             | Regenerates everything affected             |
| A limit unrelated to output changed   | Skips everything                            |
| The manifest was lost or corrupted    | Rebuilds it, re-encoding to identical bytes |

Use `--force` to regenerate regardless. Because encoding is deterministic, a
forced run over unchanged sources produces byte-identical files.

The manifest is checkpointed every 25 images, so an interrupted run resumes
having lost at most that much work.

## When something fails

A failure is reported and the run continues. The image is left exactly as it
was, with no partial derivatives, and it appears in the summary:

```
Failures:
  species/broken.jpg: Image could not be decoded. [INPUT_UNREADABLE]
```

Error codes are listed in [troubleshooting.md](troubleshooting.md).

## What it skips

Files without a recognised image extension are ignored rather than attempted,
so a stray `notes.txt` in the originals prefix is left alone and not counted as
a failure.

## Afterwards

The migration produces files; it does not update your database. Read
`optimized/manifest.json` to backfill records, or process through
`optimizeAndStore` from your own script if you need the record shape directly.

Nothing changes for visitors until the application starts rendering the
derivatives.

# Architecture

## The pipeline

```
                        untrusted bytes
                              │
                              ▼
                    ┌───────────────────┐
                    │  validateSource   │  format from the decoded header,
                    │  (src/validate)   │  byte cap, pixel cap, dimension cap,
                    └─────────┬─────────┘  animation rejected
                              │
                              ▼
                    ┌───────────────────┐
                    │   processImage    │  autoOrient, resize fit=inside,
                    │  (src/processor)  │  one decode, clone per encode,
                    └─────────┬─────────┘  strip EXIF/XMP, keep ICC
                              │
              ┌───────────────┴───────────────┐
              ▼                               ▼
        AVIF 1200/2400                  WebP 1200/2400
              │                               │
              └───────────────┬───────────────┘
                              ▼
                    ┌───────────────────┐
                    │ optimizeAndStore  │  original written first, then
                    │  (src/pipeline)   │  derivatives, then a manifest entry
                    └─────────┬─────────┘
                              ▼
                    ┌───────────────────┐
                    │  StorageAdapter   │  local filesystem or Bunny Edge Storage
                    └─────────┬─────────┘
                              ▼
                        cdn.reptiles.ge
                              │
                              ▼
                    ┌───────────────────┐
                    │  OptimizedImage   │  <picture>, srcSet, sizes,
                    │   (src/next)      │  intrinsic dimensions, priority
                    └───────────────────┘
```

## Layout in storage

Originals and derivatives live under separate prefixes, so it is impossible to
overwrite a source with something derived from it:

```
original/
  species/vipera-lebetina.jpg      ← canonical, byte-for-byte as uploaded
optimized/
  species/vipera-lebetina-1200.avif
  species/vipera-lebetina-1200.webp
  species/vipera-lebetina-2400.avif
  species/vipera-lebetina-2400.webp
  manifest.json
```

Derivative names always carry their width, including when only one width
applies. Making the suffix conditional would mean output names shifting the
first time someone changes the ladder, which defeats the point of deterministic
naming.

## Decisions worth explaining

### Two widths, not one and not eleven

A single 2400px master would send a 2400px file to a 390px phone, which is the
main thing this package exists to avoid. A ladder of ten widths would quadruple
storage and encode time for gains the browser mostly cannot use.

The default is `[1200, 2400]`: four files per image, and a `srcSet` the browser
can genuinely choose from. Widths at or above the source width are dropped, so
a 900px source yields exactly one width and nothing is ever upscaled.

### `<picture>` rather than `next/image`

The derivatives already exist on the CDN in their final encoding. `next/image`
cannot pick between two URLs by format, and routing these through
`/_next/image` would re-encode assets that are already optimal while billing a
Vercel transformation for it.

Everything `next/image` provides that matters here — intrinsic dimensions,
`srcSet`, `sizes`, lazy loading, preloading — is expressed directly by the
component. This is not reimplementing Next.js; it is declining a second
optimisation pass over already-optimised bytes.

### Encode before storing anything

Header validation cannot prove an image decodes: a truncated JPEG has a
perfectly valid header. `optimizeAndStore` therefore runs the full encode
first, and writes the original only once the bytes have proven to be a real
image.

The alternative — store the original, then process — would publish unverified
attacker-supplied bytes to a public CDN and leave behind an asset that every
later migration run fails on. A failed call here writes nothing, deletes
nothing, and returns a typed error while the caller still holds the source.

### Idempotency through a manifest

`optimized/manifest.json` maps each logical key to the SHA-256 of its source,
a fingerprint of the encoding settings, and the derivatives that were produced.

A run skips an image when the source hash matches, the settings fingerprint
matches, and the original plus every derivative is still present in storage.
Presence is checked rather than assumed, so deleting a file from the CDN is
enough to have the next run rebuild it.

The fingerprint covers only settings that change the output bytes — widths,
qualities, effort, chroma subsampling and `PIPELINE_VERSION`. Raising the input
size limit does not invalidate anything, because it cannot change a single byte
of a file that was already accepted.

### Metadata: strip EXIF, keep ICC

Derivatives drop EXIF, XMP and IPTC. That removes GPS coordinates and camera
identifiers from public files and saves bytes on every request.

The ICC profile is deliberately kept. Discarding it makes a wide-gamut
photograph render with visibly wrong colours in a colour-managed browser, which
is a quality regression, not an optimisation. Originals keep everything.

### One decode, several encodes

`processImage` builds a single sharp pipeline and calls `clone()` per output.
Clones share their parent's input, so libvips resolves the decode once and
reuses it across every width and format instead of re-reading the JPEG four
times.

### Nothing queued, nothing distributed

Uploads are processed inline and migrations run in a small in-process pool
sized to the CPU count. The site's image volume does not justify a queue, a
worker fleet, or a separate service, and each of those would be another thing
to operate and secure.

## Module map

| Module             | Responsibility                                                     |
| ------------------ | ------------------------------------------------------------------ |
| `src/config.ts`    | Every tunable value, environment parsing, the settings fingerprint |
| `src/errors.ts`    | Typed errors carrying a stable `code`                              |
| `src/validate.ts`  | Guards applied to untrusted input                                  |
| `src/naming.ts`    | Key safety, deterministic derivative names                         |
| `src/processor.ts` | The sharp pipeline                                                 |
| `src/pipeline.ts`  | Orchestration: validate, encode, store, describe                   |
| `src/manifest.ts`  | Idempotency state                                                  |
| `src/migrate.ts`   | Batch processing of existing assets                                |
| `src/storage/`     | Adapter interface, local filesystem, Bunny Edge Storage            |
| `src/asset.ts`     | The serialisable shape shared by server and browser                |
| `src/next/`        | The delivery component                                             |
| `src/cli/`         | Command-line entry point                                           |

`src/asset.ts` and `src/next/` never import sharp, so the `./next` entry point
carries no Node-only code into a client bundle.

# Troubleshooting

Every error thrown by this package carries a stable `code`. Branch on that
rather than on the message, which may change.

```ts
import { ImagePipelineError } from '@reptiles-ge/img-compression';

try {
  await optimizeAndStore({ ... });
} catch (error) {
  if (error instanceof ImagePipelineError && error.code === 'INPUT_TOO_LARGE') {
    return respondWith(413);
  }
  throw error;
}
```

## Error codes

| Code                      | Meaning                                                                | What to do                                                                                 |
| ------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `INPUT_EMPTY`             | Zero bytes.                                                            | Usually a broken upload form or an empty multipart field.                                  |
| `INPUT_TOO_LARGE`         | Above `IMAGE_MAX_INPUT_BYTES`.                                         | Reject it at the edge, or raise the limit if genuine camera originals are being rejected.  |
| `INPUT_UNREADABLE`        | libvips could not decode it.                                           | The file is corrupt, truncated, or not an image regardless of its extension.               |
| `UNSUPPORTED_FORMAT`      | Decoded fine but the format is not on the allowlist.                   | GIF and SVG are intentionally excluded.                                                    |
| `ANIMATED_UNSUPPORTED`    | Multi-frame input.                                                     | Rejected rather than silently reduced to one frame. Convert to video, or to a still first. |
| `DIMENSIONS_OUT_OF_RANGE` | A side exceeds `IMAGE_MAX_DIMENSION`.                                  | Catches panoramas and pathological slivers that slip under the pixel budget.               |
| `PIXEL_BUDGET_EXCEEDED`   | Above `IMAGE_MAX_INPUT_PIXELS`.                                        | The decompression-bomb guard. Raise it only if you know the source.                        |
| `UNSAFE_KEY`              | The storage key is absolute, contains `..`, or has control characters. | Build keys with `slugifyFileName`, never from raw user input.                              |
| `ENCODE_FAILED`           | Decoding succeeded but encoding did not.                               | Often a timeout on a very large image. Check `IMAGE_PROCESSING_TIMEOUT_SECONDS`.           |
| `STORAGE_FAILED`          | The adapter could not read or write.                                   | Credentials, permissions, or the storage service itself.                                   |
| `CONFIG_INVALID`          | A setting is out of range or malformed.                                | The message names the setting.                                                             |

## Common situations

### A valid photograph is rejected as `INPUT_UNREADABLE`

Nearly always truncation. A file can have an intact header and be missing its
tail, which no header check can detect — decoding is what finds it. Re-upload
or re-download the source and compare byte counts.

### Encoding times out on large images

AVIF encoding is expensive. A 6000px source at effort 4 can take a while on a
small instance. Either raise `IMAGE_PROCESSING_TIMEOUT_SECONDS`, or lower
`IMAGE_MAX_WIDTH` if the site never renders that large.

### The migration keeps reprocessing everything

The settings fingerprint is changing between runs. Check that every process
sees the same `IMAGE_*` values — a shell that has `IMAGE_AVIF_QUALITY` exported
and a CI job that does not will disagree, and each will invalidate the other's
work.

The fingerprint only covers settings that change the output bytes, so a
differing `IMAGE_MAX_INPUT_BYTES` is not the cause.

### The migration finds no images

It lists `IMAGE_ORIGINAL_PREFIX`, `original/` by default. If the existing
assets live at the root of the bucket, either point the setting at where they
are or move them first. Files without a recognised image extension are ignored
by design.

### The migration reports a name collision

Two originals in the same directory share a base name and differ only by
extension, such as `viper.jpg` and `viper.png`. Derivative names drop the
source extension, so both would claim `viper-2400.avif`.

Both are refused rather than one silently overwriting the other. Rename one of
the sources so the base names differ.

### Colours look washed out or oversaturated

The ICC profile is being lost somewhere after this package, which keeps it
deliberately. Check that whatever serves or post-processes the files is not
stripping metadata.

### AVIF is larger than the original

Expected when the original is already a small, well-compressed JPEG or WebP.
AVIF wins decisively on large camera originals and can lose on a 100 KB source
that has already been through an optimiser. The
[benchmarks](benchmarks.md) show both cases.

### Images shift the layout as they load

The component always emits `width` and `height`. If the layout still shifts,
CSS is overriding the ratio — constraining `width` without setting
`height: auto` is the usual cause. See [frontend.md](frontend.md).

### A phone downloads the 2400px file

`sizes` does not match the real layout. It describes the rendered box, not the
image, so `sizes="100vw"` on a half-width grid card asks the browser for twice
the pixels it needs.

### Bunny uploads fail with HTTP 401

`BUNNY_STORAGE_ACCESS_KEY` must be the storage zone password from the storage
zone's FTP and API settings, not an account API key and not the pull zone
token.

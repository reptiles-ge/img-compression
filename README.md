# @reptiles-ge/img-compression

Native image compression for [Reptiles.ge](https://reptiles.ge).

Turns untouched original photographs into AVIF and WebP derivatives with
[sharp](https://sharp.pixelplumbing.com/), stores them through a pluggable
storage adapter, and delivers them to the browser with correct responsive,
LCP and layout-stability behaviour.

Measured against thirteen of the site's own photographs, the shipped settings
produce **88% fewer bytes than the originals at a mean SSIM of 0.983**, and
**39–53% fewer bytes than what the site currently serves**, most of which is
already WebP. The numbers are in [docs/benchmarks.md](docs/benchmarks.md).

## Why this exists

The site publishes wildlife photography, which is both the reason pages are
heavy and the reason quality cannot simply be traded away. The goal is not the
smallest possible file: it is the smallest file that still looks right on a
species page.

```
original (preserved, canonical)
      │
      ▼
   sharp ── EXIF orientation, resize, strip metadata, keep ICC
      │
      ├──▶ AVIF at 1200px and 2400px
      └──▶ WebP at 1200px and 2400px
      │
      ▼
storage adapter ──▶ Bunny Edge Storage ──▶ cdn.reptiles.ge
      │
      ▼
<OptimizedImage> ──▶ <picture> with srcSet and sizes ──▶ browser
```

## Install

```bash
npm install @reptiles-ge/img-compression
```

Requires Node 20.11 or newer. `react` and `next` are optional peers, needed
only for the delivery component.

## Optimising an upload

```ts
import {
  optimizeAndStore,
  resolveImageConfig,
  slugifyFileName,
} from '@reptiles-ge/img-compression';
import { createStorageFromEnv } from '@reptiles-ge/img-compression/storage';

const storage = createStorageFromEnv();
const config = resolveImageConfig();

const { record } = await optimizeAndStore({
  key: `species/${slugifyFileName(file.name)}.jpg`,
  source: Buffer.from(await file.arrayBuffer()),
  storage,
  config,
});
```

`record` carries everything worth persisting: `originalUrl`, `avifUrl`,
`webpUrl`, `width`, `height`, `originalSize`, `optimizedSize`, and the full
list of derivatives. Invalid or undecodable input throws a typed error and
writes nothing at all.

## Rendering

```tsx
import { OptimizedImage, toImageAsset } from '@reptiles-ge/img-compression/next';

<OptimizedImage
  asset={toImageAsset(record)}
  alt="A blunt-nosed viper basking on limestone"
  sizes="(max-width: 768px) 100vw, 800px"
  priority
/>;
```

`sizes` is required and `priority` is not the default, both on purpose. See
[docs/frontend.md](docs/frontend.md).

## Optimising images that already exist

```bash
npm run images:optimize -- --dry-run   # report without writing
npm run images:optimize                # process everything
```

The run only ever adds derivatives; it never rewrites or deletes an original,
and running it twice re-encodes nothing. See
[docs/migration.md](docs/migration.md).

## Documentation

| Document                                           | Contents                                                    |
| -------------------------------------------------- | ----------------------------------------------------------- |
| [docs/architecture.md](docs/architecture.md)       | How the pipeline fits together, and the decisions behind it |
| [docs/configuration.md](docs/configuration.md)     | Every setting and environment variable                      |
| [docs/frontend.md](docs/frontend.md)               | Using the component, LCP, lazy loading and CLS              |
| [docs/migration.md](docs/migration.md)             | Processing existing images safely                           |
| [docs/benchmarks.md](docs/benchmarks.md)           | Measured results and how the defaults were chosen           |
| [docs/troubleshooting.md](docs/troubleshooting.md) | What the errors mean and what to do about them              |
| [docs/licensing.md](docs/licensing.md)             | Dependency licences and compatibility                       |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security reports go through
[SECURITY.md](SECURITY.md), not the public issue tracker.

## Licence

[MIT](LICENSE).

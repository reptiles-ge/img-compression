import sharp from 'sharp';

import { resolveImageConfig } from '../src/config.js';
import { validateSource } from '../src/validate.js';

/**
 * Measures what the live site currently ships and what these encoder settings
 * would ship instead.
 *
 * This is how the figures in `docs/benchmarks.md` were produced, kept in the
 * repository so a reviewer can reproduce them rather than take them on trust.
 * It reads the public site only and writes nothing.
 *
 * Only the widest derivative is encoded, because that is the file a modern
 * browser actually fetches; encoding the whole ladder would quadruple the run
 * for bytes nobody downloads.
 *
 *   npm run images:measure-live -- --limit 25 --concurrency 6
 */

const PAGES: ReadonlyArray<readonly [string, string]> = [
  ['homepage', 'https://reptiles.ge'],
  ['snake species index', 'https://reptiles.ge/gvelebi/saxeoebebi'],
  ['lizard species index', 'https://reptiles.ge/xvlikebi/saxeoebebi'],
];

function numericArgument(flag: string, fallback: number): number {
  const index = process.argv.indexOf(flag);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

const LIMIT = numericArgument('--limit', 25);
const CONCURRENCY = numericArgument('--concurrency', 6);
const config = resolveImageConfig({}, {});

const kilobytes = (bytes: number): string => `${(bytes / 1024).toFixed(0)} KB`;

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let cursor = 0;

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        results[index] = await worker(items[index] as T);
      }
    }),
  );

  return results;
}

interface ImageMeasurement {
  readonly live: number;
  readonly avif: number;
  readonly webp: number;
}

async function measureImage(url: string): Promise<ImageMeasurement | null> {
  const response = await fetch(url);
  if (!response.ok) return null;

  const source = Buffer.from(await response.arrayBuffer());

  try {
    const { width } = await validateSource(source, config);
    const base = sharp(source)
      .autoOrient()
      .resize({ width: Math.min(width, config.maxWidth), withoutEnlargement: true });

    const [avif, webp] = await Promise.all([
      base
        .clone()
        .keepIccProfile()
        .avif({
          quality: config.avifQuality,
          effort: config.avifEffort,
          chromaSubsampling: config.avifChromaSubsampling,
        })
        .toBuffer(),
      base
        .clone()
        .keepIccProfile()
        .webp({ quality: config.webpQuality, effort: config.webpEffort, smartSubsample: true })
        .toBuffer(),
    ]);

    process.stdout.write('.');
    return { live: source.byteLength, avif: avif.byteLength, webp: webp.byteLength };
  } catch {
    process.stdout.write('x');
    return null;
  }
}

for (const [label, url] of PAGES) {
  const html = await (await fetch(url)).text();
  const referenced = [
    ...new Set(html.match(/https:\/\/cdn\.reptiles\.ge\/[^"\\ )]+/g) ?? []),
  ].filter((candidate) => /\.(jpe?g|png|webp)$/i.test(candidate));

  const sample = referenced.slice(0, LIMIT);
  process.stdout.write(`${label}: ${sample.length} of ${referenced.length} images `);

  const measured = (await mapWithConcurrency(sample, CONCURRENCY, measureImage)).filter(
    (entry): entry is ImageMeasurement => entry !== null,
  );

  const total = (pick: (entry: ImageMeasurement) => number): number =>
    measured.reduce((sum, entry) => sum + pick(entry), 0);

  const live = total((entry) => entry.live);
  const avif = total((entry) => entry.avif);
  const webp = total((entry) => entry.webp);

  console.log(
    `\n  live ${kilobytes(live)} -> ` +
      `AVIF ${kilobytes(avif)} (${(100 - (avif / live) * 100).toFixed(1)}% less), ` +
      `WebP ${kilobytes(webp)} (${(100 - (webp / live) * 100).toFixed(1)}% less)`,
  );
}

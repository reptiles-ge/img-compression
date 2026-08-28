import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

import { resolveImageConfig, targetWidthsFor, type ImageConfig } from '../src/config.js';
import { processImage } from '../src/processor.js';
import { meanSsim } from './ssim.js';

/**
 * Measures the shipped encoder settings against real Reptiles.ge photography.
 *
 * The images are the site's own and stay out of the repository: they are cached
 * under `benchmarks/fixtures/`, which is ignored by git. Only the numbers this
 * script prints are committed, in `docs/benchmarks.md`.
 *
 *   npm run images:benchmark            measure the current configuration
 *   npm run images:benchmark -- --sweep compare candidate quality settings
 */

const FIXTURE_DIRECTORY = path.resolve('benchmarks/fixtures');
const CDN = 'https://cdn.reptiles.ge';

interface Subject {
  readonly file: string;
  readonly description: string;
}

/** Chosen to span the photographic characteristics the site actually publishes. */
const SUBJECTS: readonly Subject[] = [
  { file: 'ablepharus-pannonicus.jpg', description: 'lizard close-up' },
  { file: 'coronella-austriaca-sandro-1.jpg', description: 'snake scales, fine detail' },
  { file: 'anguis-colchica-sandro-1.jpg', description: 'slow worm in foliage' },
  { file: 'macrovipera-lebetina-nika-3.png', description: 'viper close-up, PNG source' },
  { file: 'accipiter-nisus-sharp-female.jpg', description: 'bird, feather detail' },
  { file: 'buteo-buteo-sharp-vulpinus.jpg', description: 'bird in flight, smooth sky' },
  { file: 'canis-lupus-eurasian-1.jpg', description: 'mammal, fur detail' },
  { file: 'capreolus-capreolus-buck-1.jpg', description: 'mammal in grass' },
  { file: 'bufo-verrucosissimus.jpg', description: 'amphibian, warty skin texture' },
  { file: 'bufotes-viridis-ioane-1.jpg', description: 'amphibian, high local contrast' },
  { file: 'regions/kakheti.jpg', description: 'habitat landscape' },
  { file: 'regions/adjara.jpg', description: 'habitat landscape, dense foliage' },
  { file: 'landing-cta-cover.jpeg', description: 'wide cover image' },
];

async function fetchSubject(subject: Subject): Promise<Buffer> {
  const cached = path.join(FIXTURE_DIRECTORY, subject.file);
  try {
    return await readFile(cached);
  } catch {
    // Not cached yet.
  }

  const response = await fetch(`${CDN}/${subject.file}`);
  if (!response.ok) {
    throw new Error(`Could not fetch ${subject.file}: HTTP ${response.status}.`);
  }

  const body = Buffer.from(await response.arrayBuffer());
  await mkdir(path.dirname(cached), { recursive: true });
  await writeFile(cached, body);
  return body;
}

function formatBytes(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${(bytes / 1024).toFixed(0)} KB`
    : `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/** The resized-but-not-yet-encoded image, which isolates codec loss from resize loss. */
async function reference(source: Buffer, width: number): Promise<Buffer> {
  return sharp(source)
    .autoOrient()
    .resize({ width, fit: 'inside', withoutEnlargement: true })
    .png({ compressionLevel: 0 })
    .toBuffer();
}

interface Measurement {
  readonly subject: Subject;
  readonly sourceBytes: number;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly outputWidth: number;
  readonly avifBytes: number;
  readonly webpBytes: number;
  readonly avifSsim: number;
  readonly webpSsim: number;
}

async function measure(
  subject: Subject,
  source: Buffer,
  config: ImageConfig,
): Promise<Measurement> {
  const processed = await processImage(source, config);
  const widest = Math.max(...processed.derivatives.map((derivative) => derivative.width));
  const at = (format: 'avif' | 'webp'): (typeof processed.derivatives)[number] =>
    processed.derivatives.find(
      (derivative) => derivative.format === format && derivative.width === widest,
    )!;

  const avif = at('avif');
  const webp = at('webp');
  const baseline = await reference(source, widest);

  return {
    subject,
    sourceBytes: source.byteLength,
    sourceWidth: processed.source.width,
    sourceHeight: processed.source.height,
    outputWidth: widest,
    avifBytes: avif.byteSize,
    webpBytes: webp.byteSize,
    avifSsim: await meanSsim(baseline, avif.data),
    webpSsim: await meanSsim(baseline, webp.data),
  };
}

async function reportCurrentConfiguration(subjects: Map<Subject, Buffer>): Promise<void> {
  const config = resolveImageConfig();

  console.log(
    `\nConfiguration: max ${config.maxWidth}px, widths ${targetWidthsFor(config, 99_999).join('/')}, ` +
      `AVIF q${config.avifQuality} effort ${config.avifEffort} ${config.avifChromaSubsampling}, ` +
      `WebP q${config.webpQuality} effort ${config.webpEffort}\n`,
  );

  const header = [
    'subject'.padEnd(34),
    'source'.padStart(10),
    'dimensions'.padStart(12),
    'AVIF'.padStart(9),
    'WebP'.padStart(9),
    'saved'.padStart(7),
    'SSIM avif'.padStart(10),
    'SSIM webp'.padStart(10),
  ].join(' ');
  console.log(header);
  console.log('-'.repeat(header.length));

  const measurements: Measurement[] = [];
  for (const [subject, source] of subjects) {
    const measurement = await measure(subject, source, config);
    measurements.push(measurement);

    console.log(
      [
        subject.description.padEnd(34),
        formatBytes(measurement.sourceBytes).padStart(10),
        `${measurement.sourceWidth}x${measurement.sourceHeight}`.padStart(12),
        formatBytes(measurement.avifBytes).padStart(9),
        formatBytes(measurement.webpBytes).padStart(9),
        `${(100 - (measurement.avifBytes / measurement.sourceBytes) * 100).toFixed(0)}%`.padStart(7),
        measurement.avifSsim.toFixed(4).padStart(10),
        measurement.webpSsim.toFixed(4).padStart(10),
      ].join(' '),
    );
  }

  const total = (pick: (m: Measurement) => number): number =>
    measurements.reduce((sum, measurement) => sum + pick(measurement), 0);

  const sourceTotal = total((m) => m.sourceBytes);
  const avifTotal = total((m) => m.avifBytes);
  const webpTotal = total((m) => m.webpBytes);
  const average = (pick: (m: Measurement) => number): number =>
    total(pick) / measurements.length;

  console.log('-'.repeat(header.length));
  console.log(
    `${measurements.length} images: ${formatBytes(sourceTotal)} source, ` +
      `${formatBytes(avifTotal)} AVIF (${(100 - (avifTotal / sourceTotal) * 100).toFixed(1)}% smaller), ` +
      `${formatBytes(webpTotal)} WebP (${(100 - (webpTotal / sourceTotal) * 100).toFixed(1)}% smaller)`,
  );
  console.log(
    `Mean SSIM: AVIF ${average((m) => m.avifSsim).toFixed(4)}, ` +
      `WebP ${average((m) => m.webpSsim).toFixed(4)}`,
  );
}

async function sweep(subjects: Map<Subject, Buffer>): Promise<void> {
  const candidates = [
    { label: 'AVIF q45 4:4:4', overrides: { avifQuality: 45 } },
    { label: 'AVIF q50 4:4:4', overrides: { avifQuality: 50 } },
    { label: 'AVIF q55 4:4:4', overrides: { avifQuality: 55 } },
    { label: 'AVIF q60 4:4:4', overrides: { avifQuality: 60 } },
    { label: 'AVIF q65 4:4:4', overrides: { avifQuality: 65 } },
    {
      label: 'AVIF q55 4:2:0',
      overrides: { avifQuality: 55, avifChromaSubsampling: '4:2:0' as const },
    },
    {
      label: 'AVIF q60 4:2:0',
      overrides: { avifQuality: 60, avifChromaSubsampling: '4:2:0' as const },
    },
    { label: 'WebP q75', overrides: { webpQuality: 75 } },
    { label: 'WebP q80', overrides: { webpQuality: 80 } },
    { label: 'WebP q85', overrides: { webpQuality: 85 } },
  ];

  console.log('\nQuality sweep, averaged over every subject at full output width.\n');
  console.log(
    `${'candidate'.padEnd(18)} ${'AVIF mean'.padStart(10)} ${'SSIM'.padStart(8)} ` +
      `${'WebP mean'.padStart(10)} ${'SSIM'.padStart(8)}`,
  );
  console.log('-'.repeat(58));

  for (const candidate of candidates) {
    const config = resolveImageConfig(candidate.overrides, {});
    const measurements: Measurement[] = [];

    for (const [subject, source] of subjects) {
      measurements.push(await measure(subject, source, config));
    }

    const average = (pick: (m: Measurement) => number): number =>
      measurements.reduce((sum, measurement) => sum + pick(measurement), 0) / measurements.length;

    console.log(
      `${candidate.label.padEnd(18)} ` +
        `${formatBytes(average((m) => m.avifBytes)).padStart(10)} ` +
        `${average((m) => m.avifSsim).toFixed(4).padStart(8)} ` +
        `${formatBytes(average((m) => m.webpBytes)).padStart(10)} ` +
        `${average((m) => m.webpSsim).toFixed(4).padStart(8)}`,
    );
  }
}

async function main(): Promise<void> {
  await mkdir(FIXTURE_DIRECTORY, { recursive: true });

  const subjects = new Map<Subject, Buffer>();
  for (const subject of SUBJECTS) {
    subjects.set(subject, await fetchSubject(subject));
  }

  if (process.argv.includes('--sweep')) {
    await sweep(subjects);
  } else {
    await reportCurrentConfiguration(subjects);
  }
}

await main();

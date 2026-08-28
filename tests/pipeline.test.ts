import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveImageConfig } from '../src/config.js';
import { ImageProcessingError, ImageValidationError } from '../src/errors.js';
import { emptyManifest, type Manifest } from '../src/manifest.js';
import { optimizeAndStore, planOptimization } from '../src/pipeline.js';
import { LocalStorageAdapter } from '../src/storage/local.js';
import { createTemporaryDirectory, gradientJpeg } from './fixtures.js';

const config = resolveImageConfig({}, {});

describe('optimizeAndStore', () => {
  let directory: Awaited<ReturnType<typeof createTemporaryDirectory>>;
  let storage: LocalStorageAdapter;

  beforeEach(async () => {
    directory = await createTemporaryDirectory();
    storage = new LocalStorageAdapter({ root: directory.path, baseUrl: 'https://cdn.example.test' });
  });

  afterEach(async () => {
    await directory.cleanup();
  });

  it('stores the original byte-for-byte alongside its derivatives', async () => {
    const source = await gradientJpeg({ width: 3000, height: 2000 });

    const result = await optimizeAndStore({ key: 'species/viper.jpg', source, storage, config });

    expect(result.status).toBe('processed');

    const storedOriginal = await storage.get('original/species/viper.jpg');
    expect(storedOriginal?.equals(source)).toBe(true);

    for (const derivative of result.record.derivatives) {
      expect(await storage.exists(derivative.key)).toBe(true);
    }
  });

  it('names derivatives deterministically from the source key and width', async () => {
    const source = await gradientJpeg({ width: 3000, height: 2000 });
    const result = await optimizeAndStore({ key: 'species/viper.jpg', source, storage, config });

    expect(result.record.derivatives.map((derivative) => derivative.key)).toEqual([
      'optimized/species/viper-1200.avif',
      'optimized/species/viper-1200.webp',
      'optimized/species/viper-2400.avif',
      'optimized/species/viper-2400.webp',
    ]);
  });

  it('reports URLs built by the storage adapter', async () => {
    const source = await gradientJpeg({ width: 1600, height: 1000 });
    const { record } = await optimizeAndStore({ key: 'hero.jpg', source, storage, config });

    expect(record.originalUrl).toBe('https://cdn.example.test/original/hero.jpg');
    expect(record.avifUrl).toBe('https://cdn.example.test/optimized/hero-1600.avif');
    expect(record.webpUrl).toBe('https://cdn.example.test/optimized/hero-1600.webp');
  });

  it('reduces the transfer size of a photographic original', async () => {
    const source = await gradientJpeg({ width: 3000, height: 2000 });
    const { record } = await optimizeAndStore({ key: 'hero.jpg', source, storage, config });

    expect(record.optimizedSize).toBeLessThan(record.originalSize);
    expect(record.width).toBe(2400);
    expect(record.height).toBe(1600);
  });

  it('writes nothing at all when the source cannot be decoded', async () => {
    const source = await gradientJpeg({ width: 1200, height: 800 });
    const truncated = Buffer.from(source.subarray(0, Math.floor(source.byteLength / 3)));

    await expect(
      optimizeAndStore({ key: 'broken.jpg', source: truncated, storage, config }),
    ).rejects.toBeInstanceOf(ImageProcessingError);

    expect(await storage.list('')).toEqual([]);
  });

  it('writes nothing when the input is not an image', async () => {
    await expect(
      optimizeAndStore({
        key: 'payload.jpg',
        source: Buffer.from('not an image at all', 'utf8'),
        storage,
        config,
      }),
    ).rejects.toBeInstanceOf(ImageValidationError);

    expect(await storage.list('')).toEqual([]);
  });

  it('leaves an existing original untouched when a later run fails', async () => {
    const source = await gradientJpeg({ width: 1600, height: 1000 });
    await optimizeAndStore({ key: 'hero.jpg', source, storage, config });
    const before = await storage.get('original/hero.jpg');

    await expect(
      optimizeAndStore({
        key: 'hero.jpg',
        source: Buffer.from('corrupt', 'utf8'),
        storage,
        config,
      }),
    ).rejects.toBeInstanceOf(ImageValidationError);

    const after = await storage.get('original/hero.jpg');
    expect(after?.equals(before!)).toBe(true);
  });

  it('rejects a key that tries to escape its prefix', async () => {
    const source = await gradientJpeg({ width: 400, height: 400 });

    for (const key of ['../escape.jpg', '/absolute.jpg', 'a/../../b.jpg', 'nul\u0000.jpg']) {
      const error = await optimizeAndStore({ key, source, storage, config }).catch(
        (thrown: unknown) => thrown,
      );
      expect(error, `key "${key}" was not rejected`).toBeInstanceOf(ImageValidationError);
      expect((error as ImageValidationError).code).toBe('UNSAFE_KEY');
    }

    expect(await storage.list('')).toEqual([]);
  });

  it('stores only the original when processing is disabled', async () => {
    const disabled = resolveImageConfig({ enabled: false }, {});
    const source = await gradientJpeg({ width: 1600, height: 1000 });

    const result = await optimizeAndStore({
      key: 'hero.jpg',
      source,
      storage,
      config: disabled,
    });

    expect(result.status).toBe('processing-disabled');
    expect(result.entry).toBeNull();
    expect(await storage.list('')).toEqual(['original/hero.jpg']);
  });

  it('skips work when the manifest already covers the same bytes and settings', async () => {
    const source = await gradientJpeg({ width: 2000, height: 1500 });
    const first = await optimizeAndStore({ key: 'hero.jpg', source, storage, config });

    const manifest: Manifest = {
      ...emptyManifest(),
      entries: { 'hero.jpg': first.entry! },
    };

    const second = await optimizeAndStore({ key: 'hero.jpg', source, storage, config, manifest });
    expect(second.status).toBe('skipped');

    const forced = await optimizeAndStore({
      key: 'hero.jpg',
      source,
      storage,
      config,
      manifest,
      force: true,
    });
    expect(forced.status).toBe('processed');
  });

  it('reprocesses when a derivative has been deleted from storage', async () => {
    const source = await gradientJpeg({ width: 2000, height: 1500 });
    const first = await optimizeAndStore({ key: 'hero.jpg', source, storage, config });
    const manifest: Manifest = { ...emptyManifest(), entries: { 'hero.jpg': first.entry! } };

    const { rm } = await import('node:fs/promises');
    await rm(`${directory.path}/optimized/hero-1200.avif`);

    const second = await optimizeAndStore({ key: 'hero.jpg', source, storage, config, manifest });
    expect(second.status).toBe('processed');
    expect(await storage.exists('optimized/hero-1200.avif')).toBe(true);
  });

  it('reprocesses when the quality configuration changes', async () => {
    const source = await gradientJpeg({ width: 2000, height: 1500 });
    const first = await optimizeAndStore({ key: 'hero.jpg', source, storage, config });
    const manifest: Manifest = { ...emptyManifest(), entries: { 'hero.jpg': first.entry! } };

    const second = await optimizeAndStore({
      key: 'hero.jpg',
      source,
      storage,
      config: resolveImageConfig({ avifQuality: config.avifQuality - 10 }, {}),
      manifest,
    });

    expect(second.status).toBe('processed');
  });
});

describe('planOptimization', () => {
  it('reports the derivatives a run would create without writing anything', async () => {
    const directory = await createTemporaryDirectory();
    try {
      const storage = new LocalStorageAdapter({ root: directory.path });
      const source = await gradientJpeg({ width: 3000, height: 2000 });

      const plan = await planOptimization({ key: 'species/viper.jpg', source, storage, config });

      expect(plan.upToDate).toBe(false);
      expect(plan.sourceWidth).toBe(3000);
      expect(plan.derivatives.map((derivative) => derivative.key)).toEqual([
        'optimized/species/viper-1200.avif',
        'optimized/species/viper-1200.webp',
        'optimized/species/viper-2400.avif',
        'optimized/species/viper-2400.webp',
      ]);
      expect(await storage.list('')).toEqual([]);
    } finally {
      await directory.cleanup();
    }
  });
});

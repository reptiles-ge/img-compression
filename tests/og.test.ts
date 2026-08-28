import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';

import { resolveImageConfig } from '../src/config.js';
import { ConfigurationError, ImageProcessingError, ImageValidationError } from '../src/errors.js';
import {
  ogImageDescriptor,
  ogImageKey,
  ogImageMetaTags,
  renderAndStoreOgImage,
  renderOgImage,
  resolveOgImageConfig,
} from '../src/og.js';
import { LocalStorageAdapter } from '../src/storage/local.js';
import {
  animatedWebp,
  createTemporaryDirectory,
  gradientJpeg,
  jpegWithMetadata,
  noisyJpeg,
  transparentPng,
} from './fixtures.js';

const og = resolveOgImageConfig({}, {});
const limits = resolveImageConfig({}, {});

describe('renderOgImage', () => {
  it('always produces exactly the card the meta tags will declare', async () => {
    const wide = await renderOgImage(await gradientJpeg({ width: 3000, height: 900 }), { og });
    const tall = await renderOgImage(await gradientJpeg({ width: 900, height: 3000 }), { og });

    for (const image of [wide, tall]) {
      expect(image.width).toBe(1200);
      expect(image.height).toBe(630);

      const metadata = await sharp(image.data).metadata();
      expect(metadata.width).toBe(1200);
      expect(metadata.height).toBe(630);
    }
  });

  it('encodes JPEG, because unfurlers cannot be relied on to decode anything else', async () => {
    const image = await renderOgImage(await gradientJpeg({ width: 2000, height: 1200 }), { og });

    expect(image.contentType).toBe('image/jpeg');
    expect((await sharp(image.data).metadata()).format).toBe('jpeg');
  });

  it('stays inside the byte budget that keeps WhatsApp rendering the preview', async () => {
    const image = await renderOgImage(await noisyJpeg({ width: 2400, height: 1600 }), { og });

    expect(image.byteSize).toBeLessThanOrEqual(og.maxBytes);
    expect(image.withinBudget).toBe(true);
  });

  it('lowers quality until the result fits a tight budget', async () => {
    const source = await noisyJpeg({ width: 2400, height: 1600 });
    const tight = resolveOgImageConfig({ maxBytes: 100_000 }, {});

    const image = await renderOgImage(source, { og: tight });

    expect(image.quality).toBeLessThan(tight.quality);
    expect(image.byteSize).toBeLessThanOrEqual(tight.maxBytes);
  });

  it('reports honestly when even the lowest quality cannot reach the budget', async () => {
    const source = await noisyJpeg({ width: 2400, height: 1600 });
    const impossible = resolveOgImageConfig({ maxBytes: 20_000, minQuality: 70 }, {});

    const image = await renderOgImage(source, { og: impossible });

    expect(image.withinBudget).toBe(false);
    expect(image.quality).toBe(impossible.minQuality);
    expect(image.data.byteLength).toBeGreaterThan(0);
  });

  it('enlarges a source smaller than the card and says so', async () => {
    const image = await renderOgImage(await gradientJpeg({ width: 600, height: 400 }), { og });

    expect(image.width).toBe(1200);
    expect(image.enlarged).toBe(true);
  });

  it('does not claim enlargement for a source larger than the card', async () => {
    const image = await renderOgImage(await gradientJpeg({ width: 2000, height: 1400 }), { og });

    expect(image.enlarged).toBe(false);
  });

  it('composites transparency onto the background, since JPEG has no alpha', async () => {
    const image = await renderOgImage(await transparentPng({ width: 1400, height: 800 }), { og });

    const metadata = await sharp(image.data).metadata();
    expect(metadata.hasAlpha).toBe(false);
    expect(metadata.channels).toBe(3);
  });

  it('drops metadata so a shared card carries no capture location', async () => {
    const source = await jpegWithMetadata({ width: 1600, height: 1000 });
    expect((await sharp(source).metadata()).exif).toBeDefined();

    const image = await renderOgImage(source, { og });

    const metadata = await sharp(image.data).metadata();
    expect(metadata.exif).toBeUndefined();
    expect(metadata.xmp).toBeUndefined();
  });

  it('produces identical bytes for identical input and settings', async () => {
    const source = await gradientJpeg({ width: 1800, height: 1000 });

    const first = await renderOgImage(source, { og });
    const second = await renderOgImage(source, { og });

    expect(first.data.equals(second.data)).toBe(true);
  });

  it('applies the same guards to untrusted input as the rest of the pipeline', async () => {
    await expect(renderOgImage(await animatedWebp(), { og })).rejects.toBeInstanceOf(
      ImageValidationError,
    );
    await expect(
      renderOgImage(Buffer.from('this is not an image', 'utf8'), { og }),
    ).rejects.toBeInstanceOf(ImageValidationError);
  });

  it('honours a caller-supplied pixel budget', async () => {
    const source = await gradientJpeg({ width: 2000, height: 1400 });
    const strict = resolveImageConfig({ maxInputPixels: 100_000 }, {});

    await expect(renderOgImage(source, { og, config: strict })).rejects.toBeInstanceOf(
      ImageValidationError,
    );
  });

  it('respects a configured card size other than the default', async () => {
    const twitter = resolveOgImageConfig({ width: 1200, height: 675 }, {});

    const image = await renderOgImage(await gradientJpeg({ width: 2400, height: 1600 }), {
      og: twitter,
    });

    expect([image.width, image.height]).toEqual([1200, 675]);
  });
});

describe('resolveOgImageConfig', () => {
  it('defaults to the 1.91:1 card every platform renders at full size', () => {
    expect(og.width).toBe(1200);
    expect(og.height).toBe(630);
    expect(og.maxBytes).toBe(300_000);
  });

  it('reads settings from the environment', () => {
    const config = resolveOgImageConfig(
      {},
      { OG_IMAGE_WIDTH: '1200', OG_IMAGE_HEIGHT: '675', OG_IMAGE_MAX_BYTES: '250000' },
    );

    expect([config.width, config.height, config.maxBytes]).toEqual([1200, 675, 250_000]);
  });

  it('lets explicit overrides win over the environment', () => {
    const config = resolveOgImageConfig({ height: 630 }, { OG_IMAGE_HEIGHT: '675' });

    expect(config.height).toBe(630);
  });

  it('rejects settings that are out of range or contradictory', () => {
    expect(() => resolveOgImageConfig({ quality: 0 }, {})).toThrow(ConfigurationError);
    expect(() => resolveOgImageConfig({ width: 10 }, {})).toThrow(ConfigurationError);
    expect(() => resolveOgImageConfig({ quality: 60, minQuality: 80 }, {})).toThrow(
      ImageProcessingError,
    );
    expect(() => resolveOgImageConfig({}, { OG_IMAGE_CROP: 'sideways' })).toThrow(
      ImageProcessingError,
    );
  });

  it('refuses a prefix that could escape its directory', () => {
    expect(() => resolveOgImageConfig({ prefix: '../secrets' }, {})).toThrow(ConfigurationError);
  });
});

describe('ogImageKey', () => {
  it('nests the preview under its own prefix and always ends in .jpg', () => {
    expect(ogImageKey(og, 'species/vipera-lebetina.jpg')).toBe('og/species/vipera-lebetina.jpg');
    expect(ogImageKey(og, 'landing.png')).toBe('og/landing.jpg');
  });

  it('refuses a key that tries to escape', () => {
    expect(() => ogImageKey(og, '../../etc/passwd')).toThrow();
  });
});

describe('ogImageMetaTags', () => {
  it('declares the dimensions of the image actually rendered', async () => {
    const image = await renderOgImage(await gradientJpeg({ width: 2000, height: 1200 }), { og });
    const descriptor = ogImageDescriptor(image, 'https://cdn.reptiles.ge/og/viper.jpg', 'A viper');

    const tags = ogImageMetaTags(descriptor);
    const content = (key: string): string | undefined =>
      tags.find((tag) => tag.key === key)?.content;

    expect(content('og:image:width')).toBe(String(image.width));
    expect(content('og:image:height')).toBe(String(image.height));
    expect(content('og:image:type')).toBe('image/jpeg');
  });

  it('emits the Twitter card explicitly rather than relying on a fallback', () => {
    const tags = ogImageMetaTags(
      ogImageDescriptor({ width: 1200, height: 630 }, 'https://cdn.reptiles.ge/og/x.jpg', 'Alt'),
    );

    expect(tags.find((tag) => tag.key === 'twitter:card')?.content).toBe('summary_large_image');
    expect(tags.find((tag) => tag.key === 'twitter:image')?.attribute).toBe('name');
    expect(tags.find((tag) => tag.key === 'og:image')?.attribute).toBe('property');
  });

  it('carries the alt text through to both vocabularies', () => {
    const tags = ogImageMetaTags(
      ogImageDescriptor({ width: 1200, height: 630 }, 'https://cdn.reptiles.ge/og/x.jpg', 'გიურზა'),
    );

    expect(tags.find((tag) => tag.key === 'og:image:alt')?.content).toBe('გიურზა');
    expect(tags.find((tag) => tag.key === 'twitter:image:alt')?.content).toBe('გიურზა');
  });
});

describe('renderAndStoreOgImage', () => {
  let directory: Awaited<ReturnType<typeof createTemporaryDirectory>>;
  let storage: LocalStorageAdapter;

  beforeEach(async () => {
    directory = await createTemporaryDirectory();
    storage = new LocalStorageAdapter({
      root: directory.path,
      baseUrl: 'https://cdn.reptiles.ge',
    });
  });

  afterEach(async () => {
    await directory.cleanup();
  });

  it('writes the preview and describes it with the adapter URL', async () => {
    const stored = await renderAndStoreOgImage({
      key: 'species/vipera-lebetina.jpg',
      source: await gradientJpeg({ width: 2000, height: 1200 }),
      alt: 'A blunt-nosed viper',
      storage,
      og,
      config: limits,
    });

    expect(stored.key).toBe('og/species/vipera-lebetina.jpg');
    expect(stored.descriptor.url).toBe('https://cdn.reptiles.ge/og/species/vipera-lebetina.jpg');
    expect(stored.descriptor.width).toBe(1200);

    const written = await storage.get(stored.key);
    expect(written?.equals(stored.data)).toBe(true);
  });

  it('leaves nothing behind when the source cannot be used', async () => {
    await expect(
      renderAndStoreOgImage({
        key: 'species/broken.jpg',
        source: Buffer.from('not an image', 'utf8'),
        alt: 'Broken',
        storage,
        og,
        config: limits,
      }),
    ).rejects.toBeInstanceOf(ImageValidationError);

    expect(await storage.list('og')).toEqual([]);
  });
});

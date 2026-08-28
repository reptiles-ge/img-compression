import { describe, expect, it } from 'vitest';
import sharp from 'sharp';

import { resolveImageConfig } from '../src/config.js';
import { processImage } from '../src/processor.js';
import {
  FAST_ENCODER_SETTINGS,
  gradientJpeg,
  gradientPng,
  jpegWithMetadata,
  noisyJpeg,
  rotatedJpeg,
  transparentPng,
} from './fixtures.js';

const config = resolveImageConfig({}, {});
const fastConfig = resolveImageConfig(FAST_ENCODER_SETTINGS, {});

describe('processImage', () => {
  it('derives AVIF and WebP from a valid JPEG while leaving the input untouched', async () => {
    const source = await gradientJpeg({ width: 3000, height: 2000 });
    const sourceCopy = Buffer.from(source);

    const result = await processImage(source, config);

    expect(source.equals(sourceCopy)).toBe(true);
    expect(result.derivatives.map((derivative) => derivative.format)).toContain('avif');
    expect(result.derivatives.map((derivative) => derivative.format)).toContain('webp');

    for (const derivative of result.derivatives) {
      const metadata = await sharp(derivative.data).metadata();
      const container =
        metadata.format === 'heif' && metadata.compression === 'av1' ? 'avif' : metadata.format;
      expect(container).toBe(derivative.format);
    }
  });

  it('derives from a valid PNG', async () => {
    const result = await processImage(await gradientPng({ width: 1600, height: 900 }), config);

    expect(result.source.format).toBe('png');
    expect(result.width).toBe(1600);
    expect(result.height).toBe(900);
  });

  it('preserves the alpha channel of a transparent PNG', async () => {
    const result = await processImage(await transparentPng({ width: 800, height: 600 }), config);

    for (const derivative of result.derivatives) {
      const metadata = await sharp(derivative.data).metadata();
      expect(metadata.hasAlpha, `${derivative.format} lost its alpha channel`).toBe(true);
    }
  });

  it('never upscales an image smaller than the configured maximum', async () => {
    const result = await processImage(await gradientJpeg({ width: 600, height: 400 }), config);

    expect(result.width).toBe(600);
    expect(result.height).toBe(400);
    for (const derivative of result.derivatives) {
      expect(derivative.width).toBe(600);
      expect(derivative.height).toBe(400);
    }
  });

  it('emits a single width when the source is smaller than the whole ladder', async () => {
    const result = await processImage(await gradientJpeg({ width: 600, height: 400 }), config);
    const widths = new Set(result.derivatives.map((derivative) => derivative.width));

    expect([...widths]).toEqual([600]);
    expect(result.derivatives).toHaveLength(2);
  });

  it('resizes a large image down to the configured maximum width', async () => {
    const result = await processImage(await noisyJpeg({ width: 4000, height: 3000 }), fastConfig);

    expect(result.width).toBe(fastConfig.maxWidth);
    expect(result.height).toBe(1800);

    const widths = [...new Set(result.derivatives.map((derivative) => derivative.width))];
    expect(widths).toEqual([1200, 2400]);
  });

  it('preserves the aspect ratio when resizing', async () => {
    const result = await processImage(await gradientJpeg({ width: 3200, height: 1200 }), config);

    for (const derivative of result.derivatives) {
      expect(derivative.width / derivative.height).toBeCloseTo(3200 / 1200, 2);
    }
  });

  it('applies EXIF orientation so the derivative renders upright', async () => {
    const source = await rotatedJpeg({ width: 800, height: 1200 });
    expect((await sharp(source).metadata()).orientation).toBe(6);

    const result = await processImage(source, config);

    expect(result.source.width).toBe(1200);
    expect(result.source.height).toBe(800);
    for (const derivative of result.derivatives) {
      expect(derivative.width).toBeGreaterThan(derivative.height);
      const metadata = await sharp(derivative.data).metadata();
      expect(metadata.width).toBe(derivative.width);
      expect(metadata.orientation).toBeUndefined();
    }
  });

  it('drops EXIF but keeps the ICC profile on derivatives', async () => {
    const source = await jpegWithMetadata({ width: 1200, height: 800 });
    expect((await sharp(source).metadata()).exif).toBeDefined();

    const result = await processImage(source, config);

    for (const derivative of result.derivatives) {
      const metadata = await sharp(derivative.data).metadata();
      expect(metadata.exif, `${derivative.format} kept EXIF`).toBeUndefined();
      expect(metadata.xmp, `${derivative.format} kept XMP`).toBeUndefined();
      expect(metadata.icc, `${derivative.format} lost its colour profile`).toBeDefined();
    }
  });

  it('produces byte-identical output for identical input and configuration', async () => {
    const source = await gradientJpeg({ width: 1500, height: 1000 });

    const first = await processImage(source, config);
    const second = await processImage(source, config);

    expect(first.derivatives).toHaveLength(second.derivatives.length);
    for (const [index, derivative] of first.derivatives.entries()) {
      expect(derivative.data.equals(second.derivatives[index]!.data)).toBe(true);
    }
  });

  it('honours a configured quality change', async () => {
    const source = await noisyJpeg({ width: 1400, height: 1000 });

    const high = await processImage(
      source,
      resolveImageConfig({ ...FAST_ENCODER_SETTINGS, avifQuality: 80 }, {}),
    );
    const low = await processImage(
      source,
      resolveImageConfig({ ...FAST_ENCODER_SETTINGS, avifQuality: 30 }, {}),
    );

    const avifBytes = (result: Awaited<ReturnType<typeof processImage>>): number =>
      result.derivatives.filter((derivative) => derivative.format === 'avif').at(-1)!.byteSize;

    expect(avifBytes(low)).toBeLessThan(avifBytes(high));
  });
});

import { describe, expect, it } from 'vitest';
import sharp from 'sharp';

import { resolveImageConfig } from '../src/config.js';
import { ImageValidationError } from '../src/errors.js';
import { validateSource } from '../src/validate.js';
import { animatedWebp, gradientJpeg, rotatedJpeg } from './fixtures.js';

const config = resolveImageConfig({}, {});

async function expectRejection(input: Buffer, code: string): Promise<void> {
  const error = await validateSource(input, config).catch((thrown: unknown) => thrown);

  expect(error).toBeInstanceOf(ImageValidationError);
  expect((error as ImageValidationError).code).toBe(code);
}

describe('validateSource', () => {
  it('accepts a well-formed JPEG', async () => {
    const source = await gradientJpeg({ width: 1200, height: 800 });
    const result = await validateSource(source, config);

    expect(result).toMatchObject({ format: 'jpeg', width: 1200, height: 800, hasAlpha: false });
    expect(result.byteSize).toBe(source.byteLength);
  });

  it('reports orientation-corrected dimensions', async () => {
    const result = await validateSource(await rotatedJpeg({ width: 400, height: 900 }), config);

    expect(result.orientation).toBe(6);
    expect(result).toMatchObject({ width: 900, height: 400 });
  });

  it('rejects empty input', async () => {
    await expectRejection(Buffer.alloc(0), 'INPUT_EMPTY');
  });

  it('rejects input above the byte limit before decoding it', async () => {
    const source = await gradientJpeg({ width: 1200, height: 800 });
    const tiny = resolveImageConfig({ maxInputBytes: 2048 }, {});

    const error = await validateSource(source, tiny).catch((thrown: unknown) => thrown);
    expect((error as ImageValidationError).code).toBe('INPUT_TOO_LARGE');
  });

  it('rejects a file that is not an image, whatever it claims to be', async () => {
    await expectRejection(Buffer.from('#!/bin/sh\nrm -rf /\n', 'utf8'), 'INPUT_UNREADABLE');
  });

  it('rejects a document whose bytes only start like an image', async () => {
    const source = await gradientJpeg({ width: 64, height: 64 });
    const spoofed = Buffer.concat([source.subarray(0, 4), Buffer.from('<?xml version="1.0"?>')]);

    await expectRejection(spoofed, 'INPUT_UNREADABLE');
  });

  it('rejects an unsupported image format regardless of its extension', async () => {
    const gif = await sharp({
      create: { width: 32, height: 32, channels: 3, background: '#ff0000' },
    })
      .gif()
      .toBuffer();

    await expectRejection(gif, 'UNSUPPORTED_FORMAT');
  });

  it('rejects an animated image rather than silently keeping one frame', async () => {
    await expectRejection(await animatedWebp(), 'ANIMATED_UNSUPPORTED');
  });

  it('accepts a header that only a full decode can disprove', async () => {
    const source = await gradientJpeg({ width: 1200, height: 800 });
    const truncated = source.subarray(0, Math.floor(source.byteLength / 3));

    await expect(validateSource(truncated, config)).resolves.toMatchObject({ format: 'jpeg' });
  });

  it('rejects a decompression bomb through the pixel budget', async () => {
    const bomb = await sharp({
      create: { width: 12_000, height: 12_000, channels: 3, background: '#000000' },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();

    const limited = resolveImageConfig({ maxInputPixels: 40_000_000 }, {});
    const error = await validateSource(bomb, limited).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ImageValidationError);
    expect(['PIXEL_BUDGET_EXCEEDED', 'INPUT_UNREADABLE']).toContain(
      (error as ImageValidationError).code,
    );
  });

  it('rejects pathological aspect ratios that slip under the pixel budget', async () => {
    const sliver = await sharp({
      create: { width: 30_000, height: 8, channels: 3, background: '#0000ff' },
    })
      .png()
      .toBuffer();

    await expectRejection(sliver, 'DIMENSIONS_OUT_OF_RANGE');
  });
});

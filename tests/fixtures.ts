import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

/**
 * Fixtures are synthesised at run time rather than committed.
 *
 * Real wildlife photography would be the better compression sample, but it is
 * copyrighted and would put binary blobs in an open-source repository. Encoder
 * quality is measured separately by `scripts/benchmark.ts` against the site's
 * own images; these fixtures exist to prove behaviour, not compression ratios.
 */

export interface FixtureOptions {
  readonly width: number;
  readonly height: number;
}

/** Smooth diagonal gradient: the easy case for both encoders. */
export async function gradientJpeg({ width, height }: FixtureOptions): Promise<Buffer> {
  return sharp(gradientRaw(width, height), {
    raw: { width, height, channels: 3 },
  })
    .jpeg({ quality: 92 })
    .toBuffer();
}

export async function gradientPng({ width, height }: FixtureOptions): Promise<Buffer> {
  return sharp(gradientRaw(width, height), {
    raw: { width, height, channels: 3 },
  })
    .png()
    .toBuffer();
}

/** PNG carrying an alpha channel, to prove transparency survives the pipeline. */
export async function transparentPng({ width, height }: FixtureOptions): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 20, g: 140, b: 90, alpha: 0.35 },
    },
  })
    .png()
    .toBuffer();
}

/** High-frequency noise: the pathological case that resists compression. */
export async function noisyJpeg({ width, height }: FixtureOptions): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: '#808080',
      noise: { type: 'gaussian', mean: 128, sigma: 40 },
    },
  })
    .jpeg({ quality: 92 })
    .toBuffer();
}

/**
 * A portrait JPEG tagged with EXIF orientation 6, which means "rotate 90
 * degrees clockwise to display". A correct pipeline renders it landscape.
 */
export async function rotatedJpeg({ width, height }: FixtureOptions): Promise<Buffer> {
  return sharp(gradientRaw(width, height), {
    raw: { width, height, channels: 3 },
  })
    .withMetadata({ orientation: 6 })
    .jpeg({ quality: 92 })
    .toBuffer();
}

/** A genuinely animated WebP, built by joining three still frames. */
export async function animatedWebp(): Promise<Buffer> {
  const frame = async (background: string): Promise<Buffer> =>
    sharp({ create: { width: 32, height: 32, channels: 3, background } })
      .png()
      .toBuffer();

  const frames = [await frame('#ff0000'), await frame('#00ff00'), await frame('#0000ff')];

  return sharp(frames, { join: { animated: true } })
    .webp({ delay: 100, loop: 0 })
    .toBuffer();
}

/** A JPEG carrying EXIF, XMP and an ICC profile, for metadata assertions. */
export async function jpegWithMetadata({ width, height }: FixtureOptions): Promise<Buffer> {
  return sharp(gradientRaw(width, height), {
    raw: { width, height, channels: 3 },
  })
    .withIccProfile('p3')
    .withExif({
      IFD0: {
        Copyright: 'Reptiles.ge',
        Make: 'Test Camera',
      },
    })
    .jpeg({ quality: 92 })
    .toBuffer();
}

function gradientRaw(width: number, height: number): Buffer {
  const pixels = Buffer.allocUnsafe(width * height * 3);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      pixels[offset] = Math.round((x / Math.max(1, width - 1)) * 255);
      pixels[offset + 1] = Math.round((y / Math.max(1, height - 1)) * 255);
      pixels[offset + 2] = 128;
    }
  }
  return pixels;
}

export async function createTemporaryDirectory(): Promise<{
  path: string;
  cleanup: () => Promise<void>;
}> {
  const directory = await mkdtemp(path.join(tmpdir(), 'img-compression-'));
  return {
    path: directory,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

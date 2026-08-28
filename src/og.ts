import sharp from 'sharp';

import { resolveImageConfig, type ImageConfig } from './config.js';
import { assertRange, normalizePrefix, parseInteger } from './env.js';
import { ImageProcessingError } from './errors.js';
import { assertSafeKey, parseKey } from './naming.js';
import type { StorageAdapter } from './storage/types.js';
import { validateSource } from './validate.js';

/**
 * Social preview images are JPEG, deliberately, and not AVIF or WebP.
 *
 * This is the one place in the pipeline where the modern formats are the wrong
 * answer. An `og:image` is fetched by link unfurlers rather than browsers, and
 * those crawlers decode far less than a browser does: AVIF is rendered by only
 * a handful of them and silently dropped by the rest, which costs the preview
 * entirely. WebP is widely but not universally handled, and a format that
 * usually works is a poor trade for an asset whose first fetch is cached by the
 * platform and outlives any fix.
 *
 * JPEG is accepted everywhere and, for photographs, gives the best ratio of
 * quality to bytes among the formats that are safe here. The rest of the site
 * still gets AVIF and WebP; only the preview opts out.
 */

export const OG_IMAGE_CONTENT_TYPE = 'image/jpeg';

export interface OgImageConfig {
  /** 1200x630 is the 1.91:1 card every major platform renders at full size. */
  readonly width: number;
  readonly height: number;
  /** Starting quality. Lowered automatically when the result exceeds the budget. */
  readonly quality: number;
  /** Floor for that search, below which softness is worse than the extra bytes. */
  readonly minQuality: number;
  /**
   * WhatsApp drops the preview above roughly 300 KB, which is stricter than
   * every other platform and therefore the limit that matters.
   */
  readonly maxBytes: number;
  /** Where the crop is taken from when the source is not already 1.91:1. */
  readonly crop: 'attention' | 'entropy' | 'centre';
  /** JPEG has no alpha, so a transparent source is composited onto this. */
  readonly background: string;
  readonly prefix: string;
}

export const DEFAULT_OG_IMAGE_CONFIG: OgImageConfig = {
  width: 1200,
  height: 630,
  quality: 82,
  minQuality: 62,
  maxBytes: 300_000,
  crop: 'attention',
  background: '#ffffff',
  prefix: 'og',
};

export interface OgImageConfigEnv {
  OG_IMAGE_WIDTH?: string | undefined;
  OG_IMAGE_HEIGHT?: string | undefined;
  OG_IMAGE_QUALITY?: string | undefined;
  OG_IMAGE_MIN_QUALITY?: string | undefined;
  OG_IMAGE_MAX_BYTES?: string | undefined;
  OG_IMAGE_CROP?: string | undefined;
  OG_IMAGE_BACKGROUND?: string | undefined;
  OG_IMAGE_PREFIX?: string | undefined;
}

export type OgImageConfigOverrides = Partial<OgImageConfig>;

function parseCrop(raw: string | undefined): OgImageConfig['crop'] | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = raw.trim();
  if (value !== 'attention' && value !== 'entropy' && value !== 'centre') {
    throw new ImageProcessingError(
      `OG_IMAGE_CROP must be "attention", "entropy" or "centre", received "${raw}".`,
    );
  }
  return value;
}

/**
 * Resolved separately from {@link resolveImageConfig} on purpose.
 *
 * These settings do not participate in the derivative fingerprint, so changing
 * the preview quality does not invalidate every AVIF and WebP the site has
 * already produced.
 */
export function resolveOgImageConfig(
  overrides: OgImageConfigOverrides = {},
  env: OgImageConfigEnv = process.env,
): OgImageConfig {
  const fromEnv: OgImageConfigOverrides = {};
  const assign = <K extends keyof OgImageConfig>(
    key: K,
    value: OgImageConfig[K] | undefined,
  ): void => {
    if (value !== undefined) fromEnv[key] = value;
  };

  assign('width', parseInteger('OG_IMAGE_WIDTH', env.OG_IMAGE_WIDTH));
  assign('height', parseInteger('OG_IMAGE_HEIGHT', env.OG_IMAGE_HEIGHT));
  assign('quality', parseInteger('OG_IMAGE_QUALITY', env.OG_IMAGE_QUALITY));
  assign('minQuality', parseInteger('OG_IMAGE_MIN_QUALITY', env.OG_IMAGE_MIN_QUALITY));
  assign('maxBytes', parseInteger('OG_IMAGE_MAX_BYTES', env.OG_IMAGE_MAX_BYTES));
  assign('crop', parseCrop(env.OG_IMAGE_CROP));
  assign('background', env.OG_IMAGE_BACKGROUND);
  assign('prefix', env.OG_IMAGE_PREFIX);

  const config: OgImageConfig = { ...DEFAULT_OG_IMAGE_CONFIG, ...fromEnv, ...overrides };

  assertRange('OG_IMAGE_WIDTH', config.width, 200, 5000);
  assertRange('OG_IMAGE_HEIGHT', config.height, 100, 5000);
  assertRange('OG_IMAGE_QUALITY', config.quality, 1, 100);
  assertRange('OG_IMAGE_MIN_QUALITY', config.minQuality, 1, 100);
  assertRange('OG_IMAGE_MAX_BYTES', config.maxBytes, 10_000, 8_000_000);

  if (config.minQuality > config.quality) {
    throw new ImageProcessingError('OG_IMAGE_MIN_QUALITY must not exceed OG_IMAGE_QUALITY.');
  }

  return { ...config, prefix: normalizePrefix('OG_IMAGE_PREFIX', config.prefix) };
}

export interface OgImage {
  readonly data: Buffer;
  readonly width: number;
  readonly height: number;
  readonly byteSize: number;
  readonly contentType: typeof OG_IMAGE_CONTENT_TYPE;
  /** Quality actually used, which is lower than configured when the budget bit. */
  readonly quality: number;
  /** True when the source was smaller than the card and had to be enlarged. */
  readonly enlarged: boolean;
  /** False when even `minQuality` could not reach `maxBytes`. */
  readonly withinBudget: boolean;
}

const QUALITY_STEP = 6;

function encode(
  pixels: Buffer,
  info: { width: number; height: number; channels: number },
  quality: number,
): Promise<Buffer> {
  if (info.channels !== 3) {
    throw new ImageProcessingError(
      `Expected three channels after flattening, received ${info.channels}.`,
    );
  }

  return sharp(pixels, { raw: { width: info.width, height: info.height, channels: 3 } })
    .jpeg({ quality, mozjpeg: true, chromaSubsampling: '4:2:0' })
    .toBuffer();
}

/**
 * Renders a social preview card from a source photograph.
 *
 * The output is always exactly the configured size, because the dimensions are
 * also declared in the page's meta tags and a platform that trusts them will
 * letterbox or distort a card that does not match. Unlike the rest of the
 * pipeline this will enlarge a small source rather than emit something smaller
 * than the card, since a correct-but-soft preview beats a broken one; the
 * result reports `enlarged` so a caller can flag the asset.
 *
 * Quality steps down from the configured starting point until the result fits
 * the byte budget. Resizing happens once and only the encode is repeated.
 *
 * The image is converted to sRGB and stripped of all metadata. Unfurlers do not
 * colour-manage, so a CMYK or greyscale source has to be converted rather than
 * merely tagged, and EXIF would carry capture coordinates into a file whose
 * whole purpose is to be shared.
 */
export async function renderOgImage(
  source: Buffer,
  options: {
    readonly og?: OgImageConfig;
    readonly config?: ImageConfig;
  } = {},
): Promise<OgImage> {
  const og = options.og ?? resolveOgImageConfig();
  const limits = options.config ?? resolveImageConfig();

  const validated = await validateSource(source, limits);

  let resized;
  try {
    resized = await sharp(source, { failOn: 'error', limitInputPixels: limits.maxInputPixels })
      .timeout({ seconds: limits.processingTimeoutSeconds })
      .autoOrient()
      .resize({
        width: og.width,
        height: og.height,
        fit: 'cover',
        position: og.crop === 'centre' ? 'centre' : sharp.strategy[og.crop],
      })
      .flatten({ background: og.background })
      .toColorspace('srgb')
      .raw()
      .toBuffer({ resolveWithObject: true });
  } catch (cause) {
    throw new ImageProcessingError('Failed to build the social preview image.', { cause });
  }

  let quality = og.quality;
  let data = await encode(resized.data, resized.info, quality);

  while (data.byteLength > og.maxBytes && quality - QUALITY_STEP >= og.minQuality) {
    quality -= QUALITY_STEP;
    data = await encode(resized.data, resized.info, quality);
  }

  return {
    data,
    width: og.width,
    height: og.height,
    byteSize: data.byteLength,
    contentType: OG_IMAGE_CONTENT_TYPE,
    quality,
    enlarged: validated.width < og.width || validated.height < og.height,
    withinBudget: data.byteLength <= og.maxBytes,
  };
}

/**
 * Storage key for a preview, derived from the same logical key as the rest of
 * an image's derivatives and always ending in `.jpg`.
 */
export function ogImageKey(og: OgImageConfig, key: string): string {
  const { directory, baseName } = parseKey(assertSafeKey(key));
  return directory === ''
    ? `${og.prefix}/${baseName}.jpg`
    : `${og.prefix}/${directory}/${baseName}.jpg`;
}

export interface OgImageDescriptor {
  readonly url: string;
  readonly type: typeof OG_IMAGE_CONTENT_TYPE;
  readonly width: number;
  readonly height: number;
  readonly alt: string;
}

/**
 * Describes a stored preview in the shape Next.js expects for
 * `metadata.openGraph.images` and `metadata.twitter.images`.
 *
 * The dimensions come from the rendered file rather than from a constant, so
 * the declared size cannot drift from the bytes actually served.
 */
export function ogImageDescriptor(
  image: Pick<OgImage, 'width' | 'height'>,
  url: string,
  alt: string,
): OgImageDescriptor {
  return { url, type: OG_IMAGE_CONTENT_TYPE, width: image.width, height: image.height, alt };
}

export interface MetaTag {
  readonly attribute: 'property' | 'name';
  readonly key: string;
  readonly content: string;
}

/**
 * The full set of preview tags, for consumers not using the Next.js metadata
 * API. `twitter:image` is emitted explicitly rather than left to fall back to
 * `og:image`, and the URL must already be absolute and served over HTTPS,
 * because a relative one is dropped by every unfurler.
 */
export function ogImageMetaTags(descriptor: OgImageDescriptor): readonly MetaTag[] {
  return [
    { attribute: 'property', key: 'og:image', content: descriptor.url },
    { attribute: 'property', key: 'og:image:secure_url', content: descriptor.url },
    { attribute: 'property', key: 'og:image:type', content: descriptor.type },
    { attribute: 'property', key: 'og:image:width', content: String(descriptor.width) },
    { attribute: 'property', key: 'og:image:height', content: String(descriptor.height) },
    { attribute: 'property', key: 'og:image:alt', content: descriptor.alt },
    { attribute: 'name', key: 'twitter:card', content: 'summary_large_image' },
    { attribute: 'name', key: 'twitter:image', content: descriptor.url },
    { attribute: 'name', key: 'twitter:image:alt', content: descriptor.alt },
  ];
}

export interface StoredOgImage extends OgImage {
  readonly key: string;
  readonly descriptor: OgImageDescriptor;
}

/**
 * Renders a preview and writes it, returning everything the page needs to
 * declare it.
 */
export async function renderAndStoreOgImage(input: {
  readonly key: string;
  readonly source: Buffer;
  readonly alt: string;
  readonly storage: StorageAdapter;
  readonly og?: OgImageConfig;
  readonly config?: ImageConfig;
}): Promise<StoredOgImage> {
  const og = input.og ?? resolveOgImageConfig();
  const image = await renderOgImage(input.source, {
    og,
    ...(input.config && { config: input.config }),
  });
  const key = ogImageKey(og, input.key);

  await input.storage.put(key, image.data, { contentType: image.contentType });

  return {
    ...image,
    key,
    descriptor: ogImageDescriptor(image, input.storage.urlFor(key), input.alt),
  };
}

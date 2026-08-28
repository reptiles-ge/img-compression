import { createHash } from 'node:crypto';

import { ConfigurationError } from './errors.js';

/**
 * Bumped whenever a change to the processing pipeline alters the produced bytes
 * without any user-visible configuration having changed. It participates in the
 * config fingerprint so that a release can invalidate previously derived assets.
 */
export const PIPELINE_VERSION = 1;

export type AvifChromaSubsampling = '4:4:4' | '4:2:0';

export interface ImageConfig {
  /** Largest derivative width. Sources narrower than this are never upscaled. */
  readonly maxWidth: number;
  /** Smaller widths emitted alongside `maxWidth` to make `srcSet` meaningful. */
  readonly additionalWidths: readonly number[];
  readonly avifQuality: number;
  readonly avifEffort: number;
  readonly avifChromaSubsampling: AvifChromaSubsampling;
  readonly webpQuality: number;
  readonly webpEffort: number;
  /** When false, `optimizeAndStore` stores the original and derives nothing. */
  readonly enabled: boolean;
  readonly maxInputBytes: number;
  /** Decoded-pixel ceiling. The primary decompression-bomb guard. */
  readonly maxInputPixels: number;
  readonly minDimension: number;
  readonly maxDimension: number;
  readonly processingTimeoutSeconds: number;
  readonly originalPrefix: string;
  readonly optimizedPrefix: string;
}

/**
 * Defaults chosen from measurements against the site's own photography rather
 * than from convention; `docs/benchmarks.md` records the numbers.
 *
 * AVIF quality 60 is where mean SSIM crosses 0.98 across the sample, the point
 * generally treated as visually transparent for photographs. Dropping to 55
 * saves about 19% more bytes but falls to 0.976, and climbing to 65 costs 12%
 * more bytes for 0.003 of SSIM. 4:4:4 chroma is kept because 4:2:0 saved only
 * 3% while risking exactly the saturated greens and reds this site publishes,
 * and because SSIM measures luma only and so cannot see that damage.
 *
 * WebP quality 82 sits deliberately above the usual 80 so the browsers that
 * cannot decode AVIF are not left with a visibly worse image.
 */
export const DEFAULT_IMAGE_CONFIG: ImageConfig = {
  maxWidth: 2400,
  additionalWidths: [1200],
  avifQuality: 60,
  avifEffort: 4,
  avifChromaSubsampling: '4:4:4',
  webpQuality: 82,
  webpEffort: 5,
  enabled: true,
  maxInputBytes: 40 * 1024 * 1024,
  maxInputPixels: 80_000_000,
  minDimension: 1,
  maxDimension: 20_000,
  processingTimeoutSeconds: 60,
  originalPrefix: 'original',
  optimizedPrefix: 'optimized',
};

export type ImageConfigOverrides = Partial<ImageConfig>;

/** Environment variables recognised by {@link resolveImageConfig}. */
export interface ImageConfigEnv {
  IMAGE_PROCESSING_ENABLED?: string | undefined;
  IMAGE_MAX_WIDTH?: string | undefined;
  IMAGE_ADDITIONAL_WIDTHS?: string | undefined;
  IMAGE_AVIF_QUALITY?: string | undefined;
  IMAGE_AVIF_EFFORT?: string | undefined;
  IMAGE_AVIF_CHROMA_SUBSAMPLING?: string | undefined;
  IMAGE_WEBP_QUALITY?: string | undefined;
  IMAGE_WEBP_EFFORT?: string | undefined;
  IMAGE_MAX_INPUT_BYTES?: string | undefined;
  IMAGE_MAX_INPUT_PIXELS?: string | undefined;
  IMAGE_MAX_DIMENSION?: string | undefined;
  IMAGE_PROCESSING_TIMEOUT_SECONDS?: string | undefined;
  IMAGE_ORIGINAL_PREFIX?: string | undefined;
  IMAGE_OPTIMIZED_PREFIX?: string | undefined;
}

function parseInteger(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw.trim());
  if (!Number.isInteger(value)) {
    throw new ConfigurationError(`${name} must be an integer, received "${raw}".`);
  }
  return value;
}

function parseBoolean(name: string, raw: string | undefined): boolean | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  throw new ConfigurationError(`${name} must be a boolean, received "${raw}".`);
}

function parseWidthList(name: string, raw: string | undefined): number[] | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => {
      const value = Number(part);
      if (!Number.isInteger(value)) {
        throw new ConfigurationError(
          `${name} must be a comma-separated list of integers, received "${raw}".`,
        );
      }
      return value;
    });
}

function parseChromaSubsampling(
  name: string,
  raw: string | undefined,
): AvifChromaSubsampling | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = raw.trim();
  if (value !== '4:4:4' && value !== '4:2:0') {
    throw new ConfigurationError(`${name} must be "4:4:4" or "4:2:0", received "${raw}".`);
  }
  return value;
}

function assertRange(name: string, value: number, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigurationError(`${name} must be an integer between ${min} and ${max}.`);
  }
}

function normalizePrefix(name: string, prefix: string): string {
  const trimmed = prefix.trim().replace(/^\/+|\/+$/g, '');
  if (trimmed === '') {
    throw new ConfigurationError(`${name} must not be empty.`);
  }
  if (!/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(trimmed) || trimmed.split('/').includes('..')) {
    throw new ConfigurationError(
      `${name} must be a relative slash-separated path of [A-Za-z0-9._-] segments.`,
    );
  }
  return trimmed;
}

type MutableConfig = { -readonly [K in keyof ImageConfig]?: ImageConfig[K] };

function readEnvOverrides(env: ImageConfigEnv): ImageConfigOverrides {
  const overrides: MutableConfig = {};

  // Only defined values are copied, so an unset variable falls through to the
  // default rather than overwriting it with `undefined`.
  const assign = <K extends keyof ImageConfig>(key: K, value: ImageConfig[K] | undefined): void => {
    if (value !== undefined) overrides[key] = value;
  };

  assign('enabled', parseBoolean('IMAGE_PROCESSING_ENABLED', env.IMAGE_PROCESSING_ENABLED));
  assign('maxWidth', parseInteger('IMAGE_MAX_WIDTH', env.IMAGE_MAX_WIDTH));
  assign(
    'additionalWidths',
    parseWidthList('IMAGE_ADDITIONAL_WIDTHS', env.IMAGE_ADDITIONAL_WIDTHS),
  );
  assign('avifQuality', parseInteger('IMAGE_AVIF_QUALITY', env.IMAGE_AVIF_QUALITY));
  assign('avifEffort', parseInteger('IMAGE_AVIF_EFFORT', env.IMAGE_AVIF_EFFORT));
  assign(
    'avifChromaSubsampling',
    parseChromaSubsampling('IMAGE_AVIF_CHROMA_SUBSAMPLING', env.IMAGE_AVIF_CHROMA_SUBSAMPLING),
  );
  assign('webpQuality', parseInteger('IMAGE_WEBP_QUALITY', env.IMAGE_WEBP_QUALITY));
  assign('webpEffort', parseInteger('IMAGE_WEBP_EFFORT', env.IMAGE_WEBP_EFFORT));
  assign('maxInputBytes', parseInteger('IMAGE_MAX_INPUT_BYTES', env.IMAGE_MAX_INPUT_BYTES));
  assign('maxInputPixels', parseInteger('IMAGE_MAX_INPUT_PIXELS', env.IMAGE_MAX_INPUT_PIXELS));
  assign('maxDimension', parseInteger('IMAGE_MAX_DIMENSION', env.IMAGE_MAX_DIMENSION));
  assign(
    'processingTimeoutSeconds',
    parseInteger('IMAGE_PROCESSING_TIMEOUT_SECONDS', env.IMAGE_PROCESSING_TIMEOUT_SECONDS),
  );
  assign('originalPrefix', env.IMAGE_ORIGINAL_PREFIX);
  assign('optimizedPrefix', env.IMAGE_OPTIMIZED_PREFIX);

  return overrides;
}

/**
 * Builds the effective configuration from defaults, environment and explicit
 * overrides, in that order of increasing precedence, and validates the result.
 */
export function resolveImageConfig(
  overrides: ImageConfigOverrides = {},
  env: ImageConfigEnv = process.env,
): ImageConfig {
  const config: ImageConfig = {
    ...DEFAULT_IMAGE_CONFIG,
    ...readEnvOverrides(env),
    ...overrides,
  };

  assertRange('maxWidth', config.maxWidth, 16, 10_000);
  assertRange('avifQuality', config.avifQuality, 1, 100);
  assertRange('avifEffort', config.avifEffort, 0, 9);
  assertRange('webpQuality', config.webpQuality, 1, 100);
  assertRange('webpEffort', config.webpEffort, 0, 6);
  assertRange('maxInputBytes', config.maxInputBytes, 1024, 1024 * 1024 * 1024);
  assertRange('maxInputPixels', config.maxInputPixels, 1024, 1_000_000_000);
  assertRange('minDimension', config.minDimension, 1, 1024);
  assertRange('maxDimension', config.maxDimension, config.minDimension, 100_000);
  assertRange('processingTimeoutSeconds', config.processingTimeoutSeconds, 1, 600);

  for (const width of config.additionalWidths) {
    assertRange('additionalWidths', width, 16, 10_000);
  }

  return {
    ...config,
    additionalWidths: [...new Set(config.additionalWidths)].sort((a, b) => a - b),
    originalPrefix: normalizePrefix('originalPrefix', config.originalPrefix),
    optimizedPrefix: normalizePrefix('optimizedPrefix', config.optimizedPrefix),
  };
}

/**
 * The widths that would be emitted for a source of `sourceWidth` pixels.
 * Never exceeds the source width, so an image is never upscaled and a small
 * source collapses to a single derivative instead of several identical ones.
 */
export function targetWidthsFor(config: ImageConfig, sourceWidth: number): number[] {
  const ladder = [...config.additionalWidths, config.maxWidth]
    .filter((width) => width <= config.maxWidth)
    .filter((width) => width < sourceWidth);

  const widths = new Set(ladder);
  widths.add(Math.min(sourceWidth, config.maxWidth));

  return [...widths].sort((a, b) => a - b);
}

/**
 * A short, stable digest of every setting that influences the produced bytes.
 * Stored in the manifest so a quality or ladder change invalidates derivatives
 * while a change to, say, the input size limit does not.
 */
export function configFingerprint(config: ImageConfig): string {
  const encodingRelevant = {
    pipelineVersion: PIPELINE_VERSION,
    maxWidth: config.maxWidth,
    additionalWidths: [...config.additionalWidths].sort((a, b) => a - b),
    avifQuality: config.avifQuality,
    avifEffort: config.avifEffort,
    avifChromaSubsampling: config.avifChromaSubsampling,
    webpQuality: config.webpQuality,
    webpEffort: config.webpEffort,
  };

  return createHash('sha256').update(JSON.stringify(encodingRelevant)).digest('hex').slice(0, 16);
}

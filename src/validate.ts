import sharp, { type Metadata } from 'sharp';

import type { ImageConfig } from './config.js';
import { ImageValidationError } from './errors.js';
import { isSupportedInputFormat, type SupportedInputFormat } from './formats.js';

export interface ValidatedSource {
  readonly format: SupportedInputFormat;
  /** Width after EXIF orientation has been applied. */
  readonly width: number;
  /** Height after EXIF orientation has been applied. */
  readonly height: number;
  readonly byteSize: number;
  readonly hasAlpha: boolean;
  /** EXIF orientation tag, 1 when absent or already upright. */
  readonly orientation: number;
}

/**
 * A quarter turn swaps the reported dimensions. libvips exposes the raw EXIF
 * tag, so callers must apply this themselves to know the rendered size.
 */
function isQuarterTurn(orientation: number): boolean {
  return orientation >= 5 && orientation <= 8;
}

/**
 * Inspects untrusted bytes and either returns their trustworthy properties or
 * throws. Every check runs against the decoded header rather than the file name
 * or a client-supplied content type, both of which are attacker-controlled.
 *
 * This never returns partially validated data: a throw means nothing downstream
 * should touch the input.
 */
export async function validateSource(
  input: Buffer,
  config: ImageConfig,
): Promise<ValidatedSource> {
  if (input.byteLength === 0) {
    throw new ImageValidationError('INPUT_EMPTY', 'Image input is empty.');
  }

  // Checked before decoding so that an oversized payload is rejected without
  // ever being handed to libvips.
  if (input.byteLength > config.maxInputBytes) {
    throw new ImageValidationError(
      'INPUT_TOO_LARGE',
      `Image is ${input.byteLength} bytes, which exceeds the ${config.maxInputBytes} byte limit.`,
    );
  }

  let metadata: Metadata;
  try {
    metadata = await sharp(input, {
      failOn: 'error',
      limitInputPixels: config.maxInputPixels,
      animated: false,
    }).metadata();
  } catch (cause) {
    throw new ImageValidationError('INPUT_UNREADABLE', 'Image could not be decoded.', { cause });
  }

  if (!isSupportedInputFormat(metadata.format)) {
    throw new ImageValidationError(
      'UNSUPPORTED_FORMAT',
      `Image format "${metadata.format ?? 'unknown'}" is not supported.`,
    );
  }

  // Animated sources would silently collapse to their first frame, which is a
  // surprising result for a caller who uploaded a GIF or animated WebP.
  if ((metadata.pages ?? 1) > 1) {
    throw new ImageValidationError(
      'ANIMATED_UNSUPPORTED',
      'Animated images are not supported by this pipeline.',
    );
  }

  const rawWidth = metadata.width;
  const rawHeight = metadata.height;
  if (
    rawWidth === undefined ||
    rawHeight === undefined ||
    !Number.isFinite(rawWidth) ||
    !Number.isFinite(rawHeight)
  ) {
    throw new ImageValidationError('INPUT_UNREADABLE', 'Image dimensions could not be determined.');
  }

  const orientation = metadata.orientation ?? 1;
  const width = isQuarterTurn(orientation) ? rawHeight : rawWidth;
  const height = isQuarterTurn(orientation) ? rawWidth : rawHeight;

  if (
    width < config.minDimension ||
    height < config.minDimension ||
    width > config.maxDimension ||
    height > config.maxDimension
  ) {
    throw new ImageValidationError(
      'DIMENSIONS_OUT_OF_RANGE',
      `Image is ${width}x${height}px, outside the permitted ` +
        `${config.minDimension}-${config.maxDimension}px range per side.`,
    );
  }

  // A second, explicit bomb guard. libvips already enforces limitInputPixels
  // while decoding, but a header can advertise a plausible size per side and
  // still multiply out to an unreasonable allocation.
  if (width * height > config.maxInputPixels) {
    throw new ImageValidationError(
      'PIXEL_BUDGET_EXCEEDED',
      `Image has ${width * height} pixels, which exceeds the ${config.maxInputPixels} pixel limit.`,
    );
  }

  return {
    format: metadata.format,
    width,
    height,
    byteSize: input.byteLength,
    hasAlpha: metadata.hasAlpha ?? false,
    orientation,
  };
}

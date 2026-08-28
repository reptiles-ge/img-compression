import sharp, { type Sharp } from 'sharp';

import { targetWidthsFor, type ImageConfig } from './config.js';
import { ImageProcessingError } from './errors.js';
import { DERIVATIVE_FORMATS, type DerivativeFormat } from './formats.js';
import { validateSource, type ValidatedSource } from './validate.js';

export interface Derivative {
  readonly format: DerivativeFormat;
  readonly width: number;
  readonly height: number;
  readonly byteSize: number;
  readonly data: Buffer;
}

export interface ProcessedImage {
  readonly source: ValidatedSource;
  /** Ordered by ascending width, then by the browser's format preference. */
  readonly derivatives: readonly Derivative[];
  /** Dimensions of the largest derivative, i.e. the intrinsic size to render at. */
  readonly width: number;
  readonly height: number;
}

/**
 * Builds the shared decode stage.
 *
 * `autoOrient` bakes EXIF orientation into the pixels and clears the tag, so
 * every downstream measurement and crop works on an upright image.
 */
function createBasePipeline(input: Buffer, config: ImageConfig): Sharp {
  return sharp(input, {
    failOn: 'error',
    limitInputPixels: config.maxInputPixels,
    animated: false,
  })
    .timeout({ seconds: config.processingTimeoutSeconds })
    .autoOrient();
}

function encode(pipeline: Sharp, format: DerivativeFormat, config: ImageConfig): Sharp {
  switch (format) {
    case 'avif':
      return pipeline.avif({
        quality: config.avifQuality,
        effort: config.avifEffort,
        chromaSubsampling: config.avifChromaSubsampling,
      });
    case 'webp':
      return pipeline.webp({
        quality: config.webpQuality,
        effort: config.webpEffort,
        smartSubsample: true,
      });
  }
}

/**
 * Decodes once and emits an AVIF and a WebP derivative for every applicable
 * width. Clones share the parent's input, so libvips resolves the decode a
 * single time and reuses it across the encoders.
 *
 * All metadata except the ICC profile is dropped: EXIF, XMP and IPTC add bytes
 * and can leak capture location, while discarding the colour profile would
 * visibly shift the colours of wide-gamut photography.
 *
 * WebP is always 4:2:0, so `smartSubsample` is enabled: it spends a little
 * encode time to avoid the chroma bleed that shows on saturated scales and
 * plumage.
 *
 * Nothing is written anywhere; the caller decides what to persist. A rejection
 * therefore leaves no partial output behind.
 */
export async function processImage(input: Buffer, config: ImageConfig): Promise<ProcessedImage> {
  const source = await validateSource(input, config);
  const widths = targetWidthsFor(config, source.width);

  const base = createBasePipeline(input, config);
  const derivatives: Derivative[] = [];

  for (const width of widths) {
    const resized = base.clone().resize({
      width,
      fit: 'inside',
      withoutEnlargement: true,
    });

    let encoded: Awaited<ReturnType<typeof encodeAll>>;
    try {
      encoded = await encodeAll(resized, config);
    } catch (cause) {
      throw new ImageProcessingError(`Failed to encode derivative at ${width}px.`, { cause });
    }

    derivatives.push(...encoded);
  }

  const largest = derivatives.at(-1);
  if (largest === undefined) {
    throw new ImageProcessingError('Processing produced no derivatives.');
  }

  return {
    source,
    derivatives,
    width: largest.width,
    height: largest.height,
  };
}

async function encodeAll(resized: Sharp, config: ImageConfig): Promise<Derivative[]> {
  return Promise.all(
    DERIVATIVE_FORMATS.map(async (format) => {
      const { data, info } = await encode(
        resized.clone().keepIccProfile(),
        format,
        config,
      ).toBuffer({ resolveWithObject: true });

      return {
        format,
        width: info.width,
        height: info.height,
        byteSize: data.byteLength,
        data,
      } satisfies Derivative;
    }),
  );
}

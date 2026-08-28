import type { DerivativeFormat } from './formats.js';
import type { OptimizedImageRecord } from './pipeline.js';

/**
 * The serialisable view of an optimised image.
 *
 * This module intentionally imports nothing at runtime: it is the boundary
 * between the Node-only processing side and the browser-facing rendering side,
 * so the same shape can be stored in the database, sent over the wire and
 * handed straight to the React component.
 */
export interface ImageAssetSource {
  readonly format: DerivativeFormat;
  readonly url: string;
  readonly width: number;
  readonly height: number;
}

export interface ImageAsset {
  /** Intrinsic width of the largest derivative. */
  readonly width: number;
  /** Intrinsic height of the largest derivative. */
  readonly height: number;
  /** Every derivative, ascending by width. */
  readonly sources: readonly ImageAssetSource[];
  /**
   * Reached only by a browser that supports neither AVIF nor WebP, so it points
   * at the preserved original. Those bytes are larger, but they are the only
   * ones such a browser can actually decode.
   */
  readonly fallbackUrl: string;
}

export function toImageAsset(record: OptimizedImageRecord): ImageAsset {
  return {
    width: record.width,
    height: record.height,
    sources: record.derivatives.map((derivative) => ({
      format: derivative.format,
      url: derivative.url,
      width: derivative.width,
      height: derivative.height,
    })),
    fallbackUrl: record.originalUrl,
  };
}

/**
 * Builds the `srcSet` for one format, or `null` when the asset carries none.
 * Width descriptors let the browser combine the candidate list with `sizes`
 * and its own DPR to pick a file, which is what keeps a phone from downloading
 * the 2400px master.
 *
 * Candidates are sorted by width so the string is stable however the caller
 * assembled the asset. Browsers ignore candidate order, but stable output stays
 * diffable and cacheable.
 */
export function srcSetFor(asset: ImageAsset, format: DerivativeFormat): string | null {
  const candidates = asset.sources
    .filter((source) => source.format === format)
    .sort((a, b) => a.width - b.width)
    .map((source) => `${source.url} ${source.width}w`);

  return candidates.length === 0 ? null : candidates.join(', ');
}

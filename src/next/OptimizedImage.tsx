import type { CSSProperties, ReactElement } from 'react';

import { srcSetFor, type ImageAsset } from '../asset.js';
import { DERIVATIVE_FORMATS, MIME_TYPES } from '../formats.js';

export interface OptimizedImageProps {
  readonly asset: ImageAsset;
  /**
   * Describes what the image means, or an empty string when it is purely
   * decorative and the surrounding text already conveys the information.
   */
  readonly alt: string;
  /**
   * The rendered width at each breakpoint, for example
   * `(max-width: 768px) 100vw, 800px`.
   *
   * Required on purpose. Omitting it makes the browser assume `100vw` and pick
   * the largest candidate on every device, which quietly undoes the point of
   * generating several widths.
   */
  readonly sizes: string;
  /**
   * Marks the image as the page's Largest Contentful Paint candidate: it loads
   * eagerly, is fetched at high priority and is preloaded from the document
   * head. Use it for a single above-the-fold image per page; applying it
   * broadly makes every image compete and helps none of them.
   */
  readonly priority?: boolean;
  readonly className?: string;
  readonly style?: CSSProperties;
  readonly id?: string;
}

/**
 * Renders a pre-generated AVIF/WebP pair with correct responsive, priority and
 * layout-stability behaviour.
 *
 * A `<picture>` element rather than `next/image` is deliberate. The derivatives
 * already exist on the CDN in their final encoding, and `next/image` cannot
 * choose between two URLs by format; routing them through `/_next/image` would
 * re-encode assets that are already optimal and bill a transformation for the
 * privilege. Everything `next/image` gives us that matters here -- intrinsic
 * dimensions, `srcSet`, `sizes`, lazy loading and preloading -- is expressed
 * directly.
 *
 * `width` and `height` are always emitted, so the browser reserves the correct
 * box before the bytes arrive and the image contributes nothing to CLS. When
 * CSS constrains the width, pair it with `height: auto` to keep the ratio.
 */
export function OptimizedImage({
  asset,
  alt,
  sizes,
  priority = false,
  className,
  style,
  id,
}: OptimizedImageProps): ReactElement {
  const sourceSets = DERIVATIVE_FORMATS.flatMap((format) => {
    const srcSet = srcSetFor(asset, format);
    return srcSet === null ? [] : [{ format, srcSet }];
  });

  const preferred = sourceSets[0];

  return (
    <>
      {priority && preferred !== undefined ? (
        <link
          rel="preload"
          as="image"
          type={MIME_TYPES[preferred.format]}
          imageSrcSet={preferred.srcSet}
          imageSizes={sizes}
          fetchPriority="high"
        />
      ) : null}
      <picture>
        {sourceSets.map((entry) => (
          <source
            key={entry.format}
            type={MIME_TYPES[entry.format]}
            srcSet={entry.srcSet}
            sizes={sizes}
          />
        ))}
        <img
          src={asset.fallbackUrl}
          alt={alt}
          width={asset.width}
          height={asset.height}
          loading={priority ? 'eager' : 'lazy'}
          decoding={priority ? 'sync' : 'async'}
          {...(priority ? { fetchPriority: 'high' as const } : {})}
          {...(className === undefined ? {} : { className })}
          {...(style === undefined ? {} : { style })}
          {...(id === undefined ? {} : { id })}
        />
      </picture>
    </>
  );
}

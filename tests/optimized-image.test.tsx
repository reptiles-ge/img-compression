import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import type { ImageAsset } from '../src/asset.js';
import { OptimizedImage } from '../src/next/OptimizedImage.js';

const asset: ImageAsset = {
  width: 2400,
  height: 1600,
  sources: [
    { format: 'avif', url: 'https://cdn.reptiles.ge/optimized/viper-1200.avif', width: 1200, height: 800 },
    { format: 'webp', url: 'https://cdn.reptiles.ge/optimized/viper-1200.webp', width: 1200, height: 800 },
    { format: 'avif', url: 'https://cdn.reptiles.ge/optimized/viper-2400.avif', width: 2400, height: 1600 },
    { format: 'webp', url: 'https://cdn.reptiles.ge/optimized/viper-2400.webp', width: 2400, height: 1600 },
  ],
  fallbackUrl: 'https://cdn.reptiles.ge/original/viper.jpg',
};

const sizes = '(max-width: 768px) 100vw, 800px';

describe('OptimizedImage', () => {
  it('offers AVIF before WebP and falls back to the original', () => {
    const html = renderToStaticMarkup(
      <OptimizedImage asset={asset} alt="A blunt-nosed viper on a rock" sizes={sizes} />,
    );

    const avifIndex = html.indexOf('image/avif');
    const webpIndex = html.indexOf('image/webp');
    expect(avifIndex).toBeGreaterThan(-1);
    expect(webpIndex).toBeGreaterThan(avifIndex);
    expect(html).toContain('src="https://cdn.reptiles.ge/original/viper.jpg"');
  });

  it('builds a width-descriptor srcSet per format', () => {
    const html = renderToStaticMarkup(<OptimizedImage asset={asset} alt="A viper" sizes={sizes} />);

    expect(html).toContain(
      'srcSet="https://cdn.reptiles.ge/optimized/viper-1200.avif 1200w, ' +
        'https://cdn.reptiles.ge/optimized/viper-2400.avif 2400w"',
    );
    expect(html).toContain(
      'srcSet="https://cdn.reptiles.ge/optimized/viper-1200.webp 1200w, ' +
        'https://cdn.reptiles.ge/optimized/viper-2400.webp 2400w"',
    );
  });

  it('passes sizes to every candidate list', () => {
    const html = renderToStaticMarkup(<OptimizedImage asset={asset} alt="A viper" sizes={sizes} />);
    const occurrences = html.split('(max-width: 768px) 100vw, 800px').length - 1;

    expect(occurrences).toBe(2);
  });

  it('emits intrinsic dimensions so the browser reserves space before loading', () => {
    const html = renderToStaticMarkup(<OptimizedImage asset={asset} alt="A viper" sizes={sizes} />);

    expect(html).toContain('width="2400"');
    expect(html).toContain('height="1600"');
  });

  it('lazy-loads by default', () => {
    const html = renderToStaticMarkup(<OptimizedImage asset={asset} alt="A viper" sizes={sizes} />);

    expect(html).toContain('loading="lazy"');
    expect(html).toContain('decoding="async"');
    expect(html).not.toContain('rel="preload"');
  });

  it('loads eagerly and preloads the AVIF candidates when marked as the LCP image', () => {
    const html = renderToStaticMarkup(
      <OptimizedImage asset={asset} alt="A viper" sizes={sizes} priority />,
    );

    expect(html).toContain('rel="preload"');
    expect(html).toContain('type="image/avif"');
    expect(html).toContain('imageSrcSet="https://cdn.reptiles.ge/optimized/viper-1200.avif 1200w');
    expect(html).toContain('loading="eager"');
    expect(html).toContain('decoding="sync"');
    expect(html).not.toContain('loading="lazy"');

    // HTML attribute names are case-insensitive, so React's camelCase output
    // parses as fetchpriority in the browser.
    expect(html.toLowerCase().split('fetchpriority="high"')).toHaveLength(3);
  });

  it('keeps an empty alt attribute for a decorative image', () => {
    const html = renderToStaticMarkup(<OptimizedImage asset={asset} alt="" sizes={sizes} />);
    expect(html).toContain('alt=""');
  });

  it('degrades to a plain image when no derivative exists', () => {
    const bare: ImageAsset = {
      width: 800,
      height: 600,
      sources: [],
      fallbackUrl: 'https://cdn.reptiles.ge/original/legacy.jpg',
    };

    const html = renderToStaticMarkup(<OptimizedImage asset={bare} alt="Legacy" sizes={sizes} />);

    expect(html).not.toContain('<source');
    expect(html).toContain('src="https://cdn.reptiles.ge/original/legacy.jpg"');
    expect(html).toContain('width="800"');
  });

  it('forwards presentation props without letting them replace the essentials', () => {
    const html = renderToStaticMarkup(
      <OptimizedImage
        asset={asset}
        alt="A viper"
        sizes={sizes}
        className="rounded-lg w-full h-auto"
        id="hero"
      />,
    );

    expect(html).toContain('class="rounded-lg w-full h-auto"');
    expect(html).toContain('id="hero"');
    expect(html).toContain('width="2400"');
  });
});

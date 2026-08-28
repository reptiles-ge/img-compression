import { describe, expect, it } from 'vitest';

import {
  DEFAULT_IMAGE_CONFIG,
  configFingerprint,
  resolveImageConfig,
  targetWidthsFor,
} from '../src/config.js';
import { ConfigurationError } from '../src/errors.js';

describe('resolveImageConfig', () => {
  it('falls back to the defaults with an empty environment', () => {
    expect(resolveImageConfig({}, {})).toEqual(DEFAULT_IMAGE_CONFIG);
  });

  it('reads settings from the environment', () => {
    const config = resolveImageConfig(
      {},
      {
        IMAGE_MAX_WIDTH: '1800',
        IMAGE_ADDITIONAL_WIDTHS: '600, 900',
        IMAGE_AVIF_QUALITY: '48',
        IMAGE_WEBP_QUALITY: '75',
        IMAGE_PROCESSING_ENABLED: 'false',
      },
    );

    expect(config).toMatchObject({
      maxWidth: 1800,
      additionalWidths: [600, 900],
      avifQuality: 48,
      webpQuality: 75,
      enabled: false,
    });
  });

  it('lets explicit overrides win over the environment', () => {
    const config = resolveImageConfig({ maxWidth: 3000 }, { IMAGE_MAX_WIDTH: '1000' });
    expect(config.maxWidth).toBe(3000);
  });

  it('rejects values that are out of range or malformed', () => {
    const cases: Array<[string, () => unknown]> = [
      ['non-numeric width', () => resolveImageConfig({}, { IMAGE_MAX_WIDTH: 'wide' })],
      ['quality above 100', () => resolveImageConfig({ avifQuality: 150 })],
      ['quality below 1', () => resolveImageConfig({ webpQuality: 0 })],
      ['effort out of range', () => resolveImageConfig({ avifEffort: 12 })],
      ['unknown boolean', () => resolveImageConfig({}, { IMAGE_PROCESSING_ENABLED: 'maybe' })],
      ['bad chroma', () => resolveImageConfig({}, { IMAGE_AVIF_CHROMA_SUBSAMPLING: '4:1:1' })],
      ['empty prefix', () => resolveImageConfig({ originalPrefix: '  ' })],
      ['traversal in prefix', () => resolveImageConfig({ originalPrefix: '../escape' })],
      ['traversal inside prefix', () => resolveImageConfig({ optimizedPrefix: 'web/../../etc' })],
      [
        'prefix with a separator we do not accept',
        () => resolveImageConfig({ originalPrefix: 'a\\b' }),
      ],
    ];

    for (const [label, run] of cases) {
      expect(run, label).toThrow(ConfigurationError);
    }
  });

  it('normalises prefixes and deduplicates widths', () => {
    const config = resolveImageConfig({
      originalPrefix: '/original/',
      optimizedPrefix: '/var/www/',
      additionalWidths: [1200, 800, 1200],
    });

    expect(config.originalPrefix).toBe('original');
    expect(config.optimizedPrefix).toBe('var/www');
    expect(config.additionalWidths).toEqual([800, 1200]);
  });
});

describe('targetWidthsFor', () => {
  const config = resolveImageConfig({}, {});

  it('caps at the configured maximum for a large source', () => {
    expect(targetWidthsFor(config, 4000)).toEqual([1200, 2400]);
  });

  it('never exceeds the source width', () => {
    expect(targetWidthsFor(config, 1500)).toEqual([1200, 1500]);
    expect(targetWidthsFor(config, 600)).toEqual([600]);
  });

  it('emits no duplicate when the source matches a ladder entry', () => {
    expect(targetWidthsFor(config, 1200)).toEqual([1200]);
    expect(targetWidthsFor(config, 2400)).toEqual([1200, 2400]);
  });
});

describe('configFingerprint', () => {
  it('is stable for settings that produce the same bytes', () => {
    const a = resolveImageConfig({ maxInputBytes: 1024 * 1024 });
    const b = resolveImageConfig({ maxInputBytes: 8 * 1024 * 1024 });

    expect(configFingerprint(a)).toBe(configFingerprint(b));
  });

  it('changes when an encoding setting changes', () => {
    const base = resolveImageConfig({});

    for (const variant of [
      resolveImageConfig({ avifQuality: base.avifQuality - 1 }),
      resolveImageConfig({ webpQuality: base.webpQuality - 1 }),
      resolveImageConfig({ maxWidth: base.maxWidth - 100 }),
      resolveImageConfig({ additionalWidths: [640] }),
      resolveImageConfig({ avifChromaSubsampling: '4:2:0' }),
      resolveImageConfig({ avifEffort: base.avifEffort + 1 }),
    ]) {
      expect(configFingerprint(variant)).not.toBe(configFingerprint(base));
    }
  });
});

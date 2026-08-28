import { describe, expect, it } from 'vitest';

import { resolveImageConfig } from '../src/config.js';
import { ImageValidationError } from '../src/errors.js';
import {
  assertSafeKey,
  derivativeKey,
  manifestKey,
  originalKey,
  parseKey,
  slugifyFileName,
} from '../src/naming.js';

const config = resolveImageConfig({}, {});

describe('assertSafeKey', () => {
  it('accepts ordinary relative keys', () => {
    for (const key of ['snake.jpg', 'species/viper.jpg', 'a/b/c/d.png', 'ხვლიკი.jpg']) {
      expect(assertSafeKey(key)).toBe(key);
    }
  });

  it('rejects anything that could escape its prefix', () => {
    const unsafe = [
      '',
      '..',
      '../secret.jpg',
      'a/../../etc/passwd',
      '/etc/passwd',
      './relative.jpg',
      'a//b.jpg',
      'windows\\path.jpg',
      'C:/windows/system32.jpg',
      'nul\u0000byte.jpg',
      'line\nbreak.jpg',
    ];

    for (const key of unsafe) {
      const error = (() => {
        try {
          assertSafeKey(key);
          return null;
        } catch (thrown) {
          return thrown;
        }
      })();

      expect(error, `"${key}" was accepted`).toBeInstanceOf(ImageValidationError);
      expect((error as ImageValidationError).code).toBe('UNSAFE_KEY');
    }
  });
});

describe('parseKey', () => {
  it('splits a key into directory, base name and extension', () => {
    expect(parseKey('species/viper.JPG')).toEqual({
      directory: 'species',
      baseName: 'viper',
      extension: 'jpg',
    });
    expect(parseKey('viper')).toEqual({ directory: '', baseName: 'viper', extension: '' });
    expect(parseKey('.hidden')).toEqual({ directory: '', baseName: '.hidden', extension: '' });
    expect(parseKey('a/b/c.tar.gz')).toEqual({
      directory: 'a/b',
      baseName: 'c.tar',
      extension: 'gz',
    });
  });
});

describe('derivative naming', () => {
  it('is deterministic and carries the width', () => {
    expect(derivativeKey(config, 'snake.jpg', 2400, 'avif')).toBe('optimized/snake-2400.avif');
    expect(derivativeKey(config, 'snake.jpg', 1200, 'webp')).toBe('optimized/snake-1200.webp');
    expect(derivativeKey(config, 'species/snake-1.jpg', 2400, 'avif')).toBe(
      'optimized/species/snake-1-2400.avif',
    );
  });

  it('keeps originals under their own prefix', () => {
    expect(originalKey(config, 'species/snake.jpg')).toBe('original/species/snake.jpg');
    expect(manifestKey(config)).toBe('optimized/manifest.json');
  });

  it('honours configured prefixes', () => {
    const custom = resolveImageConfig({ originalPrefix: 'raw/', optimizedPrefix: 'web' }, {});

    expect(originalKey(custom, 'snake.jpg')).toBe('raw/snake.jpg');
    expect(derivativeKey(custom, 'snake.jpg', 800, 'avif')).toBe('web/snake-800.avif');
  });
});

describe('slugifyFileName', () => {
  it('reduces an untrusted upload name to a conservative ASCII slug', () => {
    expect(slugifyFileName('Vipera Lebetina (2).JPG')).toBe('vipera-lebetina-2');
    expect(slugifyFileName('../../etc/passwd')).toBe('passwd');
    expect(slugifyFileName('Grüne Eidechse.png')).toBe('grune-eidechse');
    expect(slugifyFileName('   .jpg')).toBe('image');
    expect(slugifyFileName('!!!.png', 'photo')).toBe('photo');
  });

  it('produces a key that always passes the safety check', () => {
    for (const name of ['../../x.jpg', 'a\u0000b.png', 'C:\\evil.jpg', '....jpg']) {
      expect(() => assertSafeKey(`${slugifyFileName(name)}.jpg`)).not.toThrow();
    }
  });
});

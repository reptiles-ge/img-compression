import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConfigurationError, ImageValidationError, StorageError } from '../src/errors.js';
import { BunnyStorageAdapter } from '../src/storage/bunny.js';
import { LocalStorageAdapter } from '../src/storage/local.js';
import { createStorageFromEnv } from '../src/storage/index.js';
import { createTemporaryDirectory } from './fixtures.js';

describe('LocalStorageAdapter', () => {
  let directory: Awaited<ReturnType<typeof createTemporaryDirectory>>;
  let storage: LocalStorageAdapter;

  beforeEach(async () => {
    directory = await createTemporaryDirectory();
    storage = new LocalStorageAdapter({ root: directory.path, baseUrl: 'https://cdn.example.test/' });
  });

  afterEach(async () => {
    await directory.cleanup();
  });

  it('round-trips an object', async () => {
    const payload = Buffer.from('reptile', 'utf8');
    await storage.put('a/b/c.txt', payload, { contentType: 'text/plain' });

    expect((await storage.get('a/b/c.txt'))?.equals(payload)).toBe(true);
    expect(await storage.exists('a/b/c.txt')).toBe(true);
  });

  it('reports a missing object as null rather than throwing', async () => {
    expect(await storage.get('nothing.txt')).toBeNull();
    expect(await storage.exists('nothing.txt')).toBe(false);
    expect(await storage.list('missing')).toEqual([]);
  });

  it('lists nested objects with forward slashes', async () => {
    await storage.put('x/1.txt', Buffer.from('1'), { contentType: 'text/plain' });
    await storage.put('x/y/2.txt', Buffer.from('2'), { contentType: 'text/plain' });

    expect(await storage.list('')).toEqual(['x/1.txt', 'x/y/2.txt']);
    expect(await storage.list('x/y')).toEqual(['x/y/2.txt']);
  });

  it('leaves no temporary files behind after a write', async () => {
    await storage.put('a.txt', Buffer.from('a'), { contentType: 'text/plain' });
    expect(await storage.list('')).toEqual(['a.txt']);
  });

  it('refuses to resolve outside its root', async () => {
    for (const key of ['../outside.txt', '/etc/passwd', 'a/../../b.txt']) {
      await expect(
        storage.put(key, Buffer.from('x'), { contentType: 'text/plain' }),
        `"${key}" was accepted`,
      ).rejects.toBeInstanceOf(ImageValidationError);
    }
  });

  it('builds URLs from its base', () => {
    expect(storage.urlFor('optimized/a-2400.avif')).toBe(
      'https://cdn.example.test/optimized/a-2400.avif',
    );
  });
});

interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
}

function bunnyWithResponses(
  handler: (request: RecordedRequest, body: BodyInit | null | undefined) => Response,
): { adapter: BunnyStorageAdapter; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];

  const adapter = new BunnyStorageAdapter({
    storageZone: 'reptiles',
    accessKey: 'super-secret-key',
    region: 'de',
    cdnBaseUrl: 'https://cdn.reptiles.ge',
    fetchImpl: (input, init) => {
      const request: RecordedRequest = {
        url: input instanceof URL || typeof input === 'string' ? String(input) : input.url,
        method: init?.method ?? 'GET',
        headers: (init?.headers ?? {}) as Record<string, string>,
      };
      requests.push(request);
      return Promise.resolve(handler(request, init?.body));
    },
  });

  return { adapter, requests };
}

describe('BunnyStorageAdapter', () => {
  it('uploads with the access key and a checksum', async () => {
    const { adapter, requests } = bunnyWithResponses(() => new Response(null, { status: 201 }));

    await adapter.put('optimized/a-2400.avif', Buffer.from('avif-bytes'), {
      contentType: 'image/avif',
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      'https://storage.bunnycdn.com/reptiles/optimized/a-2400.avif',
    );
    expect(requests[0]?.method).toBe('PUT');
    expect(requests[0]?.headers['AccessKey']).toBe('super-secret-key');
    expect(requests[0]?.headers['Content-Type']).toBe('image/avif');
    expect(requests[0]?.headers['Checksum']).toMatch(/^[0-9A-F]{64}$/);
  });

  it('treats a missing object as null', async () => {
    const { adapter } = bunnyWithResponses(() => new Response(null, { status: 404 }));
    expect(await adapter.get('optimized/missing.avif')).toBeNull();
  });

  it('retries a transient failure and then succeeds', async () => {
    let attempts = 0;
    const { adapter } = bunnyWithResponses(() => {
      attempts += 1;
      return attempts < 3 ? new Response(null, { status: 503 }) : new Response(null, { status: 201 });
    });

    await adapter.put('a.avif', Buffer.from('x'), { contentType: 'image/avif' });
    expect(attempts).toBe(3);
  });

  it('does not retry a permanent rejection', async () => {
    let attempts = 0;
    const { adapter } = bunnyWithResponses(() => {
      attempts += 1;
      return new Response(null, { status: 401 });
    });

    await expect(
      adapter.put('a.avif', Buffer.from('x'), { contentType: 'image/avif' }),
    ).rejects.toBeInstanceOf(StorageError);
    expect(attempts).toBe(1);
  });

  it('never puts the access key in an error message', async () => {
    const { adapter } = bunnyWithResponses(() => new Response(null, { status: 500 }));

    const error = await adapter
      .put('a.avif', Buffer.from('x'), { contentType: 'image/avif' })
      .catch((thrown: unknown) => thrown);

    expect(JSON.stringify({ message: (error as Error).message })).not.toContain('super-secret-key');
  });

  it('answers existence from a directory listing', async () => {
    const { adapter, requests } = bunnyWithResponses((request) => {
      if (request.method === 'GET') {
        return Response.json([
          { ObjectName: 'a-2400.avif', IsDirectory: false },
          { ObjectName: 'nested', IsDirectory: true },
        ]);
      }
      return new Response(null, { status: 201 });
    });

    expect(await adapter.exists('optimized/a-2400.avif')).toBe(true);
    expect(await adapter.exists('optimized/b-2400.avif')).toBe(false);
    // The second question is answered from the memoised listing.
    expect(requests).toHaveLength(1);
  });

  it('walks nested directories when listing', async () => {
    const { adapter } = bunnyWithResponses((request) => {
      if (request.url.endsWith('/optimized/')) {
        return Response.json([
          { ObjectName: 'a-2400.avif', IsDirectory: false },
          { ObjectName: 'species', IsDirectory: true },
        ]);
      }
      return Response.json([{ ObjectName: 'viper-2400.avif', IsDirectory: false }]);
    });

    expect(await adapter.list('optimized')).toEqual([
      'optimized/a-2400.avif',
      'optimized/species/viper-2400.avif',
    ]);
  });

  it('builds CDN URLs from the pull zone origin', () => {
    const { adapter } = bunnyWithResponses(() => new Response(null, { status: 200 }));
    expect(adapter.urlFor('optimized/a-2400.avif')).toBe(
      'https://cdn.reptiles.ge/optimized/a-2400.avif',
    );
  });

  it('refuses an incomplete configuration', () => {
    const base = {
      storageZone: 'reptiles',
      accessKey: 'key',
      cdnBaseUrl: 'https://cdn.reptiles.ge',
    };

    expect(() => new BunnyStorageAdapter({ ...base, region: 'mars' })).toThrow(ConfigurationError);
    expect(() => new BunnyStorageAdapter({ ...base, storageZone: '' })).toThrow(ConfigurationError);
    expect(() => new BunnyStorageAdapter({ ...base, accessKey: '' })).toThrow(ConfigurationError);
    expect(() => new BunnyStorageAdapter({ ...base, cdnBaseUrl: 'not a url' })).toThrow(
      ConfigurationError,
    );
  });
});

describe('createStorageFromEnv', () => {
  it('defaults to the local driver', () => {
    expect(createStorageFromEnv({}).name).toBe('local');
  });

  it('builds the Bunny driver from the environment', () => {
    const storage = createStorageFromEnv({
      IMAGE_STORAGE_DRIVER: 'bunny',
      BUNNY_STORAGE_ZONE: 'reptiles',
      BUNNY_STORAGE_ACCESS_KEY: 'key',
      BUNNY_CDN_BASE_URL: 'https://cdn.reptiles.ge',
    });

    expect(storage.name).toBe('bunny');
  });

  it('explains which variable is missing', () => {
    expect(() => createStorageFromEnv({ IMAGE_STORAGE_DRIVER: 'bunny' })).toThrow(
      /BUNNY_STORAGE_ZONE/,
    );
  });

  it('rejects an unknown driver', () => {
    expect(() => createStorageFromEnv({ IMAGE_STORAGE_DRIVER: 's3' })).toThrow(ConfigurationError);
  });
});

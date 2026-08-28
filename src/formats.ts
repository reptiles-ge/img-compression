/** Formats emitted by the pipeline, in the order browsers should prefer them. */
export const DERIVATIVE_FORMATS = ['avif', 'webp'] as const;

export type DerivativeFormat = (typeof DERIVATIVE_FORMATS)[number];

/**
 * Source formats we are willing to decode. Determined from the decoded image
 * itself, never from the file name or a client-supplied content type.
 */
export const SUPPORTED_INPUT_FORMATS = ['jpeg', 'png', 'webp', 'avif', 'tiff', 'heif'] as const;

export type SupportedInputFormat = (typeof SUPPORTED_INPUT_FORMATS)[number];

export function isSupportedInputFormat(format: string | undefined): format is SupportedInputFormat {
  return (
    format !== undefined && (SUPPORTED_INPUT_FORMATS as readonly string[]).includes(format)
  );
}

export const MIME_TYPES: Readonly<Record<DerivativeFormat, string>> = {
  avif: 'image/avif',
  webp: 'image/webp',
};

/**
 * Content types for stored originals. Derived from the decoded format, so the
 * value we persist can never be influenced by a client-supplied header.
 */
export const INPUT_MIME_TYPES: Readonly<Record<SupportedInputFormat, string>> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
  tiff: 'image/tiff',
  heif: 'image/heif',
};

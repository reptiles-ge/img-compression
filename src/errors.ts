/**
 * Error codes are part of the public API: callers are expected to branch on
 * `error.code` rather than on message text, which is free to change.
 */
export type ImageErrorCode =
  | 'CONFIG_INVALID'
  | 'INPUT_EMPTY'
  | 'INPUT_TOO_LARGE'
  | 'INPUT_UNREADABLE'
  | 'UNSUPPORTED_FORMAT'
  | 'ANIMATED_UNSUPPORTED'
  | 'DIMENSIONS_OUT_OF_RANGE'
  | 'PIXEL_BUDGET_EXCEEDED'
  | 'UNSAFE_KEY'
  | 'ENCODE_FAILED'
  | 'STORAGE_FAILED';

export class ImagePipelineError extends Error {
  readonly code: ImageErrorCode;

  constructor(code: ImageErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

/** The input failed a guard before or during decoding. The source is untouched. */
export class ImageValidationError extends ImagePipelineError {}

/** Decoding or encoding failed. No derivative has been stored. */
export class ImageProcessingError extends ImagePipelineError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('ENCODE_FAILED', message, options);
  }
}

/** A storage adapter could not complete a read or write. */
export class StorageError extends ImagePipelineError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('STORAGE_FAILED', message, options);
  }
}

export class ConfigurationError extends ImagePipelineError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('CONFIG_INVALID', message, options);
  }
}

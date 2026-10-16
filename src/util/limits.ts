// limits against decompression bombs: small files declaring huge images

/** Thrown when an image exceeds the decode options' maxPixels */
export class LimitError extends RangeError {}

/** The default of the decode options' maxPixels: 16383 squared (like sharp's limitInputPixels) */
export const MAX_PIXELS = 0x3fff * 0x3fff;

/**
 * Throws if decoding an image of the given size would exceed the limit, before anything that size is allocated
 * @param count the number of such images (frames)
 */
export function checkPixels(width: number, height: number, limit: number, count = 1): void {
    if (!(width * height * count <= limit))
        throw new LimitError(`Image too large: ${count > 1 ? `${count} frames of ` : ''}${width}x${height} pixels exceed the limit of ${limit} (the decode options' maxPixels)`);
}

/** The most bytes of raw samples per pixel of the limit (4 samples of 16 bits) */
export const MAX_BYTES_PER_PIXEL = 8;

/**
 * Throws if an image's raw samples (bytes) would exceed what the pixel limit allows, for formats with any number of
 * samples per pixel
 */
export function checkBytes(bytes: number, limit: number): void {
    if (!(bytes <= limit * MAX_BYTES_PER_PIXEL))
        throw new LimitError(`Image too large: ${bytes} bytes of samples exceed what the limit of ${limit} pixels allows (the decode options' maxPixels)`);
}

/** Counts the pixels of decoded frames against a limit */
export class PixelBudget {
    private left: number;
    private limit: number;

    constructor(limit: number) {
        this.limit = this.left = limit;
    }

    /** Throws if another frame of the given size would exceed the limit */
    take(width: number, height: number): void {
        this.left -= width * height;
        if (!(this.left >= 0)) throw new LimitError(`Image too large: its frames exceed the limit of ${this.limit} pixels (the decode options' maxPixels)`);
    }
}

/**
 * Runs a decoder: reading past the end of damaged or truncated data throws a RangeError, which becomes an Error saying
 * so (with the RangeError as its cause); exceeded limits stay RangeErrors
 */
export async function decoding<T>(decode: () => T | Promise<T>): Promise<T> {
    try {
        return await decode();
    } catch (err) {
        if (err instanceof RangeError && !(err instanceof LimitError)) throw new Error('Image: damaged or truncated image data', { cause: err });
        throw err;
    }
}

import { VERSION } from './version.ts';
import { encode as utf8 } from './util/utf8.ts';
import * as exif from './codecs/exif.ts';

/**
 * Metadata written by the encoders. Each format stores the fields it has a place for:
 *
 * | Format | Fields |
 * |---|---|
 * | PNG, APNG | all (as text chunks) |
 * | JPEG | author, description, copyright, creation time, software (Exif); comment (comment marker) |
 * | WebP | author, description, copyright, creation time, software (Exif) |
 * | GIF | software, comment (comment extensions) |
 * | TGA | author, comment, creation time, software (extension area) |
 *
 * Empty fields are left out
 */
export interface Metadata {
    /** The image's title */
    title?: string;
    /** The image's author */
    author?: string;
    /** The image's description */
    description?: string;
    /** The image's copyright info */
    copyright?: string;
    /** The image's creation time. Default: now */
    creationTime?: string | number | Date;
    /** The software used to create the image. Default: `'github.com/matmen/ImageScript vX.X.X'`, `''` leaves it out */
    software?: string;
    /** A disclaimer for the image */
    disclaimer?: string;
    /** A warning for the image */
    warning?: string;
    /** The image's source */
    source?: string;
    /** A comment for the image */
    comment?: string;
}

/** @internal metadata with the defaults applied and empty fields removed */
export interface ResolvedMetadata {
    title?: string;
    author?: string;
    description?: string;
    copyright?: string;
    creationTime: Date;
    software?: string;
    disclaimer?: string;
    warning?: string;
    source?: string;
    comment?: string;
}

const TEXT_FIELDS = ['title', 'author', 'description', 'copyright', 'software', 'disclaimer', 'warning', 'source', 'comment'] as const;

/** @internal */
export function resolveMetadata(metadata: Metadata = {}): ResolvedMetadata {
    const { creationTime, software } = metadata || {};
    const time = new Date(creationTime === undefined ? Date.now() : creationTime);
    if (isNaN(time.getTime())) throw new RangeError('Invalid creation time');

    const resolved: ResolvedMetadata = { creationTime: time };
    for (const key of TEXT_FIELDS) {
        const value = key === 'software' && software === undefined ? `github.com/matmen/ImageScript v${VERSION}` : metadata?.[key];
        if (value) resolved[key] = String(value);
    }
    return resolved;
}

/** @internal PNG tEXt chunks, keyed by their keywords */
export function pngText(m: ResolvedMetadata): Record<string, string | undefined> {
    return {
        Title: m.title,
        Author: m.author,
        Description: m.description,
        Copyright: m.copyright,
        'Creation Time': m.creationTime.toUTCString(),
        Software: m.software,
        Disclaimer: m.disclaimer,
        Warning: m.warning,
        Source: m.source,
        Comment: m.comment
    };
}

/** @internal Exif data (a TIFF header and IFDs) for JPEG and WebP */
export function exifData(m: ResolvedMetadata): Uint8Array {
    return exif.encode({
        description: m.description,
        software: m.software,
        dateTime: m.creationTime,
        artist: m.author,
        copyright: m.copyright
    });
}

/** @internal GIF comment extensions */
export function gifComments(m: ResolvedMetadata): Uint8Array[] {
    return [m.software, m.comment].filter((c): c is string => !!c).map(utf8);
}

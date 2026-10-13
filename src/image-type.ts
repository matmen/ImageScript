import { BinaryData, view as bytes } from './util/mem.ts';

export type ImageTypeName = 'png' | 'jpeg' | 'tiff' | 'gif';

const MAGIC_NUMBERS = {
    PNG: 0x89504e47,
    JPEG: 0xffd8ff,
    TIFF_LE: 0x49492a00,
    TIFF_BE: 0x4d4d002a,
    BIGTIFF_LE: 0x49492b00,
    BIGTIFF_BE: 0x4d4d002b,
    GIF: 0x474946
};

// any binary data as a DataView (DataViews are used as is)
function dataView(data: BinaryData): DataView {
    if (data instanceof DataView) return data;
    const u8 = bytes(data);
    return new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
}

export class ImageType {
    /**
     * Gets an image's type from its magic number
     * @param data The image binary to get the type of
     * @returns The image type, or null if it isn't supported
     */
    static getType(data: BinaryData): ImageTypeName | null {
        const view = dataView(data);

        if (this.isPNG(view)) return 'png';
        if (this.isJPEG(view)) return 'jpeg';
        if (this.isTIFF(view)) return 'tiff';
        if (this.isGIF(view)) return 'gif';
        return null;
    }

    static isPNG(data: BinaryData): boolean {
        const view = dataView(data);
        return view.byteLength >= 4 && view.getUint32(0, false) === MAGIC_NUMBERS.PNG;
    }

    static isJPEG(data: BinaryData): boolean {
        const view = dataView(data);
        return view.byteLength >= 4 && (view.getUint32(0, false) >>> 8) === MAGIC_NUMBERS.JPEG;
    }

    static isTIFF(data: BinaryData): boolean {
        const view = dataView(data);
        if (view.byteLength < 4) return false;
        const magic = view.getUint32(0, false);
        return magic === MAGIC_NUMBERS.TIFF_LE || magic === MAGIC_NUMBERS.TIFF_BE || magic === MAGIC_NUMBERS.BIGTIFF_LE || magic === MAGIC_NUMBERS.BIGTIFF_BE;
    }

    static isGIF(data: BinaryData): boolean {
        const view = dataView(data);
        return view.byteLength >= 4 && (view.getUint32(0, false) >>> 8) === MAGIC_NUMBERS.GIF;
    }
}

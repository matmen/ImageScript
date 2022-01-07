import { crc32 } from './crc.mjs';
import { from_parts } from './mem.mjs';
import { compress, decompress } from './zlib.mjs';

const __IHDR__ = new Uint8Array([73, 72, 68, 82]);
const __IDAT__ = new Uint8Array([73, 68, 65, 84]);
const __IEND__ = new Uint8Array([73, 69, 78, 68]);
const __IEND_CRC__ = crc32(new Uint8Array([73, 69, 78, 68]));
const HEAD = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

const color_types = {
  GREYSCALE: 0,
  TRUECOLOR: 2,
  INDEXED_COLOR: 3,
  GREYSCALE_ALPHA: 4,
  TRUECOLOR_ALPHA: 6
};

const channels_to_color_type = {
  1: color_types.GREYSCALE,
  2: color_types.GREYSCALE_ALPHA,

  3: color_types.TRUECOLOR,
  4: color_types.TRUECOLOR_ALPHA
};

const utf8encoder = new TextEncoder; // replace with latin1 encoder or iext

export function encode(data, { text, width, height, channels, depth = 8, level = 0 }) {
  let offset = 0;
  let tmp_offset = 0;
  const row_length = width * channels;
  const tmp = new Uint8Array(height + data.length);

  while (offset < data.length) {
    tmp[tmp_offset++] = 0;
    tmp.set(data.subarray(offset, (offset += row_length)), tmp_offset);

    tmp_offset += row_length;
  }

  if (text) {
    let chunks = [];
    for (const key in text) {
      if (!text[key]) continue;
      const kb = utf8encoder.encode(key);
      const tb = utf8encoder.encode(text[key]);
      const chunk = new Uint8Array(1 + 12 + kb.length + tb.length);

      const view = new DataView(chunk.buffer);

      chunk[4] = 0x74;
      chunk[5] = 0x45;
      chunk[6] = 0x58;
      chunk[7] = 0x74;
      chunk.set(kb, 8);
      chunks.push(chunk);
      chunk.set(tb, 9 + kb.length);
      view.setUint32(0, chunk.length - 12);
      view.setUint32(chunk.length - 4, crc32(chunk.subarray(4, chunk.length - 4)));
    }

    text = from_parts(chunks);
  }

  offset = text ? text.length : 0;
  const compressed = compress(tmp, level);
  const array = new Uint8Array(49 + offset + HEAD.length + compressed.length);

  array[26] = 0;
  array[27] = 0;
  array[28] = 0;
  array[24] = depth;
  array.set(HEAD, 0);
  array.set(__IHDR__, 12);
  array.set(__IDAT__, 37);
  array.set(compressed, 41);
  array[25] = channels_to_color_type[channels];
  if (text) array.set(text, 45 + compressed.length);
  array.set(__IEND__, 49 + offset + compressed.length);

  const view = new DataView(array.buffer);

  view.setUint32(8, 13);
  view.setUint32(16, width);
  view.setUint32(20, height);
  view.setUint32(33, compressed.length);
  view.setUint32(45 + offset + compressed.length, 0);
  view.setUint32(53 + offset + compressed.length, __IEND_CRC__);
  view.setUint32(29, crc32(new Uint8Array(array.buffer, 12, 17)));
  view.setUint32(41 + compressed.length, crc32(new Uint8Array(array.buffer, 37, 4 + compressed.length)));

  return array;
}

export function decode(array) {
  let view = new DataView(array.buffer, array.byteOffset, array.byteLength);

  const width = view.getUint32(16);
  const height = view.getUint32(20);
  const bpc = array[24];
  const pixel_type = array[25];
  let channels = ({ 3: 1, 0: 1, 4: 2, 2: 3, 6: 4 })[pixel_type];
  const bytespp = channels * bpc / 8;

  const row_length = width * bytespp;
  let pixels = new Uint8Array(height * row_length);

  let offset = 0;
  let p_offset = 0;

  let c_offset = 33;
  const chunks = [];

  let palette, alphaPalette;

  const maxSearchOffset = array.length - 5;

  let type;
  while ((type = view.getUint32(4 + c_offset)) !== 1229278788) { // IEND
    if (type === 1229209940) // IDAT
      chunks.push(array.subarray(8 + c_offset, 8 + c_offset + view.getUint32(c_offset)));
    else if (type === 1347179589) { // PLTE
      if (palette)
        throw new Error('PLTE can only occur once in an image');
      palette = new Uint32Array(view.getUint32(c_offset));
      for (let pxlOffset = 0; pxlOffset < palette.length * 8; pxlOffset += 3)
        palette[pxlOffset / 3] = array[8 + c_offset + pxlOffset] << 24 | array[8 + c_offset + pxlOffset + 1] << 16 | array[8 + c_offset + pxlOffset + 2] << 8 | 0xff;
    } else if (type === 1951551059) { // tRNS
      if (alphaPalette)
        throw new Error('tRNS can only occur once in an image');
      alphaPalette = new Uint8Array(view.getUint32(c_offset));
      for (let i = 0; i < alphaPalette.length; i++)
        alphaPalette[i] = array[8 + c_offset + i];
    }

    c_offset += 4 + 4 + 4 + view.getUint32(c_offset);
    if (c_offset > maxSearchOffset) // missing IEND
      break;
  }

  array = decompress(chunks.length === 1 ? chunks[0] : from_parts(chunks), height + height * row_length);

  while (offset < array.byteLength) {
    const filter = array[offset++];
    const slice = array.subarray(offset, offset += row_length);

    if (0 === filter) pixels.set(slice, p_offset);
    else if (1 === filter) filter_1(slice, pixels, p_offset, bytespp, row_length);
    else if (2 === filter) filter_2(slice, pixels, p_offset, bytespp, row_length);
    else if (3 === filter) filter_3(slice, pixels, p_offset, bytespp, row_length);
    else if (4 === filter) filter_4(slice, pixels, p_offset, bytespp, row_length);

    p_offset += row_length;
  }

  if (pixel_type === 3) {
    if (!palette)
      throw new Error('Indexed color PNG has no PLTE');

    if (alphaPalette)
      for (let i = 0; i < alphaPalette.length; i++)
        palette[i] &= 0xffffff00 | alphaPalette[i];

    channels = 4;
    const newPixels = new Uint8Array(width * height * 4);
    const pixelView = new DataView(newPixels.buffer, newPixels.byteOffset, newPixels.byteLength);
    for (let i = 0; i < pixels.length; i++)
      pixelView.setUint32(i * 4, palette[pixels[i]], false);
    pixels = newPixels;
  }

  if (bpc !== 8) {
    const newPixels = new Uint8Array(pixels.length / bpc * 8);
    for (let i = 0; i < pixels.length; i += 2)
      newPixels[i / 2] = pixels[i];
    pixels = newPixels;
  }

  if (channels !== 4) {
    const newPixels = new Uint8Array(width * height * 4);
    const view = new DataView(newPixels.buffer);

    if (channels === 1) {
      for (let i = 0; i < width * height; i++) {
        const pixel = pixels[i];
        view.setUint32(i * 4, pixel << 24 | pixel << 16 | pixel << 8 | 0xff, false);
      }
    } else if (channels === 2) {
      for (let i = 0; i < width * height * 2; i += 2) {
        const pixel = pixels[i];
        view.setUint32(i * 2, pixel << 24 | pixel << 16 | pixel << 8 | pixels[i + 1], false);
      }
    } else if (channels === 3) {
      newPixels.fill(0xff);
      for (let i = 0; i < width * height; i++)
        newPixels.set(pixels.subarray(i * 3, i * 3 + 3), i * 4);
    }

    pixels = newPixels;
  }

  return { width, height, buffer: pixels };
}

function filter_1(slice, pixels, p_offset, bytespp, row_length) {
  let i = 0;
  while (i < bytespp) pixels[i + p_offset] = slice[i++];
  while (i < row_length) pixels[i + p_offset] = slice[i] + pixels[i++ + p_offset - bytespp];
}

function filter_2(slice, pixels, p_offset, bytespp, row_length) {
  if (0 === p_offset) pixels.set(slice, p_offset);
  else {
    let i = 0;
    while (i < row_length) pixels[i + p_offset] = slice[i] + pixels[i++ + p_offset - row_length];
  }
}

function filter_3(slice, pixels, p_offset, bytespp, row_length) {
  let i = 0;

  if (0 === p_offset) {
    while (i < bytespp) pixels[i] = slice[i++];
    while (i < row_length) pixels[i] = slice[i] + (pixels[i++ - bytespp] >> 1);
  } else {
    while (i < bytespp) pixels[i + p_offset] = slice[i] + (pixels[i++ + p_offset - row_length] >> 1);
    while (i < row_length) pixels[i + p_offset] = slice[i] + (pixels[i + p_offset - bytespp] + pixels[i++ + p_offset - row_length] >> 1);
  }
}

function filter_4(slice, pixels, p_offset, bytespp, row_length) {
  let i = 0;

  if (0 === p_offset) {
    while (i < bytespp) pixels[i] = slice[i++];
    while (i < row_length) pixels[i] = slice[i] + pixels[i++ - bytespp];
  } else {
    while (i < bytespp) pixels[i + p_offset] = slice[i] + pixels[i++ + p_offset - row_length];

    while (i < row_length) {
      const a = pixels[i + p_offset - bytespp];
      const b = pixels[i + p_offset - row_length];
      const c = pixels[i + p_offset - bytespp - row_length];

      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);

      pixels[i + p_offset] = slice[i++] + ((pa <= pb && pa <= pc) ? a : ((pb <= pc) ? b : c));
    }
  }
}

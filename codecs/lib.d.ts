declare module '@imagescript/codecs' {
  type wah = { width: number, height: number };
  type jpeg_encode_options = wah & { quality?: number };
  type webp_encode_options = wah & { quality?: number };

  type png_encode_options = wah & {
    compression?: 'fast' | 'best' | 'default',
    filter?: 'up' | 'sub' | 'none' | 'paeth' | 'average',
  };

  type gif_frame_options = wah & {
    x?: number,
    y?: number,
    delay?: number,
    speed?: number,
    colors?: number,
    quality?: number,
    dispose?: 'any' | 'keep' | 'previous' | 'background',
  }


  class gif_encoder {
    width: number;
    height: number;

    constructor(width: number, height: number): this;
    add(buffer: ArrayBufferView, options: gif_frame_options): void;
    finish(options: { repeat?: number, comment: string, application?: string }): Uint8Array;
  }


  export interface gif {
    encoder: gif_encoder,
  }

  export interface png {
    encode(buffer: ArrayBufferView, options: png_encode_options): Uint8Array,
    encode_async(buffer: ArrayBufferView, options: png_encode_options): Promise<Uint8Array>,
  }

  export interface jpeg {
    encode(buffer: ArrayBufferView, options: png_encode_options): Uint8Array,
    encode_async(buffer: ArrayBufferView, options: png_encode_options): Promise<Uint8Array>,
  }

  export interface webp {
    encode(buffer: ArrayBufferView, options: png_encode_options): Uint8Array,
    encode_async(buffer: ArrayBufferView, options: png_encode_options): Promise<Uint8Array>,
  }
}
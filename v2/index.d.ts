import { Color } from './framebuffer';
import type framebuffer from './framebuffer';

export { Color };
export function load(buffer: BufferSource): Image | Animation;

type svg_options = {
  /** image fit options */
  fit?: svg_fit_zoom | svg_fit_width | svg_fit_height,
};

type png_options = {
  compression?: 'fast' | 'best' | 'default',
  filter?: 'up' | 'sub' | 'none' | 'paeth' | 'average',
}

type svg_fit_zoom = {
  /** zoom by factor */
  zoom: number,
  width?: undefined,
  height?: undefined,
};
type svg_fit_width = {
  /** scale to width */
  width: number,
  zoom?: undefined,
  height?: undefined,
};

type svg_fit_height = {
  /** scale to height */
  height: number,
  zoom?: undefined,
  width?: undefined,
};

export class Frame {
  image: Image;
  timestamp: number;
  dispose: 'any' | 'keep' | 'previous' | 'background';

  constructor(width: number, height: number, buffer?: Image | BufferSource);
  static from(framebuffer: { width: number, height: number, u8?: BufferSource, timestamp?: number, buffer?: BufferSource, dispose: 'any' | 'keep' | 'previous' | 'background' }): Frame;

  clone(): this;
  get width(): number;
  get height(): number;
}

// @ts-ignore
export class Image extends framebuffer {
  clone(): this;
  static from(framebuffer: { width: number, height: number, u8?: BufferSource, buffer?: BufferSource }): Image;

  encode(format: 'png', options?: png_options): Promise<Uint8Array>;
  encode(format: 'png', options: png_options & { sync: true }): Uint8Array;
  encode(format: 'jpeg', options?: { quality?: number }): Promise<Uint8Array>;
  encode(format: 'webp', options?: { quality?: number }): Promise<Uint8Array>;
  encode(format: 'jpeg', options: { quality?: number } & { sync: true }): Uint8Array;
  encode(format: 'webp', options: { quality?: number } & { sync: true }): Uint8Array;

  static decode(format: 'png', buffer: BufferSource): Promise<Image>;
  static decode(format: 'jpeg', buffer: BufferSource): Promise<Image>;
  static decode(format: 'tiff', buffer: BufferSource): Promise<Image>;
  static decode(format: 'auto', buffer: string | BufferSource, options?: any): Promise<Image>;
  static decode(format: 'svg', buffer: string | BufferSource, options?: svg_options): Promise<Image>;
}

export class Animation {
  repeat: number;
  readonly width: number;
  readonly height: number;
  readonly frames: Frame[];

  constructor(width: number, height: number);
  static decode(format: 'gif', buffer: BufferSource, options?: {}): Promise<Animation>;
  static decode(format: 'auto', buffer: BufferSource, options?: any): Promise<Animation>;

  clear(): void;
  add(frame: Frame): void;
  [Symbol.iterator]: Generator<Frame, Frame>;
  resize(type: 'cubic' | 'linear' | 'nearest', width: number, height: number): void;
  encode(format: 'gif', options?: { repeat?: number, comment?: string, application?: string }): Promise<Uint8Array>;
}
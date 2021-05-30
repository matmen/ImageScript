type rgb = [r: number, g: number, b: number];
type rgba = [r: number, g: number, b: number, a: number];

export class Color {
  private value: number;

  constructor(color: string);
  static rgb(r: number, g: number, b: number): number;
  static rgba(r: number, g: number, b: number, a: number): number;
  static hsla(h: number, s: number, l: number, a: number): number;

  get rgb(): rgb;
  toJSON(): number;
  get rgba(): rgba;
  valueOf(): number;
  get name(): null | string;
  toString(radix?: '16' | 'hex' | 'rgb' | 'rgba'): string;
}

export default class framebuffer {
  readonly width: number;
  readonly u8: Uint8Array;
  readonly height: number;
  readonly u32: Uint32Array;
  private readonly view: DataView;

  constructor(width: number, height: number, buffer?: BufferSource);
  static from(framebuffer: { width: number, height: number, u8?: BufferSource, buffer?: BufferSource }): framebuffer;

  toString(): string;
  clone(): framebuffer;
  get(x: number, y: number): number;
  at(x: number, y: number): Uint8Array;
  flip(type: 'vertical' | 'horizontal'): this;
  rotate(deg: number, resize?: boolean): this;
  set(x: number, y: number, color: number): void;
  overlay(frame: this, x?: number, y?: number): this;
  replace(frame: this, x?: number, y?: number): this;
  toJSON(): { width: number, height: number, buffer: number[] };
  static decode(format: 'png', buffer: BufferSource): framebuffer;
  scale(type: 'cubic' | 'linear' | 'nearest', factor: number): this;
  [Symbol.iterator](): Generator<[x: number, y: number], [x: number, y: number]>;
  resize(type: 'cubic' | 'linear' | 'nearest', width: number, height: number): this;
  encode(format: 'png', options?: { compression?: 'none' | 'fast' | 'best' | 'default' }): Uint8Array;

  cut(type: 'circle', feathering?: number): this;
  cut(type: 'box', x: number, y: number, width: number, height: number): this;

  crop(type: 'circle', feathering?: number): this;
  crop(type: 'box', x: number, y: number, width: number, height: number): this;

  blur(type: 'cubic'): this;
  blur(type: 'box', radius: number): this;
  blur(type: 'gaussian', radius: number): this;

  swap(old: rgba, color: rgba): this;
  swap(old: Color, color: Color): this;
  swap(old: number, color: number): this;

  fill(rgba: rgba): this;
  fill(color: Color): this;
  fill(color: number): this;
  fill(cb: (x: number, y: number) => number): this;

  pixels(type?: 'int'): Generator<[x: number, y: number, color: number], [x: number, y: number, color: number]>;
  pixels(type: 'rgba'): Generator<[x: number, y: number, rgba: Uint8Array], [x: number, y: number, rgba: Uint8Array]>;
}
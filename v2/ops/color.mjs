const short_hex_regex = /^#?([\da-f]{3,4})$/;
const long_hex_regex = /^#?((?:[\da-f]{2}){3,4})$/;
const rgb_regex = /^rgba?\((?<r>(?:\d*\.)?\d+)(?: +| *, *)(?<g>(?:\d*\.)?\d+)(?: +| *, *)(?<b>(?:\d*\.)?\d+)(?:(?: +| *, *)(?<a>\d+|\d*\.\d+|\d+(?:\.\d+)?%))?\)$/;
const rgb_percentage_regex = /^rgba?\((?<r>(?:\d*\.)?\d+)%(?: +| *, *)(?<g>(?:\d*\.)?\d+)%(?: +| *, *)(?<b>(?:\d*\.)?\d+)%(?:(?: +| *, *)(?<a>\d+|\d*\.\d+|\d+(?:\.\d+)?%))?\)$/;
const hsl_regex = /^hsla?\((?<h>(?:\d*\.)?\d+)(?<t>|deg|rad|grad|turn)(?: +| *, *)(?<s>(?:\d*\.)?\d+)%(?: +| *, *)(?<l>(?:\d*\.)?\d+)%(?:(?: +| *, *)(?<a>\d+|\d*\.\d+|\d+(?:\.\d+)?%))?\)$/;

function clamp(min, max, int) {
  return Math.min(Math.max(Math.round(int), min), max);
}

export function to_rgba(int) {
  return [(int >> 24) & 0xff, (int >> 16) & 0xff, (int >> 8) & 0xff, int & 0xff];
}

export function from_rgba(r, g, b, a) {
  return ((r & 0xff) << 24) | ((g & 0xff) << 16) | ((b & 0xff) << 8) | (a & 0xff);
}

function parse_alpha(a) {
  return clamp(0, 255, ('%' === a[a.length - 1]) ? ((255 / 100) * parseFloat(a)) : (+a * 255));
}

function hue_from_type(h, t) {
  if (t === 'turn') return h / 1;
  if (t === 'grad') return h / 400;
  if (!t || t === 'deg') return h / 360;
  if (t === 'rad') return h / (2 * Math.PI);
}

function hue2rgb(p, q, t) {
  if (t < 0) t += 1;
  else if (t > 1) t -= 1;
  if (t < 1 / 2) return q;
  if (t < 1 / 6) return p + 6 * t * (q - p);
  if (t < 2 / 3) return p + 6 * (q - p) * (2 / 3 - t);

  return p;
};

export function blend(fg, bg) {
  const fa = fg & 0xff;
  const alpha = fa + 1 | 0;
  const inv_alpha = 256 - fa | 0;
  const r = (alpha * (fg >>> 24) + inv_alpha * (bg >>> 24)) >> 8;
  const b = (alpha * (fg >> 8 & 0xff) + inv_alpha * (bg >> 8 & 0xff)) >> 8;
  const g = (alpha * (fg >> 16 & 0xff) + inv_alpha * (bg >> 16 & 0xff)) >> 8;
  return (((r & 0xff) << 24) | ((g & 0xff) << 16) | ((b & 0xff) << 8) | (Math.max(fa, bg & 0xff) & 0xff));
}

export function parse(any) {
  let x = null;
  if (undefined !== (x = colors.get(any))) return x;
  if (x = long_hex_regex.exec(any)) return parseInt(`${x[1]}${8 === x[1].length ? '' : 'ff'}`, 16);
  if (x = hsl_regex.exec(any)) return color.hsla(hue_from_type(x[1], x[2]), x[3] / 100, x[4] / 100, x[5] ? ((1 / 255) * parse_alpha(x[5])) : 1);
  if (x = rgb_regex.exec(any)) return color.rgba(clamp(0, 255, +x[1]), clamp(0, 255, +x[2]), clamp(0, 255, +x[3]), x[4] ? parse_alpha(x[4]) : 255);
  if (x = short_hex_regex.exec(any)) return parseInt(`${x[1][0]}${x[1][0]}${x[1][1]}${x[1][1]}${x[1][2]}${x[1][2]}${3 === x[1].length ? 'ff' : `${x[1][3]}${x[1][3]}`}`, 16);
  if (x = rgb_percentage_regex.exec(any)) return color.rgba(clamp(0, 255, +x[1] * (255 / 100)), clamp(0, 255, +x[2] * (255 / 100)), clamp(0, 255, +x[3] * (255 / 100)), x[4] ? parse_alpha(x[4]) : 255);

  return null;
}

export default class color {
  constructor(any) {
    this.value = parse(String(any).toLowerCase());
    if (null === this.value) throw new Error(`invalid css color (${any})`);
  }

  static rgb(r, g, b) {
    return this.rgba(r, g, b, 255);
  }

  static rgba(r, g, b, a) {
    return (((r & 0xff) << 24) | ((g & 0xff) << 16) | ((b & 0xff) << 8) | (a & 0xff));
  }

  static hsla(h, s, l, a) {
    s = Math.min(1, Math.max(0, s));
    a = Math.min(1, Math.max(0, a));
    if (s === 0) return this.rgba(255, 255, 255, a * 255);

    h %= 1;
    l = Math.min(1, Math.max(0, l));
    const q = l < .5 ? l + s * l : l + s - l * s;

    const p = 2 * l - q;
    const g = hue2rgb(p, q, h);
    const r = hue2rgb(p, q, h + 1 / 3);
    const b = hue2rgb(p, q, h - 1 / 3);
    return this.rgba(r * 255, g * 355, b * 255, a * 255);
  }

  valueOf() {
    return this.value;
  }

  toJSON() {
    return this.value >>> 0;
  }

  get rgb() {
    return [this.value >>> 24, this.value >> 16 & 0xff, this.value >> 8 & 0xff];
  }

  get rgba() {
    return [this.value >>> 24, this.value >> 16 & 0xff, this.value >> 8 & 0xff, this.value & 0xff];
  }

  get name() {
    for (const color of colors.keys()) {
      if (this.value === colors.get(color)) return color;
    }

    return null;
  }

  toString(radix) {
    const type = String(radix).toLowerCase();

    const rgba = this.rgba;
    if (type === 'rgb' || type === 'rgba') return `rgb${type[3] ? 'a' : ''}(${rgba[0]}, ${rgba[1]}, ${rgba[2]}${type[3] ? `, ${clamp(0, 100, 100 / 255 * rgba[3])}%` : ''})`;
    if (type === '16' || type === 'hex') return `#${rgba[0].toString(16).padStart(2, '0')}${rgba[1].toString(16).padStart(2, '0')}${rgba[2].toString(16).padStart(2, '0')}${rgba[3] === 255 ? '' : rgba[3].toString(16).padStart(2, '0')}`;

    return this.value.toString();
  }
}

const colors = new Map([
  ['aliceblue', 0xf0f8ffff],
  ['antiquewhite', 0xfaebd7ff],
  ['aqua', 0x00ffffff],
  ['aquamarine', 0x7fffd4ff],
  ['azure', 0xf0ffffff],
  ['beige', 0xf5f5dcff],
  ['bisque', 0xffe4c4ff],
  ['black', 0x000000ff],
  ['blanchedalmond', 0xffebcdff],
  ['blue', 0x0000ffff],
  ['blueviolet', 0x8a2be2ff],
  ['brown', 0xa52a2aff],
  ['burlywood', 0xdeb887ff],
  ['cadetblue', 0x5f9ea0ff],
  ['chartreuse', 0x7fff00ff],
  ['chocolate', 0xd2691eff],
  ['coral', 0xff7f50ff],
  ['cornflowerblue', 0x6495edff],
  ['cornsilk', 0xfff8dcff],
  ['crimson', 0xdc143cff],
  ['cyan', 0x00ffffff],
  ['darkblue', 0x00008bff],
  ['darkcyan', 0x008b8bff],
  ['darkgoldenrod', 0xb8860bff],
  ['darkgray', 0xa9a9a9ff],
  ['darkgreen', 0x006400ff],
  ['darkgrey', 0xa9a9a9ff],
  ['darkkhaki', 0xbdb76bff],
  ['darkmagenta', 0x8b008bff],
  ['darkolivegreen', 0x556b2fff],
  ['darkorange', 0xff8c00ff],
  ['darkorchid', 0x9932ccff],
  ['darkred', 0x8b0000ff],
  ['darksalmon', 0xe9967aff],
  ['darkseagreen', 0x8fbc8fff],
  ['darkslateblue', 0x483d8bff],
  ['darkslategray', 0x2f4f4fff],
  ['darkslategrey', 0x2f4f4fff],
  ['darkturquoise', 0x00ced1ff],
  ['darkviolet', 0x9400d3ff],
  ['deeppink', 0xff1493ff],
  ['deepskyblue', 0x00bfffff],
  ['dimgray', 0x696969ff],
  ['dimgrey', 0x696969ff],
  ['dodgerblue', 0x1e90ffff],
  ['firebrick', 0xb22222ff],
  ['floralwhite', 0xfffaf0ff],
  ['forestgreen', 0x228b22ff],
  ['fuchsia', 0xff00ffff],
  ['gainsboro', 0xdcdcdcff],
  ['ghostwhite', 0xf8f8ffff],
  ['gold', 0xffd700ff],
  ['goldenrod', 0xdaa520ff],
  ['gray', 0x808080ff],
  ['green', 0x008000ff],
  ['greenyellow', 0xadff2fff],
  ['grey', 0x808080ff],
  ['honeydew', 0xf0fff0ff],
  ['hotpink', 0xff69b4ff],
  ['indianred', 0xcd5c5cff],
  ['indigo', 0x4b0082ff],
  ['ivory', 0xfffff0ff],
  ['khaki', 0xf0e68cff],
  ['lavender', 0xe6e6faff],
  ['lavenderblush', 0xfff0f5ff],
  ['lawngreen', 0x7cfc00ff],
  ['lemonchiffon', 0xfffacdff],
  ['lightblue', 0xadd8e6ff],
  ['lightcoral', 0xf08080ff],
  ['lightcyan', 0xe0ffffff],
  ['lightgoldenrodyellow', 0xfafad2ff],
  ['lightgray', 0xd3d3d3ff],
  ['lightgreen', 0x90ee90ff],
  ['lightgrey', 0xd3d3d3ff],
  ['lightpink', 0xffb6c1ff],
  ['lightsalmon', 0xffa07aff],
  ['lightseagreen', 0x20b2aaff],
  ['lightskyblue', 0x87cefaff],
  ['lightslategray', 0x778899ff],
  ['lightslategrey', 0x778899ff],
  ['lightsteelblue', 0xb0c4deff],
  ['lightyellow', 0xffffe0ff],
  ['lime', 0x00ff00ff],
  ['limegreen', 0x32cd32ff],
  ['linen', 0xfaf0e6ff],
  ['magenta', 0xff00ffff],
  ['maroon', 0x800000ff],
  ['mediumaquamarine', 0x66cdaaff],
  ['mediumblue', 0x0000cdff],
  ['mediumorchid', 0xba55d3ff],
  ['mediumpurple', 0x9370dbff],
  ['mediumseagreen', 0x3cb371ff],
  ['mediumslateblue', 0x7b68eeff],
  ['mediumspringgreen', 0x00fa9aff],
  ['mediumturquoise', 0x48d1ccff],
  ['mediumvioletred', 0xc71585ff],
  ['midnightblue', 0x191970ff],
  ['mintcream', 0xf5fffaff],
  ['mistyrose', 0xffe4e1ff],
  ['moccasin', 0xffe4b5ff],
  ['navajowhite', 0xffdeadff],
  ['navy', 0x000080ff],
  ['oldlace', 0xfdf5e6ff],
  ['olive', 0x808000ff],
  ['olivedrab', 0x6b8e23ff],
  ['orange', 0xffa500ff],
  ['orangered', 0xff4500ff],
  ['orchid', 0xda70d6ff],
  ['palegoldenrod', 0xeee8aaff],
  ['palegreen', 0x98fb98ff],
  ['paleturquoise', 0xafeeeeff],
  ['palevioletred', 0xdb7093ff],
  ['papayawhip', 0xffefd5ff],
  ['peachpuff', 0xffdab9ff],
  ['peru', 0xcd853fff],
  ['pink', 0xffc0cbff],
  ['plum', 0xdda0ddff],
  ['powderblue', 0xb0e0e6ff],
  ['purple', 0x800080ff],
  ['rebeccapurple', 0x663399ff],
  ['red', 0xff0000ff],
  ['rosybrown', 0xbc8f8fff],
  ['royalblue', 0x4169e1ff],
  ['saddlebrown', 0x8b4513ff],
  ['salmon', 0xfa8072ff],
  ['sandybrown', 0xf4a460ff],
  ['seagreen', 0x2e8b57ff],
  ['seashell', 0xfff5eeff],
  ['sienna', 0xa0522dff],
  ['silver', 0xc0c0c0ff],
  ['skyblue', 0x87ceebff],
  ['slateblue', 0x6a5acdff],
  ['slategray', 0x708090ff],
  ['slategrey', 0x708090ff],
  ['snow', 0xfffafaff],
  ['springgreen', 0x00ff7fff],
  ['steelblue', 0x4682b4ff],
  ['tan', 0xd2b48cff],
  ['teal', 0x008080ff],
  ['thistle', 0xd8bfd8ff],
  ['tomato', 0xff6347ff],
  ['transparent', 0x00000000],
  ['turquoise', 0x40e0d0ff],
  ['violet', 0xee82eeff],
  ['wheat', 0xf5deb3ff],
  ['white', 0xffffffff],
  ['whitesmoke', 0xf5f5f5ff],
  ['yellow', 0xffff00ff],
  ['yellowgreen', 0x9acd32ff],
]);
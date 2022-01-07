var __defProp = Object.defineProperty;
var __markAsModule = (target) => __defProp(target, "__esModule", { value: true });
var __export = (target, all) => {
  __markAsModule(target);
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// v2/framebuffer.mjs
__export(exports, {
  Color: () => color,
  default: () => framebuffer
});

// v2/ops/color.js
var color_exports = {};
__export(color_exports, {
  blend: () => blend,
  default: () => color,
  from_rgba: () => from_rgba,
  parse: () => parse,
  to_rgba: () => to_rgba
});
var short_hex_regex = /^#?([\da-f]{3,4})$/;
var long_hex_regex = /^#?((?:[\da-f]{2}){3,4})$/;
var rgb_regex = /^rgba?\((?<r>(?:\d*\.)?\d+)(?: +| *, *)(?<g>(?:\d*\.)?\d+)(?: +| *, *)(?<b>(?:\d*\.)?\d+)(?:(?: +| *, *)(?<a>\d+|\d*\.\d+|\d+(?:\.\d+)?%))?\)$/;
var rgb_percentage_regex = /^rgba?\((?<r>(?:\d*\.)?\d+)%(?: +| *, *)(?<g>(?:\d*\.)?\d+)%(?: +| *, *)(?<b>(?:\d*\.)?\d+)%(?:(?: +| *, *)(?<a>\d+|\d*\.\d+|\d+(?:\.\d+)?%))?\)$/;
var hsl_regex = /^hsla?\((?<h>(?:\d*\.)?\d+)(?<t>|deg|rad|grad|turn)(?: +| *, *)(?<s>(?:\d*\.)?\d+)%(?: +| *, *)(?<l>(?:\d*\.)?\d+)%(?:(?: +| *, *)(?<a>\d+|\d*\.\d+|\d+(?:\.\d+)?%))?\)$/;
function clamp(min, max2, int) {
  return Math.min(Math.max(Math.round(int), min), max2);
}
function to_rgba(int) {
  return [int >> 24 & 255, int >> 16 & 255, int >> 8 & 255, int & 255];
}
function from_rgba(r, g, b, a) {
  return (r & 255) << 24 | (g & 255) << 16 | (b & 255) << 8 | a & 255;
}
function parse_alpha(a) {
  return clamp(0, 255, a[a.length - 1] === "%" ? 255 / 100 * parseFloat(a) : +a * 255);
}
function hue_from_type(h, t) {
  if (t === "turn")
    return h / 1;
  if (t === "grad")
    return h / 400;
  if (!t || t === "deg")
    return h / 360;
  if (t === "rad")
    return h / (2 * Math.PI);
}
function hue2rgb(p, q, t) {
  if (t < 0)
    t += 1;
  else if (t > 1)
    t -= 1;
  if (t < 1 / 2)
    return q;
  if (t < 1 / 6)
    return p + 6 * t * (q - p);
  if (t < 2 / 3)
    return p + 6 * (q - p) * (2 / 3 - t);
  return p;
}
function blend(fg, bg) {
  const fa = fg & 255;
  const alpha = fa + 1 | 0;
  const inv_alpha = 256 - fa | 0;
  const r = alpha * (fg >>> 24) + inv_alpha * (bg >>> 24) >> 8;
  const b = alpha * (fg >> 8 & 255) + inv_alpha * (bg >> 8 & 255) >> 8;
  const g = alpha * (fg >> 16 & 255) + inv_alpha * (bg >> 16 & 255) >> 8;
  return (r & 255) << 24 | (g & 255) << 16 | (b & 255) << 8 | Math.max(fa, bg & 255) & 255;
}
function parse(any) {
  let x2 = null;
  if ((x2 = colors.get(any)) !== void 0)
    return x2;
  if (x2 = long_hex_regex.exec(any))
    return parseInt(`${x2[1]}${x2[1].length === 8 ? "" : "ff"}`, 16);
  if (x2 = hsl_regex.exec(any))
    return color.hsla(hue_from_type(x2[1], x2[2]), x2[3] / 100, x2[4] / 100, x2[5] ? 1 / 255 * parse_alpha(x2[5]) : 1);
  if (x2 = rgb_regex.exec(any))
    return color.rgba(clamp(0, 255, +x2[1]), clamp(0, 255, +x2[2]), clamp(0, 255, +x2[3]), x2[4] ? parse_alpha(x2[4]) : 255);
  if (x2 = short_hex_regex.exec(any))
    return parseInt(`${x2[1][0]}${x2[1][0]}${x2[1][1]}${x2[1][1]}${x2[1][2]}${x2[1][2]}${x2[1].length === 3 ? "ff" : `${x2[1][3]}${x2[1][3]}`}`, 16);
  if (x2 = rgb_percentage_regex.exec(any))
    return color.rgba(clamp(0, 255, +x2[1] * (255 / 100)), clamp(0, 255, +x2[2] * (255 / 100)), clamp(0, 255, +x2[3] * (255 / 100)), x2[4] ? parse_alpha(x2[4]) : 255);
  return null;
}
var color = class {
  constructor(any) {
    this.value = parse(String(any).toLowerCase());
    if (this.value === null)
      throw new Error(`invalid css color (${any})`);
  }
  static rgb(r, g, b) {
    return this.rgba(r, g, b, 255);
  }
  static rgba(r, g, b, a) {
    return (r & 255) << 24 | (g & 255) << 16 | (b & 255) << 8 | a & 255;
  }
  static hsla(h, s, l, a) {
    s = Math.min(1, Math.max(0, s));
    a = Math.min(1, Math.max(0, a));
    if (s === 0)
      return this.rgba(255, 255, 255, a * 255);
    h %= 1;
    l = Math.min(1, Math.max(0, l));
    const q = l < 0.5 ? l + s * l : l + s - l * s;
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
    return [this.value >>> 24, this.value >> 16 & 255, this.value >> 8 & 255];
  }
  get rgba() {
    return [this.value >>> 24, this.value >> 16 & 255, this.value >> 8 & 255, this.value & 255];
  }
  get name() {
    for (const color3 of colors.keys()) {
      if (this.value === colors.get(color3))
        return color3;
    }
    return null;
  }
  toString(radix) {
    const type = String(radix).toLowerCase();
    const rgba2 = this.rgba;
    if (type === "rgb" || type === "rgba")
      return `rgb${type[3] ? "a" : ""}(${rgba2[0]}, ${rgba2[1]}, ${rgba2[2]}${type[3] ? `, ${clamp(0, 100, 100 / 255 * rgba2[3])}%` : ""})`;
    if (type === "16" || type === "hex")
      return `#${rgba2[0].toString(16).padStart(2, "0")}${rgba2[1].toString(16).padStart(2, "0")}${rgba2[2].toString(16).padStart(2, "0")}${rgba2[3] === 255 ? "" : rgba2[3].toString(16).padStart(2, "0")}`;
    return this.value.toString();
  }
};
var colors = new Map([
  ["aliceblue", 4042850303],
  ["antiquewhite", 4209760255],
  ["aqua", 16777215],
  ["aquamarine", 2147472639],
  ["azure", 4043309055],
  ["beige", 4126530815],
  ["bisque", 4293182719],
  ["black", 255],
  ["blanchedalmond", 4293643775],
  ["blue", 65535],
  ["blueviolet", 2318131967],
  ["brown", 2771004159],
  ["burlywood", 3736635391],
  ["cadetblue", 1604231423],
  ["chartreuse", 2147418367],
  ["chocolate", 3530104575],
  ["coral", 4286533887],
  ["cornflowerblue", 1687547391],
  ["cornsilk", 4294499583],
  ["crimson", 3692313855],
  ["cyan", 16777215],
  ["darkblue", 35839],
  ["darkcyan", 9145343],
  ["darkgoldenrod", 3095792639],
  ["darkgray", 2846468607],
  ["darkgreen", 6553855],
  ["darkgrey", 2846468607],
  ["darkkhaki", 3182914559],
  ["darkmagenta", 2332068863],
  ["darkolivegreen", 1433087999],
  ["darkorange", 4287365375],
  ["darkorchid", 2570243327],
  ["darkred", 2332033279],
  ["darksalmon", 3918953215],
  ["darkseagreen", 2411499519],
  ["darkslateblue", 1211993087],
  ["darkslategray", 793726975],
  ["darkslategrey", 793726975],
  ["darkturquoise", 13554175],
  ["darkviolet", 2483082239],
  ["deeppink", 4279538687],
  ["deepskyblue", 12582911],
  ["dimgray", 1768516095],
  ["dimgrey", 1768516095],
  ["dodgerblue", 512819199],
  ["firebrick", 2988581631],
  ["floralwhite", 4294635775],
  ["forestgreen", 579543807],
  ["fuchsia", 4278255615],
  ["gainsboro", 3705462015],
  ["ghostwhite", 4177068031],
  ["gold", 4292280575],
  ["goldenrod", 3668254975],
  ["gray", 2155905279],
  ["green", 8388863],
  ["greenyellow", 2919182335],
  ["grey", 2155905279],
  ["honeydew", 4043305215],
  ["hotpink", 4285117695],
  ["indianred", 3445382399],
  ["indigo", 1258324735],
  ["ivory", 4294963455],
  ["khaki", 4041641215],
  ["lavender", 3873897215],
  ["lavenderblush", 4293981695],
  ["lawngreen", 2096890111],
  ["lemonchiffon", 4294626815],
  ["lightblue", 2916673279],
  ["lightcoral", 4034953471],
  ["lightcyan", 3774873599],
  ["lightgoldenrodyellow", 4210742015],
  ["lightgray", 3553874943],
  ["lightgreen", 2431553791],
  ["lightgrey", 3553874943],
  ["lightpink", 4290167295],
  ["lightsalmon", 4288707327],
  ["lightseagreen", 548580095],
  ["lightskyblue", 2278488831],
  ["lightslategray", 2005441023],
  ["lightslategrey", 2005441023],
  ["lightsteelblue", 2965692159],
  ["lightyellow", 4294959359],
  ["lime", 16711935],
  ["limegreen", 852308735],
  ["linen", 4210091775],
  ["magenta", 4278255615],
  ["maroon", 2147483903],
  ["mediumaquamarine", 1724754687],
  ["mediumblue", 52735],
  ["mediumorchid", 3126187007],
  ["mediumpurple", 2473647103],
  ["mediumseagreen", 1018393087],
  ["mediumslateblue", 2070474495],
  ["mediumspringgreen", 16423679],
  ["mediumturquoise", 1221709055],
  ["mediumvioletred", 3340076543],
  ["midnightblue", 421097727],
  ["mintcream", 4127193855],
  ["mistyrose", 4293190143],
  ["moccasin", 4293178879],
  ["navajowhite", 4292783615],
  ["navy", 33023],
  ["oldlace", 4260751103],
  ["olive", 2155872511],
  ["olivedrab", 1804477439],
  ["orange", 4289003775],
  ["orangered", 4282712319],
  ["orchid", 3664828159],
  ["palegoldenrod", 4008225535],
  ["palegreen", 2566625535],
  ["paleturquoise", 2951671551],
  ["palevioletred", 3681588223],
  ["papayawhip", 4293907967],
  ["peachpuff", 4292524543],
  ["peru", 3448061951],
  ["pink", 4290825215],
  ["plum", 3718307327],
  ["powderblue", 2967529215],
  ["purple", 2147516671],
  ["rebeccapurple", 1714657791],
  ["red", 4278190335],
  ["rosybrown", 3163525119],
  ["royalblue", 1097458175],
  ["saddlebrown", 2336560127],
  ["salmon", 4202722047],
  ["sandybrown", 4104413439],
  ["seagreen", 780883967],
  ["seashell", 4294307583],
  ["sienna", 2689740287],
  ["silver", 3233857791],
  ["skyblue", 2278484991],
  ["slateblue", 1784335871],
  ["slategray", 1887473919],
  ["slategrey", 1887473919],
  ["snow", 4294638335],
  ["springgreen", 16744447],
  ["steelblue", 1182971135],
  ["tan", 3535047935],
  ["teal", 8421631],
  ["thistle", 3636451583],
  ["tomato", 4284696575],
  ["transparent", 0],
  ["turquoise", 1088475391],
  ["violet", 4001558271],
  ["wheat", 4125012991],
  ["white", 4294967295],
  ["whitesmoke", 4126537215],
  ["yellow", 4294902015],
  ["yellowgreen", 2597139199]
]);

// v2/util/mem.js
function view(buffer, shared = false) {
  if (buffer instanceof ArrayBuffer)
    return new Uint8Array(buffer);
  if (shared && buffer instanceof SharedArrayBuffer)
    return new Uint8Array(buffer);
  if (ArrayBuffer.isView(buffer))
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  throw new TypeError("The provided value is not of type '(ArrayBuffer or ArrayBufferView)'");
}

// v2/ops/flip.js
var flip_exports = {};
__export(flip_exports, {
  horizontal: () => horizontal,
  vertical: () => vertical
});
function horizontal(framebuffer2) {
  let offset = 0 | 0;
  const u323 = framebuffer2.u32;
  const width = framebuffer2.width | 0;
  const height = framebuffer2.height | 0;
  for (let y = 0 | 0; y < height; y++) {
    u323.subarray(offset, offset += width).reverse();
  }
}
function vertical(framebuffer2) {
  const u323 = framebuffer2.u32;
  const width = framebuffer2.width | 0;
  const oheight = framebuffer2.height | 0;
  const height = framebuffer2.height / 2 | 0;
  for (let y = 0 | 0; y < height; y++) {
    const yo = y * width | 0;
    const wo1y = width * (oheight - 1 - y) | 0;
    for (let x2 = 0 | 0; x2 < width; x2++) {
      const offset = x2 + yo;
      const offset2 = x2 + wo1y;
      const top = u323[offset];
      const bottom = u323[offset2];
      u323[offset2] = top;
      u323[offset] = bottom;
    }
  }
}

// v2/ops/fill.js
var fill_exports = {};
__export(fill_exports, {
  color: () => color2,
  fn: () => fn,
  swap: () => swap
});
function color2(int, framebuffer2) {
  framebuffer2.view.setUint32(0, int);
  framebuffer2.u32.fill(framebuffer2.u32[0]);
}
function fn(cb, framebuffer2) {
  let offset = 0 | 0;
  const view3 = framebuffer2.view;
  const width = framebuffer2.width | 0;
  const height = framebuffer2.height | 0;
  for (let y = 1 | 0; y <= height; y++) {
    for (let x2 = 1 | 0; x2 <= width; x2++) {
      view3.setUint32(offset, cb(x2, y), false);
      offset += 4;
    }
  }
}
function swap(old, int, framebuffer2) {
  {
    const t = new Uint32Array(2);
    const v = new DataView(t.buffer);
    old = (v.setUint32(0, old), t[0]);
    int = (v.setUint32(4, int), t[1]);
  }
  const u323 = framebuffer2.u32;
  const l = framebuffer2.u32.length | 0;
  for (let o = 0 | 0; o < l; o++) {
    if (old === u323[o])
      u323[o] = int;
  }
}

// v2/ops/blur.js
var blur_exports = {};
__export(blur_exports, {
  box: () => box,
  cubic: () => cubic,
  gaussian: () => gaussian
});
function cubic(framebuffer2) {
  const width = framebuffer2.width;
  const height = framebuffer2.height;
  framebuffer2.resize("cubic", Math.max(1, 8e-3 * width), Math.max(1, 8e-3 * height));
  framebuffer2.resize("cubic", width, height);
}
function box(radius, framebuffer2) {
  if (!radius)
    return;
  const u82 = framebuffer2.u8;
  const width = framebuffer2.width;
  const height = framebuffer2.height;
  const old = framebuffer2.u8.slice();
  bb(u82, old, width, height, radius);
}
function gaussian(radius, framebuffer2) {
  if (0 >= radius)
    return;
  const a = Math.exp(0.726 ** 2) / radius;
  const g1 = Math.exp(-a);
  const g2 = Math.exp(a * -2);
  const old = framebuffer2.u8.slice();
  const k = (1 - g1) ** 2 / (1 - g2 + 2 * a * g1);
  const b2 = -g2;
  const b1 = 2 * g1;
  const a3 = -k * g2;
  const a1 = k * g1 * (a - 1);
  const a2 = k * g1 * (a + 1);
  const lc2 = (k + a1) / (1 - b1 - b2);
  const width = framebuffer2.width | 0;
  const rc = (a2 + a3) / (1 - b1 - b2);
  const height = framebuffer2.height | 0;
  const tmp = new Float32Array(4 * Math.max(width, height));
  gc(old, framebuffer2.u8, tmp, width, height, k, a1, a2, a3, b1, b2, lc2, rc);
  gc(framebuffer2.u8, old, tmp, height, width, k, a1, a2, a3, b1, b2, lc2, rc);
}
function bb(u82, old, width, height, radius) {
  const divisor = 1 / (1 + radius + radius);
  bbt(u82, old, width, height, radius, divisor);
  bbh(u82, old, width, height, radius, divisor);
}
function bbh(u82, old, width, height, radius, divisor) {
  for (var y = 0; y < height; y++) {
    let y_offset = y * width;
    let li = y_offset;
    let ri = radius + y_offset;
    const fv_offset = 4 * y_offset;
    const lv_offset = 4 * (width - 1 + y_offset);
    const rfv = old[fv_offset];
    const gfv = old[1 + fv_offset];
    const bfv = old[2 + fv_offset];
    const afv = old[3 + fv_offset];
    const rlv = old[lv_offset];
    const glv = old[1 + lv_offset];
    const blv = old[2 + lv_offset];
    const alv = old[3 + lv_offset];
    let r = rfv * (1 + radius);
    let g = gfv * (1 + radius);
    let b = bfv * (1 + radius);
    let a = afv * (1 + radius);
    for (let x2 = 0; x2 < radius; x2++) {
      const offset = 4 * (x2 + y_offset);
      r += old[offset];
      g += old[1 + offset];
      b += old[2 + offset];
      a += old[3 + offset];
    }
    for (let x2 = 0; x2 <= radius; x2++) {
      let offset = 4 * ri++;
      r += old[offset] - rfv;
      g += old[1 + offset] - gfv;
      b += old[2 + offset] - bfv;
      a += old[3 + offset] - afv;
      offset = 4 * y_offset++;
      u82[offset] = Math.round(r * divisor);
      u82[1 + offset] = Math.round(g * divisor);
      u82[2 + offset] = Math.round(b * divisor);
      u82[3 + offset] = Math.round(a * divisor);
    }
    for (let x2 = 1 + radius; x2 < width - radius; x2++) {
      let offset = 4 * ri++;
      const roffset = 4 * li++;
      r += old[offset] - old[roffset];
      g += old[1 + offset] - old[1 + roffset];
      b += old[2 + offset] - old[2 + roffset];
      a += old[3 + offset] - old[3 + roffset];
      offset = 4 * y_offset++;
      u82[offset] = Math.round(r * divisor);
      u82[1 + offset] = Math.round(g * divisor);
      u82[2 + offset] = Math.round(b * divisor);
      u82[3 + offset] = Math.round(a * divisor);
    }
    for (let x2 = width - radius; x2 < width; x2++) {
      let offset = 4 * li++;
      r += rlv - old[offset];
      g += glv - old[1 + offset];
      b += blv - old[2 + offset];
      a += alv - old[3 + offset];
      offset = 4 * y_offset++;
      u82[offset] = Math.round(r * divisor);
      u82[1 + offset] = Math.round(g * divisor);
      u82[2 + offset] = Math.round(b * divisor);
      u82[3 + offset] = Math.round(a * divisor);
    }
  }
}
function bbt(u82, old, width, height, radius, divisor) {
  for (var x2 = 0; x2 < width; x2++) {
    let ti = x2;
    let li = ti;
    const fv_offset = 4 * ti;
    let ri = ti + width * radius;
    const lv_offset = 4 * (ti + width * (height - 1));
    const rfv = old[fv_offset];
    const gfv = old[1 + fv_offset];
    const bfv = old[2 + fv_offset];
    const afv = old[3 + fv_offset];
    const rlv = old[lv_offset];
    const glv = old[1 + lv_offset];
    const blv = old[2 + lv_offset];
    const alv = old[3 + lv_offset];
    let r = rfv * (1 + radius);
    let g = gfv * (1 + radius);
    let b = bfv * (1 + radius);
    let a = afv * (1 + radius);
    for (let y = 0; y < radius; y++) {
      const offset = 4 * (ti + y * width);
      r += old[offset];
      g += old[1 + offset];
      b += old[2 + offset];
      a += old[3 + offset];
    }
    for (let y = 0; y <= radius; y++) {
      let offset = 4 * ri;
      r += old[offset] - rfv;
      g += old[1 + offset] - gfv;
      b += old[2 + offset] - bfv;
      a += old[3 + offset] - afv;
      offset = 4 * ti;
      u82[offset] = Math.round(r * divisor);
      u82[1 + offset] = Math.round(g * divisor);
      u82[2 + offset] = Math.round(b * divisor);
      u82[3 + offset] = Math.round(a * divisor);
      ri += width;
      ti += width;
    }
    for (let y = 1 + radius; y < height - radius; y++) {
      let offset = 4 * ri;
      const xoffset = 4 * li;
      r += old[offset] - old[xoffset];
      g += old[1 + offset] - old[1 + xoffset];
      b += old[2 + offset] - old[2 + xoffset];
      a += old[3 + offset] - old[3 + xoffset];
      offset = 4 * ti;
      u82[offset] = Math.round(r * divisor);
      u82[1 + offset] = Math.round(g * divisor);
      u82[2 + offset] = Math.round(b * divisor);
      u82[3 + offset] = Math.round(a * divisor);
      li += width;
      ri += width;
      ti += width;
    }
    for (let y = height - radius; y < height; y++) {
      let offset = 4 * li;
      r += rlv - old[offset];
      g += glv - old[1 + offset];
      b += blv - old[2 + offset];
      a += alv - old[3 + offset];
      offset = 4 * ti;
      u82[offset] = Math.round(r * divisor);
      u82[1 + offset] = Math.round(g * divisor);
      u82[2 + offset] = Math.round(b * divisor);
      u82[3 + offset] = Math.round(a * divisor);
      li += width;
      ti += width;
    }
  }
}
function gc(u82, old, tmp, width, height, k, a1, a2, a3, b1, b2, lc2, rc) {
  const width4 = width * 4;
  const height4 = height * 4;
  const hw1 = height * (width - 1);
  for (let y = 0; y < height; y++) {
    let toffset = 0 | 0;
    let ooffset = y * width4 | 0;
    let offset = 4 * (y + hw1) | 0;
    let por = old[ooffset];
    let pog = old[1 + ooffset];
    let pob = old[2 + ooffset];
    let poa = old[3 + ooffset];
    let pur = lc2 * por;
    let pug = lc2 * pog;
    let pub = lc2 * pob;
    let pua = lc2 * poa;
    let ppur = pur;
    let ppug = pug;
    let ppub = pub;
    let ppua = pua;
    for (let x2 = 0; x2 < width; x2++) {
      const cor2 = old[ooffset++];
      const cog2 = old[ooffset++];
      const cob2 = old[ooffset++];
      const coa2 = old[ooffset++];
      const cur = k * cor2 + a1 * por + b1 * pur + b2 * ppur;
      const cug = k * cog2 + a1 * pog + b1 * pug + b2 * ppug;
      const cub = k * cob2 + a1 * pob + b1 * pub + b2 * ppub;
      const cua = k * coa2 + a1 * poa + b1 * pua + b2 * ppua;
      ppur = pur;
      pur = cur;
      por = cor2;
      ppug = pug;
      pug = cug;
      pog = cog2;
      ppub = pub;
      pub = cub;
      pob = cob2;
      ppua = pua;
      pua = cua;
      poa = coa2;
      tmp[toffset++] = pur;
      tmp[toffset++] = pug;
      tmp[toffset++] = pub;
      tmp[toffset++] = pua;
    }
    ooffset -= 4;
    toffset -= 4;
    ppur = rc * (por = old[ooffset]);
    ppug = rc * (pog = old[1 + ooffset]);
    ppub = rc * (pob = old[2 + ooffset]);
    ppua = rc * (poa = old[3 + ooffset]);
    pur = ppur;
    pug = ppug;
    pub = ppub;
    pua = ppua;
    let cor = por;
    let cog = pog;
    let cob = pob;
    let coa = poa;
    for (let x2 = width - 1; 0 <= x2; x2--) {
      const cur = a2 * cor + a3 * por + b1 * pur + b2 * ppur;
      const cug = a2 * cog + a3 * pog + b1 * pug + b2 * ppug;
      const cub = a2 * cob + a3 * pob + b1 * pub + b2 * ppub;
      const cua = a2 * coa + a3 * poa + b1 * pua + b2 * ppua;
      ppur = pur;
      pur = cur;
      por = cor;
      ppug = pug;
      pug = cug;
      pog = cog;
      ppub = pub;
      pub = cub;
      pob = cob;
      ppua = pua;
      pua = cua;
      poa = coa;
      cor = old[ooffset];
      cog = old[1 + ooffset];
      cob = old[2 + ooffset];
      coa = old[3 + ooffset];
      u82[offset] = pur + tmp[toffset];
      u82[1 + offset] = pug + tmp[1 + toffset];
      u82[2 + offset] = pub + tmp[2 + toffset];
      u82[3 + offset] = pua + tmp[3 + toffset];
      ooffset -= 4;
      toffset -= 4;
      offset -= height4;
    }
  }
}

// v2/ops/crop.js
var crop_exports = {};
__export(crop_exports, {
  circle: () => circle,
  crop: () => crop,
  cut: () => cut
});
function clamp2(min, int, max2) {
  const t = int < min ? min : int;
  return t > max2 ? max2 : t;
}
function cut(x2, y, width, height, framebuffer2) {
  width |= 0;
  height |= 0;
  const frame = new framebuffer2.constructor(width, height);
  const n32 = frame.u32;
  const o32 = framebuffer2.u32;
  const fwidth = framebuffer2.width | 0;
  for (let yy = 0 | 0; yy < height; yy++) {
    const offset = x2 + fwidth * (y + yy);
    n32.set(o32.subarray(offset, width + offset), yy * width);
  }
  return frame;
}
function crop(x2, y, width, height, framebuffer2) {
  width |= 0;
  height |= 0;
  const old = framebuffer2.u32;
  const fwidth = framebuffer2.width | 0;
  const u323 = framebuffer2.u32 = new Uint32Array(width * height);
  for (let yy = 0; yy < height; yy++) {
    const offset = x2 + fwidth * (y + yy);
    u323.set(old.subarray(offset, width + offset), yy * width);
  }
  framebuffer2.width = width;
  framebuffer2.height = height;
  framebuffer2.u8 = new Uint8Array(framebuffer2.u32.buffer);
  framebuffer2.view = new DataView(framebuffer2.u32.buffer);
}
function circle(feathering, framebuffer2) {
  const u82 = framebuffer2.u8;
  const u323 = framebuffer2.u32;
  const width = framebuffer2.width | 0;
  const height = framebuffer2.height | 0;
  const rad = Math.min(width, height) / 2;
  const cx = width / 2;
  const cy = height / 2;
  const rad_2 = rad ** 2;
  const feathering_12 = feathering ** (1 / 2);
  for (let y = 0 | 0; y < height; y++) {
    const cdy = (y - cy) ** 2;
    const y_offset = y * width;
    for (let x2 = 0 | 0; x2 < width; x2++) {
      const cd = cdy + (x2 - cx) ** 2;
      if (cd > rad_2)
        u323[x2 + y_offset] = 0;
      else if (feathering)
        u82[3 + 4 * (x2 + y_offset)] *= clamp2(0, 1 - cd / rad_2 * feathering_12, 1);
    }
  }
  return framebuffer2;
}

// v2/ops/resize.js
var resize_exports = {};
__export(resize_exports, {
  cubic: () => cubic2,
  linear: () => linear,
  nearest: () => nearest
});
function lerp(a, b, t) {
  return t * b + a * (1 - t);
}
function clamp3(min, int, max2) {
  const t = int < min ? min : int;
  return t > max2 ? max2 : t;
}
function clamped(x2, y, width, height) {
  return 4 * (clamp3(0, x2, width - 1) + clamp3(0, y, height - 1) * width);
}
function hermite(A, B, C, D, t) {
  const c = C / 2 + A / -2;
  const b = A + C * 2 - D / 2 - B * 2.5;
  const a = D / 2 + A / -2 + B * 1.5 - C * 1.5;
  const t2 = t * t;
  return B + c * t + b * t2 + a * t * t2;
}
function nearest(width, height, framebuffer2) {
  width = width | 0;
  height = height | 0;
  const old = framebuffer2.u32;
  const fwidth = framebuffer2.width | 0;
  const fheight = framebuffer2.height | 0;
  const u323 = framebuffer2.u32 = new Uint32Array(width * height);
  const dw = 1 / width;
  const dh = 1 / height;
  const xw = dw * fwidth;
  const yw = dh * fheight;
  for (let y = 0 | 0; y < height; y++) {
    const yoffset = y * width;
    const yyoffset = fwidth * (y * yw | 0);
    for (let x2 = 0 | 0; x2 < width; x2++) {
      u323[x2 + yoffset] = old[yyoffset + (x2 * xw | 0)];
    }
  }
  framebuffer2.width = width;
  framebuffer2.height = height;
  framebuffer2.u8 = new Uint8Array(u323.buffer);
  framebuffer2.view = new DataView(u323.buffer);
}
function linear(width, height, framebuffer2) {
  width = width | 0;
  height = height | 0;
  const old = framebuffer2.u8;
  const old_width = framebuffer2.width | 0;
  const old_height = framebuffer2.height | 0;
  const u82 = new Uint8ClampedArray(4 * width * height);
  let offset = 0 | 0;
  const width1 = 1 / (width - 1);
  const height1 = 1 / (height - 1);
  for (let y = 0 | 0; y < height; y++) {
    const yy = old_height * (y * height1) - 0.5;
    const yyi = yy | 0;
    const ty = yy - yyi;
    for (let x2 = 0 | 0; x2 < width; x2++) {
      const xx = old_width * (x2 * width1) - 0.5;
      const xxi = xx | 0;
      const tx = xx - xxi;
      const s0 = clamped(xxi, yyi, old_width, old_height);
      const s1 = clamped(1 + xxi, yyi, old_width, old_height);
      const s2 = clamped(xxi, 1 + yyi, old_width, old_height);
      const s3 = clamped(1 + xxi, 1 + yyi, old_width, old_height);
      u82[offset++] = lerp(lerp(old[s0], old[s2], tx), lerp(old[s1], old[s3], tx), ty);
      u82[offset++] = lerp(lerp(old[1 + s0], old[1 + s2], tx), lerp(old[1 + s1], old[1 + s3], tx), ty);
      u82[offset++] = lerp(lerp(old[2 + s0], old[2 + s2], tx), lerp(old[2 + s1], old[2 + s3], tx), ty);
      u82[offset++] = lerp(lerp(old[3 + s0], old[3 + s2], tx), lerp(old[3 + s1], old[3 + s3], tx), ty);
    }
  }
  framebuffer2.width = width;
  framebuffer2.height = height;
  framebuffer2.u8 = new Uint8Array(u82.buffer);
  framebuffer2.view = new DataView(u82.buffer);
  framebuffer2.u32 = new Uint32Array(u82.buffer);
}
function cubic2(width, height, framebuffer2) {
  width = width | 0;
  height = height | 0;
  const old = framebuffer2.u8;
  const old_width = framebuffer2.width | 0;
  const old_height = framebuffer2.height | 0;
  const u82 = new Uint8ClampedArray(4 * width * height);
  let offset = 0 | 0;
  const width1 = 1 / (width - 1);
  const height1 = 1 / (height - 1);
  for (let y = 0 | 0; y < height; y++) {
    const yy = old_height * (y * height1) - 0.5;
    const yyi = yy | 0;
    const ty = yy - yyi;
    for (let x2 = 0 | 0; x2 < width; x2++) {
      const xx = old_width * (x2 * width1) - 0.5;
      const xxi = xx | 0;
      const tx = xx - xxi;
      const s0 = clamped(xxi - 1, yyi - 1, old_width, old_height);
      const s1 = clamped(0 + xxi, yyi - 1, old_width, old_height);
      const s2 = clamped(1 + xxi, yyi - 1, old_width, old_height);
      const s3 = clamped(2 + xxi, yyi - 1, old_width, old_height);
      const s4 = clamped(xxi - 1, yyi, old_width, old_height);
      const s5 = clamped(0 + xxi, yyi, old_width, old_height);
      const s6 = clamped(1 + xxi, yyi, old_width, old_height);
      const s7 = clamped(2 + xxi, yyi, old_width, old_height);
      const s8 = clamped(xxi - 1, 1 + yyi, old_width, old_height);
      const s9 = clamped(0 + xxi, 1 + yyi, old_width, old_height);
      const s10 = clamped(1 + xxi, 1 + yyi, old_width, old_height);
      const s11 = clamped(2 + xxi, 1 + yyi, old_width, old_height);
      const s12 = clamped(xxi - 1, 2 + yyi, old_width, old_height);
      const s13 = clamped(0 + xxi, 2 + yyi, old_width, old_height);
      const s14 = clamped(1 + xxi, 2 + yyi, old_width, old_height);
      const s15 = clamped(2 + xxi, 2 + yyi, old_width, old_height);
      const c0 = hermite(old[s0], old[s1], old[s2], old[s3], tx);
      const c00 = hermite(old[1 + s0], old[1 + s1], old[1 + s2], old[1 + s3], tx);
      const c000 = hermite(old[2 + s0], old[2 + s1], old[2 + s2], old[2 + s3], tx);
      const c0000 = hermite(old[3 + s0], old[3 + s1], old[3 + s2], old[3 + s3], tx);
      const c1 = hermite(old[s4], old[s5], old[s6], old[s7], tx);
      const c11 = hermite(old[1 + s4], old[1 + s5], old[1 + s6], old[1 + s7], tx);
      const c111 = hermite(old[2 + s4], old[2 + s5], old[2 + s6], old[2 + s7], tx);
      const c1111 = hermite(old[3 + s4], old[3 + s5], old[3 + s6], old[3 + s7], tx);
      const c2 = hermite(old[s8], old[s9], old[s10], old[s11], tx);
      const c22 = hermite(old[1 + s8], old[1 + s9], old[1 + s10], old[1 + s11], tx);
      const c222 = hermite(old[2 + s8], old[2 + s9], old[2 + s10], old[2 + s11], tx);
      const c2222 = hermite(old[3 + s8], old[3 + s9], old[3 + s10], old[3 + s11], tx);
      const c3 = hermite(old[s12], old[s13], old[s14], old[s15], tx);
      const c33 = hermite(old[1 + s12], old[1 + s13], old[1 + s14], old[1 + s15], tx);
      const c333 = hermite(old[2 + s12], old[2 + s13], old[2 + s14], old[2 + s15], tx);
      const c3333 = hermite(old[3 + s12], old[3 + s13], old[3 + s14], old[3 + s15], tx);
      u82[offset++] = hermite(c0, c1, c2, c3, ty);
      u82[offset++] = hermite(c00, c11, c22, c33, ty);
      u82[offset++] = hermite(c000, c111, c222, c333, ty);
      u82[offset++] = hermite(c0000, c1111, c2222, c3333, ty);
    }
  }
  framebuffer2.width = width;
  framebuffer2.height = height;
  framebuffer2.u8 = new Uint8Array(u82.buffer);
  framebuffer2.view = new DataView(u82.buffer);
  framebuffer2.u32 = new Uint32Array(u82.buffer);
}

// v2/ops/rotate.js
var rotate_exports = {};
__export(rotate_exports, {
  rotate: () => rotate,
  rotate180: () => rotate180,
  rotate270: () => rotate270,
  rotate90: () => rotate90
});
function rotate180(framebuffer2) {
  framebuffer2.u32.reverse();
}
function rotate90(framebuffer2) {
  const u323 = framebuffer2.u32;
  const old = framebuffer2.u32.slice();
  const width = framebuffer2.width | 0;
  const height = framebuffer2.height | 0;
  framebuffer2.width = height;
  framebuffer2.height = width;
  for (let y = 0 | 0; y < width; y++) {
    const yoffset = y * width;
    const height1y = height - 1 - y;
    for (let x2 = 0 | 0; x2 < height; x2++) {
      u323[height1y + x2 * width] = old[x2 + yoffset];
    }
  }
}
function rotate270(framebuffer2) {
  const u323 = framebuffer2.u32;
  const old = framebuffer2.u32.slice();
  const width = framebuffer2.width | 0;
  const height = framebuffer2.height | 0;
  framebuffer2.width = height;
  framebuffer2.height = width;
  for (let y = 0 | 0; y < width; y++) {
    const yoffset = y * width | 0;
    const soffset = y + width * (width - 1) | 0;
    for (let x2 = 0 | 0; x2 < height; x2++) {
      u323[soffset - x2 * width] = old[x2 + yoffset];
    }
  }
}
function rotate(deg, framebuffer2, resize) {
  const rad = Math.PI * ((360 - deg) / 180);
  const sin = Math.sin(rad);
  const cos = Math.cos(rad);
  const width = (resize ? Math.abs(framebuffer2.width * sin) + Math.abs(framebuffer2.height * cos) : framebuffer2.width) | 0;
  const height = (resize ? Math.abs(framebuffer2.width * cos) + Math.abs(framebuffer2.height * sin) : framebuffer2.height) | 0;
  const same_size = width === framebuffer2.width && height === framebuffer2.height;
  const inn = same_size ? framebuffer2.clone() : framebuffer2;
  const out = { width, height, u8: same_size ? framebuffer2.u8 : new Uint8Array(4 * width * height) };
  const out_cx = width / 2 - 0.5;
  const out_cy = height / 2 - 0.5;
  const src_cx = framebuffer2.width / 2 - 0.5;
  const src_cy = framebuffer2.height / 2 - 0.5;
  let h = 0;
  do {
    let w = 0;
    const ysin = src_cx - sin * (h - out_cy);
    const ycos = src_cy + cos * (h - out_cy);
    do {
      interpolate(inn, out, w, h, ysin + cos * (w - out_cx), ycos + sin * (w - out_cx));
    } while (w++ < width);
  } while (h++ < height);
  framebuffer2.u8 = out.u8;
  framebuffer2.width = width;
  framebuffer2.height = height;
  framebuffer2.view = new DataView(out.u8.buffer, out.u8.byteOffset, out.u8.byteLength);
  framebuffer2.u32 = new Uint32Array(out.u8.buffer, out.u8.byteOffset, out.u8.byteLength / 4);
}
function interpolate(inn, out, x0, y0, x1, y1) {
  const x2 = ~~x1;
  const y2 = ~~y1;
  const xq = x1 - x2;
  const yq = y1 - y2;
  const offset = 4 * (x0 + y0 * out.width);
  const ref = { r: 0, g: 0, b: 0, a: 0 };
  pawn(x2, y2, (1 - xq) * (1 - yq), ref, inn);
  pawn(1 + x2, y2, xq * (1 - yq), ref, inn);
  pawn(x2, 1 + y2, (1 - xq) * yq, ref, inn);
  pawn(1 + x2, 1 + y2, xq * yq, ref, inn);
  out.u8[3 + offset] = ref.a;
  out.u8[offset] = ref.r / ref.a;
  out.u8[1 + offset] = ref.g / ref.a;
  out.u8[2 + offset] = ref.b / ref.a;
}
function pawn(point0, point1, weight, ref, inn) {
  if (point0 > 0 && point1 > 0 && point0 < inn.width && point1 < inn.height) {
    const offset = 4 * (point0 + point1 * inn.width);
    const wa = weight * inn.u8[3 + offset];
    ref.a += wa;
    ref.r += wa * inn.u8[offset];
    ref.g += wa * inn.u8[1 + offset];
    ref.b += wa * inn.u8[2 + offset];
  }
}

// v2/ops/overlay.js
var overlay_exports = {};
__export(overlay_exports, {
  blend: () => blend2,
  replace: () => replace
});
function replace(bg, fg, x2, y) {
  const b32 = bg.u32;
  const f32 = fg.u32;
  const fw = fg.width | 0;
  const bw = bg.width | 0;
  const fh = fg.height | 0;
  const bh = bg.height | 0;
  const ox = (x2 > 0 ? 0 : -x2) | 0;
  const oy = (y > 0 ? 0 : -y) | 0;
  const top = (y > 0 ? y : 0) | 0;
  const left = (x2 > 0 ? x2 : 0) | 0;
  const width = Math.min(bw, x2 + fw) - left | 0;
  const height = Math.min(bh, y + fh) - top | 0;
  if (0 >= width || 0 >= height)
    return;
  for (let yy = 0 | 0; yy < height; yy++) {
    const yyoffset = ox + fw * (yy + oy);
    const yoffset = left + bw * (yy + top);
    b32.subarray(yoffset, width + yoffset).set(f32.subarray(yyoffset, width + yyoffset));
  }
}
function blend2(bg, fg, x2, y) {
  const b32 = bg.u32;
  const f32 = fg.u32;
  const fw = fg.width | 0;
  const bw = bg.width | 0;
  const fh = fg.height | 0;
  const bh = bg.height | 0;
  const ox = (x2 > 0 ? 0 : -x2) | 0;
  const oy = (y > 0 ? 0 : -y) | 0;
  const top = (y > 0 ? y : 0) | 0;
  const left = (x2 > 0 ? x2 : 0) | 0;
  const width = Math.min(bw, x2 + fw) - left | 0;
  const height = Math.min(bh, y + fh) - top | 0;
  if (0 >= width || 0 >= height)
    return;
  for (let yy = 0 | 0; yy < height; yy++) {
    const yyoffset = ox + fw * (yy + oy);
    const yoffset = left + bw * (yy + top);
    for (let xx = 0 | 0; xx < width; xx++) {
      const F = f32[xx + yyoffset];
      const fa = F >> 24 & 255;
      if (fa === 0)
        continue;
      else if (fa === 255)
        b32[xx + yoffset] = F;
      else {
        const alpha = 1 + fa;
        const inv_alpha = 256 - fa;
        const B = b32[xx + yoffset];
        const r = alpha * (F & 255) + inv_alpha * (B & 255) >> 8;
        const g = alpha * (F >> 8 & 255) + inv_alpha * (B >> 8 & 255) >> 8;
        const b = alpha * (F >> 16 & 255) + inv_alpha * (B >> 16 & 255) >> 8;
        b32[xx + yoffset] = Math.max(fa, B >> 24 & 255) << 24 | (b & 255) << 16 | (g & 255) << 8 | r;
      }
    }
  }
}

// v2/ops/iterator.js
var iterator_exports = {};
__export(iterator_exports, {
  cords: () => cords,
  rgba: () => rgba,
  u32: () => u32
});
function* cords(framebuffer2) {
  const width = framebuffer2.width | 0;
  const height = framebuffer2.height | 0;
  for (let y = 0 | 0; y < height; y++) {
    for (let x2 = 0 | 0; x2 < width; x2++)
      yield [x2, y];
  }
}
function* rgba(framebuffer2) {
  let offset = 0 | 0;
  const u82 = framebuffer2.u8;
  const width = framebuffer2.width | 0;
  const height = framebuffer2.height | 0;
  for (let y = 0 | 0; y < height; y++) {
    for (let x2 = 0 | 0; x2 < width; x2++) {
      yield [x2, y, u82.subarray(offset, offset += 4)];
    }
  }
}
function* u32(framebuffer2) {
  let offset = 0 | 0;
  const view3 = framebuffer2.view;
  const width = framebuffer2.width | 0;
  const height = framebuffer2.height | 0;
  for (let y = 0 | 0; y < height; y++) {
    for (let x2 = 0 | 0; x2 < width; x2++) {
      yield [x2, y, view3.getUint32(offset, false)];
      offset += 4;
    }
  }
}

// png/src/crc.js
var table = new Uint32Array([
  0,
  1996959894,
  3993919788,
  2567524794,
  124634137,
  1886057615,
  3915621685,
  2657392035,
  249268274,
  2044508324,
  3772115230,
  2547177864,
  162941995,
  2125561021,
  3887607047,
  2428444049,
  498536548,
  1789927666,
  4089016648,
  2227061214,
  450548861,
  1843258603,
  4107580753,
  2211677639,
  325883990,
  1684777152,
  4251122042,
  2321926636,
  335633487,
  1661365465,
  4195302755,
  2366115317,
  997073096,
  1281953886,
  3579855332,
  2724688242,
  1006888145,
  1258607687,
  3524101629,
  2768942443,
  901097722,
  1119000684,
  3686517206,
  2898065728,
  853044451,
  1172266101,
  3705015759,
  2882616665,
  651767980,
  1373503546,
  3369554304,
  3218104598,
  565507253,
  1454621731,
  3485111705,
  3099436303,
  671266974,
  1594198024,
  3322730930,
  2970347812,
  795835527,
  1483230225,
  3244367275,
  3060149565,
  1994146192,
  31158534,
  2563907772,
  4023717930,
  1907459465,
  112637215,
  2680153253,
  3904427059,
  2013776290,
  251722036,
  2517215374,
  3775830040,
  2137656763,
  141376813,
  2439277719,
  3865271297,
  1802195444,
  476864866,
  2238001368,
  4066508878,
  1812370925,
  453092731,
  2181625025,
  4111451223,
  1706088902,
  314042704,
  2344532202,
  4240017532,
  1658658271,
  366619977,
  2362670323,
  4224994405,
  1303535960,
  984961486,
  2747007092,
  3569037538,
  1256170817,
  1037604311,
  2765210733,
  3554079995,
  1131014506,
  879679996,
  2909243462,
  3663771856,
  1141124467,
  855842277,
  2852801631,
  3708648649,
  1342533948,
  654459306,
  3188396048,
  3373015174,
  1466479909,
  544179635,
  3110523913,
  3462522015,
  1591671054,
  702138776,
  2966460450,
  3352799412,
  1504918807,
  783551873,
  3082640443,
  3233442989,
  3988292384,
  2596254646,
  62317068,
  1957810842,
  3939845945,
  2647816111,
  81470997,
  1943803523,
  3814918930,
  2489596804,
  225274430,
  2053790376,
  3826175755,
  2466906013,
  167816743,
  2097651377,
  4027552580,
  2265490386,
  503444072,
  1762050814,
  4150417245,
  2154129355,
  426522225,
  1852507879,
  4275313526,
  2312317920,
  282753626,
  1742555852,
  4189708143,
  2394877945,
  397917763,
  1622183637,
  3604390888,
  2714866558,
  953729732,
  1340076626,
  3518719985,
  2797360999,
  1068828381,
  1219638859,
  3624741850,
  2936675148,
  906185462,
  1090812512,
  3747672003,
  2825379669,
  829329135,
  1181335161,
  3412177804,
  3160834842,
  628085408,
  1382605366,
  3423369109,
  3138078467,
  570562233,
  1426400815,
  3317316542,
  2998733608,
  733239954,
  1555261956,
  3268935591,
  3050360625,
  752459403,
  1541320221,
  2607071920,
  3965973030,
  1969922972,
  40735498,
  2617837225,
  3943577151,
  1913087877,
  83908371,
  2512341634,
  3803740692,
  2075208622,
  213261112,
  2463272603,
  3855990285,
  2094854071,
  198958881,
  2262029012,
  4057260610,
  1759359992,
  534414190,
  2176718541,
  4139329115,
  1873836001,
  414664567,
  2282248934,
  4279200368,
  1711684554,
  285281116,
  2405801727,
  4167216745,
  1634467795,
  376229701,
  2685067896,
  3608007406,
  1308918612,
  956543938,
  2808555105,
  3495958263,
  1231636301,
  1047427035,
  2932959818,
  3654703836,
  1088359270,
  936918e3,
  2847714899,
  3736837829,
  1202900863,
  817233897,
  3183342108,
  3401237130,
  1404277552,
  615818150,
  3134207493,
  3453421203,
  1423857449,
  601450431,
  3009837614,
  3294710456,
  1567103746,
  711928724,
  3020668471,
  3272380065,
  1510334235,
  755167117
]);
function crc32(buffer) {
  let offset = 0 | 0;
  let crc = 4294967295 | 0;
  const bl = buffer.length - 4 | 0;
  while (bl > offset) {
    crc = table[(crc ^ buffer[offset++]) & 255] ^ crc >>> 8;
    crc = table[(crc ^ buffer[offset++]) & 255] ^ crc >>> 8;
    crc = table[(crc ^ buffer[offset++]) & 255] ^ crc >>> 8;
    crc = table[(crc ^ buffer[offset++]) & 255] ^ crc >>> 8;
  }
  while (offset < buffer.length) {
    crc = table[(crc ^ buffer[offset++]) & 255] ^ crc >>> 8;
  }
  return (crc ^ 4294967295) >>> 0;
}

// png/src/mem.js
function view2(buffer, shared = false) {
  if (buffer instanceof ArrayBuffer)
    return new Uint8Array(buffer);
  if (shared && buffer instanceof SharedArrayBuffer)
    return new Uint8Array(buffer);
  if (ArrayBuffer.isView(buffer))
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  throw new TypeError("The provided value is not of type '(ArrayBuffer or ArrayBufferView)'");
}
function from_parts(buffers, shared = false) {
  let length = 0;
  let offset = 0;
  buffers.forEach((buffer) => length += buffer.byteLength == null ? buffer.length : buffer.byteLength);
  const u82 = new Uint8Array(shared ? new SharedArrayBuffer(length) : length);
  buffers.forEach((buffer) => {
    const ref = Array.isArray(buffer) ? buffer : view2(buffer, true);
    u82.set(ref, offset);
    offset += ref.length;
  });
  return u82;
}

// png/src/zlib.js
var u8 = Uint8Array;
var u16 = Uint16Array;
var u322 = Uint32Array;
var clim = u8.of(16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15);
var fleb = u8.of(0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0, 0, 0, 0);
var fdeb = u8.of(0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13, 0, 0);
var freb = function(eb, start) {
  var b = new u16(31);
  for (var i = 0; i < 31; ++i) {
    b[i] = start += 1 << eb[i - 1];
  }
  var r = new u322(b[30]);
  for (var i = 1; i < 30; ++i) {
    for (var j = b[i]; j < b[i + 1]; ++j) {
      r[j] = j - b[i] << 5 | i;
    }
  }
  return [b, r];
};
var _a = freb(fleb, 2);
var fl = _a[0];
var revfl = _a[1];
fl[28] = 258, revfl[258] = 28;
var _b = freb(fdeb, 0);
var fd = _b[0];
var revfd = _b[1];
var rev = new u16(32768);
for (i = 0; i < 32768; ++i) {
  x = (i & 43690) >>> 1 | (i & 21845) << 1;
  x = (x & 52428) >>> 2 | (x & 13107) << 2;
  x = (x & 61680) >>> 4 | (x & 3855) << 4;
  rev[i] = ((x & 65280) >>> 8 | (x & 255) << 8) >>> 1;
}
var i;
var x;
var hMap = function(cd, mb, r) {
  var s = cd.length;
  var i = 0;
  var l = new u16(mb);
  for (; i < s; ++i)
    ++l[cd[i] - 1];
  var le = new u16(mb);
  for (i = 0; i < mb; ++i) {
    le[i] = le[i - 1] + l[i - 1] << 1;
  }
  var co;
  if (r) {
    co = new u16(1 << mb);
    var rvb = 15 - mb;
    for (i = 0; i < s; ++i) {
      if (cd[i]) {
        var sv = i << 4 | cd[i];
        var r_1 = mb - cd[i];
        var v = le[cd[i] - 1]++ << r_1;
        for (var m = v | (1 << r_1) - 1; v <= m; ++v) {
          co[rev[v] >>> rvb] = sv;
        }
      }
    }
  } else {
    co = new u16(s);
    for (i = 0; i < s; ++i) {
      if (cd[i]) {
        co[i] = rev[le[cd[i] - 1]++] >>> 15 - cd[i];
      }
    }
  }
  return co;
};
var flt = new u8(288);
for (i = 0; i < 144; ++i)
  flt[i] = 8;
var i;
for (i = 144; i < 256; ++i)
  flt[i] = 9;
var i;
for (i = 256; i < 280; ++i)
  flt[i] = 7;
var i;
for (i = 280; i < 288; ++i)
  flt[i] = 8;
var i;
var fdt = new u8(32);
for (i = 0; i < 32; ++i)
  fdt[i] = 5;
var i;
var flm = hMap(flt, 9, 0);
var flrm = hMap(flt, 9, 1);
var fdm = hMap(fdt, 5, 0);
var fdrm = hMap(fdt, 5, 1);
var max = function(a) {
  var m = a[0];
  for (var i = 1; i < a.length; ++i) {
    if (a[i] > m)
      m = a[i];
  }
  return m;
};
var bits = function(d, p, m) {
  var o = p >> 3 | 0;
  return (d[o] | d[o + 1] << 8) >> (p & 7) & m;
};
var bits16 = function(d, p) {
  var o = p >> 3 | 0;
  return (d[o] | d[o + 1] << 8 | d[o + 2] << 16) >> (p & 7);
};
var shft = function(p) {
  return (p >> 3 | 0) + (p & 7 && 1);
};
var slc = function(v, s, e) {
  if (s == null || s < 0)
    s = 0;
  if (e == null || e > v.length)
    e = v.length;
  var n = new (v instanceof u16 ? u16 : v instanceof u322 ? u322 : u8)(e - s);
  n.set(v.subarray(s, e));
  return n;
};
var inflt = function(dat, buf, st) {
  var sl = dat.length;
  if (!sl || st && !st.l && sl < 5)
    return buf || new u8(0);
  var noBuf = !buf || st;
  var noSt = !st || st.i;
  if (!st)
    st = {};
  if (!buf)
    buf = new u8(sl * 3);
  var cbuf = function(l2) {
    var bl = buf.length;
    if (l2 > bl) {
      var nbuf = new u8(Math.max(bl * 2, l2));
      nbuf.set(buf);
      buf = nbuf;
    }
  };
  var final = st.f || 0, pos = st.p || 0, bt = st.b || 0, lm = st.l, dm = st.d, lbt = st.m, dbt = st.n;
  var tbts = sl * 8;
  do {
    if (!lm) {
      st.f = final = bits(dat, pos, 1);
      var type = bits(dat, pos + 1, 3);
      pos += 3;
      if (!type) {
        var s = shft(pos) + 4, l = dat[s - 4] | dat[s - 3] << 8, t = s + l;
        if (t > sl) {
          if (noSt)
            throw "unexpected EOF";
          break;
        }
        if (noBuf)
          cbuf(bt + l);
        buf.set(dat.subarray(s, t), bt);
        st.b = bt += l, st.p = pos = t * 8;
        continue;
      } else if (type === 1)
        lm = flrm, dm = fdrm, lbt = 9, dbt = 5;
      else if (type === 2) {
        var hLit = bits(dat, pos, 31) + 257, hcLen = bits(dat, pos + 10, 15) + 4;
        var tl = hLit + bits(dat, pos + 5, 31) + 1;
        pos += 14;
        var ldt = new u8(tl);
        var clt = new u8(19);
        for (var i = 0; i < hcLen; ++i) {
          clt[clim[i]] = bits(dat, pos + i * 3, 7);
        }
        pos += hcLen * 3;
        var clb = max(clt), clbmsk = (1 << clb) - 1;
        var clm = hMap(clt, clb, 1);
        for (var i = 0; i < tl; ) {
          var r = clm[bits(dat, pos, clbmsk)];
          pos += r & 15;
          var s = r >>> 4;
          if (s < 16) {
            ldt[i++] = s;
          } else {
            var c = 0, n = 0;
            if (s === 16)
              n = 3 + bits(dat, pos, 3), pos += 2, c = ldt[i - 1];
            else if (s === 17)
              n = 3 + bits(dat, pos, 7), pos += 3;
            else if (s === 18)
              n = 11 + bits(dat, pos, 127), pos += 7;
            while (n--)
              ldt[i++] = c;
          }
        }
        var lt = ldt.subarray(0, hLit), dt = ldt.subarray(hLit);
        lbt = max(lt);
        dbt = max(dt);
        lm = hMap(lt, lbt, 1);
        dm = hMap(dt, dbt, 1);
      } else
        throw "invalid block type";
      if (pos > tbts) {
        if (noSt)
          throw "unexpected EOF";
        break;
      }
    }
    if (noBuf)
      cbuf(bt + 131072);
    var lms = (1 << lbt) - 1, dms = (1 << dbt) - 1;
    var lpos = pos;
    for (; ; lpos = pos) {
      var c = lm[bits16(dat, pos) & lms], sym = c >>> 4;
      pos += c & 15;
      if (pos > tbts) {
        if (noSt)
          throw "unexpected EOF";
        break;
      }
      if (!c)
        throw "invalid length/literal";
      if (sym < 256)
        buf[bt++] = sym;
      else if (sym === 256) {
        lpos = pos, lm = null;
        break;
      } else {
        var add = sym - 254;
        if (sym > 264) {
          var i = sym - 257, b = fleb[i];
          add = bits(dat, pos, (1 << b) - 1) + fl[i];
          pos += b;
        }
        var d = dm[bits16(dat, pos) & dms], dsym = d >>> 4;
        if (!d)
          throw "invalid distance";
        pos += d & 15;
        var dt = fd[dsym];
        if (dsym > 3) {
          var b = fdeb[dsym];
          dt += bits16(dat, pos) & (1 << b) - 1, pos += b;
        }
        if (pos > tbts) {
          if (noSt)
            throw "unexpected EOF";
          break;
        }
        if (noBuf)
          cbuf(bt + 131072);
        var end = bt + add;
        for (; bt < end; bt += 4) {
          buf[bt] = buf[bt - dt];
          buf[bt + 1] = buf[bt + 1 - dt];
          buf[bt + 2] = buf[bt + 2 - dt];
          buf[bt + 3] = buf[bt + 3 - dt];
        }
        bt = end;
      }
    }
    st.l = lm, st.p = lpos, st.b = bt;
    if (lm)
      final = 1, st.m = lbt, st.d = dm, st.n = dbt;
  } while (!final);
  return bt === buf.length ? buf : slc(buf, 0, bt);
};
var wbits = function(d, p, v) {
  v <<= p & 7;
  var o = p >> 3 | 0;
  d[o] |= v;
  d[o + 1] |= v >>> 8;
};
var wbits16 = function(d, p, v) {
  v <<= p & 7;
  var o = p >> 3 | 0;
  d[o] |= v;
  d[o + 1] |= v >>> 8;
  d[o + 2] |= v >>> 16;
};
var hTree = function(d, mb) {
  var t = [];
  for (var i = 0; i < d.length; ++i) {
    if (d[i])
      t.push({ s: i, f: d[i] });
  }
  var s = t.length;
  var t2 = t.slice();
  if (!s)
    return [et, 0];
  if (s === 1) {
    var v = new u8(t[0].s + 1);
    v[t[0].s] = 1;
    return [v, 1];
  }
  t.sort(function(a, b) {
    return a.f - b.f;
  });
  t.push({ s: -1, f: 25001 });
  var l = t[0], r = t[1], i0 = 0, i1 = 1, i2 = 2;
  t[0] = { s: -1, f: l.f + r.f, l, r };
  while (i1 !== s - 1) {
    l = t[t[i0].f < t[i2].f ? i0++ : i2++];
    r = t[i0 !== i1 && t[i0].f < t[i2].f ? i0++ : i2++];
    t[i1++] = { s: -1, f: l.f + r.f, l, r };
  }
  var maxSym = t2[0].s;
  for (var i = 1; i < s; ++i) {
    if (t2[i].s > maxSym)
      maxSym = t2[i].s;
  }
  var tr = new u16(maxSym + 1);
  var mbt = ln(t[i1 - 1], tr, 0);
  if (mbt > mb) {
    var i = 0, dt = 0;
    var lft = mbt - mb, cst = 1 << lft;
    t2.sort(function(a, b) {
      return tr[b.s] - tr[a.s] || a.f - b.f;
    });
    for (; i < s; ++i) {
      var i2_1 = t2[i].s;
      if (tr[i2_1] > mb) {
        dt += cst - (1 << mbt - tr[i2_1]);
        tr[i2_1] = mb;
      } else
        break;
    }
    dt >>>= lft;
    while (dt > 0) {
      var i2_2 = t2[i].s;
      if (tr[i2_2] < mb)
        dt -= 1 << mb - tr[i2_2]++ - 1;
      else
        ++i;
    }
    for (; i >= 0 && dt; --i) {
      var i2_3 = t2[i].s;
      if (tr[i2_3] === mb) {
        --tr[i2_3];
        ++dt;
      }
    }
    mbt = mb;
  }
  return [new u8(tr), mbt];
};
var ln = function(n, l, d) {
  return n.s === -1 ? Math.max(ln(n.l, l, d + 1), ln(n.r, l, d + 1)) : l[n.s] = d;
};
var lc = function(c) {
  var s = c.length;
  while (s && !c[--s])
    ;
  var cl = new u16(++s);
  var cli = 0, cln = c[0], cls = 1;
  var w = function(v) {
    cl[cli++] = v;
  };
  for (var i = 1; i <= s; ++i) {
    if (c[i] === cln && i !== s)
      ++cls;
    else {
      if (!cln && cls > 2) {
        for (; cls > 138; cls -= 138)
          w(32754);
        if (cls > 2) {
          w(cls > 10 ? cls - 11 << 5 | 28690 : cls - 3 << 5 | 12305);
          cls = 0;
        }
      } else if (cls > 3) {
        w(cln), --cls;
        for (; cls > 6; cls -= 6)
          w(8304);
        if (cls > 2)
          w(cls - 3 << 5 | 8208), cls = 0;
      }
      while (cls--)
        w(cln);
      cls = 1;
      cln = c[i];
    }
  }
  return [cl.subarray(0, cli), s];
};
var clen = function(cf, cl) {
  var l = 0;
  for (var i = 0; i < cl.length; ++i)
    l += cf[i] * cl[i];
  return l;
};
var wfblk = function(out, pos, dat) {
  var s = dat.length;
  var o = shft(pos + 2);
  out[o] = s & 255;
  out[o + 1] = s >>> 8;
  out[o + 2] = out[o] ^ 255;
  out[o + 3] = out[o + 1] ^ 255;
  for (var i = 0; i < s; ++i)
    out[o + i + 4] = dat[i];
  return (o + 4 + s) * 8;
};
var wblk = function(dat, out, final, syms, lf, df, eb, li, bs, bl, p) {
  wbits(out, p++, final);
  ++lf[256];
  var _a2 = hTree(lf, 15), dlt = _a2[0], mlb = _a2[1];
  var _b2 = hTree(df, 15), ddt = _b2[0], mdb = _b2[1];
  var _c = lc(dlt), lclt = _c[0], nlc = _c[1];
  var _d = lc(ddt), lcdt = _d[0], ndc = _d[1];
  var lcfreq = new u16(19);
  for (var i = 0; i < lclt.length; ++i)
    lcfreq[lclt[i] & 31]++;
  for (var i = 0; i < lcdt.length; ++i)
    lcfreq[lcdt[i] & 31]++;
  var _e = hTree(lcfreq, 7), lct = _e[0], mlcb = _e[1];
  var nlcc = 19;
  for (; nlcc > 4 && !lct[clim[nlcc - 1]]; --nlcc)
    ;
  var flen = bl + 5 << 3;
  var ftlen = clen(lf, flt) + clen(df, fdt) + eb;
  var dtlen = clen(lf, dlt) + clen(df, ddt) + eb + 14 + 3 * nlcc + clen(lcfreq, lct) + (2 * lcfreq[16] + 3 * lcfreq[17] + 7 * lcfreq[18]);
  if (flen <= ftlen && flen <= dtlen)
    return wfblk(out, p, dat.subarray(bs, bs + bl));
  var lm, ll, dm, dl;
  wbits(out, p, 1 + (dtlen < ftlen)), p += 2;
  if (dtlen < ftlen) {
    lm = hMap(dlt, mlb, 0), ll = dlt, dm = hMap(ddt, mdb, 0), dl = ddt;
    var llm = hMap(lct, mlcb, 0);
    wbits(out, p, nlc - 257);
    wbits(out, p + 5, ndc - 1);
    wbits(out, p + 10, nlcc - 4);
    p += 14;
    for (var i = 0; i < nlcc; ++i)
      wbits(out, p + 3 * i, lct[clim[i]]);
    p += 3 * nlcc;
    var lcts = [lclt, lcdt];
    for (var it = 0; it < 2; ++it) {
      var clct = lcts[it];
      for (var i = 0; i < clct.length; ++i) {
        var len = clct[i] & 31;
        wbits(out, p, llm[len]), p += lct[len];
        if (len > 15)
          wbits(out, p, clct[i] >>> 5 & 127), p += clct[i] >>> 12;
      }
    }
  } else {
    lm = flm, ll = flt, dm = fdm, dl = fdt;
  }
  for (var i = 0; i < li; ++i) {
    if (syms[i] > 255) {
      var len = syms[i] >>> 18 & 31;
      wbits16(out, p, lm[len + 257]), p += ll[len + 257];
      if (len > 7)
        wbits(out, p, syms[i] >>> 23 & 31), p += fleb[len];
      var dst = syms[i] & 31;
      wbits16(out, p, dm[dst]), p += dl[dst];
      if (dst > 3)
        wbits16(out, p, syms[i] >>> 5 & 8191), p += fdeb[dst];
    } else {
      wbits16(out, p, lm[syms[i]]), p += ll[syms[i]];
    }
  }
  wbits16(out, p, lm[256]);
  return p + ll[256];
};
var deo = u322.of(65540, 131080, 131088, 131104, 262176, 1048704, 1048832, 2114560, 2117632);
var et = new u8(0);
var dflt = function(dat, lvl, plvl, pre, post, lst) {
  var s = dat.length;
  var o = new u8(pre + s + 5 * (1 + Math.ceil(s / 7e3)) + post);
  var w = o.subarray(pre, o.length - post);
  var pos = 0;
  if (!lvl || s < 8) {
    for (var i = 0; i <= s; i += 65535) {
      var e = i + 65535;
      if (e < s) {
        pos = wfblk(w, pos, dat.subarray(i, e));
      } else {
        w[i] = lst;
        pos = wfblk(w, pos, dat.subarray(i, s));
      }
    }
  } else {
    var opt = deo[lvl - 1];
    var n = opt >>> 13, c = opt & 8191;
    var msk_1 = (1 << plvl) - 1;
    var prev = new u16(32768), head = new u16(msk_1 + 1);
    var bs1_1 = Math.ceil(plvl / 3), bs2_1 = 2 * bs1_1;
    var hsh = function(i2) {
      return (dat[i2] ^ dat[i2 + 1] << bs1_1 ^ dat[i2 + 2] << bs2_1) & msk_1;
    };
    var syms = new u322(25e3);
    var lf = new u16(288), df = new u16(32);
    var lc_1 = 0, eb = 0, i = 0, li = 0, wi = 0, bs = 0;
    for (; i < s; ++i) {
      var hv = hsh(i);
      var imod = i & 32767, pimod = head[hv];
      prev[imod] = pimod;
      head[hv] = imod;
      if (wi <= i) {
        var rem = s - i;
        if ((lc_1 > 7e3 || li > 24576) && rem > 423) {
          pos = wblk(dat, w, 0, syms, lf, df, eb, li, bs, i - bs, pos);
          li = lc_1 = eb = 0, bs = i;
          for (var j = 0; j < 286; ++j)
            lf[j] = 0;
          for (var j = 0; j < 30; ++j)
            df[j] = 0;
        }
        var l = 2, d = 0, ch_1 = c, dif = imod - pimod & 32767;
        if (rem > 2 && hv === hsh(i - dif)) {
          var maxn = Math.min(n, rem) - 1;
          var maxd = Math.min(32767, i);
          var ml = Math.min(258, rem);
          while (dif <= maxd && --ch_1 && imod !== pimod) {
            if (dat[i + l] === dat[i + l - dif]) {
              var nl = 0;
              for (; nl < ml && dat[i + nl] === dat[i + nl - dif]; ++nl)
                ;
              if (nl > l) {
                l = nl, d = dif;
                if (nl > maxn)
                  break;
                var mmd = Math.min(dif, nl - 2);
                var md = 0;
                for (var j = 0; j < mmd; ++j) {
                  var ti = i - dif + j + 32768 & 32767;
                  var pti = prev[ti];
                  var cd = ti - pti + 32768 & 32767;
                  if (cd > md)
                    md = cd, pimod = ti;
                }
              }
            }
            imod = pimod, pimod = prev[imod];
            dif += imod - pimod + 32768 & 32767;
          }
        }
        if (d) {
          syms[li++] = 268435456 | revfl[l] << 18 | revfd[d];
          var lin = revfl[l] & 31, din = revfd[d] & 31;
          eb += fleb[lin] + fdeb[din];
          ++lf[257 + lin];
          ++df[din];
          wi = i + l;
          ++lc_1;
        } else {
          syms[li++] = dat[i];
          ++lf[dat[i]];
        }
      }
    }
    pos = wblk(dat, w, lst, syms, lf, df, eb, li, bs, i - bs, pos);
    if (!lst && pos & 7)
      pos = wfblk(w, pos + 1, et);
  }
  return slc(o, 0, pre + shft(pos) + post);
};
var adler = function() {
  var a = 1, b = 0;
  return {
    p: function(d) {
      var n = a, m = b;
      var l = d.length | 0;
      for (var i = 0; i !== l; ) {
        var e = Math.min(i + 2655, l);
        for (; i < e; ++i)
          m += n += d[i];
        n = (n & 65535) + 15 * (n >> 16), m = (m & 65535) + 15 * (m >> 16);
      }
      a = n, b = m;
    },
    d: function() {
      a %= 65521, b %= 65521;
      return (a & 255) << 24 | a >>> 8 << 16 | (b & 255) << 8 | b >>> 8;
    }
  };
};
var dopt = function(dat, opt, pre, post, st) {
  return dflt(dat, opt.level == null ? 6 : opt.level, opt.mem == null ? Math.ceil(Math.max(8, Math.min(13, Math.log(dat.length))) * 1.5) : 12 + opt.mem, pre, post, !st);
};
var wbytes = function(d, b, v) {
  for (; v; ++b)
    d[b] = v, v >>>= 8;
};
var zlh = function(c, o) {
  var lv = o.level, fl2 = lv === 0 ? 0 : lv < 6 ? 1 : lv === 9 ? 3 : 2;
  c[0] = 120, c[1] = fl2 << 6 | (fl2 ? 32 - 2 * fl2 : 1);
};
var zlv = function(d) {
  if ((d[0] & 15) !== 8 || d[0] >>> 4 > 7 || (d[0] << 8 | d[1]) % 31)
    throw "invalid zlib data";
  if (d[1] & 32)
    throw "invalid zlib data: preset dictionaries not supported";
};
function zlibSync(data, opts) {
  if (!opts)
    opts = {};
  var a = adler();
  a.p(data);
  var d = dopt(data, opts, 2, 4);
  return zlh(d, opts), wbytes(d, d.length - 4, a.d()), d;
}
function unzlibSync(data, out) {
  return inflt((zlv(data), data.subarray(2, -4)), out);
}
function compress(buf, level) {
  return zlibSync(buf, { level });
}
function decompress(buf, limit) {
  try {
    return unzlibSync(buf, new Uint8Array(limit));
  } catch (err) {
    throw err.message ? err : new Error(err);
  }
}

// png/src/png.js
var __IHDR__ = new Uint8Array([73, 72, 68, 82]);
var __IDAT__ = new Uint8Array([73, 68, 65, 84]);
var __IEND__ = new Uint8Array([73, 69, 78, 68]);
var __IEND_CRC__ = crc32(new Uint8Array([73, 69, 78, 68]));
var HEAD = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
var color_types = {
  GREYSCALE: 0,
  TRUECOLOR: 2,
  INDEXED_COLOR: 3,
  GREYSCALE_ALPHA: 4,
  TRUECOLOR_ALPHA: 6
};
var channels_to_color_type = {
  1: color_types.GREYSCALE,
  2: color_types.GREYSCALE_ALPHA,
  3: color_types.TRUECOLOR,
  4: color_types.TRUECOLOR_ALPHA
};
var utf8encoder = new TextEncoder();
function encode(data, { text, width, height, channels, depth = 8, level = 0 }) {
  let offset = 0;
  let tmp_offset = 0;
  const row_length = width * channels;
  const tmp = new Uint8Array(height + data.length);
  while (offset < data.length) {
    tmp[tmp_offset++] = 0;
    tmp.set(data.subarray(offset, offset += row_length), tmp_offset);
    tmp_offset += row_length;
  }
  if (text) {
    let chunks = [];
    for (const key in text) {
      if (!text[key])
        continue;
      const kb = utf8encoder.encode(key);
      const tb = utf8encoder.encode(text[key]);
      const chunk = new Uint8Array(1 + 12 + kb.length + tb.length);
      const view4 = new DataView(chunk.buffer);
      chunk[4] = 116;
      chunk[5] = 69;
      chunk[6] = 88;
      chunk[7] = 116;
      chunk.set(kb, 8);
      chunks.push(chunk);
      chunk.set(tb, 9 + kb.length);
      view4.setUint32(0, chunk.length - 12);
      view4.setUint32(chunk.length - 4, crc32(chunk.subarray(4, chunk.length - 4)));
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
  if (text)
    array.set(text, 45 + compressed.length);
  array.set(__IEND__, 49 + offset + compressed.length);
  const view3 = new DataView(array.buffer);
  view3.setUint32(8, 13);
  view3.setUint32(16, width);
  view3.setUint32(20, height);
  view3.setUint32(33, compressed.length);
  view3.setUint32(45 + offset + compressed.length, 0);
  view3.setUint32(53 + offset + compressed.length, __IEND_CRC__);
  view3.setUint32(29, crc32(new Uint8Array(array.buffer, 12, 17)));
  view3.setUint32(41 + compressed.length, crc32(new Uint8Array(array.buffer, 37, 4 + compressed.length)));
  return array;
}
function decode(array) {
  let view3 = new DataView(array.buffer, array.byteOffset, array.byteLength);
  const width = view3.getUint32(16);
  const height = view3.getUint32(20);
  const bpc = array[24];
  const pixel_type = array[25];
  let channels = { 3: 1, 0: 1, 4: 2, 2: 3, 6: 4 }[pixel_type];
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
  while ((type = view3.getUint32(4 + c_offset)) !== 1229278788) {
    if (type === 1229209940)
      chunks.push(array.subarray(8 + c_offset, 8 + c_offset + view3.getUint32(c_offset)));
    else if (type === 1347179589) {
      if (palette)
        throw new Error("PLTE can only occur once in an image");
      palette = new Uint32Array(view3.getUint32(c_offset));
      for (let pxlOffset = 0; pxlOffset < palette.length * 8; pxlOffset += 3)
        palette[pxlOffset / 3] = array[8 + c_offset + pxlOffset] << 24 | array[8 + c_offset + pxlOffset + 1] << 16 | array[8 + c_offset + pxlOffset + 2] << 8 | 255;
    } else if (type === 1951551059) {
      if (alphaPalette)
        throw new Error("tRNS can only occur once in an image");
      alphaPalette = new Uint8Array(view3.getUint32(c_offset));
      for (let i = 0; i < alphaPalette.length; i++)
        alphaPalette[i] = array[8 + c_offset + i];
    }
    c_offset += 4 + 4 + 4 + view3.getUint32(c_offset);
    if (c_offset > maxSearchOffset)
      break;
  }
  array = decompress(chunks.length === 1 ? chunks[0] : from_parts(chunks), height + height * row_length);
  while (offset < array.byteLength) {
    const filter = array[offset++];
    const slice = array.subarray(offset, offset += row_length);
    if (filter === 0)
      pixels.set(slice, p_offset);
    else if (filter === 1)
      filter_1(slice, pixels, p_offset, bytespp, row_length);
    else if (filter === 2)
      filter_2(slice, pixels, p_offset, bytespp, row_length);
    else if (filter === 3)
      filter_3(slice, pixels, p_offset, bytespp, row_length);
    else if (filter === 4)
      filter_4(slice, pixels, p_offset, bytespp, row_length);
    p_offset += row_length;
  }
  if (pixel_type === 3) {
    if (!palette)
      throw new Error("Indexed color PNG has no PLTE");
    if (alphaPalette)
      for (let i = 0; i < alphaPalette.length; i++)
        palette[i] &= 4294967040 | alphaPalette[i];
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
    const view4 = new DataView(newPixels.buffer);
    if (channels === 1) {
      for (let i = 0; i < width * height; i++) {
        const pixel = pixels[i];
        view4.setUint32(i * 4, pixel << 24 | pixel << 16 | pixel << 8 | 255, false);
      }
    } else if (channels === 2) {
      for (let i = 0; i < width * height * 2; i += 2) {
        const pixel = pixels[i];
        view4.setUint32(i * 2, pixel << 24 | pixel << 16 | pixel << 8 | pixels[i + 1], false);
      }
    } else if (channels === 3) {
      newPixels.fill(255);
      for (let i = 0; i < width * height; i++)
        newPixels.set(pixels.subarray(i * 3, i * 3 + 3), i * 4);
    }
    pixels = newPixels;
  }
  return { width, height, buffer: pixels };
}
function filter_1(slice, pixels, p_offset, bytespp, row_length) {
  let i = 0;
  while (i < bytespp)
    pixels[i + p_offset] = slice[i++];
  while (i < row_length)
    pixels[i + p_offset] = slice[i] + pixels[i++ + p_offset - bytespp];
}
function filter_2(slice, pixels, p_offset, bytespp, row_length) {
  if (p_offset === 0)
    pixels.set(slice, p_offset);
  else {
    let i = 0;
    while (i < row_length)
      pixels[i + p_offset] = slice[i] + pixels[i++ + p_offset - row_length];
  }
}
function filter_3(slice, pixels, p_offset, bytespp, row_length) {
  let i = 0;
  if (p_offset === 0) {
    while (i < bytespp)
      pixels[i] = slice[i++];
    while (i < row_length)
      pixels[i] = slice[i] + (pixels[i++ - bytespp] >> 1);
  } else {
    while (i < bytespp)
      pixels[i + p_offset] = slice[i] + (pixels[i++ + p_offset - row_length] >> 1);
    while (i < row_length)
      pixels[i + p_offset] = slice[i] + (pixels[i + p_offset - bytespp] + pixels[i++ + p_offset - row_length] >> 1);
  }
}
function filter_4(slice, pixels, p_offset, bytespp, row_length) {
  let i = 0;
  if (p_offset === 0) {
    while (i < bytespp)
      pixels[i] = slice[i++];
    while (i < row_length)
      pixels[i] = slice[i] + pixels[i++ - bytespp];
  } else {
    while (i < bytespp)
      pixels[i + p_offset] = slice[i] + pixels[i++ + p_offset - row_length];
    while (i < row_length) {
      const a = pixels[i + p_offset - bytespp];
      const b = pixels[i + p_offset - row_length];
      const c = pixels[i + p_offset - bytespp - row_length];
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      pixels[i + p_offset] = slice[i++] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
    }
  }
}

// v2/framebuffer.mjs
var framebuffer = class {
  constructor(width, height, buffer) {
    this.width = width | 0;
    this.height = height | 0;
    this.u8 = buffer ? view(buffer) : new Uint8Array(4 * this.width * this.height);
    this.view = new DataView(this.u8.buffer, this.u8.byteOffset, this.u8.byteLength);
    this.u32 = new Uint32Array(this.u8.buffer, this.u8.byteOffset, this.u8.byteLength / 4);
    if (this.u8.length !== 4 * this.width * this.height)
      throw new RangeError("invalid capacity of buffer");
  }
  [Symbol.iterator]() {
    return iterator_exports.cords(this);
  }
  toString() {
    return `framebuffer<${this.width}x${this.height}>`;
  }
  get(x2, y) {
    return this.view.getUint32((x2 | 0) + (y | 0) * this.width, false);
  }
  clone() {
    return new this.constructor(this.width, this.height, this.u8.slice());
  }
  set(x2, y, color3) {
    this.view.setUint32((x2 | 0) + (y | 0) * this.width, color3, false);
  }
  toJSON() {
    return { width: this.width, height: this.height, buffer: Array.from(this.u8) };
  }
  scale(type, factor) {
    return this.resize(type, factor * this.width, factor * this.height);
  }
  overlay(frame, x2 = 0, y = 0) {
    return overlay_exports.blend(this, frame, x2 | 0, y | 0), this;
  }
  replace(frame, x2 = 0, y = 0) {
    return overlay_exports.replace(this, frame, x2 | 0, y | 0), this;
  }
  at(x2, y) {
    const offset = 4 * ((x2 | 0) + (y | 0) * this.width);
    return this.u8.subarray(offset, 4 + offset);
  }
  static from(framebuffer2) {
    return new this(framebuffer2.width, framebuffer2.height, framebuffer2.u8 || framebuffer2.buffer);
  }
  static decode(format, buffer) {
    if (format !== "png")
      throw new RangeError("invalid image format");
    else
      return framebuffer.from(decode(buffer));
  }
  encode(format, options = {}) {
    var _a2;
    if (format !== "png")
      throw new RangeError("invalid image format");
    else
      return encode(this.u8, { channels: 4, width: this.width, height: this.height, level: (_a2 = { none: 0, fast: 3, default: 6, best: 9 }[options.compression]) != null ? _a2 : 3 });
  }
  pixels(type) {
    if (type === "rgba")
      return iterator_exports.rgba(this);
    if (!type || type === "int")
      return iterator_exports.u32(this);
    throw new RangeError("invalid iterator type");
  }
  flip(type) {
    if (type === "vertical")
      flip_exports.vertical(this);
    else if (type === "horizontal")
      flip_exports.horizontal(this);
    else
      throw new RangeError("invalid flip type");
    return this;
  }
  crop(type, arg0, arg1, arg2, arg3) {
    if (type === "circle")
      crop_exports.circle(arg0 || 0, this);
    else if (type === "box")
      crop_exports.crop(arg0 | 0, arg1 | 0, arg2 | 0, arg3 | 0, this);
    else
      throw new RangeError("invalid crop type");
    return this;
  }
  cut(type, arg0, arg1, arg2, arg3) {
    if (type === "circle")
      return crop_exports.circle(arg0 || 0, this.clone());
    else if (type === "box")
      return crop_exports.cut(arg0 | 0, arg1 | 0, arg2 | 0, arg3 | 0, this);
    else
      throw new RangeError("invalid cut type");
  }
  rotate(deg, resize = true) {
    if ((deg %= 360) === 0)
      return this;
    else if (deg === 90)
      rotate_exports.rotate90(this);
    else if (deg === 180)
      rotate_exports.rotate180(this);
    else if (deg === 270)
      rotate_exports.rotate270(this);
    else
      rotate_exports.rotate(deg, this, resize);
    return this;
  }
  blur(type, arg0) {
    if (type === "cubic")
      blur_exports.cubic(this);
    else if (type === "box")
      blur_exports.box(+arg0, this);
    else if (type === "gaussian")
      blur_exports.gaussian(+arg0, this);
    else
      throw new RangeError("invalid blur type");
    return this;
  }
  fill(color3) {
    const type = typeof color3;
    if (type === "function")
      fill_exports.fn(color3, this);
    else if (type === "number")
      fill_exports.color(color3, this);
    else if (color3 instanceof color)
      fill_exports.color(color3.valueOf(), this);
    else if (Array.isArray(color3))
      fill_exports.color(color_exports.from_rgba(...color3), this);
    else
      throw new TypeError("invalid fill color");
    return this;
  }
  swap(old, color3) {
    const ot = typeof old;
    const nt = typeof color3;
    if (ot === nt && ot === "number")
      fill_exports.swap(old, color3, this);
    else if (old instanceof color && color3 instanceof color)
      fill_exports.swap(old.valueOf(), color3.valueOf(), this);
    else if (Array.isArray(old) && Array.isArray(color3))
      fill_exports.swap(color_exports.from_rgba(...old), color_exports.from_rgba(...color3), this);
    else
      throw new RangeError("invalid swap color");
    return this;
  }
  resize(type, width, height) {
    if (width === this.width && height === this.height)
      return this;
    else if (type === "cubic")
      resize_exports.cubic(width, height, this);
    else if (type === "linear")
      resize_exports.linear(width, height, this);
    else if (type === "nearest")
      resize_exports.nearest(width, height, this);
    else
      throw new RangeError("invalid resize type");
    return this;
  }
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  Color
});

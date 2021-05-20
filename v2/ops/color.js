export function to_rgba(int) {
  return [(int >> 24) & 0xff, (int >> 16) & 0xff, (int >> 8) & 0xff, int & 0xff];
}

export function from_rgba(r, g, b, a) {
  return ((r & 0xff) << 24) | ((g & 0xff) << 16) | ((b & 0xff) << 8) | (a & 0xff);
}

export function blend(fg, bg) {
  const fa = fg & 0xff;
  const alpha = fa + 1 | 0;
  const inv_alpha = 256 - fa | 0;
  const r = (alpha * (fg >>> 24) + inv_alpha * (bg >>> 24)) >> 8;
  const b = (alpha * (fg >> 8 & 0xff) + inv_alpha * (bg >> 8 & 0xff)) >> 8;
  const g = (alpha * (fg >> 16 & 0xff) + inv_alpha * (bg >> 16 & 0xff)) >> 8;
  return (((r & 0xff) << 24) | ((g & 0xff) << 16) | ((b & 0xff) << 8) | (Math.max(fa, bg & 0xff) & 0xff));
}

  // /**
  //  * Converts HSLA colors to RGBA colors
  //  * @param {number} h hue (0..1)
  //  * @param {number} s saturation (0..1)
  //  * @param {number} l lightness (0..1)
  //  * @param {number} a opacity (0..1)
  //  * @returns {number} color
  //  */
  // static hslaToColor(h, s, l, a) {
  //   h %= 1;
  //   s = Math.min(1, Math.max(0, s));
  //   l = Math.min(1, Math.max(0, l));
  //   a = Math.min(1, Math.max(0, a));

  //   let r, g, b;

  //   if (s === 0) {
  //     r = g = b = l;
  //   } else {
  //     const hue2rgb = (p, q, t) => {
  //       if (t < 0) t += 1;
  //       if (t > 1) t -= 1;
  //       if (t < 1 / 6) return p + (q - p) * 6 * t;
  //       if (t < 1 / 2) return q;
  //       if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  //       return p;
  //     };

  //     const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  //     const p = 2 * l - q;

  //     r = hue2rgb(p, q, h + 1 / 3);
  //     g = hue2rgb(p, q, h);
  //     b = hue2rgb(p, q, h - 1 / 3);
  //   }

  //   return Image.rgbaToColor(r * 255, g * 255, b * 255, a * 255);
  // }

  // /**
  //  * Converts HSL colors to RGBA colors (assuming an opacity of 255)
  //  * @param {number} h hue (0..1)
  //  * @param {number} s saturation (0..1)
  //  * @param {number} l lightness (0..1)
  //  * @returns {number} color
  //  */
  // static hslToColor(h, s, l) {
  //   return Image.hslaToColor(h, s, l, 1);
  // }

  // /**
  //  * Converts an RGBA value to an array of HSLA values
  //  * @param r {number} (0..255)
  //  * @param g {number} (0..255)
  //  * @param b {number} (0..255)
  //  * @param a {number} (0..255)
  //  * @returns {(number)[]} The HSLA values ([H, S, L, A])
  //  */
  // static rgbaToHSLA(r, g, b, a) {
  //   r /= 255;
  //   g /= 255;
  //   b /= 255;

  //   const max = Math.max(r, g, b), min = Math.min(r, g, b);
  //   let h, s, l = (max + min) / 2;

  //   if (max === min) {
  //     h = s = 0;
  //   } else {
  //     const d = max - min;
  //     s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  //     switch (max) {
  //       case r:
  //         h = (g - b) / d + (g < b ? 6 : 0);
  //         break;
  //       case g:
  //         h = (b - r) / d + 2;
  //         break;
  //       case b:
  //         h = (r - g) / d + 4;
  //         break;
  //     }

  //     h /= 6;
  //   }

  //   return [h, s, l, a / 255];
  // }
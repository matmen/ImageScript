import { blend } from './color.js';

export function replace(bg, fg, x, y) {
  const fwidth = fg.width | 0;
  const bwidth = bg.width | 0;
  const fheight = fg.height | 0;
  const bheight = bg.height | 0;
  let mw = Math.min(bwidth, fwidth) | 0;
  let mh = Math.min(bheight, fheight) | 0;

  const b32 = bg.u32;
  const f32 = fg.u32;

  // todo: range
  // todo: negative speed
  for (let yy = y | 0; yy < mh; yy++) {
    const yoffset = yy * bwidth;
    const yyoffset = fwidth * (yy - y);

    for (let xx = x | 0; xx < mw; xx++) {
      b32[xx + yoffset] = f32[xx - x + yyoffset];
    }
  }
}

export function overlay(background, foreground, x, y) {
  x = x | 0;
  y = y | 0;
  const fwidth = foreground.width | 0;
  const bwidth = background.width | 0;
  const fheight = foreground.height | 0;
  const bheight = background.height | 0;
  const mw = Math.min(bwidth, fwidth) | 0;
  const mh = Math.min(bheight, fheight) | 0;

  const fview = foreground.view;
  const bview = background.view;

  // todo: negative perf
  for (let yy = y | 0; yy < mh; yy++) {
    const yoffset = yy * bwidth;
    const yyoffset = fwidth * (yy - y);

    for (let xx = x | 0; xx < mw; xx++) {
      const offset = 4 * (xx + yoffset);
      const fg = fview.getUint32(4 * (xx - x + yyoffset), false);

      const bg = bview.getUint32(offset, false);
      if ((fg & 0xff) === 0xff) bview.setUint32(offset, fg, false);
      else if ((fg & 0xff) === 0x00) bview.setUint32(offset, bg, false);

      else bview.setUint32(offset, blend(fg, bg), false);
    }
  }
}
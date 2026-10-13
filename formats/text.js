'use strict';
const { Font } = require('./font.js');

const fonts = new WeakMap();

// parsed fonts are cached per buffer
function loadFont(data) {
    let font = fonts.get(data.buffer);
    if (!font || font.data.byteOffset !== data.byteOffset) {
        font = new Font(data);
        fonts.set(data.buffer, font);
    }
    return font;
}

/**
 * Lays out and rasterizes text
 * Lines start at ceil(ascender) and advance by ceil(ascender - descender + lineGap), glyphs advance by
 * their ceiled advance width; the canvas spans from the origin to the furthest glyph edge
 * @param {Uint8Array} data TrueType/OpenType font
 * @param {number} size font size in pixels per em
 * @param {string} text
 * @param {{maxWidth: number, maxHeight: number, wrapStyle: string, verticalAlign: string, horizontalAlign: string, wrapHardBreaks: boolean}} layout
 *     verticalAlign takes left/center/right and horizontalAlign top/middle/bottom
 * @return {{width: number, height: number, coverage: Uint8Array}}
 */
function render(data, size, text, layout) {
    const font = loadFont(data);
    const scale = size / font.unitsPerEm;
    const ascent = Math.ceil(font.ascender * scale);
    const lineHeight = Math.ceil((font.ascender - font.descender + font.lineGap) * scale);

    const glyphs = new Map();
    const glyph = codepoint => {
        let g = glyphs.get(codepoint);
        if (!g) {
            const index = font.glyphIndex(codepoint);
            g = { index, advance: Math.ceil(font.advance(index) * scale), bitmap: rasterizeGlyph(font.outline(index), scale) };
            glyphs.set(codepoint, g);
        }
        return g;
    };

    const lines = wrap(text, layout, glyph);

    // lines that fit into maxHeight, chosen by the vertical alignment
    let visible = lines;
    if (isFinite(layout.maxHeight)) {
        const count = Math.max(1, Math.floor(layout.maxHeight / lineHeight));
        if (count < lines.length) {
            const start = layout.horizontalAlign === 'bottom' ? lines.length - count
                : layout.horizontalAlign === 'middle' ? lines.length - count >> 1 : 0;
            visible = lines.slice(start, start + count);
        }
    }

    const width = Math.max(0, ...visible.map(line => line.extent));
    const height = visible.length * lineHeight;
    const coverage = new Uint8Array(width * height);

    visible.forEach((line, n) => {
        const offset = layout.verticalAlign === 'right' ? width - line.extent
            : layout.verticalAlign === 'center' ? width - line.extent >> 1 : 0;
        const baseline = ascent + n * lineHeight;

        for (const { x, glyph: g } of line.glyphs) {
            const { bitmap } = g;
            if (!bitmap) continue;
            blit(coverage, width, height, bitmap, offset + x + bitmap.left, baseline - bitmap.top);
        }
    });

    return { width, height, coverage };
}

// breaks text into lines of positioned glyphs
function wrap(text, layout, glyph) {
    const lines = [];
    const paragraphs = layout.wrapHardBreaks ? text.split(/\r\n|\r|\n/) : [text.replace(/\r\n|\r|\n/g, '')];

    // right edge of a glyph placed at x (glyphs without ink don't extend the line)
    const edge = (x, g) => g.bitmap ? x + g.bitmap.left + g.bitmap.width : 0;

    for (const paragraph of paragraphs) {
        let line = { glyphs: [], extent: 0, soft: false };
        let x = 0;
        // index into line.glyphs right after the last space, for word wrapping
        let breakAt = -1;

        const add = g => {
            line.glyphs.push({ x, glyph: g });
            line.extent = Math.max(line.extent, edge(x, g));
            x += g.advance;
        };

        const newLine = () => {
            lines.push(line);
            line = { glyphs: [], extent: 0, soft: true };
            x = 0;
            breakAt = -1;
        };

        for (const char of paragraph) {
            const codepoint = char.codePointAt(0);
            const g = glyph(codepoint);
            const space = codepoint === 0x20 || codepoint === 0x09;

            if (!space && line.glyphs.length && edge(x, g) > layout.maxWidth) {
                if (layout.wrapStyle === 'word' && breakAt > 0) {
                    // move the current word to the next line
                    const word = line.glyphs.splice(breakAt);
                    line.extent = measure(line.glyphs, edge);
                    newLine();
                    for (const item of word) add(item.glyph);
                } else newLine();
            }

            // soft wrapped lines don't start with whitespace
            if (space && line.soft && !line.glyphs.length) continue;

            add(g);
            if (space) breakAt = line.glyphs.length;
        }

        lines.push(line);
    }

    return lines;
}

function measure(glyphs, edge) {
    let extent = 0;
    for (const { x, glyph } of glyphs) if (glyph.bitmap) extent = Math.max(extent, edge(x, glyph));
    return extent;
}

function blit(target, width, height, bitmap, x0, y0) {
    for (let y = 0; y < bitmap.height; y++) {
        const ty = y0 + y;
        if (ty < 0 || ty >= height) continue;

        for (let x = 0; x < bitmap.width; x++) {
            const tx = x0 + x;
            if (tx < 0 || tx >= width) continue;

            const v = bitmap.data[y * bitmap.width + x];
            if (v) {
                const o = ty * width + tx;
                target[o] = Math.min(255, target[o] + v);
            }
        }
    }
}

/**
 * Rasterizes a glyph outline into an 8-bit coverage bitmap
 * @param {Array} path outline in font units (y up)
 * @param {number} scale pixels per font unit
 * @return {{data: Uint8Array, width: number, height: number, left: number, top: number}|null}
 *     left/top position the bitmap relative to the pen position on the baseline (top is measured upwards)
 */
function rasterizeGlyph(path, scale) {
    if (!path.length) return null;

    let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
    for (const command of path)
        for (let i = 1; i < command.length; i += 2) {
            const x = command[i] * scale, y = command[i + 1] * scale;
            if (x < xmin) xmin = x;
            if (x > xmax) xmax = x;
            if (y < ymin) ymin = y;
            if (y > ymax) ymax = y;
        }

    const left = Math.floor(xmin), right = Math.ceil(xmax);
    const bottom = Math.floor(ymin), top = Math.ceil(ymax);
    const width = right - left, height = top - bottom;
    if (width <= 0 || height <= 0) return null;

    const raster = new Rasterizer(width, height);
    // flip y and move the bitmap origin to (left, top)
    const tx = x => x * scale - left;
    const ty = y => top - y * scale;

    let sx = 0, sy = 0, cx = 0, cy = 0;
    for (const command of path) {
        switch (command[0]) {
            case 'M':
                sx = cx = tx(command[1]);
                sy = cy = ty(command[2]);
                break;
            case 'L': {
                const x = tx(command[1]), y = ty(command[2]);
                raster.line(cx, cy, x, y);
                cx = x;
                cy = y;
                break;
            }
            case 'Q': {
                const x = tx(command[3]), y = ty(command[4]);
                raster.quad(cx, cy, tx(command[1]), ty(command[2]), x, y);
                cx = x;
                cy = y;
                break;
            }
            case 'C': {
                const x = tx(command[5]), y = ty(command[6]);
                raster.cubic(cx, cy, tx(command[1]), ty(command[2]), tx(command[3]), ty(command[4]), x, y);
                cx = x;
                cy = y;
                break;
            }
            case 'Z':
                if (cx !== sx || cy !== sy) raster.line(cx, cy, sx, sy);
                cx = sx;
                cy = sy;
                break;
        }
    }

    return { data: raster.coverage(), width, height, left, top };
}

/**
 * Signed area coverage rasterizer (the font-rs algorithm): every line segment adds its
 * area to an accumulation buffer, a prefix sum over each row yields the coverage
 */
class Rasterizer {
    constructor(width, height) {
        this.width = width;
        this.height = height;
        this.accumulation = new Float32Array(width * height + 4);
    }

    line(x0, y0, x1, y1) {
        if (y0 === y1) return;

        let dir = 1;
        if (y0 > y1) {
            dir = -1;
            [x0, y0, x1, y1] = [x1, y1, x0, y0];
        }

        const a = this.accumulation;
        const w = this.width;
        const dxdy = (x1 - x0) / (y1 - y0);
        let x = x0;
        if (y0 < 0) x -= y0 * dxdy;

        const yEnd = Math.min(this.height, Math.ceil(y1));
        for (let y = Math.max(0, y0 | 0); y < yEnd; y++) {
            const lineStart = y * w;
            const dy = Math.min(y + 1, y1) - Math.max(y, y0);
            const xNext = x + dxdy * dy;
            const d = dy * dir;
            const xa = x < xNext ? x : xNext, xb = x < xNext ? xNext : x;

            const xaFloor = Math.floor(xa);
            const xai = xaFloor;
            const xbCeil = Math.ceil(xb);
            const xbi = xbCeil;
            const index = lineStart + xai;

            if (index >= 0) {
                if (xbi <= xai + 1) {
                    const xmf = 0.5 * (x + xNext) - xaFloor;
                    a[index] += d - d * xmf;
                    a[index + 1] += d * xmf;
                } else {
                    const s = 1 / (xb - xa);
                    const xaf = xa - xaFloor;
                    const a0 = 0.5 * s * (1 - xaf) * (1 - xaf);
                    const xbf = xb - xbCeil + 1;
                    const am = 0.5 * s * xbf * xbf;

                    a[index] += d * a0;
                    if (xbi === xai + 2) a[index + 1] += d * (1 - a0 - am);
                    else {
                        const a1 = s * (1.5 - xaf);
                        a[index + 1] += d * (a1 - a0);
                        for (let xi = xai + 2; xi < xbi - 1; xi++) a[lineStart + xi] += d * s;
                        const a2 = a1 + (xbi - xai - 3) * s;
                        a[lineStart + xbi - 1] += d * (1 - a2 - am);
                    }
                    a[lineStart + xbi] += d * am;
                }
            }

            x = xNext;
        }
    }

    quad(x0, y0, x1, y1, x2, y2) {
        const devx = x0 - 2 * x1 + x2;
        const devy = y0 - 2 * y1 + y2;
        const devsq = devx * devx + devy * devy;

        if (devsq < 0.333) return this.line(x0, y0, x2, y2);

        const n = 1 + Math.floor(Math.sqrt(Math.sqrt(3 * devsq)));
        let px = x0, py = y0;
        for (let i = 1; i <= n; i++) {
            const t = i / n, mt = 1 - t;
            const x = mt * mt * x0 + 2 * mt * t * x1 + t * t * x2;
            const y = mt * mt * y0 + 2 * mt * t * y1 + t * t * y2;
            this.line(px, py, x, y);
            px = x;
            py = y;
        }
    }

    cubic(x0, y0, x1, y1, x2, y2, x3, y3) {
        const dx = Math.max(Math.abs(x0 - 2 * x1 + x2), Math.abs(x1 - 2 * x2 + x3));
        const dy = Math.max(Math.abs(y0 - 2 * y1 + y2), Math.abs(y1 - 2 * y2 + y3));
        const devsq = dx * dx + dy * dy;

        if (devsq < 0.333) return this.line(x0, y0, x3, y3);

        const n = 1 + Math.floor(Math.sqrt(Math.sqrt(6 * devsq)));
        let px = x0, py = y0;
        for (let i = 1; i <= n; i++) {
            const t = i / n, mt = 1 - t;
            const x = mt * mt * mt * x0 + 3 * mt * mt * t * x1 + 3 * mt * t * t * x2 + t * t * t * x3;
            const y = mt * mt * mt * y0 + 3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t * t * t * y3;
            this.line(px, py, x, y);
            px = x;
            py = y;
        }
    }

    coverage() {
        const length = this.width * this.height;
        const out = new Uint8Array(length);
        let acc = 0;

        for (let i = 0; i < length; i++) {
            acc += this.accumulation[i];
            const v = acc < 0 ? -acc : acc;
            out[i] = v >= 1 ? 255 : v * 255 + 0.5 | 0;
        }

        return out;
    }
}

module.exports = { render, rasterizeGlyph, Rasterizer };

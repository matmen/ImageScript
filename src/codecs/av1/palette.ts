/*!
 * Palettes of the AV1 encoder: the colors of a block (by k-means, from its most frequent colors), the color indices'
 * contexts and order (like the decoder's readPalIndices, ported from dav1d: Copyright (c) 2018-2021, VideoLAN and
 * dav1d authors, Copyright (c) 2018, Two Orioles, LLC, BSD-2-Clause License, see THIRD_PARTY_NOTICES.md), their bits
 */

/**
 * At most k colors (of one or two components) for weighted colors: the k most frequent ones, refined by k-means;
 * sorted by the first component
 */
export function paletteColors(colors: number[][], weights: number[], k: number): number[][] {
    const order = colors.map((_, i) => i).sort((a, b) => weights[b] - weights[a]);
    let centers = order.slice(0, k).map(i => colors[i].slice());
    if (colors.length > k) {
        const dims = colors[0].length, assign = new Int32Array(colors.length);
        for (let iter = 0; iter < 8; iter++) {
            let changed = false;
            for (let i = 0; i < colors.length; i++) {
                let best = 0, bestD = Infinity;
                for (let c = 0; c < centers.length; c++) {
                    let d = 0;
                    for (let e = 0; e < dims; e++) d += (colors[i][e] - centers[c][e]) ** 2;
                    if (d < bestD) { bestD = d; best = c; }
                }
                if (assign[i] !== best || !iter) changed = true;
                assign[i] = best;
            }
            if (!changed) break;
            const sums = centers.map(() => new Float64Array(dims + 1));
            for (let i = 0; i < colors.length; i++) {
                const s = sums[assign[i]];
                for (let e = 0; e < dims; e++) s[e] += colors[i][e] * weights[i];
                s[dims] += weights[i];
            }
            centers = centers.map((c, j) => sums[j][dims] ? Array.from({ length: dims }, (_, e) => Math.round(sums[j][e] / sums[j][dims])) : c);
        }
    }
    // (sorted, without duplicates)
    centers.sort((a, b) => a[0] - b[0] || (a[1] ?? 0) - (b[1] ?? 0));
    return centers.filter((c, i) => !i || c.some((v, e) => v !== centers[i - 1][e]));
}

const ORDER = new Uint8Array(8);

/**
 * Visits the color indices of a palette block (w x h of t, rows of stride) after the first, in the decoder's wavefront
 * order: with the context and the index's rank in the order of its neighbours' colors (the symbol)
 */
export function colorRanks(t: Uint8Array, stride: number, w: number, h: number, visit: (ctx: number, rank: number) => void): void {
    const order = ORDER;
    for (let i = 1; i < w + h - 1; i++) {
        const first = Math.min(i, w - 1), last = Math.max(0, i - h + 1);
        for (let j = first; j >= last; j--) {
            const p = (i - j) * stride + j, v = t[p];
            let ctx: number, n = 0;
            if (!j) { ctx = 0; order[n++] = t[p - stride]; }
            else if (i === j) { ctx = 0; order[n++] = t[p - 1]; }
            else {
                const l = t[p - 1], tp = t[p - stride], tl = t[p - stride - 1];
                const sameTL = tp === l, sameTTl = tp === tl, sameLTl = l === tl;
                if (sameTL && sameTTl && sameLTl) { ctx = 4; order[n++] = tp; }
                else if (sameTL) { ctx = 3; order[n++] = tp; order[n++] = tl; }
                else if (sameTTl || sameLTl) { ctx = 2; order[n++] = tl; order[n++] = sameTTl ? l : tp; }
                else { ctx = 1; order[n++] = Math.min(tp, l); order[n++] = Math.max(tp, l); order[n++] = tl; }
            }
            let rank = -1;
            for (let r = 0; r < n; r++) if (order[r] === v) { rank = r; break; }
            if (rank < 0) {
                // (then the other colors in increasing order)
                rank = n;
                for (let c = 0; c < v; c++) {
                    let listed = false;
                    for (let r = 0; r < n; r++) if (order[r] === c) listed = true;
                    if (!listed) rank++;
                }
            }
            visit(ctx, rank);
        }
    }
}

// the approximate bits of a rank (of the first: by context)
const FIRST_BITS = [0.4, 0.8, 0.5, 0.3, 0.08];
const RANK_BITS = [0, 2.2, 3.2, 3.8, 4.3, 4.7, 5, 5.3];

/** The approximate bits of a palette block's color indices */
export function colorIndexBits(t: Uint8Array, stride: number, w: number, h: number, palSz: number): number {
    let bits = Math.log2(palSz);
    colorRanks(t, stride, w, h, (ctx, rank) => { bits += rank ? RANK_BITS[rank] : FIRST_BITS[ctx]; });
    return bits;
}

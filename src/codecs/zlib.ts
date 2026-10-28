/*!
 * zlib deflate/inflate, derived from fflate (https://github.com/101arrowz/fflate)
 * Copyright (c) 2020 Arjun Barrett, MIT License (see THIRD_PARTY_NOTICES.md)
 */

const u8 = Uint8Array, u16 = Uint16Array, u32 = Uint32Array;

// code length index map
const clim = u8.of(16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15);
// fixed length extra bits
const fleb = u8.of(0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0, 0, 0, 0);
// fixed distance extra bits
const fdeb = u8.of(0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13, 0, 0);

// base values and reverse lookup for lengths/distances
function freb(eb: Uint8Array, start: number): [Uint16Array, Uint32Array] {
    const b = new u16(31);
    for (let i = 0; i < 31; ++i) b[i] = start += 1 << eb[i - 1];

    const r = new u32(b[30]);
    for (let i = 1; i < 30; ++i)
        for (let j = b[i]; j < b[i + 1]; ++j) r[j] = j - b[i] << 5 | i;

    return [b, r];
}

const [fl, revfl] = freb(fleb, 2);
fl[28] = 258;
revfl[258] = 28;
const [fd, revfd] = freb(fdeb, 0);

// bit reversal map
const rev = new u16(32768);
for (let i = 0; i < 32768; ++i) {
    let x = (i & 0xaaaa) >>> 1 | (i & 0x5555) << 1;
    x = (x & 0xcccc) >>> 2 | (x & 0x3333) << 2;
    x = (x & 0xf0f0) >>> 4 | (x & 0x0f0f) << 4;
    rev[i] = ((x & 0xff00) >>> 8 | (x & 0x00ff) << 8) >>> 1;
}

// huffman tree from code lengths, as a reverse lookup map (r) or a code map
function hMap(cd: Uint8Array, mb: number, r: boolean): Uint16Array {
    const s = cd.length;
    const l = new u16(mb);
    for (let i = 0; i < s; ++i) if (cd[i]) ++l[cd[i] - 1];

    const le = new u16(mb);
    for (let i = 1; i < mb; ++i) le[i] = le[i - 1] + l[i - 1] << 1;

    let co: Uint16Array;
    if (r) {
        co = new u16(1 << mb);
        const rvb = 15 - mb;
        for (let i = 0; i < s; ++i) {
            if (!cd[i]) continue;
            const sv = i << 4 | cd[i];
            const r1 = mb - cd[i];
            let v = le[cd[i] - 1]++ << r1;
            for (const m = v | (1 << r1) - 1; v <= m; ++v) co[rev[v] >>> rvb] = sv;
        }
    } else {
        co = new u16(s);
        for (let i = 0; i < s; ++i)
            if (cd[i]) co[i] = rev[le[cd[i] - 1]++] >>> 15 - cd[i];
    }

    return co;
}

// fixed length/distance trees
const flt = new u8(288);
for (let i = 0; i < 144; ++i) flt[i] = 8;
for (let i = 144; i < 256; ++i) flt[i] = 9;
for (let i = 256; i < 280; ++i) flt[i] = 7;
for (let i = 280; i < 288; ++i) flt[i] = 8;
const fdt = new u8(32);
for (let i = 0; i < 32; ++i) fdt[i] = 5;
const flm = hMap(flt, 9, false), flrm = hMap(flt, 9, true);
const fdm = hMap(fdt, 5, false), fdrm = hMap(fdt, 5, true);

function max(a: Uint8Array): number {
    let m = a[0];
    for (let i = 1; i < a.length; ++i) if (a[i] > m) m = a[i];
    return m;
}

// read d at bit position p with mask m
const bits = (d: Uint8Array, p: number, m: number): number => {
    const o = p / 8 | 0;
    return (d[o] | d[o + 1] << 8) >> (p & 7) & m;
};

// read d at bit position p, at least 16 bits
const bits16 = (d: Uint8Array, p: number): number => {
    const o = p / 8 | 0;
    return (d[o] | d[o + 1] << 8 | d[o + 2] << 16) >> (p & 7);
};

// byte position after bit position p
const shft = (p: number): number => (p + 7) / 8 | 0;

/**
 * Inflates raw deflate data into a buffer of a fixed size; output beyond it is discarded
 */
function inflate(dat: Uint8Array, buf: Uint8Array): Uint8Array {
    const sl = dat.length;
    if (!sl) return buf.subarray(0, 0);

    const tbts = sl * 8;
    let final = 0, pos = 0, bt = 0;

    do {
        let lm: Uint16Array, dm: Uint16Array, lbt: number, dbt: number;
        // a block's header (every block is decoded to its end before the next one)
        final = bits(dat, pos, 1);
        const type = bits(dat, pos + 1, 3);
        pos += 3;

        if (!type) {
            // stored block
            const s = shft(pos) + 4, l = dat[s - 4] | dat[s - 3] << 8, t = s + l;
            if (t > sl) throw new Error('zlib: unexpected end of data');
            if (bt < buf.length) buf.set(dat.subarray(s, Math.min(t, s + buf.length - bt)), bt);
            bt += l;
            pos = t * 8;
            continue;
        } else if (type === 1) {
            lm = flrm;
            dm = fdrm;
            lbt = 9;
            dbt = 5;
        } else if (type === 2) {
            // dynamic huffman tables
            const hLit = bits(dat, pos, 31) + 257, hcLen = bits(dat, pos + 10, 15) + 4;
            const tl = hLit + bits(dat, pos + 5, 31) + 1;
            pos += 14;

            const ldt = new u8(tl);
            const clt = new u8(19);
            for (let i = 0; i < hcLen; ++i) clt[clim[i]] = bits(dat, pos + i * 3, 7);
            pos += hcLen * 3;

            const clb = max(clt), clbmsk = (1 << clb) - 1;
            const clm = hMap(clt, clb, true);
            for (let i = 0; i < tl;) {
                const r = clm[bits(dat, pos, clbmsk)];
                pos += r & 15;
                const s = r >> 4;

                if (s < 16) ldt[i++] = s;
                else {
                    let c = 0, n = 0;
                    if (s === 16) {
                        n = 3 + bits(dat, pos, 3);
                        pos += 2;
                        c = ldt[i - 1];
                    } else if (s === 17) {
                        n = 3 + bits(dat, pos, 7);
                        pos += 3;
                    } else if (s === 18) {
                        n = 11 + bits(dat, pos, 127);
                        pos += 7;
                    }
                    while (n--) ldt[i++] = c;
                }
            }

            const lt = ldt.subarray(0, hLit), dt = ldt.subarray(hLit);
            lbt = max(lt);
            dbt = max(dt);
            lm = hMap(lt, lbt, true);
            dm = hMap(dt, dbt, true);
        } else throw new Error('zlib: invalid block type');

        if (pos > tbts) throw new Error('zlib: unexpected end of data');

        const lms = (1 << lbt) - 1, dms = (1 << dbt) - 1;
        for (; ;) {
            const c = lm[bits16(dat, pos) & lms], sym = c >> 4;
            pos += c & 15;
            if (pos > tbts) throw new Error('zlib: unexpected end of data');
            if (!c) throw new Error('zlib: invalid length/literal');

            if (sym < 256) buf[bt++] = sym;
            else if (sym === 256) break;
            else {
                let add = sym - 254;
                if (sym > 264) {
                    const i = sym - 257, b = fleb[i];
                    add = bits(dat, pos, (1 << b) - 1) + fl[i];
                    pos += b;
                }

                const d = dm[bits16(dat, pos) & dms], dsym = d >> 4;
                if (!d) throw new Error('zlib: invalid distance');
                pos += d & 15;

                let dt = fd[dsym];
                if (dsym > 3) {
                    const b = fdeb[dsym];
                    dt += bits16(dat, pos) & (1 << b) - 1;
                    pos += b;
                }

                if (pos > tbts) throw new Error('zlib: unexpected end of data');
                if (bt >= buf.length) {
                    bt += add;
                    continue;
                }

                const end = bt + add;
                for (; bt < end; bt += 4) {
                    buf[bt] = buf[bt - dt];
                    buf[bt + 1] = buf[bt + 1 - dt];
                    buf[bt + 2] = buf[bt + 2 - dt];
                    buf[bt + 3] = buf[bt + 3 - dt];
                }
                bt = end;
            }
        }
    } while (!final);

    return buf.subarray(0, Math.min(bt, buf.length));
}

// write bits starting at bit position p
const wbits = (d: Uint8Array, p: number, v: number): void => {
    v <<= p & 7;
    const o = p / 8 | 0;
    d[o] |= v;
    d[o + 1] |= v >> 8;
};

// write at least 16 bits starting at bit position p
const wbits16 = (d: Uint8Array, p: number, v: number): void => {
    v <<= p & 7;
    const o = p / 8 | 0;
    d[o] |= v;
    d[o + 1] |= v >> 8;
    d[o + 2] |= v >> 16;
};

interface HuffNode {
    s: number;
    f: number;
    l?: HuffNode;
    r?: HuffNode;
}

const et = new u8(0);

// creates code lengths from a frequency table, limited to mb bits
function hTree(d: Uint16Array, mb: number): [Uint8Array, number] {
    const t: HuffNode[] = [];
    for (let i = 0; i < d.length; ++i) if (d[i]) t.push({ s: i, f: d[i] });

    const s = t.length;
    const t2 = t.slice();
    if (!s) return [et, 0];
    if (s === 1) {
        const v = new u8(t[0].s + 1);
        v[t[0].s] = 1;
        return [v, 1];
    }

    t.sort((a, b) => a.f - b.f);
    // after i2 reaches the last ind, will be stopped
    t.push({ s: -1, f: 25001 });

    let l = t[0], r = t[1], i0 = 0, i1 = 1, i2 = 2;
    t[0] = { s: -1, f: l.f + r.f, l, r };
    // efficient algorithm from UZIP.js
    while (i1 !== s - 1) {
        l = t[t[i0].f < t[i2].f ? i0++ : i2++];
        r = t[i0 !== i1 && t[i0].f < t[i2].f ? i0++ : i2++];
        t[i1++] = { s: -1, f: l.f + r.f, l, r };
    }

    let maxSym = t2[0].s;
    for (let i = 1; i < s; ++i) if (t2[i].s > maxSym) maxSym = t2[i].s;

    const tr = new u16(maxSym + 1);
    let mbt = ln(t[i1 - 1], tr, 0);
    if (mbt > mb) {
        // more algorithms from UZIP.js, this one limits the code lengths
        let i = 0, dt = 0;
        const lft = mbt - mb, cst = 1 << lft;
        t2.sort((a, b) => tr[b.s] - tr[a.s] || a.f - b.f);

        for (; i < s; ++i) {
            const i2 = t2[i].s;
            if (tr[i2] > mb) {
                dt += cst - (1 << mbt - tr[i2]);
                tr[i2] = mb;
            } else break;
        }

        dt >>= lft;
        while (dt > 0) {
            const i2 = t2[i].s;
            if (tr[i2] < mb) dt -= 1 << mb - tr[i2]++ - 1;
            else ++i;
        }

        for (; i >= 0 && dt; --i) {
            const i2 = t2[i].s;
            if (tr[i2] === mb) {
                --tr[i2];
                ++dt;
            }
        }

        mbt = mb;
    }

    return [new u8(tr), mbt];
}

// assigns depths to the leaves of a huffman tree, returns the maximum depth
function ln(n: HuffNode, l: Uint16Array, d: number): number {
    return n.s === -1
        ? Math.max(ln(n.l as HuffNode, l, d + 1), ln(n.r as HuffNode, l, d + 1))
        : (l[n.s] = d);
}

// run length encodes code lengths
function lc(c: Uint8Array): [Uint16Array, number] {
    let s = c.length;
    // trailing zeros don't need to be written
    while (s && !c[--s]);

    const cl = new u16(++s);
    let cli = 0, cln = c[0], cls = 1;
    const w = (v: number): void => {
        cl[cli++] = v;
    };

    for (let i = 1; i <= s; ++i) {
        if (c[i] === cln && i !== s) ++cls;
        else {
            if (!cln && cls > 2) {
                for (; cls > 138; cls -= 138) w(32754);
                if (cls > 2) {
                    w(cls > 10 ? cls - 11 << 5 | 28690 : cls - 3 << 5 | 12305);
                    cls = 0;
                }
            } else if (cls > 3) {
                w(cln);
                --cls;
                for (; cls > 6; cls -= 6) w(8304);
                if (cls > 2) {
                    w(cls - 3 << 5 | 8208);
                    cls = 0;
                }
            }

            while (cls--) w(cln);
            cls = 1;
            cln = c[i];
        }
    }

    return [cl.subarray(0, cli), s];
}

// length of encoded data given frequencies and code lengths
function clen(cf: Uint16Array, cl: Uint8Array): number {
    let l = 0;
    for (let i = 0; i < cl.length; ++i) l += cf[i] * cl[i];
    return l;
}

// writes a stored block
function wfblk(out: Uint8Array, pos: number, dat: Uint8Array): number {
    const s = dat.length;
    const o = shft(pos + 2);
    out[o] = s & 255;
    out[o + 1] = s >> 8;
    out[o + 2] = out[o] ^ 255;
    out[o + 3] = out[o + 1] ^ 255;
    for (let i = 0; i < s; ++i) out[o + i + 4] = dat[i];
    return (o + 4 + s) * 8;
}

// writes a block
function wblk(dat: Uint8Array, out: Uint8Array, final: number, syms: Uint32Array, lf: Uint16Array, df: Uint16Array, eb: number, li: number, bs: number, bl: number, p: number): number {
    wbits(out, p++, final);
    ++lf[256];

    const [dlt, mlb] = hTree(lf, 15);
    const [ddt, mdb] = hTree(df, 15);
    const [lclt, nlc] = lc(dlt);
    const [lcdt, ndc] = lc(ddt);

    const lcfreq = new u16(19);
    for (let i = 0; i < lclt.length; ++i) ++lcfreq[lclt[i] & 31];
    for (let i = 0; i < lcdt.length; ++i) ++lcfreq[lcdt[i] & 31];

    const [lct, mlcb] = hTree(lcfreq, 7);
    let nlcc = 19;
    for (; nlcc > 4 && !lct[clim[nlcc - 1]]; --nlcc);

    const flen = (bl + 5) << 3;
    const ftlen = clen(lf, flt) + clen(df, fdt) + eb;
    const dtlen = clen(lf, dlt) + clen(df, ddt) + eb + 14 + 3 * nlcc + clen(lcfreq, lct) + 2 * lcfreq[16] + 3 * lcfreq[17] + 7 * lcfreq[18];
    if (bs >= 0 && flen <= ftlen && flen <= dtlen) return wfblk(out, p, dat.subarray(bs, bs + bl));

    let lm: Uint16Array, ll: Uint8Array, dm: Uint16Array, dl: Uint8Array;
    wbits(out, p, 1 + (dtlen < ftlen ? 1 : 0));
    p += 2;

    if (dtlen < ftlen) {
        lm = hMap(dlt, mlb, false);
        ll = dlt;
        dm = hMap(ddt, mdb, false);
        dl = ddt;

        const llm = hMap(lct, mlcb, false);
        wbits(out, p, nlc - 257);
        wbits(out, p + 5, ndc - 1);
        wbits(out, p + 10, nlcc - 4);
        p += 14;

        for (let i = 0; i < nlcc; ++i) wbits(out, p + 3 * i, lct[clim[i]]);
        p += 3 * nlcc;

        for (const clct of [lclt, lcdt]) {
            for (let i = 0; i < clct.length; ++i) {
                const len = clct[i] & 31;
                wbits(out, p, llm[len]);
                p += lct[len];
                if (len > 15) {
                    wbits(out, p, clct[i] >> 5 & 127);
                    p += clct[i] >> 12;
                }
            }
        }
    } else {
        lm = flm;
        ll = flt;
        dm = fdm;
        dl = fdt;
    }

    for (let i = 0; i < li; ++i) {
        const sym = syms[i];
        if (sym > 255) {
            const len = sym >> 18 & 31;
            wbits16(out, p, lm[len + 257]);
            p += ll[len + 257];
            if (len > 7) {
                wbits(out, p, sym >> 23 & 31);
                p += fleb[len];
            }

            const dst = sym & 31;
            wbits16(out, p, dm[dst]);
            p += dl[dst];
            if (dst > 3) {
                wbits16(out, p, sym >> 5 & 8191);
                p += fdeb[dst];
            }
        } else {
            wbits16(out, p, lm[sym]);
            p += ll[sym];
        }
    }

    wbits16(out, p, lm[256]);
    return p + ll[256];
}

// deflate options (nice << 13) | chain
const deo = u32.of(65540, 131080, 131088, 131104, 262176, 1048704, 1048832, 2114560, 2117632);

// compresses data into raw deflate, leaving pre bytes before and post bytes after the output
function deflate(dat: Uint8Array, lvl: number, plvl: number, pre: number, post: number): Uint8Array {
    const s = dat.length;
    const o = new u8(pre + s + 5 * (1 + Math.ceil(s / 7000)) + post);
    const w = o.subarray(pre, o.length - post);
    let pos = 0;

    if (!lvl || s < 8) {
        for (let i = 0; i <= s; i += 65535) {
            // end
            const e = i + 65535;
            if (e >= s) w[pos >> 3] = 1;
            pos = wfblk(w, pos + 1, dat.subarray(i, e));
        }
    } else {
        const opt = deo[lvl - 1];
        const n = opt >> 13, c = opt & 8191;
        const msk = (1 << plvl) - 1;
        // prev 2-byte val map, curr 2-byte val map
        const prev = new u16(32768), head = new u16(msk + 1);
        const bs1 = Math.ceil(plvl / 3), bs2 = 2 * bs1;
        const hsh = (i: number): number => ((dat[i] | 0) ^ (dat[i + 1] | 0) << bs1 ^ (dat[i + 2] | 0) << bs2) & msk;

        const syms = new u32(25000);
        const lf = new u16(288), df = new u16(32);
        let lcnt = 0, eb = 0, i = 0, li = 0, wi = 0, bs = 0;

        // hashes near the end read past the data, which yields zeros
        for (; i < s; ++i) {
            const hv = hsh(i);
            let imod = i & 32767, pimod = head[hv];
            prev[imod] = pimod;
            head[hv] = imod;

            if (wi <= i) {
                const rem = s - i;
                if ((lcnt > 7000 || li > 24576) && rem > 423) {
                    pos = wblk(dat, w, 0, syms, lf, df, eb, li, bs, i - bs, pos);
                    li = lcnt = eb = 0;
                    bs = i;
                    for (let j = 0; j < 286; ++j) lf[j] = 0;
                    for (let j = 0; j < 30; ++j) df[j] = 0;
                }

                // len, dist, chain
                let l = 2, d = 0, ch = c, dif = imod - pimod & 32767;
                if (rem > 2 && hv === hsh(i - dif)) {
                    const maxn = Math.min(n, rem) - 1;
                    const maxd = Math.min(32767, i);
                    // max possible length, not capped at dif because decompressors implement "rolling" index population
                    const ml = Math.min(258, rem);

                    while (dif <= maxd && --ch && imod !== pimod) {
                        if (dat[i + l] === dat[i + l - dif]) {
                            let nl = 0;
                            for (; nl < ml && dat[i + nl] === dat[i + nl - dif]; ++nl);

                            if (nl > l) {
                                l = nl;
                                d = dif;
                                // break out early when we reach "nice" (we are satisfied enough)
                                if (nl > maxn) break;

                                // now, find the rarest 2-byte sequence within this length of literals and search for that instead
                                const mmd = Math.min(dif, nl - 2);
                                let md = 0;
                                for (let j = 0; j < mmd; ++j) {
                                    const ti = i - dif + j & 32767;
                                    const pti = prev[ti];
                                    const cd = ti - pti & 32767;
                                    if (cd > md) {
                                        md = cd;
                                        pimod = ti;
                                    }
                                }
                            }
                        }

                        // check the previous match
                        imod = pimod;
                        pimod = prev[imod];
                        dif += imod - pimod & 32767;
                    }
                }

                if (d) {
                    // store both dist and len data in one int32
                    syms[li++] = 268435456 | revfl[l] << 18 | revfd[d];
                    const lin = revfl[l] & 31, din = revfd[d] & 31;
                    eb += fleb[lin] + fdeb[din];
                    ++lf[257 + lin];
                    ++df[din];
                    wi = i + l;
                    ++lcnt;
                } else {
                    syms[li++] = dat[i];
                    ++lf[dat[i]];
                }
            }
        }

        pos = wblk(dat, w, 1, syms, lf, df, eb, li, bs, i - bs, pos);
    }

    return o.subarray(0, pre + shft(pos) + post);
}

function adler32(data: Uint8Array): number {
    let a = 1, b = 0;
    for (let i = 0; i < data.length;) {
        // the sums can't overflow for 2655 bytes, then reduce them
        const e = Math.min(i + 2655, data.length);
        for (; i < e; ++i) b += a += data[i];
        a = (a & 65535) + 15 * (a >> 16);
        b = (b & 65535) + 15 * (b >> 16);
    }

    a %= 65521;
    b %= 65521;
    return (b << 16 | a) >>> 0;
}

/**
 * Compresses data into a zlib stream
 * @param level compression level 0-9
 */
export function compress(data: Uint8Array, level: number): Uint8Array {
    level = Math.min(9, Math.max(0, level | 0));
    const memory = Math.ceil(Math.max(8, Math.min(13, Math.log(data.length))) * 1.5);
    const out = deflate(data, level, memory, 2, 4);

    // zlib header with the compression level hint
    const hint = level === 0 ? 0 : level < 6 ? 1 : level === 9 ? 3 : 2;
    out[0] = 120;
    out[1] = hint << 6 | (hint ? 32 - 2 * hint : 1);

    const checksum = adler32(data);
    const end = out.length - 4;
    out[end] = checksum >>> 24;
    out[end + 1] = checksum >> 16 & 255;
    out[end + 2] = checksum >> 8 & 255;
    out[end + 3] = checksum & 255;
    return out;
}

/**
 * Decompresses a zlib stream into at most limit bytes
 */
export function decompress(data: Uint8Array, limit: number): Uint8Array {
    if ((data[0] & 15) !== 8 || data[0] >> 4 > 7 || (data[0] << 8 | data[1]) % 31)
        throw new Error('zlib: invalid header');
    if (data[1] & 32)
        throw new Error('zlib: preset dictionaries are not supported');

    return inflate(data.subarray(2), new u8(limit));
}

/**
 * Decompresses a gzip stream (its first member) into at most limit bytes
 */
export function gunzip(data: Uint8Array, limit: number): Uint8Array {
    if (data.length < 18 || data[0] !== 0x1f || data[1] !== 0x8b || data[2] !== 8) throw new Error('gzip: invalid header');
    const flags = data[3];
    let o = 10;
    if (flags & 4) o += 2 + (data[o] | data[o + 1] << 8);
    if (flags & 8) while (o < data.length && data[o++]);
    if (flags & 16) while (o < data.length && data[o++]);
    if (flags & 2) o += 2;
    // (the size of the decompressed data, modulo 2^32, ends the stream)
    const end = data.length - 4, size = (data[end] | data[end + 1] << 8 | data[end + 2] << 16 | data[end + 3] << 24) >>> 0;
    if (o > end - 4 || size > limit) throw new Error('gzip: invalid or too large');
    return inflate(data.subarray(o, end - 4), new u8(size));
}

// native zlib, accessed through feature detection with minimal local types instead of depending on DOM or Node type
// definitions: node:zlib (Node, Bun and Deno expose it through process.getBuiltinModule, without an import) is the
// fastest and honors compression levels; DecompressionStream is part of the web platform

interface NodeZlib {
    deflateSync(data: Uint8Array, options: { level: number }): Uint8Array;
    crc32?(data: Uint8Array): number;
    inflateSync(data: Uint8Array, options: { maxOutputLength: number, finishFlush: number }): Uint8Array;
    constants: { Z_SYNC_FLUSH: number };
}

interface StreamReader {
    read(): Promise<{ done: boolean, value?: Uint8Array }>;
    cancel(): Promise<void>;
}

interface Globals {
    process?: { getBuiltinModule?: (id: string) => unknown };
    CompressionStream?: new (format: 'deflate') => unknown;
    DecompressionStream?: new (format: 'deflate') => unknown;
    Blob?: new (parts: Uint8Array[]) => { stream(): { pipeThrough(transform: unknown): { getReader(): StreamReader } } };
}

const { process: runtime, CompressionStream: NativeCompression, DecompressionStream: NativeDecompression, Blob: NativeBlob } = globalThis as unknown as Globals;

export const nodeZlib = ((): NodeZlib | null => {
    try {
        return (runtime && runtime.getBuiltinModule && runtime.getBuiltinModule('node:zlib') as NodeZlib) || null;
    } catch {
        return null;
    }
})();

// plain Uint8Array view of a node Buffer
const plain = (buffer: Uint8Array): Uint8Array => new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);

/**
 * Compresses data into a zlib stream, with the runtime's native zlib when available
 * @param level compression level 0-9
 */
export async function compressAsync(data: Uint8Array, level: number): Promise<Uint8Array> {
    level = Math.min(9, Math.max(0, level | 0));
    if (nodeZlib) return plain(nodeZlib.deflateSync(data, { level }));
    // CompressionStream has a fixed level (zlib's default 6): used for levels 1-6, where it is faster than the JS
    // deflate; storing (0) and the higher levels stay with the JS one
    if (NativeCompression && NativeBlob && level >= 1 && level <= 6) {
        const reader = new NativeBlob([data]).stream().pipeThrough(new NativeCompression('deflate')).getReader();
        const parts: Uint8Array[] = [];
        let length = 0;
        for (; ;) {
            const { done, value } = await reader.read();
            if (done || !value) break;
            parts.push(value);
            length += value.length;
        }
        const out = new Uint8Array(length);
        for (let i = 0, offset = 0; i < parts.length; offset += parts[i++].length) out.set(parts[i], offset);
        return out;
    }
    return compress(data, level);
}

/**
 * Decompresses a zlib stream into at most limit bytes, using the runtime's native zlib when available
 */
export async function decompressAsync(data: Uint8Array, limit: number): Promise<Uint8Array> {
    if (nodeZlib) {
        try {
            // a sync flush tolerates truncated streams, the output limit protects against zip bombs
            return plain(nodeZlib.inflateSync(data, { maxOutputLength: limit, finishFlush: nodeZlib.constants.Z_SYNC_FLUSH }));
        } catch {
            // e.g. more data than expected, handled below
        }
    }

    if (!NativeDecompression || !NativeBlob) return decompress(data, limit);

    const out = new Uint8Array(limit);
    let offset = 0;

    const reader = new NativeBlob([data]).stream().pipeThrough(new NativeDecompression('deflate')).getReader();
    try {
        for (; ;) {
            const { done, value } = await reader.read();
            if (done || !value) break;

            out.set(value.subarray(0, Math.max(0, limit - offset)), offset);
            offset += value.length;
            // stop inflating once the expected size is reached (protects against zip bombs)
            if (offset >= limit) break;
        }
    } catch {
        // the native decoder rejects truncated streams and trailing garbage that the JS one tolerates
        return decompress(data, limit);
    } finally {
        reader.cancel().catch(() => { });
    }

    return out.subarray(0, Math.min(offset, limit));
}

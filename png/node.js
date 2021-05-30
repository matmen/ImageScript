var __defProp = Object.defineProperty;
var __markAsModule = (target) => __defProp(target, "__esModule", {value: true});
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {get: all[name], enumerable: true});
};

// ../../Users/evan/GitHub/ImageScript/png/src/png.js
__markAsModule(exports);
__export(exports, {
  decode: () => decode,
  encode: () => encode
});

// ../../Users/evan/GitHub/ImageScript/png/src/crc.js
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

// ../../Users/evan/GitHub/ImageScript/png/src/mem.js
function view(buffer, shared = false) {
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
    const ref = Array.isArray(buffer) ? buffer : view(buffer, true);
    u82.set(ref, offset);
    offset += ref.length;
  });
  return u82;
}

// ../../Users/evan/GitHub/ImageScript/png/src/zlib.js
var u8 = Uint8Array;
var u16 = Uint16Array;
var u32 = Uint32Array;
var clim = u8.of(16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15);
var fleb = u8.of(0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0, 0, 0, 0);
var fdeb = u8.of(0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13, 0, 0);
var freb = function(eb, start) {
  var b = new u16(31);
  for (var i = 0; i < 31; ++i) {
    b[i] = start += 1 << eb[i - 1];
  }
  var r = new u32(b[30]);
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
for (var i = 0; i < 32768; ++i) {
  x = (i & 43690) >>> 1 | (i & 21845) << 1;
  x = (x & 52428) >>> 2 | (x & 13107) << 2;
  x = (x & 61680) >>> 4 | (x & 3855) << 4;
  rev[i] = ((x & 65280) >>> 8 | (x & 255) << 8) >>> 1;
}
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
for (var i = 0; i < 144; ++i)
  flt[i] = 8;
for (var i = 144; i < 256; ++i)
  flt[i] = 9;
for (var i = 256; i < 280; ++i)
  flt[i] = 7;
for (var i = 280; i < 288; ++i)
  flt[i] = 8;
var fdt = new u8(32);
for (var i = 0; i < 32; ++i)
  fdt[i] = 5;
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
  var n = new (v instanceof u16 ? u16 : v instanceof u32 ? u32 : u8)(e - s);
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
      t.push({s: i, f: d[i]});
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
  t.push({s: -1, f: 25001});
  var l = t[0], r = t[1], i0 = 0, i1 = 1, i2 = 2;
  t[0] = {s: -1, f: l.f + r.f, l, r};
  while (i1 !== s - 1) {
    l = t[t[i0].f < t[i2].f ? i0++ : i2++];
    r = t[i0 !== i1 && t[i0].f < t[i2].f ? i0++ : i2++];
    t[i1++] = {s: -1, f: l.f + r.f, l, r};
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
var deo = u32.of(65540, 131080, 131088, 131104, 262176, 1048704, 1048832, 2114560, 2117632);
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
    var syms = new u32(25e3);
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
  return zlibSync(buf, {level});
}
function decompress(buf, limit) {
  try {
    return unzlibSync(buf, new Uint8Array(limit));
  } catch (err) {
    throw err.message ? err : new Error(err);
  }
}

// ../../Users/evan/GitHub/ImageScript/png/src/png.js
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
function encode(data, {text, width, height, channels, depth = 8, level = 0}) {
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
      const view3 = new DataView(chunk.buffer);
      chunk[4] = 116;
      chunk[5] = 69;
      chunk[6] = 88;
      chunk[7] = 116;
      chunk.set(kb, 8);
      chunks.push(chunk);
      chunk.set(tb, 9 + kb.length);
      view3.setUint32(0, chunk.length - 12);
      view3.setUint32(chunk.length - 4, crc32(chunk.subarray(4, chunk.length - 4)));
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
  const view2 = new DataView(array.buffer);
  view2.setUint32(8, 13);
  view2.setUint32(16, width);
  view2.setUint32(20, height);
  view2.setUint32(33, compressed.length);
  view2.setUint32(45 + offset + compressed.length, 0);
  view2.setUint32(53 + offset + compressed.length, __IEND_CRC__);
  view2.setUint32(29, crc32(new Uint8Array(array.buffer, 12, 17)));
  view2.setUint32(41 + compressed.length, crc32(new Uint8Array(array.buffer, 37, 4 + compressed.length)));
  return array;
}
function decode(array) {
  let view2 = new DataView(array.buffer, array.byteOffset, array.byteLength);
  const width = view2.getUint32(16);
  const height = view2.getUint32(20);
  const bpc = array[24];
  const pixel_type = array[25];
  let channels = {3: 1, 0: 1, 4: 2, 2: 3, 6: 4}[pixel_type];
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
  while ((type = view2.getUint32(4 + c_offset)) !== 1229278788) {
    if (type === 1229209940)
      chunks.push(array.subarray(8 + c_offset, 8 + c_offset + view2.getUint32(c_offset)));
    else if (type === 1347179589) {
      if (palette)
        throw new Error("PLTE can only occur once in an image");
      palette = new Uint32Array(view2.getUint32(c_offset));
      for (let pxlOffset = 0; pxlOffset < palette.length * 8; pxlOffset += 3)
        palette[pxlOffset / 3] = array[8 + c_offset + pxlOffset] << 24 | array[8 + c_offset + pxlOffset + 1] << 16 | array[8 + c_offset + pxlOffset + 2] << 8 | 255;
    } else if (type === 1951551059) {
      if (alphaPalette)
        throw new Error("tRNS can only occur once in an image");
      alphaPalette = new Uint8Array(view2.getUint32(c_offset));
      for (let i = 0; i < alphaPalette.length; i++)
        alphaPalette[i] = array[8 + c_offset + i];
    }
    c_offset += 4 + 4 + 4 + view2.getUint32(c_offset);
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
    const view3 = new DataView(newPixels.buffer);
    if (channels === 1) {
      for (let i = 0; i < width * height; i++) {
        const pixel = pixels[i];
        view3.setUint32(i * 4, pixel << 24 | pixel << 16 | pixel << 8 | 255, false);
      }
    } else if (channels === 2) {
      for (let i = 0; i < width * height * 2; i += 2) {
        const pixel = pixels[i];
        view3.setUint32(i * 2, pixel << 24 | pixel << 16 | pixel << 8 | pixels[i + 1], false);
      }
    } else if (channels === 3) {
      newPixels.fill(255);
      for (let i = 0; i < width * height; i++)
        newPixels.set(pixels.subarray(i * 3, i * 3 + 3), i * 4);
    }
    pixels = newPixels;
  }
  return {width, height, pixels};
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

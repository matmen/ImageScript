/*!
 * AV1 inverse transforms: DCT (4-64), ADST and flipped ADST (4-16), identity (4-32) and the Walsh-Hadamard transform
 * of lossless blocks, ported from dav1d (src/itx_1d.c, src/itx_tmpl.c). Copyright (c) 2018-2019, VideoLAN and dav1d
 * authors, Copyright (c) 2018-2019, Two Orioles, LLC, BSD-2-Clause License (see THIRD_PARTY_NOTICES.md)
 */

import { TXFM_DIMENSIONS, DCT_DCT } from './tables.ts';

/* eslint-disable prefer-const */

// the range intermediate values are clipped to, set before each pass
let lo = 0, hi = 0;
const clip = (v: number): number => v < lo ? lo : v > hi ? hi : v;

function inv_dct4_1d_internal_c(c: Int32Array, o: number, stride: number, tx64: number): void {
    const in0 = c[o + 0 * stride], in1 = c[o + 1 * stride];

    let t0: number, t1: number, t2: number, t3: number;
    if (tx64) {
        t0 = t1 = (in0 * 181 + 128) >> 8;
        t2 = (in1 * 1567 + 2048) >> 12;
        t3 = (in1 * 3784 + 2048) >> 12;
    } else {
        const in2 = c[o + 2 * stride], in3 = c[o + 3 * stride];

        t0 = ((in0 + in2) * 181 + 128) >> 8;
        t1 = ((in0 - in2) * 181 + 128) >> 8;
        t2 = ((in1 *  1567         - in3 * (3784 - 4096) + 2048) >> 12) - in3;
        t3 = ((in1 * (3784 - 4096) + in3 *  1567         + 2048) >> 12) + in1;
    }

    c[o + 0 * stride] = clip(t0 + t3);
    c[o + 1 * stride] = clip(t1 + t2);
    c[o + 2 * stride] = clip(t1 - t2);
    c[o + 3 * stride] = clip(t0 - t3);
}

function inv_dct4_1d_c(c: Int32Array, o: number, stride: number): void {
    inv_dct4_1d_internal_c(c, o, stride, 0);
}

function inv_dct8_1d_internal_c(c: Int32Array, o: number, stride: number, tx64: number): void {
    inv_dct4_1d_internal_c(c, o, stride << 1, tx64);

    const in1 = c[o + 1 * stride], in3 = c[o + 3 * stride];

    let t4a: number, t5a: number, t6a: number, t7a: number;
    if (tx64) {
        t4a = (in1 *   799 + 2048) >> 12;
        t5a = (in3 * -2276 + 2048) >> 12;
        t6a = (in3 *  3406 + 2048) >> 12;
        t7a = (in1 *  4017 + 2048) >> 12;
    } else {
        const in5 = c[o + 5 * stride], in7 = c[o + 7 * stride];

        t4a = ((in1 *   799         - in7 * (4017 - 4096) + 2048) >> 12) - in7;
        t5a =  (in5 *  1703         - in3 *  1138         + 1024) >> 11;
        t6a =  (in5 *  1138         + in3 *  1703         + 1024) >> 11;
        t7a = ((in1 * (4017 - 4096) + in7 *  799          + 2048) >> 12) + in1;
    }

    const t4  = clip(t4a + t5a);
              t5a = clip(t4a - t5a);
    const t7  = clip(t7a + t6a);
              t6a = clip(t7a - t6a);

    const t5  = ((t6a - t5a) * 181 + 128) >> 8;
    const t6  = ((t6a + t5a) * 181 + 128) >> 8;

    const t0 = c[o + 0 * stride];
    const t1 = c[o + 2 * stride];
    const t2 = c[o + 4 * stride];
    const t3 = c[o + 6 * stride];

    c[o + 0 * stride] = clip(t0 + t7);
    c[o + 1 * stride] = clip(t1 + t6);
    c[o + 2 * stride] = clip(t2 + t5);
    c[o + 3 * stride] = clip(t3 + t4);
    c[o + 4 * stride] = clip(t3 - t4);
    c[o + 5 * stride] = clip(t2 - t5);
    c[o + 6 * stride] = clip(t1 - t6);
    c[o + 7 * stride] = clip(t0 - t7);
}

function inv_dct8_1d_c(c: Int32Array, o: number, stride: number): void {
    inv_dct8_1d_internal_c(c, o, stride, 0);
}

function inv_dct16_1d_internal_c(c: Int32Array, o: number, stride: number, tx64: number): void {
    inv_dct8_1d_internal_c(c, o, stride << 1, tx64);

    const in1 = c[o + 1 * stride], in3 = c[o + 3 * stride];
    const in5 = c[o + 5 * stride], in7 = c[o + 7 * stride];

    let t8a: number, t9a: number, t10a: number, t11a: number, t12a: number, t13a: number, t14a: number, t15a: number;
    if (tx64) {
        t8a  = (in1 *   401 + 2048) >> 12;
        t9a  = (in7 * -2598 + 2048) >> 12;
        t10a = (in5 *  1931 + 2048) >> 12;
        t11a = (in3 * -1189 + 2048) >> 12;
        t12a = (in3 *  3920 + 2048) >> 12;
        t13a = (in5 *  3612 + 2048) >> 12;
        t14a = (in7 *  3166 + 2048) >> 12;
        t15a = (in1 *  4076 + 2048) >> 12;
    } else {
        const in9  = c[o +  9 * stride], in11 = c[o + 11 * stride];
        const in13 = c[o + 13 * stride], in15 = c[o + 15 * stride];

        t8a  = ((in1  *   401         - in15 * (4076 - 4096) + 2048) >> 12) - in15;
        t9a  =  (in9  *  1583         - in7  *  1299         + 1024) >> 11;
        t10a = ((in5  *  1931         - in11 * (3612 - 4096) + 2048) >> 12) - in11;
        t11a = ((in13 * (3920 - 4096) - in3  *  1189         + 2048) >> 12) + in13;
        t12a = ((in13 *  1189         + in3  * (3920 - 4096) + 2048) >> 12) + in3;
        t13a = ((in5  * (3612 - 4096) + in11 *  1931         + 2048) >> 12) + in5;
        t14a =  (in9  *  1299         + in7  *  1583         + 1024) >> 11;
        t15a = ((in1  * (4076 - 4096) + in15 *   401         + 2048) >> 12) + in1;
    }

    let t8  = clip(t8a  + t9a);
    let t9  = clip(t8a  - t9a);
    let t10 = clip(t11a - t10a);
    let t11 = clip(t11a + t10a);
    let t12 = clip(t12a + t13a);
    let t13 = clip(t12a - t13a);
    let t14 = clip(t15a - t14a);
    let t15 = clip(t15a + t14a);

    t9a  = ((  t14 *  1567         - t9  * (3784 - 4096)  + 2048) >> 12) - t9;
    t14a = ((  t14 * (3784 - 4096) + t9  *  1567          + 2048) >> 12) + t14;
    t10a = ((-(t13 * (3784 - 4096) + t10 *  1567)         + 2048) >> 12) - t13;
    t13a = ((  t13 *  1567         - t10 * (3784 - 4096)  + 2048) >> 12) - t10;

    t8a  = clip(t8   + t11);
    t9   = clip(t9a  + t10a);
    t10  = clip(t9a  - t10a);
    t11a = clip(t8   - t11);
    t12a = clip(t15  - t12);
    t13  = clip(t14a - t13a);
    t14  = clip(t14a + t13a);
    t15a = clip(t15  + t12);

    t10a = ((t13  - t10)  * 181 + 128) >> 8;
    t13a = ((t13  + t10)  * 181 + 128) >> 8;
    t11  = ((t12a - t11a) * 181 + 128) >> 8;
    t12  = ((t12a + t11a) * 181 + 128) >> 8;

    const t0 = c[o +  0 * stride];
    const t1 = c[o +  2 * stride];
    const t2 = c[o +  4 * stride];
    const t3 = c[o +  6 * stride];
    const t4 = c[o +  8 * stride];
    const t5 = c[o + 10 * stride];
    const t6 = c[o + 12 * stride];
    const t7 = c[o + 14 * stride];

    c[o +  0 * stride] = clip(t0 + t15a);
    c[o +  1 * stride] = clip(t1 + t14);
    c[o +  2 * stride] = clip(t2 + t13a);
    c[o +  3 * stride] = clip(t3 + t12);
    c[o +  4 * stride] = clip(t4 + t11);
    c[o +  5 * stride] = clip(t5 + t10a);
    c[o +  6 * stride] = clip(t6 + t9);
    c[o +  7 * stride] = clip(t7 + t8a);
    c[o +  8 * stride] = clip(t7 - t8a);
    c[o +  9 * stride] = clip(t6 - t9);
    c[o + 10 * stride] = clip(t5 - t10a);
    c[o + 11 * stride] = clip(t4 - t11);
    c[o + 12 * stride] = clip(t3 - t12);
    c[o + 13 * stride] = clip(t2 - t13a);
    c[o + 14 * stride] = clip(t1 - t14);
    c[o + 15 * stride] = clip(t0 - t15a);
}

function inv_dct16_1d_c(c: Int32Array, o: number, stride: number): void {
    inv_dct16_1d_internal_c(c, o, stride, 0);
}

function inv_dct32_1d_internal_c(c: Int32Array, o: number, stride: number, tx64: number): void {
    inv_dct16_1d_internal_c(c, o, stride << 1, tx64);

    const in1  = c[o +  1 * stride], in3  = c[o +  3 * stride];
    const in5  = c[o +  5 * stride], in7  = c[o +  7 * stride];
    const in9  = c[o +  9 * stride], in11 = c[o + 11 * stride];
    const in13 = c[o + 13 * stride], in15 = c[o + 15 * stride];

    let t16a: number, t17a: number, t18a: number, t19a: number, t20a: number, t21a: number, t22a: number, t23a: number;
    let t24a: number, t25a: number, t26a: number, t27a: number, t28a: number, t29a: number, t30a: number, t31a: number;
    if (tx64) {
        t16a = (in1  *   201 + 2048) >> 12;
        t17a = (in15 * -2751 + 2048) >> 12;
        t18a = (in9  *  1751 + 2048) >> 12;
        t19a = (in7  * -1380 + 2048) >> 12;
        t20a = (in5  *   995 + 2048) >> 12;
        t21a = (in11 * -2106 + 2048) >> 12;
        t22a = (in13 *  2440 + 2048) >> 12;
        t23a = (in3  *  -601 + 2048) >> 12;
        t24a = (in3  *  4052 + 2048) >> 12;
        t25a = (in13 *  3290 + 2048) >> 12;
        t26a = (in11 *  3513 + 2048) >> 12;
        t27a = (in5  *  3973 + 2048) >> 12;
        t28a = (in7  *  3857 + 2048) >> 12;
        t29a = (in9  *  3703 + 2048) >> 12;
        t30a = (in15 *  3035 + 2048) >> 12;
        t31a = (in1  *  4091 + 2048) >> 12;
    } else {
        const in17 = c[o + 17 * stride], in19 = c[o + 19 * stride];
        const in21 = c[o + 21 * stride], in23 = c[o + 23 * stride];
        const in25 = c[o + 25 * stride], in27 = c[o + 27 * stride];
        const in29 = c[o + 29 * stride], in31 = c[o + 31 * stride];

        t16a = ((in1  *   201         - in31 * (4091 - 4096) + 2048) >> 12) - in31;
        t17a = ((in17 * (3035 - 4096) - in15 *  2751         + 2048) >> 12) + in17;
        t18a = ((in9  *  1751         - in23 * (3703 - 4096) + 2048) >> 12) - in23;
        t19a = ((in25 * (3857 - 4096) - in7  *  1380         + 2048) >> 12) + in25;
        t20a = ((in5  *   995         - in27 * (3973 - 4096) + 2048) >> 12) - in27;
        t21a = ((in21 * (3513 - 4096) - in11 *  2106         + 2048) >> 12) + in21;
        t22a =  (in13 *  1220         - in19 *  1645         + 1024) >> 11;
        t23a = ((in29 * (4052 - 4096) - in3  *   601         + 2048) >> 12) + in29;
        t24a = ((in29 *   601         + in3  * (4052 - 4096) + 2048) >> 12) + in3;
        t25a =  (in13 *  1645         + in19 *  1220         + 1024) >> 11;
        t26a = ((in21 *  2106         + in11 * (3513 - 4096) + 2048) >> 12) + in11;
        t27a = ((in5  * (3973 - 4096) + in27 *   995         + 2048) >> 12) + in5;
        t28a = ((in25 *  1380         + in7  * (3857 - 4096) + 2048) >> 12) + in7;
        t29a = ((in9  * (3703 - 4096) + in23 *  1751         + 2048) >> 12) + in9;
        t30a = ((in17 *  2751         + in15 * (3035 - 4096) + 2048) >> 12) + in15;
        t31a = ((in1  * (4091 - 4096) + in31 *   201         + 2048) >> 12) + in1;
    }

    let t16 = clip(t16a + t17a);
    let t17 = clip(t16a - t17a);
    let t18 = clip(t19a - t18a);
    let t19 = clip(t19a + t18a);
    let t20 = clip(t20a + t21a);
    let t21 = clip(t20a - t21a);
    let t22 = clip(t23a - t22a);
    let t23 = clip(t23a + t22a);
    let t24 = clip(t24a + t25a);
    let t25 = clip(t24a - t25a);
    let t26 = clip(t27a - t26a);
    let t27 = clip(t27a + t26a);
    let t28 = clip(t28a + t29a);
    let t29 = clip(t28a - t29a);
    let t30 = clip(t31a - t30a);
    let t31 = clip(t31a + t30a);

    t17a = ((  t30 *   799         - t17 * (4017 - 4096)  + 2048) >> 12) - t17;
    t30a = ((  t30 * (4017 - 4096) + t17 *   799          + 2048) >> 12) + t30;
    t18a = ((-(t29 * (4017 - 4096) + t18 *   799)         + 2048) >> 12) - t29;
    t29a = ((  t29 *   799         - t18 * (4017 - 4096)  + 2048) >> 12) - t18;
    t21a =  (  t26 *  1703         - t21 *  1138          + 1024) >> 11;
    t26a =  (  t26 *  1138         + t21 *  1703          + 1024) >> 11;
    t22a =  (-(t25 *  1138         + t22 *  1703        ) + 1024) >> 11;
    t25a =  (  t25 *  1703         - t22 *  1138          + 1024) >> 11;

    t16a = clip(t16  + t19);
    t17  = clip(t17a + t18a);
    t18  = clip(t17a - t18a);
    t19a = clip(t16  - t19);
    t20a = clip(t23  - t20);
    t21  = clip(t22a - t21a);
    t22  = clip(t22a + t21a);
    t23a = clip(t23  + t20);
    t24a = clip(t24  + t27);
    t25  = clip(t25a + t26a);
    t26  = clip(t25a - t26a);
    t27a = clip(t24  - t27);
    t28a = clip(t31  - t28);
    t29  = clip(t30a - t29a);
    t30  = clip(t30a + t29a);
    t31a = clip(t31  + t28);

    t18a = ((  t29  *  1567         - t18  * (3784 - 4096)  + 2048) >> 12) - t18;
    t29a = ((  t29  * (3784 - 4096) + t18  *  1567          + 2048) >> 12) + t29;
    t19  = ((  t28a *  1567         - t19a * (3784 - 4096)  + 2048) >> 12) - t19a;
    t28  = ((  t28a * (3784 - 4096) + t19a *  1567          + 2048) >> 12) + t28a;
    t20  = ((-(t27a * (3784 - 4096) + t20a *  1567)         + 2048) >> 12) - t27a;
    t27  = ((  t27a *  1567         - t20a * (3784 - 4096)  + 2048) >> 12) - t20a;
    t21a = ((-(t26  * (3784 - 4096) + t21  *  1567)         + 2048) >> 12) - t26;
    t26a = ((  t26  *  1567         - t21  * (3784 - 4096)  + 2048) >> 12) - t21;

    t16  = clip(t16a + t23a);
    t17a = clip(t17  + t22);
    t18  = clip(t18a + t21a);
    t19a = clip(t19  + t20);
    t20a = clip(t19  - t20);
    t21  = clip(t18a - t21a);
    t22a = clip(t17  - t22);
    t23  = clip(t16a - t23a);
    t24  = clip(t31a - t24a);
    t25a = clip(t30  - t25);
    t26  = clip(t29a - t26a);
    t27a = clip(t28  - t27);
    t28a = clip(t28  + t27);
    t29  = clip(t29a + t26a);
    t30a = clip(t30  + t25);
    t31  = clip(t31a + t24a);

    t20  = ((t27a - t20a) * 181 + 128) >> 8;
    t27  = ((t27a + t20a) * 181 + 128) >> 8;
    t21a = ((t26  - t21 ) * 181 + 128) >> 8;
    t26a = ((t26  + t21 ) * 181 + 128) >> 8;
    t22  = ((t25a - t22a) * 181 + 128) >> 8;
    t25  = ((t25a + t22a) * 181 + 128) >> 8;
    t23a = ((t24  - t23 ) * 181 + 128) >> 8;
    t24a = ((t24  + t23 ) * 181 + 128) >> 8;

    const t0  = c[o +  0 * stride];
    const t1  = c[o +  2 * stride];
    const t2  = c[o +  4 * stride];
    const t3  = c[o +  6 * stride];
    const t4  = c[o +  8 * stride];
    const t5  = c[o + 10 * stride];
    const t6  = c[o + 12 * stride];
    const t7  = c[o + 14 * stride];
    const t8  = c[o + 16 * stride];
    const t9  = c[o + 18 * stride];
    const t10 = c[o + 20 * stride];
    const t11 = c[o + 22 * stride];
    const t12 = c[o + 24 * stride];
    const t13 = c[o + 26 * stride];
    const t14 = c[o + 28 * stride];
    const t15 = c[o + 30 * stride];

    c[o +  0 * stride] = clip(t0  + t31);
    c[o +  1 * stride] = clip(t1  + t30a);
    c[o +  2 * stride] = clip(t2  + t29);
    c[o +  3 * stride] = clip(t3  + t28a);
    c[o +  4 * stride] = clip(t4  + t27);
    c[o +  5 * stride] = clip(t5  + t26a);
    c[o +  6 * stride] = clip(t6  + t25);
    c[o +  7 * stride] = clip(t7  + t24a);
    c[o +  8 * stride] = clip(t8  + t23a);
    c[o +  9 * stride] = clip(t9  + t22);
    c[o + 10 * stride] = clip(t10 + t21a);
    c[o + 11 * stride] = clip(t11 + t20);
    c[o + 12 * stride] = clip(t12 + t19a);
    c[o + 13 * stride] = clip(t13 + t18);
    c[o + 14 * stride] = clip(t14 + t17a);
    c[o + 15 * stride] = clip(t15 + t16);
    c[o + 16 * stride] = clip(t15 - t16);
    c[o + 17 * stride] = clip(t14 - t17a);
    c[o + 18 * stride] = clip(t13 - t18);
    c[o + 19 * stride] = clip(t12 - t19a);
    c[o + 20 * stride] = clip(t11 - t20);
    c[o + 21 * stride] = clip(t10 - t21a);
    c[o + 22 * stride] = clip(t9  - t22);
    c[o + 23 * stride] = clip(t8  - t23a);
    c[o + 24 * stride] = clip(t7  - t24a);
    c[o + 25 * stride] = clip(t6  - t25);
    c[o + 26 * stride] = clip(t5  - t26a);
    c[o + 27 * stride] = clip(t4  - t27);
    c[o + 28 * stride] = clip(t3  - t28a);
    c[o + 29 * stride] = clip(t2  - t29);
    c[o + 30 * stride] = clip(t1  - t30a);
    c[o + 31 * stride] = clip(t0  - t31);
}

function inv_dct32_1d_c(c: Int32Array, o: number, stride: number): void {
    inv_dct32_1d_internal_c(c, o, stride, 0);
}

function inv_dct64_1d_c(c: Int32Array, o: number, stride: number): void {
    inv_dct32_1d_internal_c(c, o, stride << 1, 1);

    const in1  = c[o +  1 * stride], in3  = c[o +  3 * stride];
    const in5  = c[o +  5 * stride], in7  = c[o +  7 * stride];
    const in9  = c[o +  9 * stride], in11 = c[o + 11 * stride];
    const in13 = c[o + 13 * stride], in15 = c[o + 15 * stride];
    const in17 = c[o + 17 * stride], in19 = c[o + 19 * stride];
    const in21 = c[o + 21 * stride], in23 = c[o + 23 * stride];
    const in25 = c[o + 25 * stride], in27 = c[o + 27 * stride];
    const in29 = c[o + 29 * stride], in31 = c[o + 31 * stride];

    let t32a = (in1  *   101 + 2048) >> 12;
    let t33a = (in31 * -2824 + 2048) >> 12;
    let t34a = (in17 *  1660 + 2048) >> 12;
    let t35a = (in15 * -1474 + 2048) >> 12;
    let t36a = (in9  *   897 + 2048) >> 12;
    let t37a = (in23 * -2191 + 2048) >> 12;
    let t38a = (in25 *  2359 + 2048) >> 12;
    let t39a = (in7  *  -700 + 2048) >> 12;
    let t40a = (in5  *   501 + 2048) >> 12;
    let t41a = (in27 * -2520 + 2048) >> 12;
    let t42a = (in21 *  2019 + 2048) >> 12;
    let t43a = (in11 * -1092 + 2048) >> 12;
    let t44a = (in13 *  1285 + 2048) >> 12;
    let t45a = (in19 * -1842 + 2048) >> 12;
    let t46a = (in29 *  2675 + 2048) >> 12;
    let t47a = (in3  *  -301 + 2048) >> 12;
    let t48a = (in3  *  4085 + 2048) >> 12;
    let t49a = (in29 *  3102 + 2048) >> 12;
    let t50a = (in19 *  3659 + 2048) >> 12;
    let t51a = (in13 *  3889 + 2048) >> 12;
    let t52a = (in11 *  3948 + 2048) >> 12;
    let t53a = (in21 *  3564 + 2048) >> 12;
    let t54a = (in27 *  3229 + 2048) >> 12;
    let t55a = (in5  *  4065 + 2048) >> 12;
    let t56a = (in7  *  4036 + 2048) >> 12;
    let t57a = (in25 *  3349 + 2048) >> 12;
    let t58a = (in23 *  3461 + 2048) >> 12;
    let t59a = (in9  *  3996 + 2048) >> 12;
    let t60a = (in15 *  3822 + 2048) >> 12;
    let t61a = (in17 *  3745 + 2048) >> 12;
    let t62a = (in31 *  2967 + 2048) >> 12;
    let t63a = (in1  *  4095 + 2048) >> 12;

    let t32 = clip(t32a + t33a);
    let t33 = clip(t32a - t33a);
    let t34 = clip(t35a - t34a);
    let t35 = clip(t35a + t34a);
    let t36 = clip(t36a + t37a);
    let t37 = clip(t36a - t37a);
    let t38 = clip(t39a - t38a);
    let t39 = clip(t39a + t38a);
    let t40 = clip(t40a + t41a);
    let t41 = clip(t40a - t41a);
    let t42 = clip(t43a - t42a);
    let t43 = clip(t43a + t42a);
    let t44 = clip(t44a + t45a);
    let t45 = clip(t44a - t45a);
    let t46 = clip(t47a - t46a);
    let t47 = clip(t47a + t46a);
    let t48 = clip(t48a + t49a);
    let t49 = clip(t48a - t49a);
    let t50 = clip(t51a - t50a);
    let t51 = clip(t51a + t50a);
    let t52 = clip(t52a + t53a);
    let t53 = clip(t52a - t53a);
    let t54 = clip(t55a - t54a);
    let t55 = clip(t55a + t54a);
    let t56 = clip(t56a + t57a);
    let t57 = clip(t56a - t57a);
    let t58 = clip(t59a - t58a);
    let t59 = clip(t59a + t58a);
    let t60 = clip(t60a + t61a);
    let t61 = clip(t60a - t61a);
    let t62 = clip(t63a - t62a);
    let t63 = clip(t63a + t62a);

    t33a = ((t33 * (4096 - 4076) + t62 *   401         + 2048) >> 12) - t33;
    t34a = ((t34 *  -401         + t61 * (4096 - 4076) + 2048) >> 12) - t61;
    t37a =  (t37 * -1299         + t58 *  1583         + 1024) >> 11;
    t38a =  (t38 * -1583         + t57 * -1299         + 1024) >> 11;
    t41a = ((t41 * (4096 - 3612) + t54 *  1931         + 2048) >> 12) - t41;
    t42a = ((t42 * -1931         + t53 * (4096 - 3612) + 2048) >> 12) - t53;
    t45a = ((t45 * -1189         + t50 * (3920 - 4096) + 2048) >> 12) + t50;
    t46a = ((t46 * (4096 - 3920) + t49 * -1189         + 2048) >> 12) - t46;
    t49a = ((t46 * -1189         + t49 * (3920 - 4096) + 2048) >> 12) + t49;
    t50a = ((t45 * (3920 - 4096) + t50 *  1189         + 2048) >> 12) + t45;
    t53a = ((t42 * (4096 - 3612) + t53 *  1931         + 2048) >> 12) - t42;
    t54a = ((t41 *  1931         + t54 * (3612 - 4096) + 2048) >> 12) + t54;
    t57a =  (t38 * -1299         + t57 *  1583         + 1024) >> 11;
    t58a =  (t37 *  1583         + t58 *  1299         + 1024) >> 11;
    t61a = ((t34 * (4096 - 4076) + t61 *   401         + 2048) >> 12) - t34;
    t62a = ((t33 *   401         + t62 * (4076 - 4096) + 2048) >> 12) + t62;

    t32a = clip(t32  + t35);
    t33  = clip(t33a + t34a);
    t34  = clip(t33a - t34a);
    t35a = clip(t32  - t35);
    t36a = clip(t39  - t36);
    t37  = clip(t38a - t37a);
    t38  = clip(t38a + t37a);
    t39a = clip(t39  + t36);
    t40a = clip(t40  + t43);
    t41  = clip(t41a + t42a);
    t42  = clip(t41a - t42a);
    t43a = clip(t40  - t43);
    t44a = clip(t47  - t44);
    t45  = clip(t46a - t45a);
    t46  = clip(t46a + t45a);
    t47a = clip(t47  + t44);
    t48a = clip(t48  + t51);
    t49  = clip(t49a + t50a);
    t50  = clip(t49a - t50a);
    t51a = clip(t48  - t51);
    t52a = clip(t55  - t52);
    t53  = clip(t54a - t53a);
    t54  = clip(t54a + t53a);
    t55a = clip(t55  + t52);
    t56a = clip(t56  + t59);
    t57  = clip(t57a + t58a);
    t58  = clip(t57a - t58a);
    t59a = clip(t56  - t59);
    t60a = clip(t63  - t60);
    t61  = clip(t62a - t61a);
    t62  = clip(t62a + t61a);
    t63a = clip(t63  + t60);

    t34a = ((t34  * (4096 - 4017) + t61  *   799         + 2048) >> 12) - t34;
    t35  = ((t35a * (4096 - 4017) + t60a *   799         + 2048) >> 12) - t35a;
    t36  = ((t36a *  -799         + t59a * (4096 - 4017) + 2048) >> 12) - t59a;
    t37a = ((t37  *  -799         + t58  * (4096 - 4017) + 2048) >> 12) - t58;
    t42a =  (t42  * -1138         + t53  *  1703         + 1024) >> 11;
    t43  =  (t43a * -1138         + t52a *  1703         + 1024) >> 11;
    t44  =  (t44a * -1703         + t51a * -1138         + 1024) >> 11;
    t45a =  (t45  * -1703         + t50  * -1138         + 1024) >> 11;
    t50a =  (t45  * -1138         + t50  *  1703         + 1024) >> 11;
    t51  =  (t44a * -1138         + t51a *  1703         + 1024) >> 11;
    t52  =  (t43a *  1703         + t52a *  1138         + 1024) >> 11;
    t53a =  (t42  *  1703         + t53  *  1138         + 1024) >> 11;
    t58a = ((t37  * (4096 - 4017) + t58  *   799         + 2048) >> 12) - t37;
    t59  = ((t36a * (4096 - 4017) + t59a *   799         + 2048) >> 12) - t36a;
    t60  = ((t35a *   799         + t60a * (4017 - 4096) + 2048) >> 12) + t60a;
    t61a = ((t34  *   799         + t61  * (4017 - 4096) + 2048) >> 12) + t61;

    t32  = clip(t32a + t39a);
    t33a = clip(t33  + t38);
    t34  = clip(t34a + t37a);
    t35a = clip(t35  + t36);
    t36a = clip(t35  - t36);
    t37  = clip(t34a - t37a);
    t38a = clip(t33  - t38);
    t39  = clip(t32a - t39a);
    t40  = clip(t47a - t40a);
    t41a = clip(t46  - t41);
    t42  = clip(t45a - t42a);
    t43a = clip(t44  - t43);
    t44a = clip(t44  + t43);
    t45  = clip(t45a + t42a);
    t46a = clip(t46  + t41);
    t47  = clip(t47a + t40a);
    t48  = clip(t48a + t55a);
    t49a = clip(t49  + t54);
    t50  = clip(t50a + t53a);
    t51a = clip(t51  + t52);
    t52a = clip(t51  - t52);
    t53  = clip(t50a - t53a);
    t54a = clip(t49  - t54);
    t55  = clip(t48a - t55a);
    t56  = clip(t63a - t56a);
    t57a = clip(t62  - t57);
    t58  = clip(t61a - t58a);
    t59a = clip(t60  - t59);
    t60a = clip(t60  + t59);
    t61  = clip(t61a + t58a);
    t62a = clip(t62  + t57);
    t63  = clip(t63a + t56a);

    t36  = ((t36a * (4096 - 3784) + t59a *  1567         + 2048) >> 12) - t36a;
    t37a = ((t37  * (4096 - 3784) + t58  *  1567         + 2048) >> 12) - t37;
    t38  = ((t38a * (4096 - 3784) + t57a *  1567         + 2048) >> 12) - t38a;
    t39a = ((t39  * (4096 - 3784) + t56  *  1567         + 2048) >> 12) - t39;
    t40a = ((t40  * -1567         + t55  * (4096 - 3784) + 2048) >> 12) - t55;
    t41  = ((t41a * -1567         + t54a * (4096 - 3784) + 2048) >> 12) - t54a;
    t42a = ((t42  * -1567         + t53  * (4096 - 3784) + 2048) >> 12) - t53;
    t43  = ((t43a * -1567         + t52a * (4096 - 3784) + 2048) >> 12) - t52a;
    t52  = ((t43a * (4096 - 3784) + t52a *  1567         + 2048) >> 12) - t43a;
    t53a = ((t42  * (4096 - 3784) + t53  *  1567         + 2048) >> 12) - t42;
    t54  = ((t41a * (4096 - 3784) + t54a *  1567         + 2048) >> 12) - t41a;
    t55a = ((t40  * (4096 - 3784) + t55  *  1567         + 2048) >> 12) - t40;
    t56a = ((t39  *  1567         + t56  * (3784 - 4096) + 2048) >> 12) + t56;
    t57  = ((t38a *  1567         + t57a * (3784 - 4096) + 2048) >> 12) + t57a;
    t58a = ((t37  *  1567         + t58  * (3784 - 4096) + 2048) >> 12) + t58;
    t59  = ((t36a *  1567         + t59a * (3784 - 4096) + 2048) >> 12) + t59a;

    t32a = clip(t32  + t47);
    t33  = clip(t33a + t46a);
    t34a = clip(t34  + t45);
    t35  = clip(t35a + t44a);
    t36a = clip(t36  + t43);
    t37  = clip(t37a + t42a);
    t38a = clip(t38  + t41);
    t39  = clip(t39a + t40a);
    t40  = clip(t39a - t40a);
    t41a = clip(t38  - t41);
    t42  = clip(t37a - t42a);
    t43a = clip(t36  - t43);
    t44  = clip(t35a - t44a);
    t45a = clip(t34  - t45);
    t46  = clip(t33a - t46a);
    t47a = clip(t32  - t47);
    t48a = clip(t63  - t48);
    t49  = clip(t62a - t49a);
    t50a = clip(t61  - t50);
    t51  = clip(t60a - t51a);
    t52a = clip(t59  - t52);
    t53  = clip(t58a - t53a);
    t54a = clip(t57  - t54);
    t55  = clip(t56a - t55a);
    t56  = clip(t56a + t55a);
    t57a = clip(t57  + t54);
    t58  = clip(t58a + t53a);
    t59a = clip(t59  + t52);
    t60  = clip(t60a + t51a);
    t61a = clip(t61  + t50);
    t62  = clip(t62a + t49a);
    t63a = clip(t63  + t48);

    t40a = ((t55  - t40 ) * 181 + 128) >> 8;
    t41  = ((t54a - t41a) * 181 + 128) >> 8;
    t42a = ((t53  - t42 ) * 181 + 128) >> 8;
    t43  = ((t52a - t43a) * 181 + 128) >> 8;
    t44a = ((t51  - t44 ) * 181 + 128) >> 8;
    t45  = ((t50a - t45a) * 181 + 128) >> 8;
    t46a = ((t49  - t46 ) * 181 + 128) >> 8;
    t47  = ((t48a - t47a) * 181 + 128) >> 8;
    t48  = ((t47a + t48a) * 181 + 128) >> 8;
    t49a = ((t46  + t49 ) * 181 + 128) >> 8;
    t50  = ((t45a + t50a) * 181 + 128) >> 8;
    t51a = ((t44  + t51 ) * 181 + 128) >> 8;
    t52  = ((t43a + t52a) * 181 + 128) >> 8;
    t53a = ((t42  + t53 ) * 181 + 128) >> 8;
    t54  = ((t41a + t54a) * 181 + 128) >> 8;
    t55a = ((t40  + t55 ) * 181 + 128) >> 8;

    const t0  = c[o +  0 * stride];
    const t1  = c[o +  2 * stride];
    const t2  = c[o +  4 * stride];
    const t3  = c[o +  6 * stride];
    const t4  = c[o +  8 * stride];
    const t5  = c[o + 10 * stride];
    const t6  = c[o + 12 * stride];
    const t7  = c[o + 14 * stride];
    const t8  = c[o + 16 * stride];
    const t9  = c[o + 18 * stride];
    const t10 = c[o + 20 * stride];
    const t11 = c[o + 22 * stride];
    const t12 = c[o + 24 * stride];
    const t13 = c[o + 26 * stride];
    const t14 = c[o + 28 * stride];
    const t15 = c[o + 30 * stride];
    const t16 = c[o + 32 * stride];
    const t17 = c[o + 34 * stride];
    const t18 = c[o + 36 * stride];
    const t19 = c[o + 38 * stride];
    const t20 = c[o + 40 * stride];
    const t21 = c[o + 42 * stride];
    const t22 = c[o + 44 * stride];
    const t23 = c[o + 46 * stride];
    const t24 = c[o + 48 * stride];
    const t25 = c[o + 50 * stride];
    const t26 = c[o + 52 * stride];
    const t27 = c[o + 54 * stride];
    const t28 = c[o + 56 * stride];
    const t29 = c[o + 58 * stride];
    const t30 = c[o + 60 * stride];
    const t31 = c[o + 62 * stride];

    c[o +  0 * stride] = clip(t0  + t63a);
    c[o +  1 * stride] = clip(t1  + t62);
    c[o +  2 * stride] = clip(t2  + t61a);
    c[o +  3 * stride] = clip(t3  + t60);
    c[o +  4 * stride] = clip(t4  + t59a);
    c[o +  5 * stride] = clip(t5  + t58);
    c[o +  6 * stride] = clip(t6  + t57a);
    c[o +  7 * stride] = clip(t7  + t56);
    c[o +  8 * stride] = clip(t8  + t55a);
    c[o +  9 * stride] = clip(t9  + t54);
    c[o + 10 * stride] = clip(t10 + t53a);
    c[o + 11 * stride] = clip(t11 + t52);
    c[o + 12 * stride] = clip(t12 + t51a);
    c[o + 13 * stride] = clip(t13 + t50);
    c[o + 14 * stride] = clip(t14 + t49a);
    c[o + 15 * stride] = clip(t15 + t48);
    c[o + 16 * stride] = clip(t16 + t47);
    c[o + 17 * stride] = clip(t17 + t46a);
    c[o + 18 * stride] = clip(t18 + t45);
    c[o + 19 * stride] = clip(t19 + t44a);
    c[o + 20 * stride] = clip(t20 + t43);
    c[o + 21 * stride] = clip(t21 + t42a);
    c[o + 22 * stride] = clip(t22 + t41);
    c[o + 23 * stride] = clip(t23 + t40a);
    c[o + 24 * stride] = clip(t24 + t39);
    c[o + 25 * stride] = clip(t25 + t38a);
    c[o + 26 * stride] = clip(t26 + t37);
    c[o + 27 * stride] = clip(t27 + t36a);
    c[o + 28 * stride] = clip(t28 + t35);
    c[o + 29 * stride] = clip(t29 + t34a);
    c[o + 30 * stride] = clip(t30 + t33);
    c[o + 31 * stride] = clip(t31 + t32a);
    c[o + 32 * stride] = clip(t31 - t32a);
    c[o + 33 * stride] = clip(t30 - t33);
    c[o + 34 * stride] = clip(t29 - t34a);
    c[o + 35 * stride] = clip(t28 - t35);
    c[o + 36 * stride] = clip(t27 - t36a);
    c[o + 37 * stride] = clip(t26 - t37);
    c[o + 38 * stride] = clip(t25 - t38a);
    c[o + 39 * stride] = clip(t24 - t39);
    c[o + 40 * stride] = clip(t23 - t40a);
    c[o + 41 * stride] = clip(t22 - t41);
    c[o + 42 * stride] = clip(t21 - t42a);
    c[o + 43 * stride] = clip(t20 - t43);
    c[o + 44 * stride] = clip(t19 - t44a);
    c[o + 45 * stride] = clip(t18 - t45);
    c[o + 46 * stride] = clip(t17 - t46a);
    c[o + 47 * stride] = clip(t16 - t47);
    c[o + 48 * stride] = clip(t15 - t48);
    c[o + 49 * stride] = clip(t14 - t49a);
    c[o + 50 * stride] = clip(t13 - t50);
    c[o + 51 * stride] = clip(t12 - t51a);
    c[o + 52 * stride] = clip(t11 - t52);
    c[o + 53 * stride] = clip(t10 - t53a);
    c[o + 54 * stride] = clip(t9  - t54);
    c[o + 55 * stride] = clip(t8  - t55a);
    c[o + 56 * stride] = clip(t7  - t56);
    c[o + 57 * stride] = clip(t6  - t57a);
    c[o + 58 * stride] = clip(t5  - t58);
    c[o + 59 * stride] = clip(t4  - t59a);
    c[o + 60 * stride] = clip(t3  - t60);
    c[o + 61 * stride] = clip(t2  - t61a);
    c[o + 62 * stride] = clip(t1  - t62);
    c[o + 63 * stride] = clip(t0  - t63a);
}

function inv_adst4_1d_internal_c(inp: Int32Array, io: number, in_s: number, out: Int32Array, oo: number, out_s: number): void {
    const in0 = inp[io + 0 * in_s], in1 = inp[io + 1 * in_s];
    const in2 = inp[io + 2 * in_s], in3 = inp[io + 3 * in_s];

    out[oo + 0 * out_s] = (( 1321         * in0 + (3803 - 4096) * in2 +
                       (2482 - 4096) * in3 + (3344 - 4096) * in1 + 2048) >> 12) +
                     in2 + in3 + in1;
    out[oo + 1 * out_s] = (((2482 - 4096) * in0 -  1321         * in2 -
                       (3803 - 4096) * in3 + (3344 - 4096) * in1 + 2048) >> 12) +
                     in0 - in3 + in1;
    out[oo + 2 * out_s] = (209 * (in0 - in2 + in3) + 128) >> 8;
    out[oo + 3 * out_s] = (((3803 - 4096) * in0 + (2482 - 4096) * in2 -
                        1321         * in3 - (3344 - 4096) * in1 + 2048) >> 12) +
                     in0 + in2 - in1;
}

function inv_adst8_1d_internal_c(inp: Int32Array, io: number, in_s: number, out: Int32Array, oo: number, out_s: number): void {
    const in0 = inp[io + 0 * in_s], in1 = inp[io + 1 * in_s];
    const in2 = inp[io + 2 * in_s], in3 = inp[io + 3 * in_s];
    const in4 = inp[io + 4 * in_s], in5 = inp[io + 5 * in_s];
    const in6 = inp[io + 6 * in_s], in7 = inp[io + 7 * in_s];

    const t0a = (((4076 - 4096) * in7 +   401         * in0 + 2048) >> 12) + in7;
    const t1a = ((  401         * in7 - (4076 - 4096) * in0 + 2048) >> 12) - in0;
    const t2a = (((3612 - 4096) * in5 +  1931         * in2 + 2048) >> 12) + in5;
    const t3a = (( 1931         * in5 - (3612 - 4096) * in2 + 2048) >> 12) - in2;
    let t4a =  ( 1299         * in3 +  1583         * in4 + 1024) >> 11;
    let t5a =  ( 1583         * in3 -  1299         * in4 + 1024) >> 11;
    let t6a = (( 1189         * in1 + (3920 - 4096) * in6 + 2048) >> 12) + in6;
    let t7a = (((3920 - 4096) * in1 -  1189         * in6 + 2048) >> 12) + in1;

    const t0 = clip(t0a + t4a);
    const t1 = clip(t1a + t5a);
    let t2 = clip(t2a + t6a);
    let t3 = clip(t3a + t7a);
    const t4 = clip(t0a - t4a);
    const t5 = clip(t1a - t5a);
    let t6 = clip(t2a - t6a);
    let t7 = clip(t3a - t7a);

    t4a = (((3784 - 4096) * t4 +  1567         * t5 + 2048) >> 12) + t4;
    t5a = (( 1567         * t4 - (3784 - 4096) * t5 + 2048) >> 12) - t5;
    t6a = (((3784 - 4096) * t7 -  1567         * t6 + 2048) >> 12) + t7;
    t7a = (( 1567         * t7 + (3784 - 4096) * t6 + 2048) >> 12) + t6;

    out[oo + 0 * out_s] =  clip(t0  + t2 );
    out[oo + 7 * out_s] = -clip(t1  + t3 );
    t2             =  clip(t0  - t2 );
    t3             =  clip(t1  - t3 );
    out[oo + 1 * out_s] = -clip(t4a + t6a);
    out[oo + 6 * out_s] =  clip(t5a + t7a);
    t6             =  clip(t4a - t6a);
    t7             =  clip(t5a - t7a);

    out[oo + 3 * out_s] = -(((t2 + t3) * 181 + 128) >> 8);
    out[oo + 4 * out_s] =   ((t2 - t3) * 181 + 128) >> 8;
    out[oo + 2 * out_s] =   ((t6 + t7) * 181 + 128) >> 8;
    out[oo + 5 * out_s] = -(((t6 - t7) * 181 + 128) >> 8);
}

function inv_adst16_1d_internal_c(inp: Int32Array, io: number, in_s: number, out: Int32Array, oo: number, out_s: number): void {
    const in0  = inp[io +  0 * in_s], in1  = inp[io +  1 * in_s];
    const in2  = inp[io +  2 * in_s], in3  = inp[io +  3 * in_s];
    const in4  = inp[io +  4 * in_s], in5  = inp[io +  5 * in_s];
    const in6  = inp[io +  6 * in_s], in7  = inp[io +  7 * in_s];
    const in8  = inp[io +  8 * in_s], in9  = inp[io +  9 * in_s];
    const in10 = inp[io + 10 * in_s], in11 = inp[io + 11 * in_s];
    const in12 = inp[io + 12 * in_s], in13 = inp[io + 13 * in_s];
    const in14 = inp[io + 14 * in_s], in15 = inp[io + 15 * in_s];

    let t0  = ((in15 * (4091 - 4096) + in0  *   201         + 2048) >> 12) + in15;
    let t1  = ((in15 *   201         - in0  * (4091 - 4096) + 2048) >> 12) - in0;
    let t2  = ((in13 * (3973 - 4096) + in2  *   995         + 2048) >> 12) + in13;
    let t3  = ((in13 *   995         - in2  * (3973 - 4096) + 2048) >> 12) - in2;
    let t4  = ((in11 * (3703 - 4096) + in4  *  1751         + 2048) >> 12) + in11;
    let t5  = ((in11 *  1751         - in4  * (3703 - 4096) + 2048) >> 12) - in4;
    let t6  =  (in9  *  1645         + in6  *  1220         + 1024) >> 11;
    let t7  =  (in9  *  1220         - in6  *  1645         + 1024) >> 11;
    let t8  = ((in7  *  2751         + in8  * (3035 - 4096) + 2048) >> 12) + in8;
    let t9  = ((in7  * (3035 - 4096) - in8  *  2751         + 2048) >> 12) + in7;
    let t10 = ((in5  *  2106         + in10 * (3513 - 4096) + 2048) >> 12) + in10;
    let t11 = ((in5  * (3513 - 4096) - in10 *  2106         + 2048) >> 12) + in5;
    let t12 = ((in3  *  1380         + in12 * (3857 - 4096) + 2048) >> 12) + in12;
    let t13 = ((in3  * (3857 - 4096) - in12 *  1380         + 2048) >> 12) + in3;
    let t14 = ((in1  *   601         + in14 * (4052 - 4096) + 2048) >> 12) + in14;
    let t15 = ((in1  * (4052 - 4096) - in14 *   601         + 2048) >> 12) + in1;

    let t0a  = clip(t0 + t8 );
    let t1a  = clip(t1 + t9 );
    let t2a  = clip(t2 + t10);
    let t3a  = clip(t3 + t11);
    let t4a  = clip(t4 + t12);
    let t5a  = clip(t5 + t13);
    let t6a  = clip(t6 + t14);
    let t7a  = clip(t7 + t15);
    let t8a  = clip(t0 - t8 );
    let t9a  = clip(t1 - t9 );
    let t10a = clip(t2 - t10);
    let t11a = clip(t3 - t11);
    let t12a = clip(t4 - t12);
    let t13a = clip(t5 - t13);
    let t14a = clip(t6 - t14);
    let t15a = clip(t7 - t15);

    t8   = ((t8a  * (4017 - 4096) + t9a  *   799         + 2048) >> 12) + t8a;
    t9   = ((t8a  *   799         - t9a  * (4017 - 4096) + 2048) >> 12) - t9a;
    t10  = ((t10a *  2276         + t11a * (3406 - 4096) + 2048) >> 12) + t11a;
    t11  = ((t10a * (3406 - 4096) - t11a *  2276         + 2048) >> 12) + t10a;
    t12  = ((t13a * (4017 - 4096) - t12a *   799         + 2048) >> 12) + t13a;
    t13  = ((t13a *   799         + t12a * (4017 - 4096) + 2048) >> 12) + t12a;
    t14  = ((t15a *  2276         - t14a * (3406 - 4096) + 2048) >> 12) - t14a;
    t15  = ((t15a * (3406 - 4096) + t14a *  2276         + 2048) >> 12) + t15a;

    t0   = clip(t0a + t4a);
    t1   = clip(t1a + t5a);
    t2   = clip(t2a + t6a);
    t3   = clip(t3a + t7a);
    t4   = clip(t0a - t4a);
    t5   = clip(t1a - t5a);
    t6   = clip(t2a - t6a);
    t7   = clip(t3a - t7a);
    t8a  = clip(t8  + t12);
    t9a  = clip(t9  + t13);
    t10a = clip(t10 + t14);
    t11a = clip(t11 + t15);
    t12a = clip(t8  - t12);
    t13a = clip(t9  - t13);
    t14a = clip(t10 - t14);
    t15a = clip(t11 - t15);

    t4a  = ((t4   * (3784 - 4096) + t5   *  1567         + 2048) >> 12) + t4;
    t5a  = ((t4   *  1567         - t5   * (3784 - 4096) + 2048) >> 12) - t5;
    t6a  = ((t7   * (3784 - 4096) - t6   *  1567         + 2048) >> 12) + t7;
    t7a  = ((t7   *  1567         + t6   * (3784 - 4096) + 2048) >> 12) + t6;
    t12  = ((t12a * (3784 - 4096) + t13a *  1567         + 2048) >> 12) + t12a;
    t13  = ((t12a *  1567         - t13a * (3784 - 4096) + 2048) >> 12) - t13a;
    t14  = ((t15a * (3784 - 4096) - t14a *  1567         + 2048) >> 12) + t15a;
    t15  = ((t15a *  1567         + t14a * (3784 - 4096) + 2048) >> 12) + t14a;

    out[oo +  0 * out_s] =  clip(t0  + t2  );
    out[oo + 15 * out_s] = -clip(t1  + t3  );
    t2a             =  clip(t0  - t2  );
    t3a             =  clip(t1  - t3  );
    out[oo +  3 * out_s] = -clip(t4a + t6a );
    out[oo + 12 * out_s] =  clip(t5a + t7a );
    t6              =  clip(t4a - t6a );
    t7              =  clip(t5a - t7a );
    out[oo +  1 * out_s] = -clip(t8a + t10a);
    out[oo + 14 * out_s] =  clip(t9a + t11a);
    t10             =  clip(t8a - t10a);
    t11             =  clip(t9a - t11a);
    out[oo +  2 * out_s] =  clip(t12 + t14 );
    out[oo + 13 * out_s] = -clip(t13 + t15 );
    t14a            =  clip(t12 - t14 );
    t15a            =  clip(t13 - t15 );

    out[oo +  7 * out_s] = -(((t2a  + t3a)  * 181 + 128) >> 8);
    out[oo +  8 * out_s] =   ((t2a  - t3a)  * 181 + 128) >> 8;
    out[oo +  4 * out_s] =   ((t6   + t7)   * 181 + 128) >> 8;
    out[oo + 11 * out_s] = -(((t6   - t7)   * 181 + 128) >> 8);
    out[oo +  6 * out_s] =   ((t10  + t11)  * 181 + 128) >> 8;
    out[oo +  9 * out_s] = -(((t10  - t11)  * 181 + 128) >> 8);
    out[oo +  5 * out_s] = -(((t14a + t15a) * 181 + 128) >> 8);
    out[oo + 10 * out_s] =   ((t14a - t15a) * 181 + 128) >> 8;
}

function inv_adst4_1d_c(c: Int32Array, o: number, stride: number): void {
    inv_adst4_1d_internal_c(c, o, stride, c, o, stride);
}

function inv_flipadst4_1d_c(c: Int32Array, o: number, stride: number): void {
    inv_adst4_1d_internal_c(c, o, stride, c, o + 3 * stride, -stride);
}

function inv_adst8_1d_c(c: Int32Array, o: number, stride: number): void {
    inv_adst8_1d_internal_c(c, o, stride, c, o, stride);
}

function inv_flipadst8_1d_c(c: Int32Array, o: number, stride: number): void {
    inv_adst8_1d_internal_c(c, o, stride, c, o + 7 * stride, -stride);
}

function inv_adst16_1d_c(c: Int32Array, o: number, stride: number): void {
    inv_adst16_1d_internal_c(c, o, stride, c, o, stride);
}

function inv_flipadst16_1d_c(c: Int32Array, o: number, stride: number): void {
    inv_adst16_1d_internal_c(c, o, stride, c, o + 15 * stride, -stride);
}

function inv_identity4_1d_c(c: Int32Array, o: number, stride: number): void {
    for (let i = 0; i < 4; i++) {
        const v = c[o + stride * i];
        c[o + stride * i] = v + ((v * 1697 + 2048) >> 12);
    }
}

function inv_identity8_1d_c(c: Int32Array, o: number, stride: number): void {
    for (let i = 0; i < 8; i++)
        c[o + stride * i] *= 2;
}

function inv_identity16_1d_c(c: Int32Array, o: number, stride: number): void {
    for (let i = 0; i < 16; i++) {
        const v = c[o + stride * i];
        c[o + stride * i] = 2 * v + ((v * 1697 + 1024) >> 11);
    }
}

function inv_identity32_1d_c(c: Int32Array, o: number, stride: number): void {
    for (let i = 0; i < 32; i++)
        c[o + stride * i] *= 4;
}

function inv_wht4_1d_c(c: Int32Array, o: number, stride: number): void {
    const in0 = c[o + 0 * stride], in1 = c[o + 1 * stride];
    const in2 = c[o + 2 * stride], in3 = c[o + 3 * stride];

    const t0 = in0 + in1;
    const t2 = in2 - in3;
    const t4 = (t0 - t2) >> 1;
    const t3 = t4 - in3;
    const t1 = t4 - in1;

    c[o + 0 * stride] = t0 - t3;
    c[o + 1 * stride] = t3;
    c[o + 2 * stride] = t1;
    c[o + 3 * stride] = t2 + t1;
}

type Transform1D = (c: Int32Array, o: number, stride: number) => void;

const DCT = 0, ADST = 1, FLIPADST = 2, IDENTITY = 3;
// by transform size (log2 of 4-64) and 1D type
const TX1D: Array<Array<Transform1D | null>> = [
    [inv_dct4_1d_c, inv_adst4_1d_c, inv_flipadst4_1d_c, inv_identity4_1d_c],
    [inv_dct8_1d_c, inv_adst8_1d_c, inv_flipadst8_1d_c, inv_identity8_1d_c],
    [inv_dct16_1d_c, inv_adst16_1d_c, inv_flipadst16_1d_c, inv_identity16_1d_c],
    [inv_dct32_1d_c, null, null, inv_identity32_1d_c],
    [inv_dct64_1d_c, null, null, null]
];
// the 1D types of the transform types (dav1d_tx1d_types): rows (first), columns (second). The coefficients are
// stored transposed, so dav1d transforms each type with the 1D types of its mirror (ADST_DCT with DCT_ADST's, ...)
const MIRROR = [0, 2, 1, 3, 5, 4, 6, 8, 7, 9, 11, 10, 13, 12, 15, 14];
const TX1D_TYPES = [
    [DCT, DCT], [ADST, DCT], [DCT, ADST], [ADST, ADST], [FLIPADST, DCT], [DCT, FLIPADST], [FLIPADST, FLIPADST],
    [ADST, FLIPADST], [FLIPADST, ADST], [IDENTITY, IDENTITY], [DCT, IDENTITY], [IDENTITY, DCT], [ADST, IDENTITY],
    [IDENTITY, ADST], [FLIPADST, IDENTITY], [IDENTITY, FLIPADST]
];
// the rounding shift between the passes, by transform size
const SHIFT = [0, 1, 2, 2, 2, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2];

const tmp = new Int32Array(64 * 64);

/**
 * The basis of a 1D inverse transform (for encoders), by size (log2 of 4-64) and 1D type: n x min(n, 32) values, column
 * k (at k + i * min(n, 32)) the output of coefficient k (without clipping, of 4096 scaled down)
 */
export function inverseBasis(log2: number, type: number): Float64Array {
    const n = 4 << log2, k = Math.min(n, 32), out = new Float64Array(n * k), c = new Int32Array(n);
    lo = -(2 ** 31);
    hi = 2 ** 31 - 1;
    for (let j = 0; j < k; j++) {
        c.fill(0);
        c[j] = 4096;
        (TX1D[log2][type] as Transform1D)(c, 0, 1);
        for (let i = 0; i < n; i++) out[i * k + j] = c[i] / 4096;
    }
    return out;
}

/** The 1D types (rows, columns) of a transform type, and the shift between the passes of a transform size */
export const transformTypes1D = (txtp: number): number[] => TX1D_TYPES[MIRROR[txtp]];
export const passShift = (tx: number): number => SHIFT[tx];

/**
 * Adds the inverse transform of the coefficients (stored transposed: coeff[y + x * min(h, 32)], cleared afterwards) to
 * the pixels at dst[d] (stride: the pixels' row stride)
 */
export function inverseTransformAdd(dst: Uint16Array, d: number, stride: number, coeff: Int32Array, eob: number, tx: number, txtp: number, bitdepthMax: number): void {
    if (txtp === 16) return whtAdd(dst, d, stride, coeff, bitdepthMax);
    const w = 4 * TXFM_DIMENSIONS[tx * 8], h = 4 * TXFM_DIMENSIONS[tx * 8 + 1];
    const lw = TXFM_DIMENSIONS[tx * 8 + 2], lh = TXFM_DIMENSIONS[tx * 8 + 3];
    const shift = SHIFT[tx];
    const isRect2 = w * 2 === h || h * 2 === w;
    const rnd = (1 << shift) >> 1;

    if (eob < (txtp === DCT_DCT ? 1 : 0)) {
        let dc = coeff[0];
        coeff[0] = 0;
        if (isRect2) dc = (dc * 181 + 128) >> 8;
        dc = (dc * 181 + 128) >> 8;
        dc = (dc + rnd) >> shift;
        dc = (dc * 181 + 128 + 2048) >> 12;
        for (let y = 0; y < h; y++, d += stride) {
            for (let x = 0; x < w; x++) {
                const v = dst[d + x] + dc;
                dst[d + x] = v < 0 ? 0 : v > bitdepthMax ? bitdepthMax : v;
            }
        }
        return;
    }

    const [t0, t1] = TX1D_TYPES[MIRROR[txtp]];
    const first = TX1D[lw][t0] as Transform1D, second = TX1D[lh][t1] as Transform1D;
    const sh = Math.min(h, 32), sw = Math.min(w, 32);
    const rowMin = bitdepthMax === 255 ? -32768 : ~bitdepthMax << 7, colMin = bitdepthMax === 255 ? -32768 : ~bitdepthMax << 5;

    // rows (the ones with coefficients; the others stay zero)
    lo = rowMin; hi = ~rowMin;
    tmp.fill(0, 0, w * sh);
    for (let y = 0; y < sh; y++) {
        let nonzero = false;
        for (let x = 0; x < sw; x++) if (coeff[y + x * sh]) { nonzero = true; break; }
        if (!nonzero) continue;
        const c = y * w;
        if (isRect2) for (let x = 0; x < sw; x++) tmp[c + x] = (coeff[y + x * sh] * 181 + 128) >> 8;
        else for (let x = 0; x < sw; x++) tmp[c + x] = coeff[y + x * sh];
        first(tmp, c, 1);
    }
    coeff.fill(0, 0, sw * sh);
    for (let i = 0; i < w * sh; i++) {
        const v = (tmp[i] + rnd) >> shift;
        tmp[i] = v < colMin ? colMin : v > ~colMin ? ~colMin : v;
    }

    // columns
    lo = colMin; hi = ~colMin;
    for (let x = 0; x < w; x++) second(tmp, x, w);

    for (let y = 0, c = 0; y < h; y++, d += stride) {
        for (let x = 0; x < w; x++, c++) {
            const v = dst[d + x] + ((tmp[c] + 8) >> 4);
            dst[d + x] = v < 0 ? 0 : v > bitdepthMax ? bitdepthMax : v;
        }
    }
}

// lossless blocks
function whtAdd(dst: Uint16Array, d: number, stride: number, coeff: Int32Array, bitdepthMax: number): void {
    for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 4; x++) tmp[y * 4 + x] = coeff[y + x * 4] >> 2;
        inv_wht4_1d_c(tmp, y * 4, 1);
    }
    coeff.fill(0, 0, 16);
    for (let x = 0; x < 4; x++) inv_wht4_1d_c(tmp, x, 4);
    for (let y = 0, c = 0; y < 4; y++, d += stride) {
        for (let x = 0; x < 4; x++, c++) {
            const v = dst[d + x] + tmp[c];
            dst[d + x] = v < 0 ? 0 : v > bitdepthMax ? bitdepthMax : v;
        }
    }
}

// Writes src/codecs/av1/data.ts: the tables of dav1d (https://code.videolan.org/videolan/dav1d, BSD-2-Clause) the AV1
// decoder uses, read from dav1d itself so they're exact: the default CDFs (the intra ones, for every quantizer
// category), scans, dequantizers, quantizer matrices and the smaller tables. With a dav1d checkout configured with
// meson (meson setup build, for build/config.h):
//   cc -O1 -I$DAV1D -I$DAV1D/include -I$DAV1D/build -I$DAV1D/build/include/dav1d -o av1-tables scripts/av1-tables.c \
//      $DAV1D/src/cdf.c $DAV1D/src/tables.c $DAV1D/src/scan.c $DAV1D/src/qm.c $DAV1D/src/dequant_tables.c
//   ./av1-tables | node scripts/av1-pack.js > src/codecs/av1/data.ts
// (the larger tables are packed into one blob, which av1-pack.js compresses)
#include <stddef.h>
#include <stdio.h>
#include <stdint.h>
#include <string.h>

#include "src/cdf.h"
#include "src/tables.h"
#include "src/scan.h"
#include "src/qm.h"
#include "src/dequant_tables.h"
#include "src/ref.h"
#include "config.h"

// (cdf.c's thread functions need these, they aren't called)
Dav1dRef *dav1d_ref_create_using_pool(Dav1dMemPool *pool, size_t size) { (void) pool; (void) size; return NULL; }
void dav1d_ref_dec(Dav1dRef **ref) { (void) ref; }

static const char b64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static void base64(const uint8_t *data, size_t n) {
    putchar('\'');
    for (size_t i = 0; i < n; i += 3) {
        uint32_t v = data[i] << 16 | (i + 1 < n ? data[i + 1] << 8 : 0) | (i + 2 < n ? data[i + 2] : 0);
        putchar(b64[v >> 18 & 63]);
        putchar(b64[v >> 12 & 63]);
        putchar(i + 1 < n ? b64[v >> 6 & 63] : '=');
        putchar(i + 2 < n ? b64[v & 63] : '=');
    }
    putchar('\'');
}

// the larger tables, one after another (16 bit ones little endian), and where they are
static uint8_t blob[1 << 17];
static size_t blob_n;
static struct { const char *name; size_t offset, size; } packed[16];
static int packed_n;

static void pack(const char *name, const void *data, size_t n) {
    packed[packed_n].name = name;
    packed[packed_n].offset = blob_n;
    packed[packed_n++].size = n;
    for (size_t i = 0; i < n; i += 2) {
        // (as little endian, whatever the machine's order)
        const uint16_t v = ((const uint16_t *) data)[i / 2];
        blob[blob_n + i] = v & 255;
        if (i + 1 < n) blob[blob_n + i + 1] = v >> 8;
    }
    blob_n += n;
}

static void pack_bytes(const char *name, const uint8_t *data, size_t n) {
    packed[packed_n].name = name;
    packed[packed_n].offset = blob_n;
    packed[packed_n++].size = n;
    memcpy(&blob[blob_n], data, n);
    blob_n += n;
}

static void ints(const char *name, const char *comment, const void *data, size_t n, int size, int sign) {
    printf("/** %s */\nexport const %s = [", comment, name);
    for (size_t i = 0; i < n; i++) {
        long v;
        if (size == 4) v = ((const int *) data)[i];
        else if (size == 1) v = sign ? ((const int8_t *) data)[i] : ((const uint8_t *) data)[i];
        else v = sign ? ((const int16_t *) data)[i] : ((const uint16_t *) data)[i];
        printf("%s%ld", i ? (i % 32 ? ", " : ",\n    ") : "", v);
    }
    printf("];\n\n");
}

// the CDF fields the intra decoder uses: their offset in CdfContext and their size, in 16 bit units
#define FIELD(name, member) { name, offsetof(CdfContext, member) / 2, sizeof(((CdfContext *) 0)->member) / 2 }
static const struct { const char *name; size_t offset, size; } mode_fields[] = {
    FIELD("kfYMode", kfym),
    FIELD("uvMode", m.uv_mode),
    FIELD("partition", m.partition),
    FIELD("cflAlpha", m.cfl_alpha),
    FIELD("txtpIntra1", m.txtp_intra1),
    FIELD("txtpIntra2", m.txtp_intra2),
    FIELD("cflSign", m.cfl_sign),
    FIELD("angleDelta", m.angle_delta),
    FIELD("filterIntra", m.filter_intra),
    FIELD("segId", m.seg_id),
    FIELD("palSize", m.pal_sz),
    FIELD("colorMap", m.color_map),
    FIELD("txSize", m.txsz),
    FIELD("deltaQ", m.delta_q),
    FIELD("deltaLf", m.delta_lf),
    FIELD("restoreSwitchable", m.restore_switchable),
    FIELD("restoreWiener", m.restore_wiener),
    FIELD("restoreSgrproj", m.restore_sgrproj),
    FIELD("useFilterIntra", m.use_filter_intra),
    FIELD("skip", m.skip),
    FIELD("palY", m.pal_y),
    FIELD("palUv", m.pal_uv),
    FIELD("intrabc", m.intrabc),
    FIELD("txPart", m.txpart),
    FIELD("txtpInter1", m.txtp_inter1),
    FIELD("txtpInter2", m.txtp_inter2),
    FIELD("txtpInter3", m.txtp_inter3),
    FIELD("mvJoint", mv.joint),
    FIELD("mvClasses0", mv.comp[0].classes),
    FIELD("mvSign0", mv.comp[0].sign),
    FIELD("mvClass00", mv.comp[0].class0),
    FIELD("mvClassN0", mv.comp[0].classN),
    FIELD("mvClasses1", mv.comp[1].classes),
    FIELD("mvSign1", mv.comp[1].sign),
    FIELD("mvClass01", mv.comp[1].class0),
    FIELD("mvClassN1", mv.comp[1].classN),
}, coef_fields[] = {
    FIELD("eobBin16", coef.eob_bin_16),
    FIELD("eobBin32", coef.eob_bin_32),
    FIELD("eobBin64", coef.eob_bin_64),
    FIELD("eobBin128", coef.eob_bin_128),
    FIELD("eobBin256", coef.eob_bin_256),
    FIELD("eobBin512", coef.eob_bin_512),
    FIELD("eobBin1024", coef.eob_bin_1024),
    FIELD("eobBaseTok", coef.eob_base_tok),
    FIELD("baseTok", coef.base_tok),
    FIELD("brTok", coef.br_tok),
    FIELD("eobHiBit", coef.eob_hi_bit),
    FIELD("coefSkip", coef.skip),
    FIELD("dcSign", coef.dc_sign),
};

int main(void) {
    printf("/*!\n * Generated by scripts/av1-tables.c from dav1d, don't edit. Copyright (c) 2018-2021, VideoLAN and dav1d authors,\n"
           " * Copyright (c) 2018, Two Orioles, LLC, BSD-2-Clause License (see THIRD_PARTY_NOTICES.md)\n */\n\n");

    // CDFs: the intra fields one after another, the coefficient ones by quantizer category
    CdfContext cdf[4];
    for (int q = 0; q < 4; q++) {
        CdfThreadContext t;
        dav1d_cdf_thread_init_static(&t, q == 0 ? 0 : q == 1 ? 21 : q == 2 ? 61 : 121);
        dav1d_cdf_thread_copy(&cdf[q], &t);
    }
    size_t at = 0;
    printf("/** where the CDFs are in a CDF context (16 bit units), the mode ones first, then the coefficient ones */\nexport const CDF = {\n");
    for (size_t i = 0; i < sizeof(mode_fields) / sizeof(*mode_fields); i++) {
        printf("    %s: %zu,\n", mode_fields[i].name, at);
        at += mode_fields[i].size;
    }
    const size_t mode_size = at;
    for (size_t i = 0; i < sizeof(coef_fields) / sizeof(*coef_fields); i++) {
        printf("    %s: %zu,\n", coef_fields[i].name, at);
        at += coef_fields[i].size;
    }
    printf("    size: %zu\n};\n\n", at);

    static uint16_t mode[8192], coef[4][8192];
    size_t mode_n = 0, coef_n = 0;
    for (size_t i = 0; i < sizeof(mode_fields) / sizeof(*mode_fields); i++) {
        memcpy(&mode[mode_n], (uint16_t *) &cdf[0] + mode_fields[i].offset, mode_fields[i].size * 2);
        mode_n += mode_fields[i].size;
    }
    for (int q = 0; q < 4; q++) {
        coef_n = 0;
        for (size_t i = 0; i < sizeof(coef_fields) / sizeof(*coef_fields); i++) {
            memcpy(&coef[q][coef_n], (uint16_t *) &cdf[q] + coef_fields[i].offset, coef_fields[i].size * 2);
            coef_n += coef_fields[i].size;
        }
    }
    pack("modeCdfs", mode, mode_n * 2);
    static const char *const coef_names[4] = { "coefCdfs0", "coefCdfs1", "coefCdfs2", "coefCdfs3" };
    for (int q = 0; q < 4; q++) pack(coef_names[q], coef[q], coef_n * 2);

    // scans (2D transforms up to 32 samples a side), by transform size
    static uint16_t scans[16384];
    size_t n = 0;
    int scan_offsets[N_RECT_TX_SIZES];
    for (int tx = 0; tx < N_RECT_TX_SIZES; tx++) {
        const TxfmInfo *t = &dav1d_txfm_dimensions[tx];
        const int w = t->w * 4 > 32 ? 32 : t->w * 4, h = t->h * 4 > 32 ? 32 : t->h * 4;
        scan_offsets[tx] = (int) n;
        memcpy(&scans[n], dav1d_scans[tx], w * h * 2);
        n += w * h;
    }
    pack("scans", scans, n * 2);
    ints("SCAN_OFFSETS", "where each transform size's scan starts", scan_offsets, N_RECT_TX_SIZES, 4, 0);

    pack("dq", dav1d_dq_tbl, sizeof(dav1d_dq_tbl));

    // quantizer matrices: the 32x16 ones and the lower triangles of the 32x32 ones, by level and luma/chroma
    // (dav1d_init_qm_tables points RTX_16X32 at the 32x16 table as stored, and expands the 32x32 one from its
    // triangle, which is written again here)
    dav1d_init_qm_tables();
    static uint8_t qm[15 * 2 * (512 + 528)];
    size_t q = 0;
    for (int i = 0; i < 15; i++)
        for (int j = 0; j < 2; j++) {
            // RTX_32X16's table is the transposed 16x32 one; RTX_16X32 points at the 32x16 source as stored
            memcpy(&qm[q], dav1d_qm_tbl[i][j][RTX_16X32], 512);
            q += 512;
        }
    for (int i = 0; i < 15; i++)
        for (int j = 0; j < 2; j++) {
            const uint8_t *full = dav1d_qm_tbl[i][j][TX_32X32];
            for (int y = 0; y < 32; y++)
                for (int x = 0; x <= y; x++) qm[q++] = full[y * 32 + x];
        }
    pack_bytes("qm", qm, q);

    ints("AL_PART_CTX", "dav1d_al_part_ctx[2][5][10]", dav1d_al_part_ctx, 2 * 5 * 10, 1, 0);
    ints("BLOCK_SIZES", "dav1d_block_sizes[5][10][2]", dav1d_block_sizes, 5 * 10 * 2, 1, 0);
    ints("BLOCK_DIMENSIONS", "dav1d_block_dimensions[22][4]: width, height (4 pixel units), their log2", dav1d_block_dimensions, 22 * 4, 1, 0);
    ints("TXFM_DIMENSIONS", "dav1d_txfm_dimensions[19]: w, h, lw, lh, min, max, sub, ctx", dav1d_txfm_dimensions, 19 * 8, 1, 0);
    ints("MAX_TXFM_SIZE_FOR_BS", "dav1d_max_txfm_size_for_bs[22][4]: luma, 4:2:0, 4:2:2, 4:4:4", dav1d_max_txfm_size_for_bs, 22 * 4, 1, 0);
    ints("TXTP_FROM_UVMODE", "dav1d_txtp_from_uvmode[14]", dav1d_txtp_from_uvmode, 14, 1, 0);
    ints("PARTITION_TYPE_COUNT", "dav1d_partition_type_count[5]", dav1d_partition_type_count, 5, 1, 0);
    ints("TX_TYPES_PER_SET", "dav1d_tx_types_per_set[40]", dav1d_tx_types_per_set, 40, 1, 0);
    ints("FILTER_MODE_TO_Y_MODE", "dav1d_filter_mode_to_y_mode[5]", dav1d_filter_mode_to_y_mode, 5, 1, 0);
    ints("LO_CTX_OFFSETS", "dav1d_lo_ctx_offsets[3][5][5]", dav1d_lo_ctx_offsets, 75, 1, 0);
    ints("SKIP_CTX", "dav1d_skip_ctx[5][5]", dav1d_skip_ctx, 25, 1, 0);
    ints("TX_TYPE_CLASS", "dav1d_tx_type_class[17]", dav1d_tx_type_class, 17, 1, 0);
    ints("INTRA_MODE_CONTEXT", "dav1d_intra_mode_context[13]", dav1d_intra_mode_context, 13, 1, 0);
    ints("CDEF_DIRECTIONS", "dav1d_cdef_directions[12][2]", dav1d_cdef_directions, 24, 1, 1);
    ints("SGR_PARAMS", "dav1d_sgr_params[16][2]", dav1d_sgr_params, 32, 2, 0);
    ints("SGR_X_BY_X", "dav1d_sgr_x_by_x[256]", dav1d_sgr_x_by_x, 256, 1, 0);
    ints("SM_WEIGHTS", "dav1d_sm_weights[128]", dav1d_sm_weights, 128, 1, 0);
    ints("DR_INTRA_DERIVATIVE", "dav1d_dr_intra_derivative[44]", dav1d_dr_intra_derivative, 44, 2, 0);
    // (dav1d's layout of the filter intra taps depends on the architecture: written as [5][8 outputs][7 taps])
    static int8_t taps[5][8][7];
    for (int i = 0; i < 5; i++)
        for (int idx = 0; idx < 8; idx++)
            for (int k = 0; k < 7; k++) {
#if ARCH_X86
                static const int off[7] = { 0, 1, 16, 17, 32, 33, 48 };
                taps[i][idx][k] = dav1d_filter_intra_taps[i][2 * idx + off[k]];
#else
                taps[i][idx][k] = dav1d_filter_intra_taps[i][idx + 8 * k];
#endif
            }
    ints("FILTER_INTRA_TAPS", "the filter intra taps [5][8 outputs][7 taps]", taps, 5 * 8 * 7, 1, 1);
    ints("RESIZE_FILTER", "dav1d_resize_filter[64][8]", dav1d_resize_filter, 64 * 8, 1, 1);
    pack("gaussianSequence", dav1d_gaussian_sequence, sizeof(dav1d_gaussian_sequence));

    printf("/**\n * The larger tables, packed: the default mode CDFs, the coefficient CDFs of each quantizer category, the scans of\n"
           " * the 2D transforms by transform size (16 bit), the dequantizers by bit depth (8, 10, 12) and qindex: DC, AC (16\n"
           " * bit), the quantizer matrices of qm.c: 32x16 (15 levels, luma and chroma, 512 values) then the lower triangles of\n"
           " * the 32x32 ones (528 values), dav1d_gaussian_sequence (16 bit, signed). Where they are: [offset, size] in bytes\n */\n"
           "export const PACKED_AT = {\n");
    for (int i = 0; i < packed_n; i++) printf("    %s: [%zu, %zu],\n", packed[i].name, packed[i].offset, packed[i].size);
    printf("    size: [0, %zu]\n};\n\n/** the packed tables, zlib compressed, base64 */\nexport const PACKED = ", blob_n);
    base64(blob, blob_n);
    printf(";\n");
    return 0;
}

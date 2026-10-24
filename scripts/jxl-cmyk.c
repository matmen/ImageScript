// Encodes a small lossless CMYK JPEG XL for tests/jxl (cjxl can't: it reads no CMYK input). Reads width * height
// samples of C, M, Y, K (8-bit, 1 - ink, interleaved) from stdin, writes the JPEG XL to stdout: the color channels with
// a black extra channel and, to keep the file small, the sRGB color encoding instead of a CMYK profile. Built and run by
// scripts/jxl-fixtures.py:
//   cc -o jxl-cmyk scripts/jxl-cmyk.c -ljxl && ./jxl-cmyk 32 32 < cmyk.raw > cmyk.jxl
#include <jxl/encode.h>
#include <stdio.h>
#include <stdlib.h>

int main(int argc, char **argv) {
    if (argc < 3) return 2;
    const uint32_t w = atoi(argv[1]), h = atoi(argv[2]);
    uint8_t *in = malloc(w * h * 4), *color = malloc(w * h * 3), *black = malloc(w * h);
    if (fread(in, 4, w * h, stdin) != w * h) return 1;
    for (size_t i = 0; i < w * h; i++) {
        for (int c = 0; c < 3; c++) color[3 * i + c] = in[4 * i + c];
        black[i] = in[4 * i + 3];
    }

    JxlEncoder *enc = JxlEncoderCreate(NULL);
    JxlBasicInfo info;
    JxlEncoderInitBasicInfo(&info);
    info.xsize = w;
    info.ysize = h;
    info.bits_per_sample = 8;
    info.num_extra_channels = 1;
    info.uses_original_profile = JXL_TRUE;
    if (JxlEncoderSetBasicInfo(enc, &info)) return 1;
    JxlExtraChannelInfo ec;
    JxlEncoderInitExtraChannelInfo(JXL_CHANNEL_BLACK, &ec);
    ec.bits_per_sample = 8;
    if (JxlEncoderSetExtraChannelInfo(enc, 0, &ec)) return 1;
    JxlColorEncoding srgb;
    JxlColorEncodingSetToSRGB(&srgb, JXL_FALSE);
    if (JxlEncoderSetColorEncoding(enc, &srgb)) return 1;

    JxlEncoderFrameSettings *settings = JxlEncoderFrameSettingsCreate(enc, NULL);
    JxlEncoderSetFrameLossless(settings, JXL_TRUE);
    JxlPixelFormat rgb = {3, JXL_TYPE_UINT8, JXL_NATIVE_ENDIAN, 0}, grey = {1, JXL_TYPE_UINT8, JXL_NATIVE_ENDIAN, 0};
    if (JxlEncoderAddImageFrame(settings, &rgb, color, w * h * 3)) return 1;
    if (JxlEncoderSetExtraChannelBuffer(settings, &grey, black, w * h, 0)) return 1;
    JxlEncoderCloseInput(enc);

    uint8_t out[1 << 16], *next = out;
    size_t avail = sizeof out;
    if (JxlEncoderProcessOutput(enc, &next, &avail) != JXL_ENC_SUCCESS) return 1;
    fwrite(out, 1, next - out, stdout);
    JxlEncoderDestroy(enc);
    return 0;
}

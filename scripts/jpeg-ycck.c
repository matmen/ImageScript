// Writes a YCCK JPEG for tests/jpegs (cjpeg and Pillow write none): an RGB PPM as CMYK (C, M, Y = max - R, G, B; K =
// 255 - max; stored inverted like Adobe does) in libjpeg's YCCK color space. Built and run by scripts/jpeg-fixtures.py:
//   cc -o jpeg-ycck scripts/jpeg-ycck.c -ljpeg && ./jpeg-ycck in.ppm ycck.jpg
#include <stdio.h>
#include <stdlib.h>
#include "jpeglib.h"
int main(int argc, char **argv) {
    FILE *in = fopen(argv[1], "rb"), *out = fopen(argv[2], "wb");
    int w, h, max;
    if (fscanf(in, "P6 %d %d %d", &w, &h, &max) != 3) return 1;
    fgetc(in);
    unsigned char *rgb = malloc(w * h * 3), *cmyk = malloc(w * 4);
    if (fread(rgb, 1, w * h * 3, in) != (size_t)(w * h * 3)) return 1;
    struct jpeg_compress_struct c; struct jpeg_error_mgr e;
    c.err = jpeg_std_error(&e); jpeg_create_compress(&c); jpeg_stdio_dest(&c, out);
    c.image_width = w; c.image_height = h; c.input_components = 4; c.in_color_space = JCS_CMYK;
    jpeg_set_defaults(&c); jpeg_set_colorspace(&c, JCS_YCCK); jpeg_set_quality(&c, 90, TRUE);
    jpeg_start_compress(&c, TRUE);
    while (c.next_scanline < c.image_height) {
        unsigned char *p = rgb + c.next_scanline * w * 3;
        for (int x = 0; x < w; x++) {
            int r = p[x * 3], g = p[x * 3 + 1], b = p[x * 3 + 2], m = r > g ? (r > b ? r : b) : (g > b ? g : b), k = 255 - m;
            // (inverted, like Adobe stores it)
            cmyk[x * 4] = 255 - (m - r); cmyk[x * 4 + 1] = 255 - (m - g); cmyk[x * 4 + 2] = 255 - (m - b); cmyk[x * 4 + 3] = 255 - k;
        }
        JSAMPROW row = cmyk; jpeg_write_scanlines(&c, &row, 1);
    }
    jpeg_finish_compress(&c); fclose(out); return 0;
}

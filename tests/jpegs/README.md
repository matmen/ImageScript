Derived from `testorig.ppm` of the [libjpeg-turbo test images](https://github.com/libjpeg-turbo/libjpeg-turbo/tree/main/testimages)
(IJG / BSD-style license), re-encoded with Pillow in different modes. `arithmetic.jpg` is `testimgari.jpg` from the same set.

`sub-440.jpg`, `sub-411.jpg`, `ycck.jpg` and `fill-bytes.jpg` are written by `scripts/jpeg-fixtures.py` from
`orig-420-base.jpg`: with cjpeg's 4:4:0 and 4:1:1 subsampling, in the YCCK color space (`scripts/jpeg-ycck.c`,
libjpeg-turbo), and with fill bytes before every marker.

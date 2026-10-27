Written by `scripts/tiff-fixtures.py`: first with Pillow (libtiff) from `tests/targets/external.png` in different modes
and compressions, then what Pillow doesn't write: BigTIFF, YCbCr, old-style LZW, fill order 2, odd tile widths,
associated alpha, 2- and 32-bit samples.

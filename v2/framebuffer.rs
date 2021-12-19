#![allow(dead_code)]
#![warn(clippy::perf)]
#![warn(clippy::complexity)]
#![feature(core_intrinsics)]
#![warn(clippy::correctness)]
#![allow(non_camel_case_types)]
#![allow(non_upper_case_globals)]
#![feature(destructuring_assignment)]
#![feature(const_fn_floating_point_arithmetic)]

mod ffi;

pub struct framebuffer {
  pub width: usize,
  pub height: usize,
  ptr: (bool, ffi::any),
}

impl Drop for framebuffer {
  fn drop(&mut self) { if self.ptr.0 { ffi::mem::free(self.ptr_mut(), self.len()); } }
}

impl Clone for framebuffer {
  fn clone(&self) -> Self {
    let ptr = ffi::mem::alloc(self.len()) as ffi::any;
    unsafe { self.ptr.1.copy_to_nonoverlapping(ptr, self.len()); }
    return Self { width: self.width, height: self.height, ptr: (true, ptr) };
  }
}

impl framebuffer {
  fn new(width: usize, height: usize) -> Self { return Self { width, height, ptr: (true, ffi::mem::alloc(4 * width * height) as ffi::any) }; }
  const unsafe fn from(width: usize, height: usize, buffer: &[u8]) -> Self { return Self { width, height, ptr: (false, buffer.as_ptr() as ffi::any) }; }
  unsafe fn from_mut(width: usize, height: usize, buffer: &mut [u8]) -> Self { return Self { width, height, ptr: (false, buffer.as_mut_ptr() as ffi::any) }; }

  fn ptr_mut<T>(&mut self) -> *mut T { return self.ptr.1 as *mut T; }
  const fn ptr<T>(&self) -> *const T { return self.ptr.1 as *const T; }
  const fn len(&self) -> usize { return 4 * self.width * self.height; }
  fn slice<T>(&self) -> &[T] { return unsafe { std::slice::from_raw_parts(self.ptr(), self.len() / std::mem::size_of::<T>()) }; }
  fn slice_mut<T>(&mut self) -> &mut [T] { return unsafe { std::slice::from_raw_parts_mut(self.ptr_mut(), self.len() / std::mem::size_of::<T>()) }; }
}

mod ops {
  use super::*;

  pub mod fill {
    use super::*;

    pub fn function<F>(fb: &mut fb, f: F) where F: Fn(usize, usize) -> u32 {
      let width = fb.width;
      let height = fb.height;
      let u32 = fb.ptr_mut::<u32>();

      for y in 0..height {
        let yoffset = y * width;
        for x in 0..width { unsafe { *u32.add(x + yoffset) = f(x, y); } }
      }
    }

    pub fn color(fb: &mut fb, r: u8, g: u8, b: u8, a: u8) {
      if r == g && r == b && r == a { unsafe { fb.ptr_mut::<u8>().write_bytes(r, fb.len()); } }

      else {
        let width = fb.width;
        let height = fb.height;
        let u32 = fb.ptr_mut::<u32>();
        unsafe { std::slice::from_raw_parts_mut(u32, width).fill(u32::from_be_bytes([r, g, b, a])); }
        for y in 1..height { unsafe { std::ptr::copy_nonoverlapping(u32 as *const u32, u32.add(y * width), width); } }
      }
    }
  }

  pub mod flip {
    use super::*;

    pub fn horizontal(fb: &mut fb) {
      let width = fb.width;
      let height = fb.height;
      let u32 = fb.ptr_mut::<u32>();
      for y in 0..height { unsafe { std::slice::from_raw_parts_mut(u32.add(y * width), width).reverse(); } }
    }

    pub fn vertical(fb: &mut fb) {
      let width = fb.width;
      let height = fb.height;
      let u32 = fb.ptr_mut::<u32>();

      for y in 0..(height / 2) {
        let yoffset = y * width;
        let yboffset = width * (height - 1 - y);
        for x in 0..width { unsafe { std::ptr::swap(u32.add(x + yoffset), u32.add(x + yboffset)) }; }
      }
    }
  }

  pub mod overlay {
    use super::*;

    pub fn replace(fb: &mut fb, fg: &fb, x: isize, y: isize) {
      let f32 = fg.ptr::<u32>();
      let b32 = fb.ptr_mut::<u32>();
      let (bw, bh) = (fb.width as isize, fb.height as isize);
      let (fw, fh) = (fg.width as isize, fg.height as isize);

      let top = y.max(0);
      let left = x.max(0);
      let ox = x.min(0).abs();
      let oy = y.min(0).abs();
      let width = bw.min(x + fw) - left;
      let height = bh.min(y + fh) - top;
      if 0 >= width || 0 >= height { return; }

      for yy in 0..height {
        let yyoffset = ox + fw * (yy + oy);
        let yoffset = left + bw * (yy + top);
        unsafe { b32.offset(yoffset).copy_from(f32.offset(yyoffset), width as usize); }
      }
    }

    pub fn blend(fb: &mut fb, fg: &fb, x: isize, y: isize) {
      let f32 = fg.ptr::<u32>();
      let b32 = fb.ptr_mut::<u32>();
      let (bw, bh) = (fb.width as isize, fb.height as isize);
      let (fw, fh) = (fg.width as isize, fg.height as isize);

      let top = y.max(0);
      let left = x.max(0);
      let ox = x.min(0).abs();
      let oy = y.min(0).abs();
      let width = bw.min(x + fw) - left;
      let height = bh.min(y + fh) - top;
      if 0 >= width || 0 >= height { return; }

      for yy in 0..height {
        let yyoffset = ox + fw * (yy + oy);
        let yoffset = left + bw * (yy + top);

        for xx in 0..width {
          unsafe {
            let fg = *f32.offset(xx + yyoffset);

            match (fg >> 24) & 0xff {
              0x00 => {},
              0xff => *b32.offset(xx + yoffset) = fg,

              fa => {
                let alpha = 1 + fa;
                let inv_alpha = 256 - fa;
                let bg = *b32.offset(xx + yoffset);
                let r = (alpha * (fg & 0xff) + inv_alpha * (bg & 0xff)) >> 8;
                let g = (alpha * ((fg >> 8) & 0xff) + inv_alpha * ((bg >> 8) & 0xff)) >> 8;
                let b = (alpha * ((fg >> 16) & 0xff) + inv_alpha * ((bg >> 16) & 0xff)) >> 8;
                *b32.offset(xx + yoffset) = r | ((g & 0xff) << 8) | ((b & 0xff) << 16) | (fa.max((bg >> 24) & 0xff) << 24);
              },
            }
          }
        }
      }
    }
  }

  pub mod resize {
    use super::*;

    const fn lerp(a: u8, b: u8, t: f64) -> u8 {
      return ((t * b as f64) + a as f64 * (1.0 - t)) as u8;
    }

    fn clamped(x: usize, y: usize, width: usize, height: usize) -> usize {
      return 4 * (x.clamp(0, width - 1) + width * y.clamp(0, height - 1));
    }

    const fn hermite(a: f64, b: f64, c: f64, d: f64, t: f64) -> f64 {
      let cc = (c / 2.0) + (a / -2.0);
      let bb = a + (c * 2.0) - (d / 2.0) - (b * 2.5);
      let aa = (d / 2.0) + (a / -2.0) + (b * 1.5) - (c * 1.5);

      let t2 = t * t;
      return b + (t * cc) + (bb * t2) + (t * aa * t2);
    }

    pub fn nearest(fb: &fb, width: usize, height: usize) -> fb {
      let owidth = fb.width;
      let oheight = fb.height;
      let old = fb.ptr::<u32>();
      let mut fb = framebuffer::new(width, height);

      let u32 = fb.ptr_mut::<u32>();
      let xw = 1.0 / width as f64 * owidth as f64;
      let yw = 1.0 / height as f64 * oheight as f64;

      for y in 0..height {
        let yoffset = y * width;
        let yyoffset = owidth * (yw * y as f64) as usize;
        for x in 0..width { unsafe { *u32.add(x + yoffset) = *old.add(yyoffset + (xw * x as f64) as usize); } };
      };

      return fb;
    }

    pub fn linear(fb: &fb, width: usize, height: usize) -> fb {
      let owidth = fb.width;
      let oheight = fb.height;
      let old = fb.ptr::<u8>();
      let mut fb = framebuffer::new(width, height);

      let mut offset = 0;
      let u8 = fb.ptr_mut::<u8>();
      let width1 = 1.0 / (width - 1) as f64;
      let height1 = 1.0 / (height - 1) as f64;

      for y in 0..height {
        let yy = oheight as f64 * (y as f64 * height1) - 0.5;

        let yyi = yy as usize;
        let ty = yy - yyi as f64;

        for x in 0..width {
          let xx = owidth as f64 * (x as f64 * width1) - 0.5;

          let xxi = xx as usize;
          let tx = xx - xxi as f64;

          let s0 = clamped(xxi, yyi, owidth, oheight);
          let s1 = clamped(1 + xxi, yyi, owidth, oheight);
          let s2 = clamped(xxi, 1 + yyi, owidth, oheight);
          let s3 = clamped(1 + xxi, 1 + yyi, owidth, oheight);

          unsafe {
            *u8.offset(offset) = lerp(lerp(*old.add(s0), *old.add(s2), tx), lerp(*old.add(s1), *old.add(s3), tx), ty);
            *u8.offset(1 + offset) = lerp(lerp(*old.add(1 + s0), *old.add(1 + s2), tx), lerp(*old.add(1 + s1), *old.add(1 + s3), tx), ty);
            *u8.offset(2 + offset) = lerp(lerp(*old.add(2 + s0), *old.add(2 + s2), tx), lerp(*old.add(2 + s1), *old.add(2 + s3), tx), ty);
            *u8.offset(3 + offset) = lerp(lerp(*old.add(3 + s0), *old.add(3 + s2), tx), lerp(*old.add(3 + s1), *old.add(3 + s3), tx), ty);
          }

          offset += 4;
        };
      };

      return fb;
    }

    pub fn cubic(fb: &fb, width: usize, height: usize) -> fb {
      let owidth = fb.width;
      let oheight = fb.height;
      let old = fb.ptr::<u8>();
      let mut fb = framebuffer::new(width, height);

      let mut offset = 0;
      let u8 = fb.ptr_mut::<u8>();
      let width1 = 1.0 / (width - 1) as f64;
      let height1 = 1.0 / (height - 1) as f64;

      for y in 0..height {
        let yy = oheight as f64 * (y as f64 * height1) - 0.5;

        let yyi = yy as usize;
        let ty = yy - yyi as f64;

        for x in 0..width {
          let xx = owidth as f64 * (x as f64 * width1) - 0.5;

          let xxi = xx as usize;
          let tx = xx - xxi as f64;

          let s0 = clamped(xxi - 1, yyi - 1, owidth, oheight);

          let s1 = clamped(xxi, yyi - 1, owidth, oheight);
          let s2 = clamped(1 + xxi, yyi - 1, owidth, oheight);
          let s3 = clamped(2 + xxi, yyi - 1, owidth, oheight);

          let s4 = clamped(xxi - 1, yyi, owidth, oheight);

          let s5 = clamped(xxi, yyi, owidth, oheight);
          let s6 = clamped(1 + xxi, yyi, owidth, oheight);
          let s7 = clamped(2 + xxi, yyi, owidth, oheight);

          let s8 = clamped(xxi - 1, 1 + yyi, owidth, oheight);

          let s9 = clamped(xxi, 1 + yyi, owidth, oheight);
          let s10 = clamped(1 + xxi, 1 + yyi, owidth, oheight);
          let s11 = clamped(2 + xxi, 1 + yyi, owidth, oheight);

          let s12 = clamped(xxi - 1, 2 + yyi, owidth, oheight);

          let s13 = clamped(xxi, 2 + yyi, owidth, oheight);
          let s14 = clamped(1 + xxi, 2 + yyi, owidth, oheight);
          let s15 = clamped(2 + xxi, 2 + yyi, owidth, oheight);

          unsafe {
            let c0 = hermite(*old.add(s0) as f64, *old.add(s1) as f64, *old.add(s2) as f64, *old.add(s3) as f64, tx);
            let c00 = hermite(*old.add(1 + s0) as f64, *old.add(1 + s1) as f64, *old.add(1 + s2) as f64, *old.add(1 + s3) as f64, tx);
            let c000 = hermite(*old.add(2 + s0) as f64, *old.add(2 + s1) as f64, *old.add(2 + s2) as f64, *old.add(2 + s3) as f64, tx);
            let c0000 = hermite(*old.add(3 + s0) as f64, *old.add(3 + s1) as f64, *old.add(3 + s2) as f64, *old.add(3 + s3) as f64, tx);

            let c1 = hermite(*old.add(s4) as f64, *old.add(s5) as f64, *old.add(s6) as f64, *old.add(s7) as f64, tx);
            let c11 = hermite(*old.add(1 + s4) as f64, *old.add(1 + s5) as f64, *old.add(1 + s6) as f64, *old.add(1 + s7) as f64, tx);
            let c111 = hermite(*old.add(2 + s4) as f64, *old.add(2 + s5) as f64, *old.add(2 + s6) as f64, *old.add(2 + s7) as f64, tx);
            let c1111 = hermite(*old.add(3 + s4) as f64, *old.add(3 + s5) as f64, *old.add(3 + s6) as f64, *old.add(3 + s7) as f64, tx);

            let c2 = hermite(*old.add(s8) as f64, *old.add(s9) as f64, *old.add(s10) as f64, *old.add(s11) as f64, tx);
            let c22 = hermite(*old.add(1 + s8) as f64, *old.add(1 + s9) as f64, *old.add(1 + s10) as f64, *old.add(1 + s11) as f64, tx);
            let c222 = hermite(*old.add(2 + s8) as f64, *old.add(2 + s9) as f64, *old.add(2 + s10) as f64, *old.add(2 + s11) as f64, tx);
            let c2222 = hermite(*old.add(3 + s8) as f64, *old.add(3 + s9) as f64, *old.add(3 + s10) as f64, *old.add(3 + s11) as f64, tx);

            let c3 = hermite(*old.add(s12) as f64, *old.add(s13) as f64, *old.add(s14) as f64, *old.add(s15) as f64, tx);
            let c33 = hermite(*old.add(1 + s12) as f64, *old.add(1 + s13) as f64, *old.add(1 + s14) as f64, *old.add(1 + s15) as f64, tx);
            let c333 = hermite(*old.add(2 + s12) as f64, *old.add(2 + s13) as f64, *old.add(2 + s14) as f64, *old.add(2 + s15) as f64, tx);
            let c3333 = hermite(*old.add(3 + s12) as f64, *old.add(3 + s13) as f64, *old.add(3 + s14) as f64, *old.add(3 + s15) as f64, tx);

            *u8.offset(offset) = hermite(c0, c1, c2, c3, ty) as u8;
            *u8.offset(1 + offset) = hermite(c00, c11, c22, c33, ty) as u8;
            *u8.offset(2 + offset) = hermite(c000, c111, c222, c333, ty) as u8;
            *u8.offset(3 + offset) = hermite(c0000, c1111, c2222, c3333, ty) as u8;
          }

          offset += 4;
        };
      };

      return fb;
    }
  }

  pub mod blur {
    use super::*;

    pub fn gaussian(fb: &mut fb, sigma: f32) {
      let cof = {
        let a = (0.726f32).powi(2).exp() / sigma;

        let l = (-a).exp();
        let c = (-a * 2.0).exp();
        let k = (1.0 - l).powi(2) / (1.0 - c + a * l * 2.0);

        let a3 = c * -k;
        let b1 = l * 2.0;
        let a1 = l * k * (a - 1.0);
        let a2 = l * k * (a + 1.0);
        (k, a1, a2, a3, b1, -c, (k + a1) / (c - b1 + 1.0), (a2 + a3) / (c - b1 + 1.0))
      };

      let width = fb.width;
      let height = fb.height;
      unsafe { gcb(fb, width, height, cof); }
    }

    #[cfg(not(target_feature = "simd128"))]
    unsafe fn gcb(fb: &mut fb, width: usize, height: usize, cof: (f32, f32, f32, f32, f32, f32, f32, f32)) {
      let u8 = fb.ptr_mut::<u8>();
      let o8 = ffi::mem::alloc(fb.len());
      let f32 = ffi::mem::alloc(4 * 4 * width.max(height)) as *mut f32;

      u8.copy_to(o8, fb.len());
      gc(o8, u8, f32, width, height, cof);
      gc(u8, o8, f32, height, width, cof);

      ffi::mem::free(o8, fb.len());
      ffi::mem::free(f32 as *mut u8, 4 * 4 * width.max(height));
    }

    #[cfg(target_arch = "wasm32")]
    #[cfg(target_feature = "simd128")]
    unsafe fn gcb(fb: &mut fb, width: usize, height: usize, cof: (f32, f32, f32, f32, f32, f32, f32, f32)) {
      let u8 = fb.ptr_mut::<u8>();
      let n32 = ffi::mem::alloc(4 * fb.len()) as *mut f32;

      for y in 0..height {
        let yoffset = y * width;

        for x in 0..width {
          let offset = 4 * (x + yoffset);
          *n32.add(offset) = *u8.add(offset) as f32;
          *n32.add(1 + offset) = *u8.add(1 + offset) as f32;
          *n32.add(2 + offset) = *u8.add(2 + offset) as f32;
          *n32.add(3 + offset) = *u8.add(3 + offset) as f32;
        }
      }

      let o32 = ffi::mem::alloc(4 * fb.len()) as *mut f32;
      let f32 = ffi::mem::alloc(4 * 4 * width.max(height)) as *mut f32;

      n32.copy_to(o32, fb.len());
      gcs(o32, n32, f32, width, height, cof);
      gcse(u8, o32, f32, height, width, cof);
      ffi::mem::free(n32 as *mut u8, 4 * fb.len());
      ffi::mem::free(o32 as *mut u8, 4 * fb.len());
      ffi::mem::free(f32 as *mut u8, 4 * 4 * width.max(height));
    }

    unsafe fn gcs(n32: *mut f32, o32: *mut f32, f32: *mut f32, width: usize, height: usize, (k, a1, a2, a3, b1, b2, lc, rc): (f32, f32, f32, f32, f32, f32, f32, f32)) {
      use std::arch::wasm32::*;

      let k = f32x4_splat(k);
      let a1 = f32x4_splat(a1);
      let a2 = f32x4_splat(a2);
      let a3 = f32x4_splat(a3);
      let b1 = f32x4_splat(b1);
      let b2 = f32x4_splat(b2);
      let lc = f32x4_splat(lc);
      let rc = f32x4_splat(rc);

      let width4 = 4 * width;
      let height4 = 4 * height;
      let hw1 = height * (width - 1);

      for y in 0..height {
        let mut toffset = 0;
        let mut ooffset = y * width4;
        let mut offset = 4 * (y + hw1);
        let mut po = v128_load(o32.add(ooffset) as *mut v128); let mut fu = f32x4_mul(lc, po); let mut tu = fu;

        for _ in 0..width {
          let co = v128_load(o32.add(ooffset) as *mut v128);
          let cu = f32x4_add(f32x4_add(f32x4_mul(k, co), f32x4_mul(a1, po)), f32x4_add(f32x4_mul(b1, fu), f32x4_mul(b2, tu)));

          tu = fu; fu = cu; po = co;
          v128_store(f32.offset(toffset) as *mut v128, fu);

          ooffset += 4;
          toffset += 4;
        }

        ooffset -= 4;
        toffset -= 4;

        let mut po = v128_load(o32.add(ooffset) as *mut v128); tu = f32x4_mul(rc, po); fu = tu; let mut co = po;

        for _ in 0..width {
          let cu = f32x4_add(f32x4_add(f32x4_mul(a2, co), f32x4_mul(a3, po)), f32x4_add(f32x4_mul(b1, fu), f32x4_mul(b2, tu)));

          tu = fu; fu = cu; po = co;
          co = v128_load(o32.add(ooffset) as *mut v128);
          v128_store(n32.add(offset) as _, f32x4_add(fu, v128_load(f32.offset(toffset) as *mut v128)));

          ooffset -= 4;
          toffset -= 4;
          offset -= height4;
        }
      }
    }

    unsafe fn gcse(u8: *mut u8, o32: *mut f32, f32: *mut f32, width: usize, height: usize, (k, a1, a2, a3, b1, b2, lc, rc): (f32, f32, f32, f32, f32, f32, f32, f32)) {
      use std::arch::wasm32::*;
      use std::intrinsics::{float_to_int_unchecked as fi};

      let k = f32x4_splat(k);
      let a1 = f32x4_splat(a1);
      let a2 = f32x4_splat(a2);
      let a3 = f32x4_splat(a3);
      let b1 = f32x4_splat(b1);
      let b2 = f32x4_splat(b2);
      let lc = f32x4_splat(lc);
      let rc = f32x4_splat(rc);

      let width4 = 4 * width;
      let height4 = 4 * height;
      let hw1 = height * (width - 1);

      for y in 0..height {
        let mut toffset = 0;
        let mut ooffset = y * width4;
        let mut offset = 4 * (y + hw1);
        let mut po = v128_load(o32.add(ooffset) as *mut v128); let mut fu = f32x4_mul(lc, po); let mut tu = fu;

        for _ in 0..width {
          let co = v128_load(o32.add(ooffset) as *mut v128);
          let cu = f32x4_add(f32x4_add(f32x4_mul(k, co), f32x4_mul(a1, po)), f32x4_add(f32x4_mul(b1, fu), f32x4_mul(b2, tu)));

          tu = fu; fu = cu; po = co;
          v128_store(f32.offset(toffset) as *mut v128, fu);

          ooffset += 4;
          toffset += 4;
        }

        ooffset -= 4;
        toffset -= 4;

        let mut po = v128_load(o32.add(ooffset) as *mut v128); tu = f32x4_mul(rc, po); fu = tu; let mut co = po;

        for _ in 0..width {
          let cu = f32x4_add(f32x4_add(f32x4_mul(a2, co), f32x4_mul(a3, po)), f32x4_add(f32x4_mul(b1, fu), f32x4_mul(b2, tu)));

          tu = fu; fu = cu; po = co;
          co = v128_load(o32.add(ooffset) as *mut v128);
          let f = &mut f32x4_add(fu, v128_load(f32.offset(toffset) as *mut v128)) as *mut v128 as *mut f32;

          *u8.add(offset) = fi(*f);
          *u8.add(1 + offset) = fi(*f.offset(1));
          *u8.add(2 + offset) = fi(*f.offset(2));
          *u8.add(3 + offset) = fi(*f.offset(3));

          ooffset -= 4;
          toffset -= 4;
          offset -= height4;
        }
      }
    }

    unsafe fn gc(u8: *mut u8, o8: *mut u8, f32: *mut f32, width: usize, height: usize, (k, a1, a2, a3, b1, b2, lc, rc): (f32, f32, f32, f32, f32, f32, f32, f32)) {
      use std::intrinsics::{fmul_fast as fm, fadd_fast as fa, float_to_int_unchecked as fi};

      let width4 = 4 * width;
      let height4 = 4 * height;
      let hw1 = height * (width - 1);

      for y in 0..height {
        let mut toffset = 0;
        let mut ooffset = y * width4;
        let mut offset = 4 * (y + hw1);

        let (mut por, mut pog, mut pob, mut poa) = (*o8.add(ooffset) as f32, *o8.add(1 + ooffset) as f32, *o8.add(2 + ooffset) as f32, *o8.add(3 + ooffset) as f32);
        let (mut fur, mut fug, mut fub, mut fua) = (fm(lc, por), fm(lc, pog), fm(lc, pob), fm(lc, poa)); let (mut tur, mut tug, mut tub, mut tua) = (fur, fug, fub, fua);

        for _ in 0..width {
          let (cor, cog, cob, coa) = (*o8.add(ooffset) as f32, *o8.add(1 + ooffset) as f32, *o8.add(2 + ooffset) as f32, *o8.add(3 + ooffset) as f32);
          let (cur, cug, cub, cua) = (fm(k, cor) + fm(a1, por) + fm(b1, fur) + fm(b2, tur), fm(k, cog) + fm(a1, pog) + fm(b1, fug) + fm(b2, tug), fm(k, cob) + fm(a1, pob) + fm(b1, fub) + fm(b2, tub), fm(k, coa) + fm(a1, poa) + fm(b1, fua) + fm(b2, tua));

          (tur, tug, tub, tua) = (fur, fug, fub, fua);
          (fur, fug, fub, fua) = (cur, cug, cub, cua);
          (por, pog, pob, poa) = (cor, cog, cob, coa);

          *f32.offset(toffset) = fur;
          *f32.offset(1 + toffset) = fug;
          *f32.offset(2 + toffset) = fub;
          *f32.offset(3 + toffset) = fua;

          ooffset += 4;
          toffset += 4;
        }

        ooffset -= 4;
        toffset -= 4;

        por = *o8.add(ooffset) as f32;
        pog = *o8.add(1 + ooffset) as f32;
        pob = *o8.add(2 + ooffset) as f32;
        poa = *o8.add(3 + ooffset) as f32;
        (tur, tug, tub, tua) = (fm(rc, por), fm(rc, pog), fm(rc, pob), fm(rc, poa));

        (fur, fug, fub, fua) = (tur, tug, tub, tua);
        let (mut cor, mut cog, mut cob, mut coa) = (por, pog, pob, poa);

        for _ in 0..width {
          let (cur, cug, cub, cua) = (fm(a2, cor) + fm(a3, por) + fm(b1, fur) + fm(b2, tur), fm(a2, cog) + fm(a3, pog) + fm(b1, fug) + fm(b2, tug), fm(a2, cob) + fm(a3, pob) + fm(b1, fub) + fm(b2, tub), fm(a2, coa) + fm(a3, poa) + fm(b1, fua) + fm(b2, tua));

          (tur, tug, tub, tua) = (fur, fug, fub, fua);
          (fur, fug, fub, fua) = (cur, cug, cub, cua);
          (por, pog, pob, poa) = (cor, cog, cob, coa);

          cor = *o8.add(ooffset) as f32;
          cog = *o8.add(1 + ooffset) as f32;
          cob = *o8.add(2 + ooffset) as f32;
          coa = *o8.add(3 + ooffset) as f32;
          *u8.add(offset) = fi(fa(fur, *f32.offset(toffset)));
          *u8.add(1 + offset) = fi(fa(fug, *f32.offset(1 + toffset)));
          *u8.add(2 + offset) = fi(fa(fub, *f32.offset(2 + toffset)));
          *u8.add(3 + offset) = fi(fa(fua, *f32.offset(3 + toffset)));

          ooffset -= 4;
          toffset -= 4;
          offset -= height4;
        }
      }
    }
  }
}

type fb = framebuffer;
type bfb = *mut framebuffer;

#[no_mangle] unsafe extern "C" fn free(fb: bfb) { ffi::ptr::drop(fb); }
#[no_mangle] unsafe extern "C" fn width(fb: bfb) -> usize { return (*fb).width; }
#[no_mangle] unsafe extern "C" fn height(fb: bfb) -> usize { return (*fb).height; }
#[no_mangle] unsafe extern "C" fn flip_vertical(fb: bfb) { ops::flip::vertical(&mut *fb); }
#[no_mangle] unsafe extern "C" fn flip_horizontal(fb: bfb) { ops::flip::horizontal(&mut *fb); }
#[no_mangle] unsafe extern "C" fn blur(fb: bfb, sigma: f32) { ops::blur::gaussian(&mut *fb, sigma); }
#[no_mangle] unsafe extern "C" fn buffer(fb: bfb) -> *mut u8 { return ffi::io::peek((*fb).slice()); }
#[no_mangle] unsafe extern "C" fn fill_color(fb: bfb, r: u8, g: u8, b: u8, a: u8) { ops::fill::color(&mut *fb, r, g, b, a); }
#[no_mangle] unsafe extern "C" fn overlay(fb: bfb, fg: bfb, x: isize, y: isize) { ops::overlay::blend(&mut *fb, &*fg, x, y); }
#[no_mangle] unsafe extern "C" fn replace(fb: bfb, fg: bfb, x: isize, y: isize) { ops::overlay::replace(&mut *fb, &*fg, x, y); }
#[no_mangle] unsafe extern "C" fn new(width: usize, height: usize) -> bfb { return ffi::ptr::pack(framebuffer::new(width, height)); }

#[no_mangle] unsafe extern "C" fn resize(fb: bfb, t: u8, width: usize, height: usize) -> bfb {
  return ffi::ptr::pack(match t {
    2 => ops::resize::cubic(&*fb, width, height),
    1 => ops::resize::linear(&*fb, width, height),
    0 => ops::resize::nearest(&*fb, width, height),

    _ => ffi::zzz::unreachable(),
  });
}
#![allow(dead_code)]
#![warn(clippy::perf)]
#![warn(clippy::complexity)]
#![warn(clippy::correctness)]
#![allow(non_camel_case_types)]
#![allow(non_upper_case_globals)]
#![feature(const_unreachable_unchecked)]
#![feature(option_result_unwrap_unchecked)]
#![feature(const_fn_floating_point_arithmetic)]

mod ffi;

pub struct framebuffer {
  width: usize,
  height: usize,
  ptr: ffi::any,
}

impl Drop for framebuffer {
  fn drop(&mut self) { ffi::mem::free(self.ptr_mut(), self.len()); }
}

impl framebuffer {
  fn new(width: usize, height: usize) -> Self { return Self { width, height, ptr: ffi::mem::alloc(4 * width * height) as ffi::any }; }

  fn ptr_mut<T>(&mut self) -> *mut T { return self.ptr as *mut T; }
  const fn ptr<T>(&self) -> *const T { return self.ptr as *const T; }
  const fn len(&self) -> usize { return 4 * self.width * self.height; }
  fn slice<T>(&self) -> &[T] { return unsafe { std::slice::from_raw_parts(self.ptr(), self.len() / std::mem::size_of::<T>()) }; }
  fn slice_mut<T>(&mut self) -> &mut [T] { return unsafe { std::slice::from_raw_parts_mut(self.ptr_mut(), self.len() / std::mem::size_of::<T>()) }; }
}

mod ops {
  use super::*;

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

        for x in 0..width {
          unsafe { *u32.add(x + yoffset) = *old.add(yyoffset + (xw * x as f64) as usize); }
        };
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
            *u8.add(offset) = lerp(lerp(*old.add(s0), *old.add(s2), tx), lerp(*old.add(s1), *old.add(s3), tx), ty);
            *u8.add(1 + offset) = lerp(lerp(*old.add(1 + s0), *old.add(1 + s2), tx), lerp(*old.add(1 + s1), *old.add(1 + s3), tx), ty);
            *u8.add(2 + offset) = lerp(lerp(*old.add(2 + s0), *old.add(2 + s2), tx), lerp(*old.add(2 + s1), *old.add(2 + s3), tx), ty);
            *u8.add(3 + offset) = lerp(lerp(*old.add(3 + s0), *old.add(3 + s2), tx), lerp(*old.add(3 + s1), *old.add(3 + s3), tx), ty);
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

            *u8.add(offset) = hermite(c0, c1, c2, c3, ty) as u8;
            *u8.add(1 + offset) = hermite(c00, c11, c22, c33, ty) as u8;
            *u8.add(2 + offset) = hermite(c000, c111, c222, c333, ty) as u8;
            *u8.add(3 + offset) = hermite(c0000, c1111, c2222, c3333, ty) as u8;
          }

          offset += 4;
        };
      };

      return fb;
    }
  }
}

type fb = framebuffer;
type bfb = *mut framebuffer;

#[no_mangle] unsafe extern "C" fn free(fb: bfb) { ffi::ptr::drop(fb); }
#[no_mangle] unsafe extern "C" fn width(fb: bfb) -> usize { return (*fb).width; }
#[no_mangle] unsafe extern "C" fn height(fb: bfb) -> usize { return (*fb).height; }
#[no_mangle] unsafe extern "C" fn buffer(fb: bfb) -> *mut u8 { return ffi::io::peek((*fb).slice()); }
#[no_mangle] unsafe extern "C" fn new(width: usize, height: usize) -> bfb { return ffi::ptr::pack(framebuffer::new(width, height)); }

#[no_mangle] unsafe extern "C" fn resize(fb: bfb, t: u8, width: usize, height: usize) -> bfb {
  return ffi::ptr::pack(match t {
    2 => ops::resize::cubic(&*fb, width, height),
    1 => ops::resize::linear(&*fb, width, height),
    0 => ops::resize::nearest(&*fb, width, height),

    _ => ffi::zzz::unreachable(),
  });
}
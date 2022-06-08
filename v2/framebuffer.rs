#![allow(dead_code)]
#![warn(clippy::perf)]
#![feature(decl_macro)]
#![feature(const_mut_refs)]
#![feature(unchecked_math)]
#![warn(clippy::complexity)]
#![feature(core_intrinsics)]
#![warn(clippy::correctness)]
#![allow(non_camel_case_types)]
#![feature(downcast_unchecked)]
#![allow(non_upper_case_globals)]
#![feature(const_slice_from_raw_parts)]
#![feature(const_fn_floating_point_arithmetic)]

macro size_of { ($type:ty) => { std::mem::size_of::<$type>() } }
#[inline] const fn alloc_len(size: usize) -> usize { return alloc_align(size).size(); }
#[inline(always)] const unsafe fn unreachable() -> ! { std::hint::unreachable_unchecked(); }
#[inline] fn alloc(size: usize) -> *mut u8 { unsafe { return std::alloc::alloc(alloc_align(size)); } }
#[inline] fn free(ptr: *mut u8, size: usize) { unsafe { std::alloc::dealloc(ptr, alloc_align(size)); } }
#[inline] fn calloc(size: usize) -> *mut u8 { unsafe { return std::alloc::alloc_zeroed(alloc_align(size)); } }
#[inline] const fn alloc_align(size: usize) -> std::alloc::Layout { return unsafe { std::alloc::Layout::from_size_align_unchecked(size, 16) }; }

type fb = framebuffer;

pub struct framebuffer {
  pub width: usize,
  pub height: usize,
  ptr: (bool, *mut u8),
}

unsafe impl Send for framebuffer {}
unsafe impl Sync for framebuffer {}

pub trait framebuffer_from<T> {
  fn from(width: usize, height: usize, container: T) -> fb;
}

impl Drop for framebuffer {
  fn drop(&mut self) { if self.ptr.0 { free(self.as_mut_ptr(), self.len()); } }
}

impl std::ops::Deref for framebuffer {
  type Target = [u8]; fn deref(&self) -> &Self::Target { return unsafe { std::slice::from_raw_parts(self.as_ptr(), self.len()) }; }
}

impl std::ops::DerefMut for framebuffer {
  fn deref_mut(&mut self) -> &mut Self::Target { return unsafe { std::slice::from_raw_parts_mut(self.as_mut_ptr(), self.len()) }; }
}

impl std::ops::IndexMut<(usize, usize)> for framebuffer {
  fn index_mut(&mut self, index: (usize, usize)) -> &mut Self::Output { return unsafe { &mut *(self.as_mut_ptr::<u32>().add(index.0 + index.1 * self.width) as *mut colors::rgba) }; }
}

impl std::ops::Index<(usize, usize)> for framebuffer {
  type Output = colors::rgba; fn index(&self, index: (usize, usize)) -> &Self::Output { return unsafe { &*(self.as_ptr::<u32>().add(index.0 + index.1 * self.width) as *mut colors::rgba) }; }
}

impl Clone for framebuffer {
  fn clone(&self) -> Self {
    let ptr = alloc(self.len());
    unsafe { self.ptr.1.copy_to_nonoverlapping(ptr, self.len()); }
    return Self { width: self.width, height: self.height, ptr: (true, ptr) };
  }
}


impl<T> framebuffer_from<*mut T> for *mut T { fn from(width: usize, height: usize, container: *mut T) -> fb { return fb { width, height, ptr: (false, container as *mut u8) }; } }
impl<T> framebuffer_from<&[T]> for &[T] { fn from(width: usize, height: usize, container: &[T]) -> fb { return fb { width, height, ptr: (false, container.as_ptr() as *mut u8) }; } }
impl<T> framebuffer_from<*const T> for *const T { fn from(width: usize, height: usize, container: *const T) -> fb { return fb { width, height, ptr: (false, container as *mut u8) }; } }
impl<T> framebuffer_from<&Vec<T>> for &Vec<T> { fn from(width: usize, height: usize, container: &Vec<T>) -> fb { return fb { width, height, ptr: (false, container.as_ptr() as *mut u8) }; } }
impl<T> framebuffer_from<&mut [T]> for &mut [T] { fn from(width: usize, height: usize, container: &mut [T]) -> fb { return fb { width, height, ptr: (false, container.as_mut_ptr() as *mut u8) }; } }
impl<T> framebuffer_from<&mut Vec<T>> for &mut Vec<T> { fn from(width: usize, height: usize, container: &mut Vec<T>) -> fb { return fb { width, height, ptr: (false, container.as_mut_ptr() as *mut u8) }; } }
impl framebuffer_from<colors::rgba> for colors::rgba { fn from(width: usize, height: usize, container: colors::rgba) -> fb { let mut fb = unsafe { framebuffer::new_uninit(width, height) }; ops::fill::color(&mut fb, container); return fb; } }
impl framebuffer_from<colors::rgb> for colors::rgb { fn from(width: usize, height: usize, container: colors::rgb) -> fb { let mut fb = unsafe { framebuffer::new_uninit(width, height) }; ops::fill::color(&mut fb, container.into()); return fb; } }
impl<F, T: ops::fill::fill_value> framebuffer_from<F> for F where F: Fn(usize, usize) -> T { fn from(width: usize, height: usize, container: F) -> fb { let mut fb = unsafe { framebuffer::new_uninit(width, height) }; ops::fill::function(&mut fb, container); return fb; } }


impl framebuffer {
  pub fn new(width: usize, height: usize) -> Self { return Self { width, height, ptr: (true, calloc(4 * width * height)) }; }
  pub fn from<T: framebuffer_from<T>>(width: usize, height: usize, container: T) -> Self { return T::from(width, height, container); }
  pub unsafe fn new_uninit(width: usize, height: usize) -> Self { return Self { width, height, ptr: (true, alloc(4 * width * height)) }; }

  pub const fn len(&self) -> usize { return 4 * self.width * self.height; }
  pub const fn as_ptr<T>(&self) -> *const T { return self.ptr.1 as *const T; }
  pub const fn as_mut_ptr<T>(&mut self) -> *mut T { return self.ptr.1 as *mut T; }
  pub const fn as_slice<T>(&self) -> &[T] { return unsafe { std::slice::from_raw_parts(self.as_ptr(), self.len() / size_of!(T)) }; }
  pub const fn as_mut_slice<T>(&mut self) -> &mut [T] { return unsafe { std::slice::from_raw_parts_mut(self.as_mut_ptr(), self.len() / size_of!(T)) }; }
  pub fn into_vec<T>(mut self) -> Vec<T> { self.ptr.0 = false; return unsafe { Vec::from_raw_parts(self.as_mut_ptr(), self.len() / size_of!(T), alloc_len(self.len()) / size_of!(T)) }; }
}

pub mod colors {
  #[repr(C)] #[derive(Copy, Clone, Debug)] pub struct rgb { pub r: u8, pub g: u8, pub b: u8 }
  #[repr(C)] #[derive(Copy, Clone, Debug)] pub struct rgba { pub r: u8, pub g: u8, pub b: u8, pub a: u8 }

  impl From<rgba> for rgb { #[inline] fn from(c: rgba) -> rgb { return rgb { r: c.r, g: c.g, b: c.b }; } }
  impl From<rgb> for rgba { #[inline] fn from(c: rgb) -> rgba { return rgba { r: c.r, g: c.g, b: c.b, a: 255 }; } }
  impl From<rgb> for u32 { #[inline] fn from(c: rgb) -> u32 { return c.r as u32 | ((c.g as u32) << 8) | ((c.b as u32) << 16) | (255 << 24); } }
  impl From<rgba> for u32 { #[inline] fn from(c: rgba) -> u32 { return c.r as u32 | ((c.g as u32) << 8) | ((c.b as u32) << 16) | ((c.a as u32) << 24); } }
  impl From<u32> for rgb { #[inline] fn from(c: u32) -> rgb { return rgb { r: (c & 0xFF) as u8, g: ((c >> 8) & 0xFF) as u8, b: ((c >> 16) & 0xFF) as u8 }; } }
  impl From<u32> for rgba { #[inline] fn from(c: u32) -> rgba { return rgba { r: (c & 0xFF) as u8, g: ((c >> 8) & 0xFF) as u8, b: ((c >> 16) & 0xFF) as u8, a: (c >> 24) as u8 }; } }

  pub fn blend(bg: u32, fg: u32) -> u32 {
    let fa = fg >> 24;
    let alpha = 1 + fa;
    let inv_alpha = 256 - fa;
    let r = (alpha * (fg & 0xff) + inv_alpha * (bg & 0xff)) >> 8;
    let g = (alpha * ((fg >> 8) & 0xff) + inv_alpha * ((bg >> 8) & 0xff)) >> 8;
    let b = (alpha * ((fg >> 16) & 0xff) + inv_alpha * ((bg >> 16) & 0xff)) >> 8;
    return r | ((g & 0xff) << 8) | ((b & 0xff) << 16) | (fa.max(bg >> 24) << 24);
  }
}

pub mod ops {
  use super::*;

  pub mod filter {
    use super::*;

    pub fn opacity(fb: &mut fb, mut amount: f32) {
      amount = amount.clamp(0.0, 1.0);
      let u8 = unsafe { fb.as_mut_ptr::<u8>().offset(3) };

      let mut offset = 0;
      let len = fb.len();
      while len > offset {
        use std::intrinsics::{fmul_fast as fm, float_to_int_unchecked as fi};
        unsafe { *u8.add(offset) = fi::<f32, u8>(fm(amount, *u8.add(offset) as f32)); }

        offset += 4;
      }
    }

    pub fn brightness(fb: &mut fb, amount: f32) {
      let u32 = fb.as_mut_ptr::<u32>();

      for o in 0..(fb.len() / 4) {
        unsafe {
          use std::intrinsics::{fmul_fast as fm, float_to_int_unchecked as fi};

          let c = *u32.add(o);
          let r = fi::<f32, u32>(fm(amount, (c & 0xff) as f32)).min(255);
          let g = fi::<f32, u32>(fm(amount, ((c >> 8) & 0xff) as f32)).min(255);
          let b = fi::<f32, u32>(fm(amount, ((c >> 16) & 0xff) as f32)).min(255);

          *u32.add(o) = r | (g << 8) | (b << 16) | (c >> 24 << 24);
        }
      }
    }

    pub fn contrast(fb: &mut fb, amount: f32) {
      let u32 = fb.as_mut_ptr::<u32>();
      let i = 255.0 * (0.5 - (0.5 * amount));

      for o in 0..(fb.len() / 4) {
        unsafe {
          use std::intrinsics::{fadd_fast as fa, fmul_fast as fm, float_to_int_unchecked as fi};

          let c = *u32.add(o);
          let r = fi::<f32, u32>(fa(i, fm(amount, (c & 0xff) as f32))).min(255);
          let g = fi::<f32, u32>(fa(i, fm(amount, ((c >> 8) & 0xff) as f32))).min(255);
          let b = fi::<f32, u32>(fa(i, fm(amount, ((c >> 16) & 0xff) as f32))).min(255);

          *u32.add(o) = r | (g << 8) | (b << 16) | (c >> 24 << 24);
        }
      }
    }

    pub fn saturate(fb: &mut fb, amount: f32) {
      let u32 = fb.as_mut_ptr::<u32>();

      let filter: [f32; 9] = [
        0.213 + 0.787 * amount, 0.715 - 0.715 * amount, 0.072 - 0.072 * amount,
        0.213 - 0.213 * amount, 0.715 + 0.285 * amount, 0.072 - 0.072 * amount,
        0.213 - 0.213 * amount, 0.715 - 0.715 * amount, 0.072 + 0.928 * amount,
      ];

      for o in 0..(fb.len() / 4) {
        unsafe {
          use std::intrinsics::{fadd_fast as fa, fmul_fast as fm, float_to_int_unchecked as fi};

          let c = *u32.add(o);
          let rr = (c & 0xff) as f32;
          let gg = ((c >> 8) & 0xff) as f32;
          let bb = ((c >> 16) & 0xff) as f32;
          let r = fi::<f32, u32>(fa(fm(rr, filter[0]), fa(fm(gg, filter[1]), fm(bb, filter[2])))).clamp(0, 255);
          let g = fi::<f32, u32>(fa(fm(rr, filter[3]), fa(fm(gg, filter[4]), fm(bb, filter[5])))).clamp(0, 255);
          let b = fi::<f32, u32>(fa(fm(rr, filter[6]), fa(fm(gg, filter[7]), fm(bb, filter[8])))).clamp(0, 255);

          *u32.add(o) = r | (g << 8) | (b << 16) | (c >> 24 << 24);
        }
      }
    }

    pub fn sepia(fb: &mut fb, mut amount: f32) {
      let u32 = fb.as_mut_ptr::<u32>();
      amount = (1.0 - amount).clamp(0.0, 1.0);

      let filter: [f32; 9] = [
        0.393 + 0.607 * amount, 0.769 - 0.769 * amount, 0.189 - 0.189 * amount,
        0.349 - 0.349 * amount, 0.686 + 0.314 * amount, 0.168 - 0.168 * amount,
        0.272 - 0.272 * amount, 0.534 - 0.534 * amount, 0.131 + 0.869 * amount,
      ];

      for o in 0..(fb.len() / 4) {
        unsafe {
          use std::intrinsics::{fadd_fast as fa, fmul_fast as fm, float_to_int_unchecked as fi};

          let c = *u32.add(o);
          let rr = (c & 0xff) as f32;
          let gg = ((c >> 8) & 0xff) as f32;
          let bb = ((c >> 16) & 0xff) as f32;
          let r = fi::<f32, u32>(fa(fm(rr, filter[0]), fa(fm(gg, filter[1]), fm(bb, filter[2])))).clamp(0, 255);
          let g = fi::<f32, u32>(fa(fm(rr, filter[3]), fa(fm(gg, filter[4]), fm(bb, filter[5])))).clamp(0, 255);
          let b = fi::<f32, u32>(fa(fm(rr, filter[6]), fa(fm(gg, filter[7]), fm(bb, filter[8])))).clamp(0, 255);

          *u32.add(o) = r | (g << 8) | (b << 16) | (c >> 24 << 24);
        }
      }
    }

    pub fn grayscale(fb: &mut fb, mut amount: f32) {
      let u32 = fb.as_mut_ptr::<u32>();
      amount = (1.0 - amount).clamp(0.0, 1.0);

      let filter: [f32; 9] = [
        0.2126 + 0.7874 * amount, 0.7152 - 0.7152 * amount, 0.0722 - 0.0722 * amount,
        0.2126 - 0.2126 * amount, 0.7152 + 0.2848 * amount, 0.0722 - 0.0722 * amount,
        0.2126 - 0.2126 * amount, 0.7152 - 0.7152 * amount, 0.0722 + 0.9278 * amount,
      ];

      for o in 0..(fb.len() / 4) {
        unsafe {
          use std::intrinsics::{fadd_fast as fa, fmul_fast as fm, float_to_int_unchecked as fi};

          let c = *u32.add(o);
          let rr = (c & 0xff) as f32;
          let gg = ((c >> 8) & 0xff) as f32;
          let bb = ((c >> 16) & 0xff) as f32;
          let r = fi::<f32, u32>(fa(fm(rr, filter[0]), fa(fm(gg, filter[1]), fm(bb, filter[2])))).clamp(0, 255);
          let g = fi::<f32, u32>(fa(fm(rr, filter[3]), fa(fm(gg, filter[4]), fm(bb, filter[5])))).clamp(0, 255);
          let b = fi::<f32, u32>(fa(fm(rr, filter[6]), fa(fm(gg, filter[7]), fm(bb, filter[8])))).clamp(0, 255);

          *u32.add(o) = r | (g << 8) | (b << 16) | (c >> 24 << 24);
        }
      }
    }

    pub fn hue_rotate(fb: &mut fb, deg: f32) {
      let u32 = fb.as_mut_ptr::<u32>();
      let cos = f32::cos(deg.to_radians());
      let sin = f32::sin(deg.to_radians());

      let filter: [f32; 9] = [
        0.213 + cos * 0.787 - sin * 0.213, 0.715 - cos * 0.715 - sin * 0.715, 0.072 - cos * 0.072 + sin * 0.928,
        0.213 - cos * 0.213 + sin * 0.143, 0.715 + cos * 0.285 + sin * 0.140, 0.072 - cos * 0.072 - sin * 0.283,
        0.213 - cos * 0.213 - sin * 0.787, 0.715 - cos * 0.715 + sin * 0.715, 0.072 + cos * 0.928 + sin * 0.072,
      ];

      for o in 0..(fb.len() / 4) {
        unsafe {
          use std::intrinsics::{fadd_fast as fa, fmul_fast as fm};
          #[cfg(any(target_arch = "x86", target_arch = "x86_64"))] const fn fi<_f, _i>(x: f32) -> u32 { return x as u32; }
          #[cfg(not(any(target_arch = "x86", target_arch = "x86_64")))] use std::intrinsics::{float_to_int_unchecked as fi};

          let c = *u32.add(o);
          let rr = (c & 0xff) as f32;
          let gg = ((c >> 8) & 0xff) as f32;
          let bb = ((c >> 16) & 0xff) as f32;
          let r = fi::<f32, u32>(fa(fm(rr, filter[0]), fa(fm(gg, filter[1]), fm(bb, filter[2])))).clamp(0, 255);
          let g = fi::<f32, u32>(fa(fm(rr, filter[3]), fa(fm(gg, filter[4]), fm(bb, filter[5])))).clamp(0, 255);
          let b = fi::<f32, u32>(fa(fm(rr, filter[6]), fa(fm(gg, filter[7]), fm(bb, filter[8])))).clamp(0, 255);

          *u32.add(o) = r | (g << 8) | (b << 16) | (c >> 24 << 24);
        }
      }
    }

    pub fn drop_shadow(fb: &mut fb, x: isize, y: isize, sigma: f32, color: Option<colors::rgba>) {
      let mut old = fb.clone();
      let u32 = old.as_mut_ptr::<u32>();
      ops::blur::gaussian(&mut old, sigma);

      if color.is_some() {
        unsafe {
          let cc: u32 = color.unwrap_unchecked().into();

          let ca = cc >> 24;
          let cc = cc & 0xffffff;

          for o in 0..(fb.len() / 4) {
            let c = *u32.add(o);
            if 0 != (c >> 24) { *u32.add(o) = cc | (c >> 24 << 24) }
          }

          if ca != 255 { ops::filter::opacity(&mut old, 1.0 / 255.0 * ca as f32); }
        }
      }

      ops::overlay::background(fb, &old, x, y);
    }

    pub fn invert(fb: &mut fb, mut amount: f32) {
      let u32 = fb.as_mut_ptr::<u32>();
      amount = amount.clamp(0.0, 1.0);

      if 1.0 == amount {
        for o in 0..(fb.len() / 4) {
          unsafe {
            let c = *u32.add(o);
            *u32.add(o) = !c & 0xffffff | (c >> 24 << 24);
          }
        }
      }

      else {
        let inv = 1.0 - amount;

        for o in 0..(fb.len() / 4) {
          use std::intrinsics::{fadd_fast as fa, fsub_fast as fs, fmul_fast as fm, float_to_int_unchecked as fi};

          unsafe {
            let c = *u32.add(o);
            let r = (c & 0xff) as f32;
            let g = ((c >> 8) & 0xff) as f32;
            let b = ((c >> 16) & 0xff) as f32;
            let r = fi::<f32, u32>(fa(fm(r, amount), fm(inv, fs(255.0, r))));
            let g = fi::<f32, u32>(fa(fm(g, amount), fm(inv, fs(255.0, g))));
            let b = fi::<f32, u32>(fa(fm(b, amount), fm(inv, fs(255.0, b))));
            *u32.add(o) = r | ((g & 0xff) << 8) | ((b & 0xff) << 16) | (c >> 24 << 24);
          }
        }
      }
    }
  }

  pub mod crop {
    use super::*;
    use std::ops::Neg;

    pub fn r#box(fb: &fb, x: isize, y: isize, width: usize, height: usize) -> fb {
      let old = fb;
      let mut fb = fb::new(width, height);
      ops::overlay::replace(&mut fb, old, x.neg(), y.neg());

      return fb;
    }
  }

  pub mod flip {
    use super::*;

    pub fn horizontal(fb: &mut fb) {
      let width = fb.width;
      let height = fb.height;
      let u32 = fb.as_mut_ptr::<u32>();
      for y in 0..height { unsafe { std::slice::from_raw_parts_mut(u32.add(y * width), width).reverse(); } }
    }

    pub fn vertical(fb: &mut fb) {
      let width = fb.width;
      let height = fb.height;
      let u32 = fb.as_mut_ptr::<u32>();

      for y in 0..(height / 2) {
        let yoffset = y * width;
        let yboffset = width * (height - 1 - y);
        for x in 0..width { unsafe { std::ptr::swap(u32.add(x + yoffset), u32.add(x + yboffset)) }; }
      }
    }
  }

  pub mod fill {
    use super::*;

    pub trait fill_value { fn value(self) -> u32; }
    impl fill_value for u32 { fn value(self) -> u32 { return self; } }
    impl fill_value for colors::rgb { fn value(self) -> u32 { return self.into(); } }
    impl fill_value for colors::rgba { fn value(self) -> u32 { return self.into(); } }

    pub fn function<F, T: fill_value>(fb: &mut fb, f: F) where F: Fn(usize, usize) -> T {
      let width = fb.width;
      let height = fb.height;
      let u32 = fb.as_mut_ptr::<u32>();

      for y in 0..height {
        let yoffset = y * width;
        for x in 0..width { unsafe { *u32.add(x + yoffset) = f(x, y).value(); } }
      }
    }

    pub fn color(fb: &mut fb, color: colors::rgba) {
      if color.r == color.g && color.r == color.b && color.r == color.a { unsafe { fb.as_mut_ptr::<u8>().write_bytes(color.r, fb.len()); } }

      else {
        let width = fb.width;
        let height = fb.height;
        let u32 = fb.as_mut_ptr::<u32>();
        unsafe { std::slice::from_raw_parts_mut(u32, width).fill(color.into()); }
        for y in 1..height { unsafe { u32.copy_to_nonoverlapping(u32.add(y * width), width); } }
      }
    }

    pub fn background(fb: &mut fb, color: colors::rgba) {
      let width = fb.width;
      let bg = color.into();
      let height = fb.height;
      let u32 = fb.as_mut_ptr::<u32>();

      for y in 0..height {
        let yoffset = y * width;

        for x in 0..width {
          unsafe {
            let fg = *u32.add(x + yoffset);

            match (fg >> 24) & 0xff {
              0xff => {},
              0x00 => *u32.add(x + yoffset) = bg,
              _ => *u32.add(x + yoffset) = colors::blend(bg, fg),
            }
          }
        }
      }
    }
  }

  pub mod rotate {
    use super::*;

    pub fn rotate180(fb: &mut fb) {
      fb.as_mut_slice::<u32>().reverse();
    }

    pub fn rotate90(fb: &mut fb) {
      let width = fb.width;
      let height = fb.height;
      let u32 = fb.as_mut_ptr::<u32>();
      let o32 = alloc(fb.len()) as *mut u32;
      unsafe { u32.copy_to_nonoverlapping(o32, fb.len() / 4); }


      fb.width = height;
      fb.height = width;

      for y in 0..height {
        let yoffset = y * width;
        let heighty1 = height - 1 - y;
        for x in 0..width { unsafe { *u32.add(heighty1 + x * height) = *o32.add(x + yoffset); } }
      }

      free(o32 as *mut u8, fb.len());
    }

    pub fn rotate270(fb: &mut fb) {
      let width = fb.width;
      let height = fb.height;
      let u32 = fb.as_mut_ptr::<u32>();
      let o32 = alloc(fb.len()) as *mut u32;
      unsafe { u32.copy_to_nonoverlapping(o32, fb.len() / 4); }

      fb.width = height;
      fb.height = width;

      for y in 0..height {
        let yoffset = y * width;
        for x in 0..width { unsafe { *u32.add(y + height * (width - 1 - x)) = *o32.add(x + yoffset); } }
      }

      free(o32 as *mut u8, fb.len());
    }
  }

  pub mod overlay {
    use super::*;

    pub fn replace(fb: &mut fb, fg: &fb, x: isize, y: isize) {
      let f32 = fg.as_ptr::<u32>();
      let b32 = fb.as_mut_ptr::<u32>();
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
      let f32 = fg.as_ptr::<u32>();
      let b32 = fb.as_mut_ptr::<u32>();
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

            match fg >> 24 {
              0x00 => {},
              0xff => *b32.offset(xx + yoffset) = fg,

              fa => {
                let alpha = 1 + fa;
                let inv_alpha = 256 - fa;
                let bg = *b32.offset(xx + yoffset);
                let r = (alpha * (fg & 0xff) + inv_alpha * (bg & 0xff)) >> 8;
                let g = (alpha * ((fg >> 8) & 0xff) + inv_alpha * ((bg >> 8) & 0xff)) >> 8;
                let b = (alpha * ((fg >> 16) & 0xff) + inv_alpha * ((bg >> 16) & 0xff)) >> 8;
                *b32.offset(xx + yoffset) = r | ((g & 0xff) << 8) | ((b & 0xff) << 16) | (fa.max(bg >> 24) << 24);
              },
            }
          }
        }
      }
    }

    pub fn background(fb: &mut fb, bg: &fb, x: isize, y: isize) {
      let bb32 = bg.as_ptr::<u32>();
      let b32 = fb.as_mut_ptr::<u32>();
      let (bw, bh) = (fb.width as isize, fb.height as isize);
      let (fw, fh) = (bg.width as isize, bg.height as isize);

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
            let fg = *b32.offset(xx + yoffset);

            match fg >> 24 {
              0xff => {},
              0x00 => *b32.offset(xx + yoffset) = *bb32.offset(xx + yyoffset),

              fa => {
                let alpha = 1 + fa;
                let inv_alpha = 256 - fa;
                let bg = *bb32.offset(xx + yyoffset);
                let r = (alpha * (fg & 0xff) + inv_alpha * (bg & 0xff)) >> 8;
                let g = (alpha * ((fg >> 8) & 0xff) + inv_alpha * ((bg >> 8) & 0xff)) >> 8;
                let b = (alpha * ((fg >> 16) & 0xff) + inv_alpha * ((bg >> 16) & 0xff)) >> 8;
                *b32.offset(xx + yoffset) = r | ((g & 0xff) << 8) | ((b & 0xff) << 16) | (fa.max(bg >> 24) << 24);
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
      let o32 = fb.as_ptr::<u32>();
      let mut fb = unsafe { framebuffer::new_uninit(width, height) };

      let u32 = fb.as_mut_ptr::<u32>();
      let xw = 1.0 / width as f64 * owidth as f64;
      let yw = 1.0 / height as f64 * oheight as f64;

      for y in 0..height {
        let yoffset = y * width;
        let yyoffset = owidth * (yw * y as f64) as usize;
        for x in 0..width { unsafe { *u32.add(x + yoffset) = *o32.add(yyoffset + (xw * x as f64) as usize); } };
      };

      return fb;
    }

    pub unsafe fn linear(fb: &fb, width: usize, height: usize) -> fb {
      let owidth = fb.width;
      let oheight = fb.height;
      let o8 = fb.as_ptr::<u8>();
      let mut fb = framebuffer::new(width, height);

      let mut offset = 0;
      let u8 = fb.as_mut_ptr::<u8>();
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

          // unsafe {
            *u8.offset(offset) = lerp(lerp(*o8.add(s0), *o8.add(s2), tx), lerp(*o8.add(s1), *o8.add(s3), tx), ty);
            *u8.offset(1 + offset) = lerp(lerp(*o8.add(1 + s0), *o8.add(1 + s2), tx), lerp(*o8.add(1 + s1), *o8.add(1 + s3), tx), ty);
            *u8.offset(2 + offset) = lerp(lerp(*o8.add(2 + s0), *o8.add(2 + s2), tx), lerp(*o8.add(2 + s1), *o8.add(2 + s3), tx), ty);
            *u8.offset(3 + offset) = lerp(lerp(*o8.add(3 + s0), *o8.add(3 + s2), tx), lerp(*o8.add(3 + s1), *o8.add(3 + s3), tx), ty);
          // }

          offset += 4;
        };
      };

      return fb;
    }

    pub unsafe fn cubic(fb: &fb, width: usize, height: usize) -> fb {
      let owidth = fb.width;
      let oheight = fb.height;
      let o8 = fb.as_ptr::<u8>();
      let mut fb = framebuffer::new(width, height);

      let mut offset = 0;
      let u8 = fb.as_mut_ptr::<u8>();
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

          // unsafe {
            let c0 = hermite(*o8.add(s0) as f64, *o8.add(s1) as f64, *o8.add(s2) as f64, *o8.add(s3) as f64, tx);
            let c00 = hermite(*o8.add(1 + s0) as f64, *o8.add(1 + s1) as f64, *o8.add(1 + s2) as f64, *o8.add(1 + s3) as f64, tx);
            let c000 = hermite(*o8.add(2 + s0) as f64, *o8.add(2 + s1) as f64, *o8.add(2 + s2) as f64, *o8.add(2 + s3) as f64, tx);
            let c0000 = hermite(*o8.add(3 + s0) as f64, *o8.add(3 + s1) as f64, *o8.add(3 + s2) as f64, *o8.add(3 + s3) as f64, tx);

            let c1 = hermite(*o8.add(s4) as f64, *o8.add(s5) as f64, *o8.add(s6) as f64, *o8.add(s7) as f64, tx);
            let c11 = hermite(*o8.add(1 + s4) as f64, *o8.add(1 + s5) as f64, *o8.add(1 + s6) as f64, *o8.add(1 + s7) as f64, tx);
            let c111 = hermite(*o8.add(2 + s4) as f64, *o8.add(2 + s5) as f64, *o8.add(2 + s6) as f64, *o8.add(2 + s7) as f64, tx);
            let c1111 = hermite(*o8.add(3 + s4) as f64, *o8.add(3 + s5) as f64, *o8.add(3 + s6) as f64, *o8.add(3 + s7) as f64, tx);

            let c2 = hermite(*o8.add(s8) as f64, *o8.add(s9) as f64, *o8.add(s10) as f64, *o8.add(s11) as f64, tx);
            let c22 = hermite(*o8.add(1 + s8) as f64, *o8.add(1 + s9) as f64, *o8.add(1 + s10) as f64, *o8.add(1 + s11) as f64, tx);
            let c222 = hermite(*o8.add(2 + s8) as f64, *o8.add(2 + s9) as f64, *o8.add(2 + s10) as f64, *o8.add(2 + s11) as f64, tx);
            let c2222 = hermite(*o8.add(3 + s8) as f64, *o8.add(3 + s9) as f64, *o8.add(3 + s10) as f64, *o8.add(3 + s11) as f64, tx);

            let c3 = hermite(*o8.add(s12) as f64, *o8.add(s13) as f64, *o8.add(s14) as f64, *o8.add(s15) as f64, tx);
            let c33 = hermite(*o8.add(1 + s12) as f64, *o8.add(1 + s13) as f64, *o8.add(1 + s14) as f64, *o8.add(1 + s15) as f64, tx);
            let c333 = hermite(*o8.add(2 + s12) as f64, *o8.add(2 + s13) as f64, *o8.add(2 + s14) as f64, *o8.add(2 + s15) as f64, tx);
            let c3333 = hermite(*o8.add(3 + s12) as f64, *o8.add(3 + s13) as f64, *o8.add(3 + s14) as f64, *o8.add(3 + s15) as f64, tx);

            *u8.offset(offset) = hermite(c0, c1, c2, c3, ty) as u8;
            *u8.offset(1 + offset) = hermite(c00, c11, c22, c33, ty) as u8;
            *u8.offset(2 + offset) = hermite(c000, c111, c222, c333, ty) as u8;
            *u8.offset(3 + offset) = hermite(c0000, c1111, c2222, c3333, ty) as u8;
          // }

          offset += 4;
        };
      };

      return fb;
    }
  }

  pub mod blur {
    use super::*;

    pub fn gaussian(fb: &mut fb, sigma: f32) {
      if 0.0 == sigma { return; }

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

      unsafe {
        let o8 = alloc(fb.len());
        let u8 = fb.as_mut_ptr::<u8>();
        let f32 = alloc(4 * 4 * width.max(height)) as *mut f32;

        u8.copy_to(o8, fb.len());
        gc(o8, u8, f32, width, height, cof);
        gc(u8, o8, f32, height, width, cof);

        free(o8, fb.len());
        free(f32 as *mut u8, 4 * 4 * width.max(height));
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

          ooffset = ooffset.saturating_sub(4);
          toffset = toffset.saturating_sub(4);
          offset = offset.saturating_sub(height4);
        }
      }
    }
  }
}

pub mod quant {
  use super::*;

  struct bin { r: u32, g: u32, b: u32, a: u32, count: u32 }

  struct tbin {
    n: u32, p: u32,
    r: f32, g: f32, b: f32, a: f32,
    la: u32, lb: u32, error: f32, count: f32, nearest: u32,
  }

  pub struct result {
    pub index: Vec<u8>,
    pub palette: Vec<colors::rgba>,
    pub transparency: Option<usize>,
  }

  pub struct options {
    pub fast: bool,
    pub dither: bool,
    pub colors: usize,
    pub transparency: bool,
    pub threshold: Option<u8>,
    pub force_transparency: bool,
  }

  impl Default for options {
    fn default() -> Self {
      return Self {
        fast: false,
        colors: 256,
        dither: true,
        threshold: None,
        transparency: true,
        force_transparency: false,
      };
    }
  }

  unsafe fn index(fb: &fb, _colors: usize, opt: &options,  palette: &[colors::rgba], s: &(f32, f32, f32, f32)) -> Vec<u8> {
    let mut index: Vec<u8> = Vec::with_capacity(fb.width * fb.height);

    let u8 = index.as_mut_ptr();
    let u32 = fb.as_ptr::<u32>();
    index.set_len(fb.width * fb.height);
    let mut nearest: fnv::FnvHashMap<u32, u8> = fnv::FnvHashMap::default();
    let mut closest: fnv::FnvHashMap<u32, (u8, u8, f32, f32)> = fnv::FnvHashMap::default();

    if opt.fast { for o in 0..(fb.len() / 4) { *u8.add(o) = self::nearest(*u32.add(o), &palette, &s, &mut nearest); } }
    else { for o in 0..(fb.len() / 4) { *u8.add(o) = self::closest(*u32.add(o), o, &palette, &s, &mut nearest, &mut closest); } }

    return index;
  }

  unsafe fn link_neareast(o: usize, bins: *mut tbin, s: &(f32, f32, f32, f32)) {
    let mut nearest = 0;
    let mut e = f32::INFINITY;
    let bin = &mut *bins.add(o);

    let n1 = bin.count;
    let mut offset = bin.n;
    let w = (bin.r, bin.g, bin.b, bin.a);

    while 0 != offset {
      let b = &*bins.add(offset as usize);

      let mut err =
        s.0 * (b.r - w.0).powi(2)
        + s.1 * (b.g - w.1).powi(2)
        + s.2 * (b.b - w.2).powi(2)
        + s.3 * (b.a - w.3).powi(2);

      let n2 = b.count;
      err *= (n1 * n2) / (n1 + n2);
      if e > err { e = err; nearest = offset; }
      offset = (*bins.offset(offset as isize)).n;
    }

    bin.error = e;
    bin.nearest = nearest;
  }

  unsafe fn nearest(c: u32, palette: &[colors::rgba], s: &(f32, f32, f32, f32), cache: &mut fnv::FnvHashMap<u32, u8>) -> u8 {
    let old = cache.get(&c);
    if old.is_some() { return *old.unwrap_unchecked(); }

    let a = (c >> 24) as f32;
    let r = (c & 0xff) as f32;
    let g = ((c >> 8) & 0xff) as f32;
    let b = ((c >> 16) & 0xff) as f32;

    let mut offset = 0;
    let p = palette.as_ptr();
    let mut m = f32::INFINITY;

    for o in 0..palette.len() {
      let cc = *p.add(o);
      let rr = cc.r as f32;
      let gg = cc.g as f32;
      let bb = cc.b as f32;
      let aa = cc.a as f32;
      let mut d = s.3 * (aa - a).powi(2);

      if d > m { continue; }
      d += s.0 * (rr - r).powi(2); if d > m { continue; }
      d += s.1 * (gg - g).powi(2); if d > m { continue; }
      d += s.2 * (bb - b).powi(2); if d > m { continue; }

      m = d; offset = o as u8;
    }

    cache.insert(c, offset); return offset;
  }

  unsafe fn closest(c: u32, o: usize, palette: &[colors::rgba], s: &(f32, f32, f32, f32), nearest: &mut fnv::FnvHashMap<u32, u8>, cache: &mut fnv::FnvHashMap<u32, (u8, u8, f32, f32)>) -> u8 {
    let old = cache.get(&c);

    let m = if old.is_some() { *old.unwrap_unchecked() } else {
      let a = (c >> 24) as f32;
      let r = (c & 0xff) as f32;
      let pp = palette.as_ptr();
      let g = ((c >> 8) & 0xff) as f32;
      let b = ((c >> 16) & 0xff) as f32;
      let mut m = (0u8, 0u8, f32::INFINITY, f32::INFINITY);

      for o in 0..palette.len() {
        let cc = *pp.add(o);
        let rr = cc.r as f32;
        let gg = cc.g as f32;
        let bb = cc.b as f32;
        let aa = cc.a as f32;
        let err = s.0 * (rr - r).powi(2) + s.1 * (gg - g).powi(2) + s.2 * (bb - b).powi(2) + s.3 * (aa - a).powi(2);
        if m.2 > err { m.1 = m.0; m.3 = m.2; m.2 = err; m.0 = o as u8; } else if m.3 > err { m.3 = err; m.1 = o as u8; }
      }

      if m.3 == f32::INFINITY { m.1 = m.0; } cache.insert(c, m); m
    };

    let l = palette.len();
    let mut oo = (1 + o) % 2;
    if m.3 * 0.67 < (m.3 - m.2) { oo = 0 } else if m.0 > m.1 { oo = o % 2; }

    let err = match oo { 0 => m.2, 1 => m.3, _ => unreachable() };
    if err >= l as f32 { return self::nearest(c, palette, s, nearest); }

    return match oo { 0 => m.0, 1 => m.1, _ => unreachable() };
  }

  pub fn quantize(fb: &fb, options: &options) -> result {
    let width = fb.width;
    let height = fb.height;
    let mut fb = fb.clone();
    let u32 = fb.as_mut_ptr::<u32>();
    let colors = options.colors.clamp(2, 256);
    let mut s = (0.2126, 0.7152, 0.0722, 0.3333);

    if 32 >= colors { s = (1.0, 1.0, 1.0, 1.0); }
    else if 512 > width || 512 > height { s = (0.299, 0.587, 0.114, s.3); }

    unsafe {
      if !options.transparency {
        s.3 = 0.0;
        let threshold = options.threshold.unwrap_or(0x42) as u32;

        for o in 0..(fb.len() / 4) {
          let a = *u32.add(o) >> 24;
          *u32.add(0) = (if a < threshold { 0 } else { *u32.add(o) & 0xffffff }) | (255 << 24);
        }
      } else {
        if options.threshold.is_none() {
          for o in 0..(fb.len() / 4) {
            let a = *u32.add(o) >> 24;
            if a == 0 { *u32.add(0) = 0xffffff; }
          }
        } else {
          let threshold = options.threshold.unwrap_unchecked() as u32;

          for o in 0..(fb.len() / 4) {
            let a = *u32.add(o) >> 24;
            *u32.add(0) = if a < threshold { 0xffffff } else { *u32.add(o) & 0xffffff | (255 << 24) };
          }
        }
      }
    }

    let mut palette: Vec<colors::rgba> = vec![0.into(); colors];

    if 2 < colors {
      let (mut s, p) = unsafe { self::palette(&fb, colors, &options, &mut s) };

      unsafe {
        let ss = s;
        let mut t = -1;
        for o in 0..s { if 0 == (*p.add(o) >> 24) { t = o as isize; break; } }
        if t == -1 && options.transparency && options.force_transparency { *p.add(if s == colors { s - 1 } else { s += 1; s - 1 }) = 0; }

        palette.as_mut_ptr().copy_from_nonoverlapping(p as _, s); palette.set_len(s);

        free(p as *mut u8, ss);
        palette.sort_by(|&a, &b| u32::cmp(&b.into(), &a.into()));
      }
    } else {
      unsafe {
        *palette.get_unchecked_mut(0) = colors::rgba { r: 0, g: 0, b: 0, a: 255 };

        let mut t = options.transparency && options.force_transparency;
        if !t && options.transparency { for o in 0..(fb.len() / 4) { if 0 == (*u32.add(o) >> 24) { t = true; break; } } }

        *palette.get_unchecked_mut(1) =
          if t { colors::rgba { r: 255, g: 255, b: 255, a: 0 } }
          else { colors::rgba { r: 255, g: 255, b: 255, a: 255 } };
      }
    }

    let mut t = None;
    let index = unsafe { index(&fb, colors, &options, &palette, &s) };
    for o in 0..palette.len() { if 0 == palette[o].a { t = Some(o); break; } }

    return result {
      index,
      palette,
      transparency: t,
    };
  }

  unsafe fn palette(fb: &fb, colors: usize, options: &options, s: &mut (f32, f32, f32, f32)) -> (usize, *mut u32) {
    let u32 = fb.as_ptr::<u32>();
    const BINS: usize = 2usize.pow(16);

    let (size, bins): (usize, *mut tbin) = {
      let bins = calloc(BINS * size_of!(bin)) as *mut bin;

      let index = match options.fast {
        true => |r: u32, g: u32, b: u32, a: u32| ((r & 0xF0) << 4) | (g & 0xF0) | (b >> 4) | ((a & 0xF0) << 8),

        false => match 64 <= colors && !options.transparency {
          true => |r: u32, g: u32, b: u32, _: u32| ((r & 0xf8) << 8) | ((g & 0xfc) << 3) | (b >> 3),
          false => |r: u32, g: u32, b: u32, a: u32| ((r & 0xf8) << 7) | ((g & 0xf8) << 2) | (b >> 3) | ((a & 0x80) << 8),
        },
      };

      for o in 0..(fb.len() / 4) {
        let c = *u32.add(o);

        let a = c >> 24;
        let r = c & 0xff;
        let g = (c >> 8) & 0xff;
        let b = (c >> 16) & 0xff;

        let mut bin = &mut *bins.add(index(r, g, b, a) as usize);

        bin.r += r;
        bin.g += g;
        bin.b += b;
        bin.a += a;
        bin.count += 1;
      }

      let mut size = 0;

      for o in 0..BINS {
        let bin = bins.add(o);
        if 0 == (*bin).count { continue; }
        bins.add(size).copy_from(bin, 1); size += 1;
      }

      let tbin = calloc(size * size_of!(tbin)) as *mut tbin;

      for o in 0..size {
        use std::intrinsics::{fdiv_fast as fd};

        let bin = &*bins.add(o);
        let tbin = &mut *tbin.add(o);

        let count = bin.count as f32;

        tbin.count = count;
        tbin.r = fd(bin.r as f32, count);
        tbin.g = fd(bin.g as f32, count);
        tbin.b = fd(bin.b as f32, count);
        tbin.a = fd(bin.a as f32, count);
      }

      free(bins as *mut u8, BINS * size_of!(bin));

      (size, tbin)
    };

    let q = {
      let weight = colors as f32 / size as f32;
      let mut e = if 16 <= colors { 1 } else { -1 };
      if 0.003 < weight && 0.005 > weight { e = 0; };

      if s.1 < 1.0 && 0.025 > weight {
        s.1 -= 3.0 * (0.025 + weight);
        s.2 += 3.0 * (0.025 + weight);
      }

      match e {
        0 => |count: f32| count,
        -1 => |count: f32| count.cbrt() as u32 as f32,
  
        1 => match 64 > colors {
          true => |count: f32| count.sqrt(),
          false => |count: f32| count.sqrt() as u32 as f32,
        },

        _ => unreachable(),
      }
    };

    for o in 0..(size - 1) {
      let bin = &mut *bins.add(o);

      bin.n = (o + 1) as u32;
      bin.count = q(bin.count);
      (*bins.add(o + 1)).p = o as u32;
    }

    (*bins.add(size - 1)).count = q((*bins.add(size - 1)).count);

    let heap = calloc(4 * (1 + BINS)) as *mut u32;

    for o in 0..size {
      link_neareast(o, bins, &s);
      let err = (*bins.add(o)).error;

      *heap += 1;
      let mut l = *heap;

      while 1 < l {
        let h = *heap.add((l >> 1) as usize);
        if err >= (*bins.add(h as usize)).error { break; }

        *heap.add(l as usize) = h; l >>= 1;
      }

      *heap.add(l as usize) = o as u32;
    }

    let ext = size as isize - colors as isize;

    for o in 0..ext {
      let mut b;

      loop {
        b = *heap.add(1);
        let tb = &mut *bins.add(b as usize);
        if (tb.la >= tb.lb) && (tb.la >= (*bins.add(tb.nearest as usize)).lb) { break; }

        if tb.lb == 0xffff {
          *heap -= 1;
          let h = 1 + *heap;
          b = *heap.add(h as usize);
          *heap.offset(1) = *heap.add(h as usize);
        } else { link_neareast(b as usize, bins, &s); tb.la = o as u32; }

        let mut l = 1;
        let err = (*bins.add(b as usize)).error;

        while l + l <= *heap {
          let mut l2 = l + l;
          if (l2 < *heap) && ((*bins.add(*heap.add(l2 as usize) as usize)).error > (*bins.add(*heap.add(1 + l2 as usize) as usize)).error) { l2 += 1 }

          let h = *heap.add(l2 as usize);
          if err <= (*bins.add(h as usize)).error { break; }

          *heap.add(l as usize) = h; l = l2;
        }

        *heap.add(l as usize) = b;
      }

      let tb = &mut *bins.add(b as usize);
      let nb = &mut *bins.add(tb.nearest as usize);

      let n1 = tb.count;
      let n2 = nb.count;
      let d = 1.0 / (n1 + n2);
      tb.r = d * (n1 * tb.r + n2 * nb.r).round();
      tb.g = d * (n1 * tb.g + n2 * nb.g).round();
      tb.b = d * (n1 * tb.b + n2 * nb.b).round();
      tb.a = d * (n1 * tb.a + n2 * nb.a).round();

      nb.lb = 0xffff;
      tb.count += nb.count;
      tb.lb = (o + 1) as u32;

      (*bins.add(nb.p as usize)).n = nb.n;
      (*bins.add(nb.n as usize)).p = nb.p;
    }

    free(heap as *mut u8, 4 * (1 + BINS));
    let s = if 0 > ext { size } else { colors };
    let palette = alloc(s * size_of!(colors::rgba)) as *mut colors::rgba;

    let mut w = 0;
    let mut offset = 0;

    loop {
      let r = (*bins.add(offset)).r.clamp(0.0, 255.0) as u8;
      let g = (*bins.add(offset)).g.clamp(0.0, 255.0) as u8;
      let b = (*bins.add(offset)).b.clamp(0.0, 255.0) as u8;
      let a = (*bins.add(offset)).a.clamp(0.0, 255.0) as u8;

      *palette.add(w) = colors::rgba { r, g, b, a };

      w += 1;
      offset = (*bins.add(offset)).n as usize;

      if 0 == offset { break; }
    }

    return (s, palette as *mut u32);
  }
}
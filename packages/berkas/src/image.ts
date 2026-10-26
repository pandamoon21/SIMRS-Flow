/**
 * Just enough image handling for OCR, with no native dependency: greyscale,
 * integer downscale, quarter-turn rotation, a PNG encoder (node:zlib) and the
 * ECG-paper grid score. Pure functions over raw pixel buffers.
 */
import { deflateSync } from 'node:zlib';

export interface Gray {
  width: number;
  height: number;
  data: Uint8Array; // one byte per pixel
}

/** RGB(A) or grey pixels from the PDF → 8-bit grey (ITU-R 601 luma). */
export function toGray(data: Uint8Array | Uint8ClampedArray, width: number, height: number, channels: number): Gray {
  const out = new Uint8Array(width * height);
  if (channels === 1) {
    out.set(data.subarray(0, out.length));
  } else {
    for (let i = 0, p = 0; i < out.length; i++, p += channels) {
      out[i] = (data[p]! * 299 + data[p + 1]! * 587 + data[p + 2]! * 114) / 1000;
    }
  }
  return { width, height, data: out };
}

/** Box-average downscale so the longer side is at most `max` px (OCR is fine at ~2000 px). */
export function downscale(img: Gray, max: number): Gray {
  const factor = Math.ceil(Math.max(img.width, img.height) / max);
  if (factor <= 1) return img;
  const width = Math.floor(img.width / factor);
  const height = Math.floor(img.height / factor);
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let dy = 0; dy < factor; dy++) {
        const row = (y * factor + dy) * img.width + x * factor;
        for (let dx = 0; dx < factor; dx++) sum += img.data[row + dx]!;
      }
      out[y * width + x] = sum / (factor * factor);
    }
  }
  return { width, height, data: out };
}

/** Rotate clockwise by 0/90/180/270 degrees. */
export function rotate(img: Gray, degrees: 0 | 90 | 180 | 270): Gray {
  if (degrees === 0) return img;
  const { width: w, height: h, data } = img;
  const out = new Uint8Array(w * h);
  if (degrees === 180) {
    for (let i = 0; i < data.length; i++) out[data.length - 1 - i] = data[i]!;
    return { width: w, height: h, data: out };
  }
  // 90: (x, y) → (h-1-y, x); 270: (x, y) → (y, w-1-x). Output is h × w.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const nx = degrees === 90 ? h - 1 - y : y;
      const ny = degrees === 90 ? x : w - 1 - x;
      out[ny * h + nx] = data[y * w + x]!;
    }
  }
  return { width: h, height: w, data: out };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}

/** 8-bit greyscale PNG — what Tesseract reads in Node. */
export function encodePng(img: Gray): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0);
  ihdr.writeUInt32BE(img.height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale
  const raw = Buffer.alloc((img.width + 1) * img.height);
  for (let y = 0; y < img.height; y++) {
    raw[y * (img.width + 1)] = 0; // filter: none
    raw.set(img.data.subarray(y * img.width, (y + 1) * img.width), y * (img.width + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

/** Strongest autocorrelation of a high-passed profile over lags lo..hi (0..1). */
function periodicity(profile: number[], lo = 8, hi = 60): number {
  const n = profile.length;
  const k = 6;
  const hp = profile.map((v, i) => {
    const from = Math.max(0, i - k);
    const to = Math.min(n, i + k + 1);
    let sum = 0;
    for (let j = from; j < to; j++) sum += profile[j]!;
    return v - sum / (to - from);
  });
  const variance = hp.reduce((sum, v) => sum + v * v, 0) || 1;
  let best = 0;
  for (let lag = lo; lag < Math.min(hi, n - 1); lag++) {
    let acc = 0;
    for (let i = 0; i + lag < n; i++) acc += hp[i]! * hp[i + lag]!;
    best = Math.max(best, acc / variance);
  }
  return best;
}

/**
 * How strongly the page repeats in BOTH axes — ECG paper's millimetre grid.
 * Measured 2026-10-20 at ~800 px: ECG 0.93/0.81, observation sheet 0.8/0.5,
 * forms and letters < 0.4. Returns the weaker axis, so a ruled form (lines in
 * one direction only) stays low.
 */
export function gridScore(img: Gray): number {
  const small = downscale(img, 800);
  const { width: w, height: h, data } = small;
  const cols = new Array<number>(w).fill(0);
  const rows = new Array<number>(h).fill(0);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = data[y * w + x]!;
      cols[x] = cols[x]! + v;
      rows[y] = rows[y]! + v;
    }
  }
  return Math.min(periodicity(cols), periodicity(rows));
}

/** ECG-like when both axes repeat at least this strongly and no title was read. */
export const ECG_GRID_THRESHOLD = 0.7;

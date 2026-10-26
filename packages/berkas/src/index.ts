/**
 * Claim bundle reader for the "Kelengkapan Berkas" notice (docs/berkas-ocr.md).
 * Node-only (unpdf + Tesseract WASM); the UI never imports it.
 */
export * from './classify.js';
export * from './image.js';
export * from './reader.js';

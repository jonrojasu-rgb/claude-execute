// Generates PWA icon PNGs using only Node.js built-ins (zlib + fs).
// Run once: node dashboard/generate-icons.cjs

'use strict';
const zlib = require('zlib');
const fs   = require('fs');
const path = require('path');

// ── CRC32 (required by PNG chunk format) ──────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const crcVal  = crc32(Buffer.concat([typeBuf, data]));
  const out     = Buffer.allocUnsafe(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  typeBuf.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crcVal, 8 + data.length);
  return out;
}

// ── Icon design ───────────────────────────────────────────────────────────────
// Three ascending cyan bars on a dark background with a cyan border.
// Matches the dashboard's #070b12 / #00c8ff colour palette.

function makePNG(size) {
  const BG = [0x07, 0x0b, 0x12]; // #070b12
  const CY = [0x00, 0xc8, 0xff]; // #00c8ff

  const border = Math.round(size * 0.05); // 5% border
  const pad    = Math.round(size * 0.16); // inner padding
  const cL = border + pad;
  const cR = size - border - pad;
  const cT = border + pad;
  const cB = size - border - pad;
  const cW = cR - cL;
  const cH = cB - cT;

  // 3 bars + 2 gaps = 5 equal segments across chart width
  const seg  = Math.floor(cW / 5);
  const bars = [
    { l: cL,          r: cL + seg,   t: cB - Math.round(cH * 0.40) }, // 40%
    { l: cL + 2*seg,  r: cL + 3*seg, t: cB - Math.round(cH * 0.70) }, // 70%
    { l: cL + 4*seg,  r: cL + 5*seg, t: cT                          }, // 100%
  ];

  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.allocUnsafe(1 + size * 3);
    row[0] = 0; // PNG filter: None
    for (let x = 0; x < size; x++) {
      const onBorder = x < border || x >= size - border || y < border || y >= size - border;
      const inBar    = bars.some(bar => x >= bar.l && x < bar.r && y >= bar.t && y < cB);
      const c        = (onBorder || inBar) ? CY : BG;
      const off      = 1 + x * 3;
      row[off] = c[0]; row[off + 1] = c[1]; row[off + 2] = c[2];
    }
    rows.push(row);
  }

  const raw        = Buffer.concat(rows);
  const compressed = zlib.deflateSync(raw, { level: 9 });

  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit depth, RGB colour type
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), // PNG signature
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Write files ───────────────────────────────────────────────────────────────
const outDir = path.join(__dirname, 'icons');
fs.mkdirSync(outDir, { recursive: true });

fs.writeFileSync(path.join(outDir, 'icon-192.png'), makePNG(192));
console.log('  ✓  dashboard/icons/icon-192.png');

fs.writeFileSync(path.join(outDir, 'icon-512.png'), makePNG(512));
console.log('  ✓  dashboard/icons/icon-512.png');

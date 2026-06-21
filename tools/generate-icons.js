// Generates the PWA app icons (PNG) with no external dependencies.
// Draws a full-bleed accent-green tile with a white "wallet" motif kept inside
// the central safe zone so the same art works for both "any" and "maskable".
// Run from the project root:  node tools/generate-icons.js
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const BG = [25, 159, 125];     // accent-fill green (#199f7d)
const WHITE = [238, 243, 241]; // app --text (#eef3f1)

// CRC32 (PNG)
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const c = Buffer.alloc(4); c.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, c]);
}
function encodePNG(size, draw) {
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const [r, g, b] = draw(x, y, size);
    const i = (y * size + x) * 4;
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255;
  }
  const stride = size * 4;
  const raw = Buffer.alloc(size * (stride + 1));
  for (let y = 0; y < size; y++) { raw[y * (stride + 1)] = 0; px.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride); }
  const idat = zlib.deflateSync(raw, { level: 9 });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // bit depth 8, color type 6 (RGBA)
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = x < x0 + r ? x0 + r : (x > x1 - r ? x1 - r : x);
  const cy = y < y0 + r ? y0 + r : (y > y1 - r ? y1 - r : y);
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function draw(x, y, S) {
  // wallet body (white rounded rect) within central safe zone
  const bx0 = 0.26 * S, by0 = 0.34 * S, bx1 = 0.74 * S, by1 = 0.68 * S, br = 0.06 * S;
  // clasp button (green dot on the right)
  const ccx = 0.655 * S, ccy = 0.51 * S, ccr = 0.045 * S;
  if (inRoundRect(x, y, bx0, by0, bx1, by1, br)) {
    const dx = x - ccx, dy = y - ccy;
    if (dx * dx + dy * dy <= ccr * ccr) return BG; // clasp punched in green
    return WHITE;
  }
  return BG;
}

const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const size of [192, 512, 180]) {
  fs.writeFileSync(path.join(outDir, `icon-${size}.png`), encodePNG(size, draw));
  console.log(`wrote icons/icon-${size}.png`);
}

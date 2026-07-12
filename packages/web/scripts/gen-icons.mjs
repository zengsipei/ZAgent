// PWA 图标生成（#7）：零依赖、确定性输出——程序化绘制 + 手写 PNG 编码（node:zlib）。
// 图形语言遵循 DESIGN.md「无声驾驶舱」：全出血深底 + teal 终端提示符（❯ + 光标块），无装饰。
// 运行：node scripts/gen-icons.mjs（产物提交进 public/icons/，无需进构建链）

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BG = [0x0d, 0x15, 0x17];
const TEAL = [0x4f, 0xd0, 0xc4];
const SUPERSAMPLE = 3;

// ---------------------------------------------------------------------------
// 绘制：glyph 空间为 [-1,1]²，chevron 两段线 + 光标块，距离场出形状
// ---------------------------------------------------------------------------

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** glyph 空间内某点是否落在提示符图形上。 */
function inGlyph(x, y) {
  const stroke = 0.17;
  // chevron ❯：A(-0.72,-0.72) → B(-0.02,0) → C(-0.72,0.72)
  if (distToSegment(x, y, -0.72, -0.72, -0.02, 0) <= stroke) return true;
  if (distToSegment(x, y, -0.02, 0, -0.72, 0.72) <= stroke) return true;
  // 光标块：底线处的实心矩形
  return x >= 0.3 && x <= 0.92 && y >= 0.5 && y <= 0.86;
}

/**
 * 渲染 size×size 的 RGB 像素缓冲。
 * contentScale：图形占画布的半宽比例（maskable 需缩进安全区）。
 */
function render(size, contentScale) {
  const px = Buffer.alloc(size * size * 3);
  const n = SUPERSAMPLE;
  const half = size / 2;
  for (let yi = 0; yi < size; yi++) {
    for (let xi = 0; xi < size; xi++) {
      let hits = 0;
      for (let sy = 0; sy < n; sy++) {
        for (let sx = 0; sx < n; sx++) {
          const gx = (xi + (sx + 0.5) / n - half) / (half * contentScale);
          const gy = (yi + (sy + 0.5) / n - half) / (half * contentScale);
          if (inGlyph(gx, gy)) hits++;
        }
      }
      const a = hits / (n * n);
      const offset = (yi * size + xi) * 3;
      for (let c = 0; c < 3; c++) {
        px[offset + c] = Math.round(BG[c] + (TEAL[c] - BG[c]) * a);
      }
    }
  }
  return px;
}

// ---------------------------------------------------------------------------
// PNG 编码：signature + IHDR + IDAT(zlib) + IEND
// ---------------------------------------------------------------------------

const CRC_TABLE = new Int32Array(256).map((_, i) => {
  let c = i;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng(size, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  // 每行前置 filter 0
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    rgb.copy(raw, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");
mkdirSync(outDir, { recursive: true });

const targets = [
  { file: "icon-192.png", size: 192, contentScale: 0.52 },
  { file: "icon-512.png", size: 512, contentScale: 0.52 },
  // maskable：内容缩进安全区（内 80% 圆），Android 启动器裁形不切图
  { file: "icon-maskable-512.png", size: 512, contentScale: 0.4 },
  { file: "apple-touch-icon.png", size: 180, contentScale: 0.52 },
];

for (const { file, size, contentScale } of targets) {
  writeFileSync(join(outDir, file), encodePng(size, render(size, contentScale)));
  console.log(`✓ ${file} (${size}x${size})`);
}

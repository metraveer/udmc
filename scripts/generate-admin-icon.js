import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const size = 64;
const pixelBytes = size * size * 4;
const maskStride = Math.ceil(size / 32) * 4;
const maskBytes = maskStride * size;
const dibBytes = 40 + pixelBytes + maskBytes;
const fileBytes = 6 + 16 + dibBytes;
const buffer = Buffer.alloc(fileBytes);

let offset = 0;
buffer.writeUInt16LE(0, offset);
offset += 2;
buffer.writeUInt16LE(1, offset);
offset += 2;
buffer.writeUInt16LE(1, offset);
offset += 2;

buffer.writeUInt8(size, offset++);
buffer.writeUInt8(size, offset++);
buffer.writeUInt8(0, offset++);
buffer.writeUInt8(0, offset++);
buffer.writeUInt16LE(1, offset);
offset += 2;
buffer.writeUInt16LE(32, offset);
offset += 2;
buffer.writeUInt32LE(dibBytes, offset);
offset += 4;
buffer.writeUInt32LE(22, offset);
offset += 4;

buffer.writeUInt32LE(40, offset);
offset += 4;
buffer.writeInt32LE(size, offset);
offset += 4;
buffer.writeInt32LE(size * 2, offset);
offset += 4;
buffer.writeUInt16LE(1, offset);
offset += 2;
buffer.writeUInt16LE(32, offset);
offset += 2;
buffer.writeUInt32LE(0, offset);
offset += 4;
buffer.writeUInt32LE(pixelBytes, offset);
offset += 4;
buffer.writeInt32LE(0, offset);
offset += 4;
buffer.writeInt32LE(0, offset);
offset += 4;
buffer.writeUInt32LE(0, offset);
offset += 4;
buffer.writeUInt32LE(0, offset);
offset += 4;

for (let y = size - 1; y >= 0; y -= 1) {
  for (let x = 0; x < size; x += 1) {
    const radius = 13;
    const dx = Math.max(radius - x, 0, x - (size - radius - 1));
    const dy = Math.max(radius - y, 0, y - (size - radius - 1));
    const inside = dx * dx + dy * dy <= radius * radius;
    const mark =
      (x >= 17 && x <= 23 && y >= 16 && y <= 45) ||
      (x >= 40 && x <= 46 && y >= 16 && y <= 45) ||
      (x >= 23 && x <= 40 && y >= 39 && y <= 45);
    const accent = x >= 27 && x <= 36 && y >= 9 && y <= 16;

    if (!inside) {
      buffer.writeUInt8(0, offset++);
      buffer.writeUInt8(0, offset++);
      buffer.writeUInt8(0, offset++);
      buffer.writeUInt8(0, offset++);
    } else if (accent) {
      buffer.writeUInt8(61, offset++);
      buffer.writeUInt8(79, offset++);
      buffer.writeUInt8(240, offset++);
      buffer.writeUInt8(255, offset++);
    } else if (mark) {
      buffer.writeUInt8(255, offset++);
      buffer.writeUInt8(255, offset++);
      buffer.writeUInt8(255, offset++);
      buffer.writeUInt8(255, offset++);
    } else {
      buffer.writeUInt8(30, offset++);
      buffer.writeUInt8(27, offset++);
      buffer.writeUInt8(23, offset++);
      buffer.writeUInt8(255, offset++);
    }
  }
}

offset += maskBytes;

const outputDir = path.resolve("apps/admin-desktop/src-tauri/icons");
await mkdir(outputDir, { recursive: true });
await writeFile(path.join(outputDir, "icon.ico"), buffer);
console.log("Generated UDMC Control icon.");

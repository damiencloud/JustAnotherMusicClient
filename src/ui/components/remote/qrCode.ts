// Lightweight, self-contained QR Code Matrix Generator (Byte Mode, ECC Level M/L)
// Zero external dependencies. Generates a boolean[][] matrix for SVG rendering.

const GF256_PRIMITIVE = 0x11d;
const EXP_TABLE = new Uint8Array(512);
const LOG_TABLE = new Uint8Array(256);

(function initGaloisField() {
  let val = 1;
  for (let i = 0; i < 255; i++) {
    EXP_TABLE[i] = val;
    EXP_TABLE[i + 255] = val;
    LOG_TABLE[val] = i;
    val <<= 1;
    if (val & 0x100) val ^= GF256_PRIMITIVE;
  }
})();

function gfMultiply(x: number, y: number): number {
  if (x === 0 || y === 0) return 0;
  return EXP_TABLE[LOG_TABLE[x] + LOG_TABLE[y]];
}

function rsGeneratorPoly(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const factor = new Uint8Array([1, EXP_TABLE[i]]);
    const next = new Uint8Array(poly.length + 1);
    for (let j = 0; j < poly.length; j++) {
      for (let k = 0; k < 2; k++) {
        next[j + k] ^= gfMultiply(poly[j], factor[k]);
      }
    }
    poly = next;
  }
  return poly;
}

function rsCompute(data: Uint8Array, eccLen: number): Uint8Array {
  const gen = rsGeneratorPoly(eccLen);
  const remainder = new Uint8Array(eccLen);
  for (let i = 0; i < data.length; i++) {
    const factor = data[i] ^ remainder[0];
    for (let j = 0; j < eccLen - 1; j++) {
      remainder[j] = remainder[j + 1] ^ gfMultiply(gen[j + 1], factor);
    }
    remainder[eccLen - 1] = gfMultiply(gen[eccLen], factor);
  }
  return remainder;
}

// Version table for Byte mode with ECC Level L
// [totalCodewords, dataCodewords, eccCodewords]
const VERSION_TABLE: Record<number, { size: number; total: number; data: number; ecc: number; align: number[] }> = {
  1: { size: 21, total: 26, data: 19, ecc: 7, align: [] },
  2: { size: 25, total: 44, data: 34, ecc: 10, align: [6, 18] },
  3: { size: 29, total: 70, data: 55, ecc: 15, align: [6, 22] },
  4: { size: 33, total: 100, data: 80, ecc: 20, align: [6, 26] },
};

function selectVersion(byteCount: number): number {
  for (let v = 1; v <= 4; v++) {
    // 4 bits mode + 8 bits count + bytes*8
    const requiredBits = 4 + 8 + byteCount * 8;
    const availableBits = VERSION_TABLE[v].data * 8;
    if (requiredBits <= availableBits) return v;
  }
  return 4;
}

export function generateQrMatrix(text: string): boolean[][] {
  const encoder = new TextEncoder();
  const rawBytes = encoder.encode(text);
  const version = selectVersion(rawBytes.length);
  const spec = VERSION_TABLE[version];
  const size = spec.size;

  // Encode data bitstream
  const bitstream: number[] = [];
  function pushBits(val: number, len: number) {
    for (let i = len - 1; i >= 0; i--) {
      bitstream.push((val >> i) & 1);
    }
  }

  // 1. Mode indicator: Byte mode (0100)
  pushBits(0b0100, 4);
  // 2. Character count (8 bits for v1-4 byte mode)
  pushBits(rawBytes.length, 8);
  // 3. Raw byte data
  for (let i = 0; i < rawBytes.length; i++) {
    pushBits(rawBytes[i], 8);
  }
  // 4. Terminator (up to 4 zeroes)
  const capacityBits = spec.data * 8;
  const padTerminator = Math.min(4, capacityBits - bitstream.length);
  pushBits(0, padTerminator);
  // 5. Pad to multiple of 8
  while (bitstream.length % 8 !== 0) {
    bitstream.push(0);
  }
  // 6. Pad bytes (0xEC, 0x11)
  const dataBytes = new Uint8Array(spec.data);
  for (let i = 0; i < bitstream.length / 8; i++) {
    let b = 0;
    for (let bit = 0; bit < 8; bit++) {
      b = (b << 1) | bitstream[i * 8 + bit];
    }
    dataBytes[i] = b;
  }
  const padPatterns = [0xec, 0x11];
  let padIdx = 0;
  for (let i = bitstream.length / 8; i < spec.data; i++) {
    dataBytes[i] = padPatterns[padIdx % 2];
    padIdx++;
  }

  // Compute ECC
  const eccBytes = rsCompute(dataBytes, spec.ecc);
  const finalCodewords = new Uint8Array(spec.total);
  finalCodewords.set(dataBytes, 0);
  finalCodewords.set(eccBytes, spec.data);

  // Initialize Matrix
  const matrix: boolean[][] = Array.from({ length: size }, () => Array(size).fill(false));
  const isFunction: boolean[][] = Array.from({ length: size }, () => Array(size).fill(false));

  function setFunction(r: number, c: number, val: boolean) {
    if (r >= 0 && r < size && c >= 0 && c < size) {
      matrix[r][c] = val;
      isFunction[r][c] = true;
    }
  }

  // Draw 7x7 Finder Pattern with 1px separator
  function drawFinder(r: number, c: number) {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const nr = r + dr;
        const nc = c + dc;
        if (nr < 0 || nr >= size || nc < 0 || nc >= size) continue;
        if (dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6) {
          const isBorder = dr === 0 || dr === 6 || dc === 0 || dc === 6;
          const isCenter = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
          setFunction(nr, nc, isBorder || isCenter);
        } else {
          setFunction(nr, nc, false); // separator
        }
      }
    }
  }

  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    setFunction(6, i, i % 2 === 0);
    setFunction(i, 6, i % 2 === 0);
  }

  // Alignment pattern
  if (spec.align.length === 2) {
    const ar = spec.align[1];
    const ac = spec.align[1];
    for (let dr = -2; dr <= 2; dr++) {
      for (let dc = -2; dc <= 2; dc++) {
        const isBlack = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
        setFunction(ar + dr, ac + dc, isBlack);
      }
    }
  }

  // Dark module
  setFunction(4 * version + 9, 8, true);

  // Reserve Format Information areas
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) {
      setFunction(8, i, false);
      setFunction(i, 8, false);
    }
  }
  for (let i = size - 8; i < size; i++) {
    setFunction(8, i, false);
  }
  for (let i = size - 7; i < size; i++) {
    setFunction(i, 8, false);
  }

  // Place Data codewords
  let dataBitIdx = 0;
  const allBits: number[] = [];
  for (let i = 0; i < finalCodewords.length; i++) {
    for (let b = 7; b >= 0; b--) {
      allBits.push((finalCodewords[i] >> b) & 1);
    }
  }

  let col = size - 1;
  let dir = -1; // upwards
  while (col > 0) {
    if (col === 6) col--; // skip vertical timing
    for (let rowStep = 0; rowStep < size; rowStep++) {
      const row = dir === -1 ? size - 1 - rowStep : rowStep;
      for (let c = 0; c < 2; c++) {
        const targetCol = col - c;
        if (!isFunction[row][targetCol]) {
          const bit = dataBitIdx < allBits.length ? allBits[dataBitIdx++] : 0;
          // Apply mask pattern 0: (row + col) % 2 === 0
          const mask = (row + targetCol) % 2 === 0;
          matrix[row][targetCol] = (bit === 1) !== mask;
        }
      }
    }
    col -= 2;
    dir = -dir;
  }

  // Write Format Information (ECC L, Mask 0 = 0b01000 -> masked 0x77c4)
  // Format string for L + mask 0 is 0b111011111000100
  const formatInfo = 0b111011111000100;
  const formatBits: boolean[] = [];
  for (let i = 14; i >= 0; i--) {
    formatBits.push(((formatInfo >> i) & 1) === 1);
  }

  // Place format info along top-left finder
  const formatCoordsTopLeft = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5],
    [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8],
    [2, 8], [1, 8], [0, 8]
  ];
  for (let i = 0; i < 15; i++) {
    const [r, c] = formatCoordsTopLeft[i];
    matrix[r][c] = formatBits[i];
  }

  // Place format info along other finders
  for (let i = 0; i < 7; i++) {
    matrix[size - 1 - i][8] = formatBits[i];
  }
  for (let i = 7; i < 15; i++) {
    matrix[8][size - 15 + i] = formatBits[i];
  }

  return matrix;
}

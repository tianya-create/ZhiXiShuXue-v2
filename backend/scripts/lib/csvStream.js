'use strict';
/**
 * csvStream.js —— 带引号状态的流式 CSV 解析（供 2012 相关脚本共用）
 *
 * 为什么不能用 readline：ASSISTments 2012 的 actions 列是引号包裹的多行文本，
 * 按行切分会把一个 CSV 记录拆成多行，导致列数不匹配、整表错位。
 *
 * 用法：
 *   const { CsvStream } = require('./lib/csvStream');
 *   for await (const rec of new CsvStream(file, new Set([0,2,3])).records()) { ... }
 *
 * wantedIdx 为「需要物化的列下标」；其余列只跳过、不累积（actions 列单行可达数 MB）。
 * 返回的 rec 是按列下标升序排列的目标列值数组。
 */

const fs = require('fs');

const QUOTE = 34;
const COMMA = 44;
const LF = 10;
const CR = 13;

class CsvStream {
  constructor(filePath, wantedIdx) {
    this.filePath = filePath;
    this.wanted = wantedIdx instanceof Set ? wantedIdx : new Set(wantedIdx);
  }

  async *records() {
    const stream = fs.createReadStream(this.filePath, { encoding: 'utf8', highWaterMark: 1 << 22 });
    const wantedSize = this.wanted.size;
    let fields = [];
    let fieldNo = 0;
    let cur = '';
    let inQuotes = false;
    let keep = this.wanted.has(0);
    let carryQuote = false;

    for await (const chunk of stream) {
      if (!chunk.length) continue;
      let i = 0;
      if (carryQuote) {
        carryQuote = false;
        if (chunk.charCodeAt(0) === QUOTE) {
          if (keep) cur += '"';
          i = 1;
        } else {
          inQuotes = false;
        }
      }
      for (; i < chunk.length; i++) {
        const c = chunk.charCodeAt(i);
        if (inQuotes) {
          if (c === QUOTE) {
            if (i + 1 < chunk.length) {
              if (chunk.charCodeAt(i + 1) === QUOTE) { if (keep) cur += '"'; i++; } else inQuotes = false;
            } else {
              carryQuote = true;
            }
          } else if (keep) cur += chunk[i];
        } else if (c === QUOTE) {
          inQuotes = true;
        } else if (c === COMMA) {
          if (keep) fields.push(cur);
          cur = '';
          fieldNo++;
          keep = this.wanted.has(fieldNo);
        } else if (c === LF) {
          if (keep) fields.push(cur);
          yield fields;   // 列数不足的记录也交给调用方判断（malformed）
          fields = [];
          cur = '';
          fieldNo = 0;
          keep = this.wanted.has(0);
        } else if (c !== CR) {
          if (keep) cur += chunk[i];
        }
      }
    }
    if (cur.length || fields.length) {
      if (keep) fields.push(cur);
      yield fields;
    }
  }
}

/** 表头解析：文件表头不含引号内逗号，但保持与记录解析一致的行为 */
function parseHeaderLine(line) {
  const cells = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') inQ = false; else cur += ch;
    } else if (ch === '"') {
      inQ = true;
    } else if (ch === ',') {
      cells.push(cur.trim()); cur = '';
    } else if (ch !== '\r') {
      cur += ch;
    }
  }
  cells.push(cur.trim());
  return cells;
}

function readHeader(filePath) {
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.allocUnsafe(1 << 16);
  let text = '';
  try {
    while (text.indexOf('\n') < 0) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      text += buf.toString('utf8', 0, n);
    }
  } finally {
    fs.closeSync(fd);
  }
  const nl = text.indexOf('\n');
  return parseHeaderLine((nl >= 0 ? text.slice(0, nl) : text).replace(/^\uFEFF/, ''));
}

/** "2012-09-28 15:11:27.856" / ISO / 纯数字毫秒 → epoch ms；不可解析返回 null */
function parseTimeMs(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?/);
  if (m) {
    const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6],
      m[7] ? Number(m[7].slice(0, 3).padEnd(3, '0')) : 0);
    return Number.isFinite(t) ? t : null;
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

module.exports = { CsvStream, parseHeaderLine, readHeader, parseTimeMs };

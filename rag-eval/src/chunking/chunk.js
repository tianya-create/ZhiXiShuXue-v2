/**
 * 语料分块：recursive-character 切分（设计 §5.2 corpus.chunkPolicy）。
 * 层级：段落（\n\n）→ 行（\n）→ 句末标点 → 硬切。
 * overlap 为「上一块结尾字符」作为下一块前缀，保证上下文连续。
 * 确定性：同输入同输出，无随机性。
 */

function splitUnits(text, size) {
  const units = [];
  for (const para of text.split(/\n{2,}/)) {
    const t = para.trim();
    if (!t) continue;
    if (t.length <= size) { units.push(t); continue; }
    for (const line of t.split('\n')) {
      const lt = line.trim();
      if (!lt) continue;
      if (lt.length <= size) { units.push(lt); continue; }
      const sentences = lt.split(/(?<=[。！？!?;.])/);
      let buf = '';
      for (const s of sentences) {
        if (!s) continue;
        if ((buf + s).length > size && buf) { units.push(buf); buf = s; } else { buf += s; }
        while (buf.length > size) { units.push(buf.slice(0, size)); buf = buf.slice(size); }
      }
      if (buf) units.push(buf);
    }
  }
  return units;
}

function chunkText(text, { size = 512, overlap = 64 } = {}) {
  if (!Number.isFinite(size) || size < 1) throw new Error(`chunkText: size 必须 ≥ 1，收到 ${size}`);
  const ov = Math.max(0, Math.min(overlap, size - 1));
  const units = splitUnits(String(text), size);
  const chunks = [];
  let cur = [];
  let len = 0;
  const emit = () => {
    const t = cur.join('\n');
    chunks.push({ index: chunks.length, text: t, charCount: t.length });
    return ov > 0 ? t.slice(-ov) : '';
  };
  for (const u of units) {
    if (cur.length && len + 1 + u.length > size) {
      const tail = emit();
      cur = [tail];
      len = tail.length;
      // 纯 overlap 前缀仍放不下时丢弃前缀（防死循环），保证每个 unit 都能进入某块
      if (len + 1 + u.length > size) { cur = []; len = 0; }
    }
    cur.push(u);
    len += u.length + (cur.length > 1 ? 1 : 0);
  }
  if (cur.length) {
    const t = cur.join('\n');
    chunks.push({ index: chunks.length, text: t, charCount: t.length });
  }
  return chunks;
}

/** 对整个语料分块，返回 [{chunkId, docId, index, text, charCount}] */
function chunkCorpus(docs, { size = 512, overlap = 64, idPrefix = 'c' } = {}) {
  const out = [];
  for (const doc of docs) {
    const docId = doc.docId ?? doc.id;
    for (const c of chunkText(doc.text, { size, overlap })) {
      out.push({ chunkId: `${idPrefix}-${docId}-${c.index}`, docId, index: c.index, text: c.text, charCount: c.charCount });
    }
  }
  return out;
}

module.exports = { chunkText, chunkCorpus, splitUnits };

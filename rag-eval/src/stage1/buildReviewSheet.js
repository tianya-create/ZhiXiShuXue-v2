'use strict';

/**
 * 生成「人类可读」的人工校准材料。
 *
 * 背景：初版盲表直接把题库原文灌进 CSV —— 题面是 `$$46\times 99$$`、
 * 图片位置是 `question_3124-image_0` 这种内部文件名，55/201 条还依赖图片。
 * 人打开后既看不懂公式，也看不到图，等于无法判分。
 *
 * 本脚本产出两件东西（都不含臂名、不含机器分，保持盲评）：
 *   1. human-calibration-blind-v2.csv —— LaTeX 已转可读，附 needsImage/images 列
 *   2. human-calibration-review.html  —— 单文件审阅器，图片内嵌、点选打分、导出 CSV
 *
 * 安全约束：
 *   - itemId 与密钥文件逐字一致（否则 --score 无法配对）；
 *   - 只做展示层转换，不回写任何数据文件、不影响冻结产物；
 *   - 输出目录内不出现 arm / judgeScore。
 */

const fs = require('fs');
const path = require('path');
const { parseCsv, toCsv } = require('./calibration');
const { toReadable, toReadableInline, extractImageRefs, needsImage } = require('../util/readable');

const DEFAULT_DIR = path.join(__dirname, '..', '..', 'data', 'stage1', 'eval', 'judge');
const DEFAULT_SHEET = 'human-calibration-blind.v1-raw.csv';

function mimeOf(file) {
  const e = path.extname(file).toLowerCase();
  if (e === '.png') return 'image/png';
  if (e === '.jpg' || e === '.jpeg') return 'image/jpeg';
  if (e === '.gif') return 'image/gif';
  if (e === '.bmp') return 'image/bmp';
  return 'application/octet-stream';
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * @param {{dir?: string, sheetFile?: string, keyFile?: string, inlineImages?: boolean, outPrefix?: string}} opts
 */
function buildReviewSheet(opts = {}) {
  const dir = opts.dir || DEFAULT_DIR;
  // v1-raw 是唯一数据源（未经展示层转换）；v2 是本脚本的产物，不能反过来当输入
  const sheetFile = path.join(dir, opts.sheetFile || DEFAULT_SHEET);
  const keyFile = path.join(dir, opts.keyFile || 'human-calibration-key.jsonl');
  const inlineImages = opts.inlineImages !== false;
  const outPrefix = opts.outPrefix || 'human-calibration';

  const rows = parseCsv(fs.readFileSync(sheetFile, 'utf8')).filter((r) => String(r.itemId || '').trim());
  const keys = fs
    .readFileSync(keyFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const keyById = new Map(keys.map((k) => [k.itemId, k]));

  if (!rows.length) throw new Error(`盲表为空：${sheetFile}`);

  const items = [];
  const missingImages = [];
  const imageCache = new Map();

  for (const r of rows) {
    const id = String(r.itemId).trim();
    const k = keyById.get(id);
    if (!k) throw new Error(`盲表 itemId ${id} 在密钥文件中不存在（两者必须同源生成）`);

    const rawQ = String(r.question || '');
    const refs = extractImageRefs(rawQ);
    const need = needsImage(rawQ);

    const images = refs.map((ref) => {
      const p = path.join(dir, 'images', ref.file);
      if (!fs.existsSync(p)) {
        missingImages.push({ itemId: id, file: ref.file });
        return { file: ref.file, missing: true, dataUri: null };
      }
      let dataUri = null;
      if (inlineImages) {
        if (!imageCache.has(ref.file)) {
          const b64 = fs.readFileSync(p).toString('base64');
          imageCache.set(ref.file, `data:${mimeOf(ref.file)};base64,${b64}`);
        }
        dataUri = imageCache.get(ref.file);
      }
      return { file: ref.file, missing: false, dataUri };
    });

    items.push({
      itemId: id,
      needsImage: need,
      question: toReadable(rawQ),
      goldAnswer: toReadableInline(r.goldAnswer),
      pred: toReadableInline(r.pred),
      images,
    });
  }

  // ---- CSV v2（Excel 可直接开；图片放 images/ 目录，另列文件名） ----
  const csvRows = items.map((it) => ({
    itemId: it.itemId,
    needsImage: it.needsImage ? 1 : 0,
    images: it.images.map((x) => x.file).join(' '),
    question: it.question.replace(/\n+/g, ' '),
    goldAnswer: it.goldAnswer,
    pred: it.pred,
    humanScore: '',
    note: '',
  }));
  const csvPath = path.join(dir, `${outPrefix}-blind-v2.csv`);
  fs.writeFileSync(
    csvPath,
    '\ufeff' + toCsv(['itemId', 'needsImage', 'images', 'question', 'goldAnswer', 'pred', 'humanScore', 'note'], csvRows),
    'utf8'
  );

  // ---- HTML 审阅器 ----
  const htmlPath = path.join(dir, `${outPrefix}-review.html`);
  fs.writeFileSync(htmlPath, renderHtml(items, { inlineImages }), 'utf8');

  const stat = {
    n: items.length,
    needsImage: items.filter((x) => x.needsImage).length,
    withRefs: items.filter((x) => x.images.length > 0).length,
    missingImages: missingImages.length,
    inlineImages,
    csvPath,
    htmlPath,
  };
  return { items, stat, missingImages };
}

function renderHtml(items, { inlineImages }) {
  const data = JSON.stringify(items).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>L3 人工校准 · 盲评审阅器</title>
<style>
  :root{
    --bg:#f6f7f9; --card:#ffffff; --ink:#1a1d21; --muted:#6b7280; --line:#e5e7eb;
    --gold:#b45309; --pred:#1d4ed8; --ok:#0f766e; --warn:#b91c1c; --chip:#eef2ff;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
    font-size:15px;line-height:1.65}
  header{position:sticky;top:0;z-index:20;background:rgba(246,247,249,.94);
    backdrop-filter:blur(8px);border-bottom:1px solid var(--line);padding:12px 20px}
  .bar{max-width:980px;margin:0 auto;display:flex;align-items:center;gap:14px;flex-wrap:wrap}
  h1{font-size:15px;margin:0;font-weight:600;letter-spacing:.01em}
  .hint{color:var(--muted);font-size:12.5px}
  .grow{flex:1}
  button{font:inherit;cursor:pointer;border-radius:8px;border:1px solid var(--line);
    background:#fff;padding:6px 12px;transition:.12s}
  button:hover{border-color:#c7cdd6;background:#fafbfc}
  button.primary{background:var(--ink);color:#fff;border-color:var(--ink)}
  button.primary:hover{background:#000}
  button.ghost{background:transparent}
  main{max-width:980px;margin:0 auto;padding:20px 20px 120px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;
    padding:20px;margin-bottom:16px;box-shadow:0 1px 2px rgba(16,24,40,.04)}
  .card.done{opacity:.55}
  .top{display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap}
  .no{font-variant-numeric:tabular-nums;color:var(--muted);font-size:13px;
    background:#f1f3f6;border-radius:6px;padding:2px 8px}
  .chip{font-size:12px;padding:2px 8px;border-radius:999px;background:var(--chip);color:#3730a3}
  .chip.img{background:#fef3c7;color:#92400e}
  .q{font-size:16.5px;line-height:1.8;white-space:pre-wrap;word-break:break-word}
  .imgs{display:flex;gap:12px;flex-wrap:wrap;margin:14px 0 4px}
  .imgs figure{margin:0;border:1px solid var(--line);border-radius:10px;padding:8px;background:#fff}
  .imgs img{display:block;max-width:min(100%,420px);height:auto;border-radius:6px}
  .imgs figcaption{font-size:11.5px;color:var(--muted);margin-top:6px;text-align:center}
  .imgs .miss{color:var(--warn);font-size:13px;padding:18px;border:1px dashed var(--warn);border-radius:8px}
  .pair{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:16px}
  @media(max-width:660px){.pair{grid-template-columns:1fr}}
  .box{border-radius:10px;padding:12px 14px;border:1px solid var(--line);background:#fcfcfd}
  .box .lab{font-size:12px;letter-spacing:.04em;text-transform:uppercase;margin-bottom:6px}
  .box.gold{border-color:#fcd9a8;background:#fffbf5}
  .box.gold .lab{color:var(--gold)}
  .box.pred{border-color:#c7d7fe;background:#f8faff}
  .box.pred .lab{color:var(--pred)}
  .val{font-size:17px;font-weight:600;word-break:break-word;white-space:pre-wrap}
  .val.empty{color:var(--muted);font-weight:400;font-style:italic}
  .score{margin-top:16px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .score .lab{font-size:13px;color:var(--muted);margin-right:4px}
  .sbtn{min-width:64px;padding:8px 14px;border-radius:9px;border:1px solid var(--line);background:#fff;font-weight:600}
  .sbtn kbd{margin-left:6px;font-size:11px;color:var(--muted);font-family:inherit}
  .sbtn.on[data-s="0"]{background:#fee2e2;border-color:#fca5a5;color:#7f1d1d}
  .sbtn.on[data-s="1"]{background:#fef3c7;border-color:#fcd34d;color:#78350f}
  .sbtn.on[data-s="2"]{background:#d1fae5;border-color:#6ee7b7;color:#065f46}
  .nrow{display:flex;gap:8px;margin-bottom:14px}
  .nrow input{flex:1;font:inherit;padding:8px 12px;border:1px solid var(--line);border-radius:9px;background:#fff}
  .nrow input:focus{outline:2px solid #c7d7fe;border-color:#93b4fd}
  .legend{max-width:980px;margin:0 auto;padding:0 20px 8px;color:var(--muted);font-size:12.5px}
  .legend b{color:var(--ink);font-weight:600}
  .progress{height:5px;background:var(--line);border-radius:99px;overflow:hidden;flex:1 1 160px;min-width:120px}
  .progress > i{display:block;height:100%;width:0;background:var(--ok);transition:width .18s}
  .floating{position:fixed;right:22px;bottom:22px;z-index:30;display:flex;gap:8px}
  @media print{header,.floating{display:none}body{background:#fff}}
</style>
</head>
<body>
<header>
  <div class="bar">
    <h1>L3 人工校准 · 盲评审阅器</h1>
    <div class="progress"><i id="pg"></i></div>
    <span class="hint" id="cnt">0 / 0</span>
    <span class="grow"></span>
    <button class="ghost" id="only">只看未评</button>
    <button class="ghost" id="reset">清空本机</button>
    <button class="primary" id="export">导出 CSV</button>
  </div>
</header>

<div class="legend">
  <b>打分规则</b>：把「模型答案」当学生答卷，对照「标准答案」逐个空位比数值 ——
  全对 <b>2</b>，部分对 <b>1</b>，全错 / 答非所问 <b>0</b>。
  键盘：<b>0 1 2</b> 打分，<b>J / K</b>（或 ↑↓）上下题，<b>N</b> 跳到下一条未评。
  进度自动存在本机浏览器，刷新不丢。
</div>

<main id="list"></main>

<div class="floating">
  <button id="export2" class="primary">导出 CSV</button>
</div>

<script>
const ITEMS = ${data};
const KEY = 'rag-eval-l3-calibration-v2';
let state = {};
try { state = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch(e) { state = {}; }
let onlyUnrated = false;

function save(){ try { localStorage.setItem(KEY, JSON.stringify(state)); } catch(e){} }

function el(tag, cls, txt){
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
}

function render(){
  const list = document.getElementById('list');
  list.innerHTML = '';
  let idx = 0;
  let shown = 0;
  for (const it of ITEMS){
    idx++;
    const cur = state[it.itemId];
    const scored = cur && [0,1,2].includes(cur.score);
    if (onlyUnrated && scored) continue;
    shown++;

    const card = el('div', 'card' + (scored ? ' done' : ''));
    card.dataset.id = it.itemId;

    const top = el('div','top');
    top.appendChild(el('span','no','#' + idx + ' · ' + it.itemId));
    if (it.needsImage) top.appendChild(el('span','chip img','依赖图片'));
    if (it.images.length) top.appendChild(el('span','chip','图 ' + it.images.length + ' 张'));
    card.appendChild(top);

    card.appendChild(el('div','q', it.question));

    if (it.images.length){
      const wrap = el('div','imgs');
      it.images.forEach((im, i) => {
        const fig = document.createElement('figure');
        if (im.dataUri){
          const img = document.createElement('img');
          img.src = im.dataUri;
          img.alt = '题图 ' + (i+1);
          fig.appendChild(img);
        } else {
          fig.appendChild(el('div','miss','图片缺失：' + im.file));
        }
        fig.appendChild(el('figcaption', null, '【图' + (i+1) + '】' + im.file));
        wrap.appendChild(fig);
      });
      card.appendChild(wrap);
    } else if (it.needsImage){
      const warn = el('div','imgs');
      warn.appendChild(el('div','miss','题面提到图，但题库未提供图片文件 —— 若无法判断请填 note 说明后按最保守打分'));
      card.appendChild(warn);
    }

    const pair = el('div','pair');
    const bg = el('div','box gold');
    bg.appendChild(el('div','lab','标准答案'));
    const gv = el('div','val' + (it.goldAnswer ? '' : ' empty'), it.goldAnswer || '（空）');
    bg.appendChild(gv);
    pair.appendChild(bg);

    const bp = el('div','box pred');
    bp.appendChild(el('div','lab','模型答案（待批改）'));
    const pv = el('div','val' + (it.pred ? '' : ' empty'), it.pred || '（空）');
    bp.appendChild(pv);
    pair.appendChild(bp);
    card.appendChild(pair);

    const sc = el('div','score');
    sc.appendChild(el('span','lab','我的判分'));
    [0,1,2].forEach(s => {
      const b = el('button','sbtn' + (scored && cur.score === s ? ' on' : ''));
      b.dataset.s = s;
      b.dataset.id = it.itemId;
      b.appendChild(document.createTextNode(String(s)));
      const k = document.createElement('kbd');
      k.textContent = s;
      b.appendChild(k);
      b.onclick = () => setScore(it.itemId, s);
      sc.appendChild(b);
    });
    card.appendChild(sc);

    const nrow = el('div','nrow');
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.placeholder = '备注（选填）：为什么这样判，例如「第二空错」「答的是另一个量」';
    inp.value = (cur && cur.note) || '';
    inp.oninput = () => { state[it.itemId] = Object.assign({}, state[it.itemId], { note: inp.value }); save(); };
    nrow.appendChild(inp);
    card.appendChild(nrow);

    list.appendChild(card);
  }
  if (!shown) list.appendChild(el('div','card','全部已评完，点右上角「导出 CSV」。'));
  updateProgress();
}

function setScore(itemId, s){
  state[itemId] = Object.assign({ score: s }, state[itemId] || {}, { score: s });
  // 保证 note 不被覆盖
  save();
  const card = document.querySelector('.card[data-id="' + itemId + '"]');
  if (card){
    card.classList.add('done');
    card.querySelectorAll('.sbtn').forEach(b => b.classList.toggle('on', Number(b.dataset.s) === s));
  }
  updateProgress();
  if (onlyUnrated) setTimeout(render, 120);
}

function updateProgress(){
  const total = ITEMS.length;
  const done = ITEMS.filter(it => state[it.itemId] && [0,1,2].includes(state[it.itemId].score)).length;
  document.getElementById('cnt').textContent = done + ' / ' + total;
  document.getElementById('pg').style.width = (total ? (done/total*100) : 0) + '%';
}

function csvCell(v){
  const s = String(v == null ? '' : v);
  return /[",\\n]/.test(s) ? '"' + s.replace(/"/g,'""') + '"' : s;
}

function exportCsv(){
  const lines = ['itemId,humanScore,note'];
  for (const it of ITEMS){
    const st = state[it.itemId] || {};
    const s = [0,1,2].includes(st.score) ? String(st.score) : '';
    lines.push([csvCell(it.itemId), s, csvCell(st.note || '')].join(','));
  }
  const blob = new Blob(['\\ufeff' + lines.join('\\n')], {type:'text/csv;charset=utf-8'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'human-calibration-blind.filled.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

document.getElementById('export').onclick = exportCsv;
document.getElementById('export2').onclick = exportCsv;
document.getElementById('only').onclick = (e) => {
  onlyUnrated = !onlyUnrated;
  e.target.textContent = onlyUnrated ? '显示全部' : '只看未评';
  render();
};
document.getElementById('reset').onclick = () => {
  if (!confirm('清空本机已填的所有分数与备注？导出过的 CSV 不受影响。')) return;
  state = {}; save(); render();
};

// 键盘
let cursor = -1;
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  const cards = [...document.querySelectorAll('.card[data-id]')];
  if (!cards.length) return;
  const k = e.key.toLowerCase();
  if (k === 'j' || e.key === 'ArrowDown'){
    cursor = Math.min(cards.length - 1, Math.max(0, cursor + 1));
    cards[cursor].scrollIntoView({behavior:'smooth', block:'center'});
    e.preventDefault(); return;
  }
  if (k === 'k' || e.key === 'ArrowUp'){
    cursor = Math.max(0, cursor - 1);
    cards[cursor].scrollIntoView({behavior:'smooth', block:'center'});
    e.preventDefault(); return;
  }
  if (['0','1','2'].includes(e.key)){
    if (cursor < 0) cursor = 0;
    const id = cards[cursor].dataset.id;
    setScore(id, Number(e.key));
    e.preventDefault(); return;
  }
  if (k === 'n'){
    const i = cards.findIndex(c => !(state[c.dataset.id] && [0,1,2].includes(state[c.dataset.id].score)));
    if (i >= 0){ cursor = i; cards[i].scrollIntoView({behavior:'smooth', block:'center'}); }
    e.preventDefault();
  }
});

render();
</script>
</body>
</html>`;
}

// CLI
if (require.main === module) {
  const args = process.argv.slice(2);
  const has = (f) => args.includes(f);
  const get = (k, d) => {
    const i = args.indexOf(k);
    return i >= 0 && args[i + 1] ? args[i + 1] : d;
  };
  const dir = get('--dir', DEFAULT_DIR);
  const r = buildReviewSheet({
    dir,
    sheetFile: get('--sheet', DEFAULT_SHEET),
    keyFile: get('--key', 'human-calibration-key.jsonl'),
    inlineImages: !has('--no-inline-images'),
    outPrefix: get('--out-prefix', 'human-calibration'),
  });
  console.log(`[校准表] ${r.stat.n} 条；依赖图片 ${r.stat.needsImage} 条（含图 ${r.stat.withRefs} 条）`);
  if (r.stat.missingImages) console.log(`[校准表][WARN] 缺图片文件 ${r.stat.missingImages} 处`);
  console.log(`[校准表] CSV  → ${r.stat.csvPath}`);
  console.log(`[校准表] HTML → ${r.stat.htmlPath}`);
}

module.exports = { buildReviewSheet };

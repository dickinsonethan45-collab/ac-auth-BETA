<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>AUTH_ID Patcher</title>
<style>
  :root{
    --bg: #12141a;
    --bg-raised: #191c24;
    --line: #262b36;
    --text: #dfe2e8;
    --text-dim: #7b8394;
    --removed: #ff6b6b;
    --removed-bg: rgba(255,107,107,0.08);
    --added: #4fd88a;
    --added-bg: rgba(79,216,138,0.08);
    --accent: #ffb454;
    --mono: ui-monospace, "SF Mono", "Cascadia Code", "JetBrains Mono", Consolas, monospace;
  }
  *{ box-sizing: border-box; }
  html,body{
    margin:0; padding:0; background:var(--bg); color:var(--text);
    font-family: var(--mono);
    min-height:100vh;
  }
  .wrap{ max-width: 760px; margin: 0 auto; padding: 48px 20px 80px; }
  .eyebrow{
    color: var(--text-dim); font-size: 12px; letter-spacing: 0.12em;
    text-transform: uppercase; margin: 0 0 10px;
  }
  h1{ font-size: 26px; margin: 0 0 6px; font-weight: 600; letter-spacing: -0.01em; }
  h1 .dim{ color: var(--text-dim); font-weight: 400; }
  .sub{ color: var(--text-dim); font-size: 14px; line-height: 1.6; margin: 0 0 34px; max-width: 56ch; }

  .section-label{
    display:flex; align-items:center; gap: 8px; font-size: 12px; color: var(--text-dim);
    margin: 0 0 10px; letter-spacing: 0.04em;
  }
  .section-label .n{
    display:inline-flex; align-items:center; justify-content:center;
    width:16px; height:16px; border-radius:50%; background:var(--line);
    color:var(--text); font-size:10px;
  }

  .dropzone{
    border: 1px dashed var(--line); border-radius: 8px; padding: 26px 20px;
    text-align: center; cursor: pointer; transition: border-color .15s ease, background .15s ease;
    margin-bottom: 30px;
  }
  .dropzone.drag{ border-color: var(--accent); background: rgba(255,180,84,0.05); }
  .dropzone.loaded{ border-style: solid; border-color: var(--added); }
  .dropzone p{ margin: 0; color: var(--text-dim); font-size: 13px; }
  .dropzone strong{ color: var(--text); font-weight: 500; }
  .dropzone input{ display:none; }

  .id-list{ margin-bottom: 14px; }
  .id-row{
    display:flex; gap: 8px; margin-bottom: 8px; align-items:center;
  }
  .id-row input{
    background: var(--bg-raised); border: 1px solid var(--line);
    border-radius: 6px; padding: 11px 12px; color: var(--text); font-family: var(--mono);
    font-size: 13px; outline: none; transition: border-color .15s ease;
  }
  .id-row input:focus{ border-color: var(--accent); }
  .id-row input::placeholder{ color: #4a5063; }
  .id-row .label-input{ width: 120px; flex-shrink: 0; color: var(--text-dim); }
  .id-row .value-input{ flex:1; color: var(--accent); }
  .id-row .remove-btn{
    background: transparent; border: 1px solid var(--line); color: var(--text-dim);
    width: 34px; height: 34px; border-radius: 6px; cursor: pointer; font-size: 15px;
    flex-shrink: 0; line-height: 1;
  }
  .id-row .remove-btn:hover{ border-color: var(--removed); color: var(--removed); }

  .add-btn{
    background: transparent; border: 1px dashed var(--line); color: var(--text-dim);
    border-radius: 6px; padding: 9px 14px; font-family: var(--mono); font-size: 12px;
    cursor: pointer; width: 100%; margin-bottom: 34px;
  }
  .add-btn:hover{ border-color: var(--accent); color: var(--accent); }

  .file-card{
    background: var(--bg-raised); border: 1px solid var(--line); border-radius: 8px;
    margin-bottom: 12px; overflow: hidden;
  }
  .file-head{
    display:flex; align-items:center; justify-content:space-between;
    padding: 11px 16px; border-bottom: 1px solid var(--line);
  }
  .file-name{ font-size: 13px; color: var(--text); }
  .file-name .path-dim{ color: var(--text-dim); }
  .badge{
    font-size: 10px; padding: 3px 8px; border-radius: 999px; letter-spacing: .04em;
    text-transform: uppercase; font-weight: 600;
  }
  .badge.ok{ color: var(--added); background: var(--added-bg); }
  .badge.warn{ color: #ffcf5c; background: rgba(255,207,92,0.08); }

  .diff{ font-size: 13px; line-height: 1.9; padding: 10px 0; }
  .diff .row{ padding: 0 16px; white-space: pre; overflow-x: auto; }
  .diff .row.rm{ background: var(--removed-bg); color: var(--removed); }
  .diff .row.add{ background: var(--added-bg); color: var(--added); }

  .file-actions{ padding: 8px 16px 14px; }
  .dl-btn{
    background: transparent; border: 1px solid var(--line); color: var(--text-dim);
    border-radius: 5px; padding: 6px 12px; font-family: var(--mono); font-size: 12px;
    cursor: pointer;
  }
  .dl-btn:hover:not(:disabled){ border-color: var(--text-dim); color: var(--text); }
  .dl-btn:disabled{ opacity: 0.4; cursor: not-allowed; }

  .empty-note{ color: #4a5063; font-size: 12px; text-align:center; padding: 6px 0 0; }
  .no-match{
    padding: 14px 16px; font-size: 13px; color: #ffcf5c;
  }
</style>
</head>
<body>
<div class="wrap">
  <p class="eyebrow">animal company &middot; frida mods</p>
  <h1>AUTH_ID Patcher</h1>
  <p class="sub">Upload one symbols.ts. List every AUTH_ID your bots use. Get back one patched .ts per ID, each a separate download.</p>

  <p class="section-label"><span class="n">1</span> source file</p>
  <div class="dropzone" id="dropzone">
    <input id="fileInput" type="file" accept=".ts,.js,.txt">
    <p id="dropzoneText"><strong>Drop your symbols.ts here</strong> or click to browse</p>
  </div>

  <p class="section-label"><span class="n">2</span> auth ids</p>
  <div class="id-list" id="idList"></div>
  <button class="add-btn" id="addBtn">+ add another AUTH_ID</button>

  <div id="fileList"></div>
  <p class="empty-note" id="emptyNote">Upload a file to get started.</p>
</div>

<script>
const STORAGE_KEY = 'auth-id-entries';
const AUTH_ID_RE = /(const\s+AUTH_ID\s*=\s*["'])([^"']*)(["']\s*;)/;

const dropzone = document.getElementById('dropzone');
const dropzoneText = document.getElementById('dropzoneText');
const fileInput = document.getElementById('fileInput');
const idListEl = document.getElementById('idList');
const addBtn = document.getElementById('addBtn');
const fileListEl = document.getElementById('fileList');
const emptyNote = document.getElementById('emptyNote');

let sourceFile = null; // { name, original }
let entries = [];      // { label, value }
let idCounter = 0;

function newEntry(label, value) {
  idCounter += 1;
  return { key: idCounter, label: label || '', value: value || '' };
}

(async () => {
  try {
    const r = await window.storage.get(STORAGE_KEY);
    if (r && r.value) {
      const saved = JSON.parse(r.value);
      if (Array.isArray(saved) && saved.length) {
        entries = saved.map(e => newEntry(e.label, e.value));
      }
    }
  } catch (e) { /* nothing saved yet */ }
  if (!entries.length) entries = [newEntry('', '')];
  renderEntries();
})();

async function persistEntries() {
  try {
    await window.storage.set(STORAGE_KEY, JSON.stringify(entries.map(e => ({ label: e.label, value: e.value }))));
  } catch (e) { /* best effort */ }
}

dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('drag'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('drag');
  if (e.dataTransfer.files.length) loadFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', () => {
  if (fileInput.files.length) loadFile(fileInput.files[0]);
});

function loadFile(f) {
  const reader = new FileReader();
  reader.onload = () => {
    sourceFile = { name: f.name, original: reader.result };
    dropzone.classList.add('loaded');
    dropzoneText.innerHTML = `<strong>${escapeHtml(f.name)}</strong> loaded &mdash; click to replace`;
    renderFiles();
  };
  reader.readAsText(f);
}

addBtn.addEventListener('click', () => {
  entries.push(newEntry('', ''));
  renderEntries();
  persistEntries();
});

function renderEntries() {
  idListEl.innerHTML = entries.map((e, i) => `
    <div class="id-row">
      <input class="label-input" data-key="${e.key}" data-field="label" placeholder="label (optional)" value="${escapeAttr(e.label)}">
      <input class="value-input" data-key="${e.key}" data-field="value" placeholder="AUTH_ID value" value="${escapeAttr(e.value)}" autocomplete="off" spellcheck="false">
      <button class="remove-btn" data-remove="${e.key}" ${entries.length === 1 ? 'disabled' : ''}>&times;</button>
    </div>
  `).join('');

  idListEl.querySelectorAll('input').forEach(inp => {
    inp.addEventListener('input', () => {
      const key = Number(inp.dataset.key);
      const field = inp.dataset.field;
      const entry = entries.find(e => e.key === key);
      if (entry) entry[field] = inp.value;
      renderFiles();
      persistEntries();
    });
  });
  idListEl.querySelectorAll('[data-remove]').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = Number(btn.dataset.remove);
      entries = entries.filter(e => e.key !== key);
      renderEntries();
      renderFiles();
      persistEntries();
    });
  });

  renderFiles();
}

function outputName(entry, index) {
  const dot = sourceFile.name.lastIndexOf('.');
  const base = dot > 0 ? sourceFile.name.slice(0, dot) : sourceFile.name;
  const ext = dot > 0 ? sourceFile.name.slice(dot) : '';
  const suffix = entry.label.trim()
    ? entry.label.trim().replace(/\s+/g, '-')
    : String(index + 1);
  return `${base}-${suffix}${ext}`;
}

function renderFiles() {
  emptyNote.style.display = sourceFile ? 'none' : 'block';
  if (!sourceFile) { fileListEl.innerHTML = ''; return; }

  const match = sourceFile.original.match(AUTH_ID_RE);
  if (!match) {
    fileListEl.innerHTML = `<div class="file-card"><div class="no-match">No <code>const AUTH_ID = "...";</code> line found in ${escapeHtml(sourceFile.name)}.</div></div>`;
    return;
  }
  const oldId = match[2];

  fileListEl.innerHTML = entries.map((entry, i) => {
    const newId = entry.value.trim();
    const name = outputName(entry, i);
    const hasNew = !!newId;
    const diffRows = hasNew ? `
        <div class="row rm">- const AUTH_ID = "${escapeHtml(oldId)}";</div>
        <div class="row add">+ const AUTH_ID = "${escapeHtml(newId)}";</div>
      ` : `
        <div class="row rm" style="opacity:.5">- const AUTH_ID = "${escapeHtml(oldId)}";</div>
      `;
    return `
      <div class="file-card">
        <div class="file-head">
          <span class="file-name">${escapeHtml(name)}${entry.label.trim() ? '' : ' <span class="path-dim">(unlabeled)</span>'}</span>
          <span class="badge ${hasNew ? 'ok' : 'warn'}">${hasNew ? 'ready' : 'enter an id'}</span>
        </div>
        <div class="diff">${diffRows}</div>
        <div class="file-actions">
          <button class="dl-btn" data-download="${entry.key}" ${hasNew ? '' : 'disabled'}>Download ${escapeHtml(name)}</button>
        </div>
      </div>`;
  }).join('');

  fileListEl.querySelectorAll('[data-download]').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = Number(btn.dataset.download);
      const i = entries.findIndex(e => e.key === key);
      downloadOne(i, oldId);
    });
  });
}

function downloadOne(i, oldId) {
  const entry = entries[i];
  const newId = entry.value.trim();
  if (!newId) return;
  const patched = sourceFile.original.replace(AUTH_ID_RE, `$1${newId}$3`);
  const name = outputName(entry, i);
  const blob = new Blob([patched], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function escapeAttr(s) { return escapeHtml(s); }
</script>
</body>
</html>

/* ==========================================================================
   Хранение: доступ к папке на диске (File System Access API), чтение и
   запись registry.json (документы, стадии, история) и config.json
   (справочники: виды документов+префиксы, контрагенты).

   Все переменные объявлены на верхнем уровне обычного (не module) скрипта,
   поэтому доступны из app.js, который подключается следующим тегом —
   классические <script> на одной странице делят один и тот же глобальный
   лексический контекст для let/const.
   ========================================================================== */

const REGISTRY_FILE = "registry.json";
const CONFIG_FILE = "config.json";
const DB_NAME = "doc-registry-fsa";
const DB_STORE = "handles";
const HANDLE_KEY = "rootDir";

let dirHandle = null;
let state = null;  // { nextDocId, nextFileId, nextStageId, stages: [], documents: [] }
let config = null; // { docTypes: [{name,prefix}], counterparties: [] }
let currentDocId = null;

/* --------------------------------------------------------------------- */
/* Утилиты */
/* --------------------------------------------------------------------- */

function nowIso() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatDateShort(isoDate) {
  // "2026-07-31" -> "31.07.26"
  if (!isoDate) return "??.??.??";
  const parts = isoDate.split("-");
  if (parts.length !== 3) return isoDate;
  const [y, m, d] = parts;
  return `${d}.${m}.${y.slice(2)}`;
}

function sanitizeFilename(name) {
  name = (name || "").normalize("NFC").trim();
  name = name.replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, " ");
  return name.slice(0, 150) || "файл";
}

/** Собирает отображаемое имя документа: "УПД №2594 от 31.07.26" */
function buildDocLabel(doc) {
  const prefix = doc.doc_type || "Документ";
  const number = doc.number ? `№${doc.number}` : "№?";
  return `${prefix} ${number} от ${formatDateShort(doc.doc_date)}`;
}

/* --------------------------------------------------------------------- */
/* IndexedDB — хранение хэндла папки между запусками */
/* --------------------------------------------------------------------- */

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readonly");
    const req = tx.objectStore(DB_STORE).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

/* --------------------------------------------------------------------- */
/* Разрешения на папку */
/* --------------------------------------------------------------------- */

async function verifyPermission(handle, readwrite) {
  const opts = {};
  if (readwrite) opts.mode = "readwrite";
  if ((await handle.queryPermission(opts)) === "granted") return true;
  if ((await handle.requestPermission(opts)) === "granted") return true;
  return false;
}

async function verifyPermissionSilent(handle) {
  try {
    return (await handle.queryPermission({ mode: "readwrite" })) === "granted";
  } catch (e) {
    return false;
  }
}

/* --------------------------------------------------------------------- */
/* registry.json — документы, стадии, история */
/* --------------------------------------------------------------------- */

function defaultState() {
  const stages = ["Получен", "На проверке", "Утверждён", "В архиве"]
    .map((name, i) => ({ id: i + 1, name, order_index: i }));
  return { nextDocId: 1, nextFileId: 1, nextStageId: stages.length + 1, stages, documents: [] };
}

async function loadState() {
  try {
    const fh = await dirHandle.getFileHandle(REGISTRY_FILE, { create: false });
    const file = await fh.getFile();
    state = JSON.parse(await file.text());
  } catch (e) {
    state = defaultState();
    await saveState();
  }
}

async function saveState() {
  const fh = await dirHandle.getFileHandle(REGISTRY_FILE, { create: true });
  const writable = await fh.createWritable();
  await writable.write(JSON.stringify(state, null, 2));
  await writable.close();
}

/* --------------------------------------------------------------------- */
/* config.json — справочники: виды документов (+префиксы), контрагенты */
/* --------------------------------------------------------------------- */

async function loadConfig() {
  try {
    const fh = await dirHandle.getFileHandle(CONFIG_FILE, { create: false });
    const file = await fh.getFile();
    config = JSON.parse(await file.text());
  } catch (e) {
    config = JSON.parse(JSON.stringify(DEFAULT_CONFIG)); // копия по значению
    await saveConfig();
  }
}

async function saveConfig() {
  const fh = await dirHandle.getFileHandle(CONFIG_FILE, { create: true });
  const writable = await fh.createWritable();
  await writable.write(JSON.stringify(config, null, 2));
  await writable.close();
}

function addDocType(name) {
  name = (name || "").trim();
  if (!name) return null;
  if (!config.docTypes.includes(name)) config.docTypes.push(name);
  return name;
}

function addCounterparty(name) {
  name = name.trim();
  if (!name) return null;
  if (!config.counterparties.includes(name)) config.counterparties.push(name);
  return name;
}

/* --------------------------------------------------------------------- */
/* Подключение папки с данными */
/* --------------------------------------------------------------------- */

async function connectFolder() {
  try {
    dirHandle = await window.showDirectoryPicker({ mode: "readwrite" });
  } catch (e) {
    return false; // пользователь отменил выбор
  }
  await idbSet(HANDLE_KEY, dirHandle);
  await loadState();
  await loadConfig();
  return true;
}

async function tryRestoreFolder() {
  let handle;
  try {
    handle = await idbGet(HANDLE_KEY);
  } catch (e) {
    handle = null;
  }
  if (!handle) return false;
  const ok = await verifyPermissionSilent(handle);
  if (!ok) {
    dirHandle = handle;
    return "needs-confirmation";
  }
  dirHandle = handle;
  await loadState();
  await loadConfig();
  return true;
}

/* --------------------------------------------------------------------- */
/* Файлы вложений — плоско, в корне выбранной папки */
/* --------------------------------------------------------------------- */

function allUsedFilenames() {
  const used = new Set();
  for (const doc of state.documents) {
    for (const f of doc.files) used.add(f.stored_filename);
  }
  return used;
}

function uniqueStoredName(base, ext) {
  const used = allUsedFilenames();
  let candidate = `${base}${ext}`;
  let i = 2;
  while (used.has(candidate)) {
    candidate = `${base} (${i})${ext}`;
    i += 1;
  }
  return candidate;
}

async function writeFileToRoot(file, storedName) {
  const fh = await dirHandle.getFileHandle(storedName, { create: true });
  const writable = await fh.createWritable();
  await writable.write(await file.arrayBuffer());
  await writable.close();
}

/**
 * Прикрепляет файл к документу. Имя файла берётся автоматически из
 * "имени документа" (вид + номер + дата), подписывать вручную не нужно.
 */
async function attachFileToDoc(doc, file, stageId) {
  const ext = (file.name.match(/\.[^./\\]+$/) || [""])[0];
  const label = sanitizeFilename(buildDocLabel(doc));
  const version = doc.files.reduce((m, f) => Math.max(m, f.version), 0) + 1;
  const base = `${label} v${version}`;
  const storedName = uniqueStoredName(base, ext);

  await writeFileToRoot(file, storedName);

  const fileEntry = {
    id: state.nextFileId++,
    version,
    custom_name: label,
    stored_filename: storedName,
    original_filename: file.name,
    stage_id: stageId,
    uploaded_at: nowIso(),
  };
  doc.files.push(fileEntry);
  doc.updated_at = nowIso();
  return fileEntry;
}

async function deleteFileEntry(doc, fileId) {
  const idx = doc.files.findIndex((f) => f.id === fileId);
  if (idx === -1) return;
  const [entry] = doc.files.splice(idx, 1);
  try {
    await dirHandle.removeEntry(entry.stored_filename);
  } catch (e) {
    // файла уже нет на диске — не страшно, просто убираем запись
  }
  await saveState();
}

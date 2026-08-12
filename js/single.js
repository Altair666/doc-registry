/* ==========================================================================
   Одиночный режим добавления документов — пакетный: можно выбрать сразу
   несколько файлов (каждый файл = один будущий документ), для каждого —
   своя карточка с полями (как в групповом режиме), кол-во карточек
   считается автоматически по числу выбранных файлов. Справа — либо
   превью всех загруженных файлов (когда ничего не выбрано слева), либо
   полное превью конкретного файла (после клика по его карточке) с
   возможностью повернуть/удалить отдельные страницы.
   ========================================================================== */

let singleItems = []; // { id, file, color, doc_type, number, doc_date, counterparty, amount, comment, pdfDoc, numPages, previewFailed, pageRotations, deletedPages, draftFileName, draftFileSize }
let singleSelectedIdx = null; // какая карточка выбрана (её файл показан справа), null = галерея всех
let singleNextId = 1;
let singlePreviewToken = 0;
let singleReattachTargetIdx = null; // какой карточке докрепляем файл (после восстановления из черновика)

/** Карточка готова к экспорту, только если заполнены нужные поля И
    прикреплён реальный файл — карточка, восстановленная из черновика,
    файла ещё не имеет, пока пользователь не прикрепит его заново. */
function isSingleItemReady(it) {
  return isGroupDataFilled(it) && !!it.file;
}

/** Сбрасывает одиночный режим к пустому состоянию — вызывается при
    каждом открытии окна «Новый документ» (см. app.js, btnAdd). */
function resetSingleModeUI() {
  singleItems = [];
  singleSelectedIdx = null;
  $("#fFile").value = "";
  $("#fFileName").textContent = "Файлы не выбраны";
  $("#singleCountInput").value = 0;
  $("#singlePreviewArea").style.setProperty("--pdf-page-scale", "70%");
  $("#singleZoom").value = 70;
  $("#singleZoomValue").textContent = "70%";
  renderSingleCards();
  renderSinglePreview();
  updateSingleSaveButtonState();
  updateSingleDropZoneVisibility();
}

function updateSingleDropZoneVisibility() {
  $("#singleDropZoneInner").style.display = singleItems.length === 0 ? "flex" : "none";
}

$("#singleZoom").addEventListener("input", () => {
  const val = $("#singleZoom").value;
  $("#singleZoomValue").textContent = val + "%";
  $("#singlePreviewArea").style.setProperty("--pdf-page-scale", val + "%");
});

/* -------------------------------------------------------------------------
   Выбор файлов: через верхнюю кнопку, центральную кнопку в пустой
   области или перетаскиванием файлов прямо на неё.
   ------------------------------------------------------------------------- */

$("#fFile").addEventListener("change", () => processSingleFiles($("#fFile").files));

$("#singleReattachFile").addEventListener("change", async () => {
  const file = $("#singleReattachFile").files[0];
  $("#singleReattachFile").value = "";
  if (!file || singleReattachTargetIdx == null) return;
  const it = singleItems[singleReattachTargetIdx];
  if (!it) return;
  it.file = file;
  it.pdfDoc = null;
  it.previewFailed = false;
  singleReattachTargetIdx = null;
  renderSingleCards();
  if (singleSelectedIdx !== null) await renderSinglePreview();
  updateSingleSaveButtonState();
});

$("#btnSinglePickCenter").addEventListener("click", (e) => {
  e.stopPropagation();
  $("#fFile").click();
});

const singleDropZone = $("#singleDropZone");
singleDropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  $("#singleDropZoneInner").classList.add("drop-active");
});
singleDropZone.addEventListener("dragleave", (e) => {
  if (e.target === singleDropZone || e.target === $("#singleDropZoneInner")) {
    $("#singleDropZoneInner").classList.remove("drop-active");
  }
});
singleDropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  $("#singleDropZoneInner").classList.remove("drop-active");
  if (e.dataTransfer.files && e.dataTransfer.files.length) {
    processSingleFiles(e.dataTransfer.files);
  }
});

async function processSingleFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  await ensureGroupVendorLoaded(); // тот же pdf.js/pdf-lib, что и в групповом режиме

  const hasPending = singleItems.some((it) => !it.file);

  if (!hasPending) {
    // Обычный случай — начинаем набор карточек заново.
    singleItems = files.map((file, i) => makeFreshSingleItem(file, i));
  } else {
    // Есть карточки из восстановленного черновика, ожидающие файл.
    // Пробуем сопоставить упавшие файлы с ними по имени — если совпало,
    // файл "прикрепляется" именно туда, подхватывая сохранённые
    // настройки, как будто он никуда и не терялся. Несовпавшие файлы
    // просто добавляются новыми карточками.
    const leftover = [];
    files.forEach((file) => {
      const pendingIdx = singleItems.findIndex((it) => !it.file && it.draftFileName === file.name);
      if (pendingIdx !== -1) {
        singleItems[pendingIdx].file = file;
        singleItems[pendingIdx].pdfDoc = null;
        singleItems[pendingIdx].previewFailed = false;
      } else {
        leftover.push(file);
      }
    });
    leftover.forEach((file) => {
      singleItems.push(makeFreshSingleItem(file, singleItems.length));
    });
  }
  singleSelectedIdx = null;

  $("#fFileName").textContent = files.length === 1 ? files[0].name : `${files.length} файлов`;
  $("#singleCountInput").value = singleItems.length;
  updateSingleDropZoneVisibility();

  renderSingleCards();

  await renderSinglePreview();
  updateSingleSaveButtonState();
}

function makeFreshSingleItem(file, colorIdx) {
  const guess = guessFieldsFromFilename(file.name);
  return {
    id: singleNextId++,
    file,
    color: randomGroupColor(colorIdx),
    doc_type: guess.doc_type || "",
    number: guess.number || "",
    doc_date: guess.doc_date || todayIso(),
    counterparty: "",
    amount: "",
    comment: "",
    pdfDoc: null,
    numPages: null,
    previewFailed: false,
    pageRotations: {},
    deletedPages: new Set(),
  };
}

/** Пробует по имени файла угадать дату, номер и вид документа — чтобы
    пользователю не нужно было вбивать всё руками, если файл изначально
    называется как-то вроде "УПД 2594 от 31.07.2026.pdf". Best-effort:
    ничего страшного, если не угадает — поля просто останутся пустыми. */
function guessFieldsFromFilename(filename) {
  const base = filename.replace(/\.[a-zA-Z0-9]{1,5}$/, "");
  const result = { doc_type: "", number: "", doc_date: "" };

  let m = base.match(/(\d{2})[.\-_](\d{2})[.\-_](\d{4})/);
  if (m) {
    result.doc_date = `${m[3]}-${m[2]}-${m[1]}`;
  } else {
    m = base.match(/(\d{4})[.\-_](\d{2})[.\-_](\d{2})/);
    if (m) {
      result.doc_date = `${m[1]}-${m[2]}-${m[3]}`;
    } else {
      m = base.match(/(?:^|\D)(\d{2})[.\-_](\d{2})[.\-_](\d{2})(?!\d)/);
      if (m) result.doc_date = `20${m[3]}-${m[2]}-${m[1]}`;
    }
  }

  m = base.match(/[№#N]\s*(\d+)/i);
  if (m) {
    result.number = m[1];
  } else {
    m = base.match(/(?:^|[\s_\-])(\d{2,10})(?:[\s_\-]|$)/);
    if (m) result.number = m[1];
  }

  const upperBase = base.toUpperCase();
  const types = (config && config.docTypes) || [];
  for (const t of types) {
    if (upperBase.includes(t.toUpperCase())) {
      result.doc_type = t;
      break;
    }
  }
  return result;
}

/* -------------------------------------------------------------------------
   Карточки документов (слева)
   ------------------------------------------------------------------------- */

function renderSingleCards() {
  const list = $("#singleCardsList");
  list.innerHTML = singleItems
    .map((it, idx) => {
      const typeOptions =
        `<option value="" ${!it.doc_type ? "selected" : ""}>— выбрать —</option>` +
        config.docTypes.map((t) => `<option value="${escapeHtml(t)}" ${t === it.doc_type ? "selected" : ""}>${escapeHtml(t)}</option>`).join("");
      const cpOptions =
        `<option value="" ${!it.counterparty ? "selected" : ""}>—</option>` +
        config.counterparties.map((c) => `<option value="${escapeHtml(c)}" ${c === it.counterparty ? "selected" : ""}>${escapeHtml(c)}</option>`).join("");
      const badgeLabel = it.doc_type ? escapeHtml(buildDocLabel(it)) : escapeHtml(it.file ? it.file.name : it.draftFileName || "без файла");
      const filled = isSingleItemReady(it);
      const missingFile = !it.file;

      return `
      <div class="group-card single-card${filled ? " single-card-filled" : ""}${missingFile ? " single-card-missing-file" : ""}${singleSelectedIdx === idx ? " single-card-selected" : ""}" data-single="${idx}">
        <div class="group-card-header">
          <span class="group-badge" style="background:${it.color}" title="${escapeHtml(it.file ? it.file.name : it.draftFileName || "")}">${badgeLabel}</span>
          <span class="group-card-actions">
            <button type="button" class="icon-btn icon-btn-danger" data-single-delete="${idx}" title="Удалить документ вместе с файлом">✕</button>
            <span class="single-status${filled ? " ready" : ""}" title="${filled ? "Заполнено" : missingFile ? "Прикрепите файл" : "Заполните вид и номер"}">✓</span>
          </span>
        </div>
        ${
          missingFile
            ? `<p class="muted single-missing-file-hint">Из черновика: файл «${escapeHtml(it.draftFileName || "?")}» нужно прикрепить заново —
                 <button type="button" class="btn btn-secondary btn-small" data-single-attach="${idx}">Прикрепить файл</button></p>`
            : ""
        }
        <div class="form-grid group-fields-grid">
          <label class="f-type compact">Вид документа
            <span class="group-field-with-add">
              <select data-single-field="doc_type" data-idx="${idx}">${typeOptions}</select>
              <button type="button" class="icon-btn" data-single-add-type="${idx}" title="Добавить новый вид">+</button>
            </span>
          </label>
          <label class="f-date compact">Дата <input type="date" data-single-field="doc_date" data-idx="${idx}" value="${it.doc_date || ""}"></label>
          <label class="f-number">Номер документа <input type="text" data-single-field="number" data-idx="${idx}" value="${escapeHtml(it.number)}"></label>
          <label class="f-cp">Контрагент
            <span class="group-field-with-add">
              <select data-single-field="counterparty" data-idx="${idx}">${cpOptions}</select>
              <button type="button" class="icon-btn" data-single-add-cp="${idx}" title="Добавить нового контрагента">+</button>
            </span>
          </label>
          <label class="f-amount">Сумма <input type="text" data-single-field="amount" data-idx="${idx}" value="${escapeHtml(it.amount)}"></label>
          <label class="f-comment full">Комментарий <textarea rows="1" data-single-field="comment" data-idx="${idx}">${escapeHtml(it.comment)}</textarea></label>
        </div>
      </div>`;
    })
    .join("");

  wireSingleCardEvents();
}

function wireSingleCardEvents() {
  const list = $("#singleCardsList");

  list.querySelectorAll("[data-single-attach]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      singleReattachTargetIdx = Number(btn.dataset.singleAttach);
      $("#singleReattachFile").click();
    });
  });

  // Карточку без файла (жёлтую, из черновика) можно не только докрепить
  // через диалог, но и перетащить файл прямо на неё.
  list.querySelectorAll(".single-card-missing-file").forEach((card) => {
    card.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.stopPropagation();
      card.classList.add("drop-active");
    });
    card.addEventListener("dragleave", () => card.classList.remove("drop-active"));
    card.addEventListener("drop", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      card.classList.remove("drop-active");
      const file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (!file) return;
      const idx = Number(card.dataset.single);
      const it = singleItems[idx];
      if (!it) return;
      it.file = file;
      it.pdfDoc = null;
      it.previewFailed = false;
      renderSingleCards();
      if (singleSelectedIdx === idx) await renderSinglePreview();
      updateSingleSaveButtonState();
    });
  });

  list.querySelectorAll("[data-single-field]").forEach((el) => {
    const evt = el.tagName === "SELECT" || el.type === "date" ? "change" : "input";
    el.addEventListener(evt, () => {
      const idx = Number(el.dataset.idx);
      singleItems[idx][el.dataset.singleField] = el.value;
      updateSingleBadge(idx);
      updateSingleSaveButtonState();
    });
  });

  list.querySelectorAll("[data-single-add-type]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const idx = Number(btn.dataset.singleAddType);
      const name = window.prompt("Новый вид документа:");
      if (!name || !name.trim()) return;
      addDocType(name);
      await saveConfig();
      singleItems[idx].doc_type = name.trim();
      renderSingleCards();
      updateSingleSaveButtonState();
    });
  });

  list.querySelectorAll("[data-single-add-cp]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const idx = Number(btn.dataset.singleAddCp);
      const name = window.prompt("Новый контрагент:");
      if (!name || !name.trim()) return;
      const saved = addCounterparty(name);
      await saveConfig();
      singleItems[idx].counterparty = saved;
      renderSingleCards();
    });
  });

  list.querySelectorAll("[data-single-delete]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteSingleItem(Number(btn.dataset.singleDelete));
    });
  });

  list.querySelectorAll(".single-card").forEach((card) => {
    card.addEventListener("click", (e) => {
      if (e.target.closest("select, input, textarea, button")) return;
      selectSingleItem(Number(card.dataset.single));
    });
  });
}

/** Удаляет карточку документа вместе с привязанным к ней файлом. */
function deleteSingleItem(idx) {
  singleItems.splice(idx, 1);
  if (singleSelectedIdx === idx) singleSelectedIdx = null;
  else if (singleSelectedIdx != null && singleSelectedIdx > idx) singleSelectedIdx -= 1;

  $("#singleCountInput").value = singleItems.length;
  $("#fFileName").textContent =
    singleItems.length === 0 ? "Файлы не выбраны" : singleItems.length === 1 ? singleItems[0].file.name : `${singleItems.length} файлов`;
  updateSingleDropZoneVisibility();

  renderSingleCards();
  renderSinglePreview();
  updateSingleSaveButtonState();
}

function updateSingleBadge(idx) {
  const card = $(`.single-card[data-single="${idx}"]`);
  if (!card) return;
  const it = singleItems[idx];
  const filled = isSingleItemReady(it);
  card.classList.toggle("single-card-filled", filled);
  const badge = card.querySelector(".group-badge");
  badge.textContent = it.doc_type ? buildDocLabel(it) : it.file ? it.file.name : it.draftFileName || "без файла";
  const status = card.querySelector(".single-status");
  status.classList.toggle("ready", filled);
  status.title = filled ? "Заполнено" : !it.file ? "Прикрепите файл" : "Заполните вид и номер";
}

/** Кнопка «Добавить документы» активна, когда хотя бы одна карточка
    заполнена (вид + номер) — подтверждать отдельно не нужно, статус
    считается автоматически. */
function updateSingleSaveButtonState() {
  const anyReady = singleItems.some((it) => isSingleItemReady(it));
  $("#btnDocSave").disabled = !anyReady;
}

/* -------------------------------------------------------------------------
   Превью справа: клик по карточке — открыть её файл; когда ничего не
   выбрано — показываем миниатюры всех загруженных файлов.
   ------------------------------------------------------------------------- */

function selectSingleItem(idx) {
  singleSelectedIdx = idx;
  $$(".single-card").forEach((c) => c.classList.toggle("single-card-selected", Number(c.dataset.single) === idx));
  renderSinglePreview();
}

function isPdfFile(file) {
  return file.type === "application/pdf" || /\.pdf$/i.test(file.name);
}

async function ensurePdfLoadedForItem(it) {
  if (it.pdfDoc || it.previewFailed || !isPdfFile(it.file)) return;
  try {
    const buf = await it.file.arrayBuffer();
    const loadingTask = window.pdfjsLib.getDocument({ data: new Uint8Array(buf) });
    it.pdfDoc = await loadingTask.promise;
    it.numPages = it.pdfDoc.numPages;
  } catch (e) {
    it.previewFailed = true;
  }
}

async function renderSinglePreview() {
  const myToken = ++singlePreviewToken;
  const area = $("#singlePreviewArea");
  const scrollWrap = area.closest(".group-pdf-pages-scroll");
  const savedScrollTop = scrollWrap ? scrollWrap.scrollTop : 0;
  area.innerHTML = "";

  if (singleSelectedIdx == null) {
    $("#singlePreviewLabel").textContent = singleItems.length ? "Превью загруженных файлов" : "Превью появится здесь";
    for (let i = 0; i < singleItems.length; i++) {
      if (myToken !== singlePreviewToken) return;
      const el = await buildSingleThumb(i);
      if (myToken !== singlePreviewToken) return;
      area.appendChild(el);
    }
    return;
  }

  const it = singleItems[singleSelectedIdx];
  $("#singlePreviewLabel").textContent = it.file ? it.file.name : `${it.draftFileName || "без файла"} (из черновика)`;

  if (!it.file) {
    const wrap = document.createElement("div");
    wrap.className = "pdf-page";
    wrap.innerHTML = `<div class="pdf-page-label">${escapeHtml(it.draftFileName || "Файл не прикреплён")}</div><p class="muted" style="padding:16px 4px">Это карточка из черновика — прикрепите исходный файл заново кнопкой «Прикрепить файл» на карточке слева, тогда появится превью.</p>`;
    area.appendChild(wrap);
    return;
  }

  if (!isPdfFile(it.file)) {
    const wrap = document.createElement("div");
    wrap.className = "pdf-page";
    wrap.innerHTML = `<div class="pdf-page-label">${escapeHtml(it.file.name)}</div><p class="muted" style="padding:16px 4px">Превью недоступно для этого типа файла — но файл будет прикреплён при добавлении.</p>`;
    area.appendChild(wrap);
    return;
  }

  await ensurePdfLoadedForItem(it);
  if (myToken !== singlePreviewToken) return;

  if (!it.pdfDoc) {
    area.innerHTML = `<p class="muted">Не удалось отобразить превью файла.</p>`;
    return;
  }

  for (let p = 1; p <= it.numPages; p++) {
    if (myToken !== singlePreviewToken) return;
    if (it.deletedPages.has(p)) continue;

    const el = await buildSingleFullPage(it, p, singleSelectedIdx);
    if (myToken !== singlePreviewToken) return;
    area.appendChild(el);
  }

  if (scrollWrap) scrollWrap.scrollTop = savedScrollTop;
}

/** Строит страницу полного превью с кнопками поворота/удаления — как в
    групповом режиме, только состояние привязано к конкретному файлу. */
async function buildSingleFullPage(it, p, itemIdx) {
  const wrap = document.createElement("div");
  wrap.className = "pdf-page";
  wrap.dataset.page = String(p);

  const actions = document.createElement("div");
  actions.className = "pdf-page-actions";
  actions.innerHTML =
    `<button type="button" class="pdf-page-btn" data-single-rotate="${p}" title="Повернуть">⟳</button>` +
    `<button type="button" class="pdf-page-btn pdf-page-btn-danger" data-single-delete-page="${p}" title="Удалить страницу">✕</button>`;
  wrap.appendChild(actions);

  const canvas = document.createElement("canvas");
  wrap.appendChild(canvas);
  const label = document.createElement("div");
  label.className = "pdf-page-label";
  label.textContent = "Стр. " + p;
  wrap.appendChild(label);

  const page = await it.pdfDoc.getPage(p);
  const rotation = (page.rotate + (it.pageRotations[p] || 0)) % 360;
  const baseViewport = page.getViewport({ scale: 1, rotation });
  const scale = GROUP_PDF_RENDER_WIDTH / baseViewport.width;
  const viewport = page.getViewport({ scale, rotation });
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;

  actions.querySelector("[data-single-rotate]").addEventListener("click", (e) => {
    e.stopPropagation();
    it.pageRotations[p] = ((it.pageRotations[p] || 0) + 90) % 360;
    if (singleSelectedIdx === itemIdx) renderSinglePreview();
  });
  actions.querySelector("[data-single-delete-page]").addEventListener("click", (e) => {
    e.stopPropagation();
    it.deletedPages.add(p);
    if (singleSelectedIdx === itemIdx) renderSinglePreview();
  });

  return wrap;
}

async function buildSingleThumb(i) {
  const it = singleItems[i];
  const wrap = document.createElement("div");
  wrap.className = "pdf-page single-thumb";
  wrap.dataset.singleThumb = String(i);

  const canvas = document.createElement("canvas");
  wrap.appendChild(canvas);
  const label = document.createElement("div");
  label.className = "pdf-page-label";
  label.textContent = it.file ? it.file.name : `${it.draftFileName || "без файла"} (нужно прикрепить)`;
  wrap.appendChild(label);
  wrap.addEventListener("click", () => selectSingleItem(i));

  if (!it.file) return wrap; // черновик без файла — только подпись, превью нечем строить

  if (isPdfFile(it.file)) {
    await ensurePdfLoadedForItem(it);
    if (it.pdfDoc) {
      try {
        const page = await it.pdfDoc.getPage(1);
        const baseViewport = page.getViewport({ scale: 1 });
        const scale = 300 / baseViewport.width;
        const viewport = page.getViewport({ scale });
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
      } catch (e) {
        /* оставляем пустой канвас, не критично */
      }
    }
  }
  return wrap;
}

/* -------------------------------------------------------------------------
   Добавление документов
   ------------------------------------------------------------------------- */

/** Если файл — PDF и у него есть повороты/удалённые страницы, нарезает
    через pdf-lib новый файл с применёнными изменениями. Если изменений
    нет — просто возвращает исходный файл как есть (без лишней работы). */
async function buildFinalFileForItem(it) {
  const hasRotations = it.pageRotations && Object.keys(it.pageRotations).some((p) => it.pageRotations[p]);
  const hasDeletions = it.deletedPages && it.deletedPages.size > 0;
  if (!isPdfFile(it.file) || (!hasRotations && !hasDeletions)) {
    return it.file;
  }

  const bytes = await it.file.arrayBuffer();
  const srcPdf = await PDFLib.PDFDocument.load(bytes);
  const totalPages = srcPdf.getPageCount();
  const keepIndices = [];
  for (let p = 1; p <= totalPages; p++) {
    if (!it.deletedPages.has(p)) keepIndices.push(p - 1);
  }
  if (!keepIndices.length) {
    alert(`В файле «${it.file.name}» удалены все страницы — оставьте хотя бы одну.`);
    return null;
  }

  const outPdf = await PDFLib.PDFDocument.create();
  const copiedPages = await outPdf.copyPages(srcPdf, keepIndices);
  copiedPages.forEach((pg, i) => {
    const originalPageNum = keepIndices[i] + 1;
    const extra = (it.pageRotations && it.pageRotations[originalPageNum]) || 0;
    if (extra) {
      const current = pg.getRotation().angle || 0;
      pg.setRotation(PDFLib.degrees((current + extra) % 360));
    }
    outPdf.addPage(pg);
  });
  const outBytes = await outPdf.save();
  return new File([outBytes], it.file.name, { type: "application/pdf" });
}

$("#btnDocSave").addEventListener("click", async () => {
  const ready = singleItems.filter((it) => isSingleItemReady(it));
  const skipped = singleItems.length - ready.length;
  if (!ready.length) return;
  if (skipped > 0 && !confirm(`${ready.length} файл(ов) готово к добавлению, ${skipped} будет пропущено (не заполнены вид/номер или не прикреплён файл). Продолжить?`)) {
    return;
  }

  const firstStage = orderedStages()[0];
  if (!firstStage) {
    alert("Нет ни одной стадии. Создайте стадию сначала (в Справочниках).");
    return;
  }

  const saveBtn = $("#btnDocSave");
  const originalLabel = saveBtn.textContent;
  saveBtn.disabled = true; // серая, пока идёт добавление — не даём нажать повторно

  let added = 0;
  for (const it of ready) {
    saveBtn.textContent = `Добавление ${added + 1} из ${ready.length}…`;
    const finalFile = await buildFinalFileForItem(it);
    if (!finalFile) continue; // например, все страницы файла оказались удалены

    const ts = nowIso();
    const doc = {
      id: state.nextDocId++,
      doc_type: it.doc_type,
      number: it.number,
      doc_date: it.doc_date,
      counterparty: it.counterparty,
      amount: it.amount,
      comment: it.comment,
      stage_id: firstStage.id,
      created_at: ts,
      updated_at: ts,
      files: [],
    };
    state.documents.push(doc);
    await attachFileToDoc(doc, finalFile, doc.stage_id);
    added++;
  }

  await saveState();
  await saveConfig();
  await deleteDraft();
  currentDraftExists = false;
  if (typeof updateDraftButtonsUI === "function") updateDraftButtonsUI();
  saveBtn.textContent = originalLabel;
  $("#modalDoc").classList.remove("open");
  renderTable();
});

/* -------------------------------------------------------------------------
   Черновик: сохраняет только описательные метаданные карточек (какие поля
   заполнены, повороты/удалённые страницы) — БЕЗ содержимого самих файлов.
   При восстановлении карточки создаются без файла, пользователь прикрепляет
   исходный файл заново кнопкой "Прикрепить файл" на карточке.
   ------------------------------------------------------------------------- */

function collectSingleDraftSnapshot() {
  if (!singleItems.length) return null;
  return {
    items: singleItems.map((it) => ({
      fileName: it.file ? it.file.name : it.draftFileName || null,
      doc_type: it.doc_type,
      number: it.number,
      doc_date: it.doc_date,
      counterparty: it.counterparty,
      amount: it.amount,
      comment: it.comment,
      pageRotations: it.pageRotations || {},
      deletedPages: it.deletedPages ? Array.from(it.deletedPages) : [],
    })),
  };
}

/** Восстанавливает карточки из черновика — без самих файлов, только
    поля. Карточка ждёт файл с тем же именем: как только он снова
    попадёт в processSingleFiles (перетаскиванием или через выбор) —
    "прикрепится" именно к этой карточке автоматически, подхватив все
    сохранённые настройки, как будто ничего и не терялось. */
function restoreSingleDraftSnapshot(snapshot) {
  if (!snapshot || !snapshot.items || !snapshot.items.length) return;
  singleItems = snapshot.items.map((it) => ({
    id: singleNextId++,
    file: null,
    draftFileName: it.fileName,
    color: randomGroupColor(singleItems.length),
    doc_type: it.doc_type || "",
    number: it.number || "",
    doc_date: it.doc_date || todayIso(),
    counterparty: it.counterparty || "",
    amount: it.amount || "",
    comment: it.comment || "",
    pdfDoc: null,
    numPages: null,
    previewFailed: false,
    pageRotations: it.pageRotations || {},
    deletedPages: new Set(it.deletedPages || []),
  }));
  singleSelectedIdx = null;
  $("#fFileName").textContent = singleItems.length + " файл(ов) из черновика — прикрепите их заново (перетащите/выберите те же файлы)";
  $("#singleCountInput").value = singleItems.length;
  updateSingleDropZoneVisibility();
  renderSingleCards();
  renderSinglePreview();
  updateSingleSaveButtonState();
}

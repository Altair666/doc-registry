/* ==========================================================================
   Одиночный режим добавления документов — теперь тоже пакетный: можно
   выбрать сразу несколько файлов (каждый файл = один будущий документ),
   для каждого — своя карточка с полями (как в групповом режиме), кол-во
   карточек считается автоматически по числу выбранных файлов. Справа —
   либо превью всех загруженных файлов (когда ничего не выбрано слева),
   либо полное превью конкретного файла (после клика по его карточке).
   ========================================================================== */

let singleItems = []; // { id, file, color, doc_type, number, doc_date, counterparty, amount, comment, confirmed, pdfDoc, numPages, previewFailed }
let singleSelectedIdx = null; // какая карточка выбрана (её файл показан справа), null = галерея всех
let singleNextId = 1;
let singlePreviewToken = 0;

/** Сбрасывает одиночный режим к пустому состоянию — вызывается при
    каждом открытии окна «Новый документ» (см. app.js, btnAdd). */
function resetSingleModeUI() {
  singleItems = [];
  singleSelectedIdx = null;
  $("#fFile").value = "";
  $("#fFileName").textContent = "Файлы не выбраны";
  $("#singleCountInput").value = 0;
  renderSingleCards();
  renderSinglePreview();
  updateSingleSaveButtonState();
}

/* -------------------------------------------------------------------------
   Выбор файлов
   ------------------------------------------------------------------------- */

$("#fFile").addEventListener("change", async () => {
  const files = Array.from($("#fFile").files || []);
  if (!files.length) return;
  await ensureGroupVendorLoaded(); // тот же pdf.js, что и в групповом режиме — для превью

  singleItems = files.map((file, i) => {
    const guess = guessFieldsFromFilename(file.name);
    return {
      id: singleNextId++,
      file,
      color: randomGroupColor(i),
      doc_type: guess.doc_type || "",
      number: guess.number || "",
      doc_date: guess.doc_date || todayIso(),
      counterparty: "",
      amount: "",
      comment: "",
      confirmed: false,
      pdfDoc: null,
      numPages: null,
      previewFailed: false,
    };
  });
  singleSelectedIdx = null;

  $("#fFileName").textContent = files.length === 1 ? files[0].name : `${files.length} файлов`;
  $("#singleCountInput").value = singleItems.length;

  renderSingleCards();
  await renderSinglePreview();
  updateSingleSaveButtonState();
});

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
      const badgeLabel = it.doc_type ? escapeHtml(buildDocLabel(it)) : escapeHtml(it.file.name);

      return `
      <div class="group-card single-card${singleSelectedIdx === idx ? " single-card-selected" : ""}" data-single="${idx}">
        <div class="group-card-header">
          <span class="group-badge${isGroupDataFilled(it) ? " filled" : ""}${it.confirmed ? " confirmed" : ""}"
                style="background:${it.color}" title="${escapeHtml(it.file.name)}">${badgeLabel}</span>
          <span class="group-card-actions">
            <button type="button" class="icon-btn icon-btn-confirm" data-single-confirm="${idx}" title="Подтвердить">✓</button>
          </span>
        </div>
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

  list.querySelectorAll("[data-single-confirm]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const idx = Number(btn.dataset.singleConfirm);
      singleItems[idx].confirmed = !singleItems[idx].confirmed;
      updateSingleBadge(idx);
      updateSingleSaveButtonState();
    });
  });

  list.querySelectorAll(".single-card").forEach((card) => {
    card.addEventListener("click", (e) => {
      if (e.target.closest("select, input, textarea, button")) return;
      selectSingleItem(Number(card.dataset.single));
    });
  });
}

function updateSingleBadge(idx) {
  const card = $(`.single-card[data-single="${idx}"]`);
  if (!card) return;
  const it = singleItems[idx];
  const badge = card.querySelector(".group-badge");
  badge.classList.toggle("filled", isGroupDataFilled(it));
  badge.classList.toggle("confirmed", !!it.confirmed);
  badge.textContent = it.doc_type ? buildDocLabel(it) : it.file.name;
}

function updateSingleSaveButtonState() {
  const ready = singleItems.some((it) => it.confirmed && isGroupDataFilled(it));
  $("#btnDocSave").disabled = !ready;
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
  area.innerHTML = "";
  $("#singlePreviewHint").style.display = singleItems.length ? "none" : "block";

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
  $("#singlePreviewLabel").textContent = it.file.name;

  if (!isPdfFile(it.file)) {
    const wrap = document.createElement("div");
    wrap.className = "pdf-page";
    wrap.style.width = "260px";
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
    const page = await it.pdfDoc.getPage(p);
    if (myToken !== singlePreviewToken) return;
    const wrap = document.createElement("div");
    wrap.className = "pdf-page";
    wrap.style.width = "70%";
    const canvas = document.createElement("canvas");
    wrap.appendChild(canvas);
    const label = document.createElement("div");
    label.className = "pdf-page-label";
    label.textContent = "Стр. " + p;
    wrap.appendChild(label);

    const baseViewport = page.getViewport({ scale: 1 });
    const scale = GROUP_PDF_RENDER_WIDTH / baseViewport.width;
    const viewport = page.getViewport({ scale });
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    if (myToken !== singlePreviewToken) return;
    area.appendChild(wrap);
  }
}

async function buildSingleThumb(i) {
  const it = singleItems[i];
  const wrap = document.createElement("div");
  wrap.className = "pdf-page single-thumb";
  wrap.style.width = "150px";
  wrap.dataset.singleThumb = String(i);
  wrap.style.cursor = "pointer";

  const canvas = document.createElement("canvas");
  wrap.appendChild(canvas);
  const label = document.createElement("div");
  label.className = "pdf-page-label";
  label.textContent = it.file.name;
  wrap.appendChild(label);
  wrap.addEventListener("click", () => selectSingleItem(i));

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

$("#btnDocSave").addEventListener("click", async () => {
  const ready = singleItems.filter((it) => it.confirmed && isGroupDataFilled(it));
  const skipped = singleItems.length - ready.length;
  if (!ready.length) return;
  if (skipped > 0 && !confirm(`${ready.length} документ(ов) готово к добавлению, ${skipped} будет пропущено (не заполнены поля или не подтверждено галочкой). Продолжить?`)) {
    return;
  }

  const firstStage = orderedStages()[0];
  if (!firstStage) {
    alert("Нет ни одной стадии. Создайте стадию сначала (в Справочниках).");
    return;
  }

  for (const it of ready) {
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
    await attachFileToDoc(doc, it.file, doc.stage_id);
  }

  await saveState();
  await saveConfig();
  $("#modalDoc").classList.remove("open");
  renderTable();
});

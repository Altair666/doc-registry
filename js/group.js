/* ==========================================================================
   Групповой режим добавления документов.
   Позволяет загрузить один PDF со сканами нескольких документов и
   расставить "бейджи" групп по страницам — при подтверждении каждая
   группа получает свой диапазон страниц. При добавлении PDF нарезается
   на отдельные файлы (как в одиночном режиме) и создаётся документ на
   группу.
   ========================================================================== */

let groupVendorLoaded = false;
let groups = []; // { color, doc_type, number, doc_date, counterparty, amount, comment, pagesCount, pendingPlacement, confirmed, assignedPages }
let groupPdfDoc = null; // pdfjsLib document proxy (для рендера превью)
let groupPdfBytesForSplit = null; // ArrayBuffer — отдельная копия для pdf-lib
let groupTotalPages = 0;
let groupConsumedPages = new Set(); // номера страниц (1-based), уже подтверждённые за какой-то группой
let pageStates = {}; // { [pageNumber]: { rotation: 0|90|180|270, deleted: bool } }
let showHiddenPages = false;

/** Ширина рендера канваса в пикселях — с запасом, чтобы страница
    оставалась чёткой даже при масштабе 100% (во всю ширину блока). */
const GROUP_PDF_RENDER_WIDTH = 900;

function getPageState(p) {
  if (!pageStates[p]) pageStates[p] = { rotation: 0, deleted: false };
  return pageStates[p];
}

$("#groupZoom").addEventListener("input", () => {
  const val = $("#groupZoom").value;
  $("#groupZoomValue").textContent = val + "%";
  $("#groupPdfPages").style.setProperty("--pdf-page-scale", val + "%");
});

$("#btnShowHiddenPages").addEventListener("click", () => {
  showHiddenPages = !showHiddenPages;
  $("#btnShowHiddenPages").textContent = showHiddenPages ? "Скрыть удалённые страницы" : "Показать скрытые страницы";
  $("#btnShowHiddenPages").classList.toggle("btn-primary", showHiddenPages);
  $("#btnShowHiddenPages").classList.toggle("btn-secondary", !showHiddenPages);
  renderGroupPdfPages();
});

/* -------------------------------------------------------------------------
   Ленивая подгрузка pdf.js / pdf-lib — только когда реально понадобились
   ------------------------------------------------------------------------- */

function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Не удалось загрузить " + src));
    document.head.appendChild(s);
  });
}

async function ensureGroupVendorLoaded() {
  if (groupVendorLoaded) return;
  $("#groupLoadingHint").style.display = "block";
  try {
    await loadScriptOnce("js/vendor/pdf-lib.min.js");
    await loadScriptOnce("js/vendor/pdf.min.js");
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = "js/vendor/pdf.worker.min.js";
    groupVendorLoaded = true;
  } finally {
    $("#groupLoadingHint").style.display = "none";
  }
}

/* -------------------------------------------------------------------------
   Переключатель "Один документ" / "Группа документов"
   ------------------------------------------------------------------------- */

$$("#modeToggle .mode-toggle-btn").forEach((btn) => {
  btn.addEventListener("click", async () => {
    $$("#modeToggle .mode-toggle-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const mode = btn.dataset.mode;
    $("#groupTopbarExtra").style.display = mode === "group" ? "flex" : "none";
    $("#singleTopbarExtra").style.display = mode === "single" ? "flex" : "none";
    $("#singleModeWrap").style.display = mode === "single" ? "flex" : "none";
    $("#groupModePanel").style.display = mode === "group" ? "flex" : "none";
    $("#modalDocTitle").textContent = mode === "group" ? "Новый документ — разбить PDF" : "Новый документ";
    if (mode === "group") {
      await ensureGroupVendorLoaded();
    }
  });
});

/** Сбрасывает групповой режим к пустому состоянию — вызывается при
    каждом открытии окна «Новый документ» (см. app.js, btnAdd). */
function resetGroupModeUI() {
  $$("#modeToggle .mode-toggle-btn").forEach((b) => b.classList.toggle("active", b.dataset.mode === "single"));
  $("#groupTopbarExtra").style.display = "none";
  $("#singleTopbarExtra").style.display = "flex";
  $("#singleModeWrap").style.display = "flex";
  $("#groupModePanel").style.display = "none";
  $("#modalDocTitle").textContent = "Новый документ";

  groups = [];
  groupPdfDoc = null;
  groupPdfBytesForSplit = null;
  groupTotalPages = 0;
  groupConsumedPages = new Set();
  pageStates = {};
  showHiddenPages = false;

  $("#groupFile").value = "";
  $("#groupFileName").textContent = "Файл не выбран";
  $("#groupPdfPages").innerHTML = "";
  $("#groupPdfPages").style.setProperty("--pdf-page-scale", "100%");
  $("#groupZoom").value = 100;
  $("#groupZoomValue").textContent = "100%";
  $("#btnShowHiddenPages").textContent = "Показать скрытые страницы";
  $("#btnShowHiddenPages").classList.remove("btn-primary");
  $("#btnShowHiddenPages").classList.add("btn-secondary");
  $("#groupCountInput").value = 1;
  updateGroupDropZoneVisibility();

  setGroupCount(1);
}

/* -------------------------------------------------------------------------
   Группы: создание, изменение количества, цвет
   ------------------------------------------------------------------------- */

function randomGroupColor(idx) {
  const hue = (idx * 137.508) % 360; // золотой угол — визуально разные, но воспроизводимые цвета
  return `hsl(${Math.round(hue)}, 68%, 48%)`;
}

function makeEmptyGroup(idx) {
  return {
    color: randomGroupColor(idx),
    doc_type: "",
    number: "",
    doc_date: todayIso(),
    counterparty: "",
    amount: "",
    comment: "",
    pagesCount: 1,
    pendingPlacement: null, // массив номеров страниц, ожидающих подтверждения
    confirmed: false,
    assignedPages: null, // массив номеров страниц, закреплённых за группой
  };
}

function isGroupDataFilled(g) {
  return !!g.doc_type && !!(g.number && g.number.trim());
}

function setGroupCount(n) {
  n = Math.max(1, Math.min(60, Math.round(n) || 1));
  if (n < groups.length) {
    for (let i = n; i < groups.length; i++) {
      const g = groups[i];
      if (g.confirmed && g.assignedPages) {
        g.assignedPages.forEach((p) => groupConsumedPages.delete(p));
      }
    }
    groups = groups.slice(0, n);
  } else {
    while (groups.length < n) groups.push(makeEmptyGroup(groups.length));
  }
  $("#groupCountInput").value = n;
  renderGroupCards();
  renderGroupPdfPages();
  updateGroupSaveButtonState();
}

$("#groupCountMinus").addEventListener("click", () => setGroupCount(Number($("#groupCountInput").value) - 1));
$("#groupCountPlus").addEventListener("click", () => setGroupCount(Number($("#groupCountInput").value) + 1));
$("#groupCountInput").addEventListener("change", () => setGroupCount(Number($("#groupCountInput").value)));

/* -------------------------------------------------------------------------
   Рендер карточек групп (левая колонка)
   ------------------------------------------------------------------------- */

function renderGroupCards() {
  const list = $("#groupCardsList");
  list.innerHTML = groups
    .map((g, idx) => {
      const typeOptions =
        `<option value="" ${g.doc_type ? "" : "selected"}>— выбрать —</option>` +
        config.docTypes.map((t) => `<option value="${escapeHtml(t)}" ${t === g.doc_type ? "selected" : ""}>${escapeHtml(t)}</option>`).join("");
      const cpOptions =
        `<option value="" ${g.counterparty ? "" : "selected"}>—</option>` +
        config.counterparties.map((c) => `<option value="${escapeHtml(c)}" ${c === g.counterparty ? "selected" : ""}>${escapeHtml(c)}</option>`).join("");
      const badgeLabel = g.doc_type ? escapeHtml(buildDocLabel(g)) : String(idx + 1);
      return `
      <div class="group-card" data-group="${idx}">
        <div class="group-card-header">
          <span class="group-badge${isGroupDataFilled(g) ? " filled" : ""}${g.confirmed ? " confirmed" : ""}"
                data-badge="${idx}" draggable="true" style="background:${g.color}" title="Перетащите на страницу справа">${badgeLabel}</span>
          <label class="group-pages-label muted">Стр.
            <span class="stepper stepper-small">
              <input type="number" min="1" max="99" value="${g.pagesCount}" data-pages-input="${idx}">
              <span class="stepper-arrows">
                <button type="button" data-pages-plus="${idx}" class="stepper-arrow stepper-arrow-up">▲</button>
                <button type="button" data-pages-minus="${idx}" class="stepper-arrow stepper-arrow-down">▼</button>
              </span>
            </span>
          </label>
          <span class="group-card-actions">
            <button type="button" class="icon-btn" data-reset="${idx}" title="Сбросить размещение">↺</button>
            <button type="button" class="icon-btn icon-btn-confirm${isGroupDataFilled(g) ? " ready" : ""}${g.confirmed ? " confirmed" : ""}" data-confirm="${idx}" title="Подтвердить размещение">✓</button>
          </span>
        </div>
        <div class="form-grid group-fields-grid">
          <label class="f-type compact">Вид документа
            <span class="group-field-with-add">
              <select data-field="doc_type" data-idx="${idx}">${typeOptions}</select>
              <button type="button" class="icon-btn" data-add-type="${idx}" title="Добавить новый вид">+</button>
            </span>
          </label>
          <label class="f-date compact">Дата <input type="date" data-field="doc_date" data-idx="${idx}" value="${g.doc_date || ""}"></label>
          <label class="f-number">Номер документа <input type="text" data-field="number" data-idx="${idx}" value="${escapeHtml(g.number)}"></label>
          <label class="f-cp">Контрагент
            <span class="group-field-with-add">
              <select data-field="counterparty" data-idx="${idx}">${cpOptions}</select>
              <button type="button" class="icon-btn" data-add-cp="${idx}" title="Добавить нового контрагента">+</button>
            </span>
          </label>
          <label class="f-amount">Сумма <input type="text" data-field="amount" data-idx="${idx}" value="${escapeHtml(g.amount)}"></label>
          <label class="f-comment full">Комментарий <textarea rows="1" data-field="comment" data-idx="${idx}">${escapeHtml(g.comment)}</textarea></label>
        </div>
      </div>`;
    })
    .join("");

  wireGroupCardEvents();
}

function wireGroupCardEvents() {
  const list = $("#groupCardsList");

  list.querySelectorAll("[data-field]").forEach((el) => {
    const evt = el.tagName === "SELECT" || el.type === "date" ? "change" : "input";
    el.addEventListener(evt, () => {
      const idx = Number(el.dataset.idx);
      groups[idx][el.dataset.field] = el.value;
      updateGroupBadgeVisual(idx);
      updateGroupSaveButtonState();
    });
  });

  list.querySelectorAll("[data-add-type]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.addType);
      const name = window.prompt("Новый вид документа:");
      if (!name || !name.trim()) return;
      addDocType(name);
      saveConfig();
      groups[idx].doc_type = name.trim();
      renderGroupCards();
      updateGroupSaveButtonState();
    });
  });
  list.querySelectorAll("[data-add-cp]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.addCp);
      const name = window.prompt("Новый контрагент:");
      if (!name || !name.trim()) return;
      const saved = addCounterparty(name);
      saveConfig();
      groups[idx].counterparty = saved;
      renderGroupCards();
    });
  });

  list.querySelectorAll("[data-pages-minus]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.pagesMinus);
      groups[idx].pagesCount = Math.max(1, groups[idx].pagesCount - 1);
      list.querySelector(`[data-pages-input="${idx}"]`).value = groups[idx].pagesCount;
    });
  });
  list.querySelectorAll("[data-pages-plus]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.pagesPlus);
      groups[idx].pagesCount = Math.min(99, groups[idx].pagesCount + 1);
      list.querySelector(`[data-pages-input="${idx}"]`).value = groups[idx].pagesCount;
    });
  });
  list.querySelectorAll("[data-pages-input]").forEach((inp) => {
    inp.addEventListener("change", () => {
      const idx = Number(inp.dataset.pagesInput);
      groups[idx].pagesCount = Math.max(1, Math.min(99, Number(inp.value) || 1));
      inp.value = groups[idx].pagesCount;
    });
  });

  list.querySelectorAll("[data-reset]").forEach((btn) => {
    btn.addEventListener("click", () => resetGroupPlacement(Number(btn.dataset.reset)));
  });
  list.querySelectorAll("[data-confirm]").forEach((btn) => {
    btn.addEventListener("click", () => confirmGroupPlacement(Number(btn.dataset.confirm)));
  });

  list.querySelectorAll(".group-badge").forEach((badge) => {
    badge.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", badge.dataset.badge);
      e.dataTransfer.effectAllowed = "move";
    });
  });
}

function updateGroupBadgeVisual(idx) {
  const badge = $(`.group-badge[data-badge="${idx}"]`);
  if (!badge) return;
  const g = groups[idx];
  const filled = isGroupDataFilled(g);
  badge.classList.toggle("filled", filled);
  badge.classList.toggle("confirmed", !!g.confirmed);
  badge.textContent = g.doc_type ? buildDocLabel(g) : String(idx + 1);
  const confirmBtn = $(`[data-confirm="${idx}"]`);
  if (confirmBtn) {
    confirmBtn.classList.toggle("ready", filled);
    confirmBtn.classList.toggle("confirmed", !!g.confirmed);
  }
}

/* -------------------------------------------------------------------------
   Размещение и подтверждение бейджей на страницах PDF
   ------------------------------------------------------------------------- */

/** Список номеров страниц, доступных для размещения — по порядку,
    без учёта уже занятых другой группой и удалённых (пропускаются). */
function availablePageNumbers() {
  const list = [];
  for (let p = 1; p <= groupTotalPages; p++) {
    if (groupConsumedPages.has(p)) continue;
    if (getPageState(p).deleted) continue;
    list.push(p);
  }
  return list;
}

function placeBadgeOnPage(idx, pageNum) {
  const g = groups[idx];
  const count = g.pagesCount;
  const available = availablePageNumbers();
  const startIdx = available.indexOf(pageNum);
  if (startIdx === -1) {
    alert("Эта страница недоступна для размещения.");
    return;
  }
  const slice = available.slice(startIdx, startIdx + count);
  if (slice.length < count) {
    alert("Недостаточно свободных (не удалённых) страниц начиная с этой.");
    return;
  }
  clearPendingOverlaysForGroup(idx); // убираем оверлей с прошлого места (если группу перетащили ещё раз)
  g.pendingPlacement = slice;
  slice.forEach((p, i) => {
    const pageEl = getPageEl(p);
    if (pageEl) renderPendingOverlay(pageEl, idx, i === 0);
  });
}

function confirmGroupPlacement(idx) {
  const g = groups[idx];
  if (!g.pendingPlacement || !g.pendingPlacement.length) {
    alert("Сначала перетащите бейдж этой группы на нужную страницу справа.");
    return;
  }
  g.pendingPlacement.forEach((p) => {
    groupConsumedPages.add(p);
    removePageFromDom(p); // страница уходит из общего пула — остальные не трогаем
  });
  g.assignedPages = g.pendingPlacement;
  g.confirmed = true;
  g.pendingPlacement = null;
  renderGroupCards();
  updateGroupSaveButtonState();
}

async function resetGroupPlacement(idx) {
  const g = groups[idx];
  if (g.confirmed && g.assignedPages) {
    const pagesToRestore = g.assignedPages;
    pagesToRestore.forEach((p) => groupConsumedPages.delete(p));
    // Вставляем строго по очереди (дожидаясь каждую) — параллельные async-
    // вызовы делят один и тот же токен отмены рендера и гасили бы друг
    // друга, из-за чего часть страниц не возвращалась в пул.
    for (const p of pagesToRestore) {
      await insertPageIntoDom(p);
    }
  }
  if (g.pendingPlacement) clearPendingOverlaysForGroup(idx);
  g.confirmed = false;
  g.assignedPages = null;
  g.pendingPlacement = null;
  renderGroupCards();
  updateGroupSaveButtonState();
}

/* -------------------------------------------------------------------------
   PDF: загрузка, рендер превью страниц, drag&drop
   ------------------------------------------------------------------------- */

function updateGroupDropZoneVisibility() {
  $("#groupDropZoneInner").style.display = groupPdfDoc ? "none" : "flex";
}

$("#groupFile").addEventListener("change", () => processGroupFile($("#groupFile").files[0]));

$("#btnGroupPickCenter").addEventListener("click", async (e) => {
  e.stopPropagation();
  await ensureGroupVendorLoaded();
  $("#groupFile").click();
});

const groupDropZone = $("#groupDropZone");
groupDropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  $("#groupDropZoneInner").classList.add("drop-active");
});
groupDropZone.addEventListener("dragleave", (e) => {
  if (e.target === groupDropZone || e.target === $("#groupDropZoneInner")) {
    $("#groupDropZoneInner").classList.remove("drop-active");
  }
});
groupDropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  $("#groupDropZoneInner").classList.remove("drop-active");
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) processGroupFile(file);
});

async function processGroupFile(file) {
  if (!file) return;
  $("#groupFileName").textContent = file.name;
  await ensureGroupVendorLoaded();

  const buf = await file.arrayBuffer();
  groupPdfBytesForSplit = buf.slice(0); // отдельная копия — для нарезки через pdf-lib
  const renderBytes = new Uint8Array(buf.slice(0));

  groupConsumedPages = new Set();
  pageStates = {};
  showHiddenPages = false;
  $("#btnShowHiddenPages").textContent = "Показать скрытые страницы";
  $("#btnShowHiddenPages").classList.remove("btn-primary");
  $("#btnShowHiddenPages").classList.add("btn-secondary");
  groups.forEach((g) => {
    g.confirmed = false;
    g.assignedPages = null;
    g.pendingPlacement = null;
  });

  const loadingTask = window.pdfjsLib.getDocument({ data: renderBytes });
  groupPdfDoc = await loadingTask.promise;
  groupTotalPages = groupPdfDoc.numPages;
  for (let p = 1; p <= groupTotalPages; p++) pageStates[p] = { rotation: 0, deleted: false };

  updateGroupDropZoneVisibility();
  await renderGroupPdfPages();
  renderGroupCards();
  updateGroupSaveButtonState();
}

let groupPdfRenderToken = 0;

/** Строит полностью готовый (с отрисованным канвасом и навешанными
    обработчиками) DOM-элемент одной страницы. Не вставляет его никуда —
    решение о позиции принимает вызывающий код. */
async function buildPageElement(p) {
  const st = getPageState(p);

  const pageWrap = document.createElement("div");
  pageWrap.className = "pdf-page" + (st.deleted ? " pdf-page-deleted" : "");
  pageWrap.dataset.page = String(p);

  const actions = document.createElement("div");
  actions.className = "pdf-page-actions";
  if (st.deleted) {
    actions.innerHTML = `<button type="button" class="pdf-page-btn pdf-page-btn-restore" data-restore="${p}" title="Вернуть страницу">Вернуть</button>`;
  } else {
    actions.innerHTML =
      `<button type="button" class="pdf-page-btn" data-rotate="${p}" title="Повернуть">⟳</button>` +
      `<button type="button" class="pdf-page-btn pdf-page-btn-danger" data-delete="${p}" title="Удалить страницу">✕</button>`;
  }
  pageWrap.appendChild(actions);

  const canvas = document.createElement("canvas");
  pageWrap.appendChild(canvas);
  const label = document.createElement("div");
  label.className = "pdf-page-label";
  label.textContent = "Стр. " + p + (st.deleted ? " (удалена)" : "");
  pageWrap.appendChild(label);

  const page = await groupPdfDoc.getPage(p);
  const rotation = (page.rotate + st.rotation) % 360;
  const baseViewport = page.getViewport({ scale: 1, rotation });
  const scale = GROUP_PDF_RENDER_WIDTH / baseViewport.width;
  const viewport = page.getViewport({ scale, rotation });
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;

  const restoreBtn = actions.querySelector("[data-restore]");
  if (restoreBtn) {
    restoreBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      getPageState(p).deleted = false;
      rerenderPageInPlace(p);
    });
  }
  const rotateBtn = actions.querySelector("[data-rotate]");
  if (rotateBtn) {
    rotateBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const s = getPageState(p);
      s.rotation = (s.rotation + 90) % 360;
      rerenderPageInPlace(p);
    });
  }
  const deleteBtn = actions.querySelector("[data-delete]");
  if (deleteBtn) {
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      getPageState(p).deleted = true;
      if (showHiddenPages) {
        rerenderPageInPlace(p);
      } else {
        removePageFromDom(p);
      }
    });
  }

  if (!st.deleted) wirePageDropzone(pageWrap, p);
  return pageWrap;
}

function getPageEl(p) {
  return $(`#groupPdfPages .pdf-page[data-page="${p}"]`);
}

function removePageFromDom(p) {
  const el = getPageEl(p);
  if (el) el.remove();
}

/** Пересоздаёт ОДНУ страницу на её текущем месте в DOM, не трогая
    остальные — используется для поворота/удаления/восстановления,
    чтобы список не мигал и не перематывался при каждом изменении. */
async function rerenderPageInPlace(p) {
  const myToken = ++groupPdfRenderToken;
  const oldEl = getPageEl(p);
  const newEl = await buildPageElement(p);
  if (myToken !== groupPdfRenderToken) return; // подоспело более новое изменение — бросаем это
  if (oldEl && oldEl.parentNode) {
    oldEl.replaceWith(newEl);
  } else {
    insertPageElementSorted(newEl, p);
  }
}

/** Вставляет уже готовый элемент страницы в правильное (отсортированное
    по номеру) место среди уже отображённых страниц. */
function insertPageElementSorted(el, p) {
  const container = $("#groupPdfPages");
  let insertBeforeEl = null;
  for (let q = p + 1; q <= groupTotalPages; q++) {
    const candidate = getPageEl(q);
    if (candidate) {
      insertBeforeEl = candidate;
      break;
    }
  }
  if (insertBeforeEl) container.insertBefore(el, insertBeforeEl);
  else container.appendChild(el);
}

/** Строит и вставляет страницу, которой сейчас нет в DOM (например,
    страница вернулась в общий пул после сброса размещения группы) —
    без перерисовки остальных страниц. */
async function insertPageIntoDom(p) {
  const myToken = ++groupPdfRenderToken;
  const el = await buildPageElement(p);
  if (myToken !== groupPdfRenderToken) return;
  insertPageElementSorted(el, p);
}

/** Полная перерисовка всего списка страниц — используется только при
    первой загрузке PDF и при переключении "показать скрытые страницы"
    (там меняется сразу много страниц). Для единичных изменений
    (удаление/поворот/восстановление/размещение) используются точечные
    функции выше — они не трогают остальные страницы и не сбрасывают
    прокрутку списка. */
async function renderGroupPdfPages() {
  const myToken = ++groupPdfRenderToken;
  const container = $("#groupPdfPages");
  const scrollWrap = $(".group-pdf-pages-scroll");
  const savedScrollTop = scrollWrap ? scrollWrap.scrollTop : 0;
  if (!groupPdfDoc) {
    container.innerHTML = "";
    return;
  }
  container.innerHTML = "";

  for (let p = 1; p <= groupTotalPages; p++) {
    if (myToken !== groupPdfRenderToken) return; // подоспел более новый вызов — этот бросаем
    if (groupConsumedPages.has(p)) continue;
    const st = getPageState(p);
    if (st.deleted && !showHiddenPages) continue;

    const el = await buildPageElement(p);
    if (myToken !== groupPdfRenderToken) return;
    container.appendChild(el);
  }

  if (myToken !== groupPdfRenderToken) return;

  groups.forEach((g, idx) => {
    if (!g.pendingPlacement) return;
    g.pendingPlacement.forEach((p, i) => {
      const pageEl = getPageEl(p);
      if (pageEl) renderPendingOverlay(pageEl, idx, i === 0);
    });
  });

  if (scrollWrap) scrollWrap.scrollTop = savedScrollTop;
}

function wirePageDropzone(pageEl, pageNum) {
  pageEl.addEventListener("dragover", (e) => {
    e.preventDefault();
    pageEl.classList.add("dropzone-active");
  });
  pageEl.addEventListener("dragleave", () => pageEl.classList.remove("dropzone-active"));
  pageEl.addEventListener("drop", (e) => {
    e.preventDefault();
    pageEl.classList.remove("dropzone-active");
    const idx = Number(e.dataTransfer.getData("text/plain"));
    if (Number.isNaN(idx)) return;
    placeBadgeOnPage(idx, pageNum);
  });
}

/** Убирает уже показанный оверлей размещения для конкретной группы (если
    она перетаскивалась ранее на другие страницы) — без перерисовки всего
    списка. */
function clearPendingOverlaysForGroup(idx) {
  $$(`#groupPdfPages .pdf-page-overlay[data-group-idx="${idx}"]`).forEach((el) => el.remove());
}

function renderPendingOverlay(pageEl, idx, showControls) {
  const g = groups[idx];
  const overlay = document.createElement("div");
  overlay.className = "pdf-page-overlay";
  overlay.dataset.groupIdx = String(idx);
  overlay.innerHTML =
    `<span class="group-badge-mini" style="background:${g.color}">${escapeHtml(g.doc_type ? buildDocLabel(g) : String(idx + 1))}</span>` +
    (showControls
      ? `<span>
           <button type="button" class="mini-btn mini-confirm" data-mini-confirm="${idx}" title="Подтвердить">✓</button>
           <button type="button" class="mini-btn mini-cancel" data-mini-cancel="${idx}" title="Отменить">✗</button>
         </span>`
      : "");
  pageEl.appendChild(overlay);
  const confirmBtn = overlay.querySelector("[data-mini-confirm]");
  const cancelBtn = overlay.querySelector("[data-mini-cancel]");
  if (confirmBtn) confirmBtn.addEventListener("click", (e) => { e.stopPropagation(); confirmGroupPlacement(idx); });
  if (cancelBtn)
    cancelBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      groups[idx].pendingPlacement = null;
      clearPendingOverlaysForGroup(idx);
    });
}

/* -------------------------------------------------------------------------
   Кнопка «Добавить документы»
   ------------------------------------------------------------------------- */

function updateGroupSaveButtonState() {
  const ready = groups.some((g) => g.confirmed && isGroupDataFilled(g));
  $("#btnGroupSave").disabled = !ready;
}

$("#btnGroupCancel").addEventListener("click", () => $("#modalDoc").classList.remove("open"));

$("#btnGroupSave").addEventListener("click", async () => {
  const ready = groups.filter((g) => g.confirmed && isGroupDataFilled(g));
  const skipped = groups.length - ready.length;
  if (!ready.length) return;
  if (skipped > 0 && !confirm(`${ready.length} групп готово к добавлению, ${skipped} будет пропущено (не заполнены поля или не подтверждено размещение). Продолжить?`)) {
    return;
  }

  const PDFLib = window.PDFLib;
  const srcPdf = await PDFLib.PDFDocument.load(groupPdfBytesForSplit);
  const firstStage = orderedStages()[0];

  for (const g of ready) {
    const ts = nowIso();
    const doc = {
      id: state.nextDocId++,
      doc_type: g.doc_type,
      number: g.number,
      doc_date: g.doc_date,
      counterparty: g.counterparty,
      amount: g.amount,
      comment: g.comment,
      stage_id: firstStage.id,
      created_at: ts,
      updated_at: ts,
      files: [],
    };
    state.documents.push(doc);

    const outPdf = await PDFLib.PDFDocument.create();
    const pageIndices = g.assignedPages.map((p) => p - 1);
    const copiedPages = await outPdf.copyPages(srcPdf, pageIndices);
    copiedPages.forEach((pg, i) => {
      const pageNum = g.assignedPages[i];
      const extra = getPageState(pageNum).rotation || 0;
      if (extra) {
        const current = pg.getRotation().angle || 0;
        pg.setRotation(PDFLib.degrees((current + extra) % 360));
      }
      outPdf.addPage(pg);
    });
    const outBytes = await outPdf.save();
    const outFile = new File([outBytes], "scan.pdf", { type: "application/pdf" });

    await attachFileToDoc(doc, outFile, doc.stage_id);
  }

  await saveState();
  await saveConfig();
  $("#modalDoc").classList.remove("open");
  renderTable();
});

/* ==========================================================================
   Режим "Отдельные файлы" — можно перетащить/выбрать сразу несколько
   файлов, каждый становится своим блоком с собственными полями (вид,
   номер, дата, контрагент, сумма, комментарий) и своим документом при
   сохранении. В отличие от "Разбить PDF на документы" здесь нет
   разбиения одного файла на страницы — каждый файл целиком становится
   вложением одного документа.
   ========================================================================== */

let singleFiles = []; // { id, file, doc_type, number, doc_date, counterparty, amount, comment }
let singleFileIdSeq = 0;
let singlePdfRenderToken = 0;

function isSingleEntryFilled(entry) {
  return !!entry.doc_type && !!(entry.number && entry.number.trim());
}

function updateSingleDropZoneVisibility() {
  $("#singleDropZoneInner").style.display = singleFiles.length ? "none" : "flex";
}

/** Сбрасывает режим "Отдельные файлы" к пустому состоянию — вызывается
    при каждом открытии окна «Новый документ» (см. app.js, btnAdd). */
function resetSingleModeUI() {
  singleFiles = [];
  $("#fFile").value = "";
  $("#fFileName").textContent = "Файлы не выбраны";
  $("#singleCountInput").value = 0;
  $("#singleCardsList").innerHTML = "";
  $("#singlePreviewArea").innerHTML = "";
  $("#singlePreviewArea").style.setProperty("--pdf-page-scale", "70%");
  $("#singleZoom").value = 70;
  $("#singleZoomValue").textContent = "70%";
  updateSingleDropZoneVisibility();
  updateSingleSaveButtonState();
}

$("#singleZoom").addEventListener("input", () => {
  const val = $("#singleZoom").value;
  $("#singleZoomValue").textContent = val + "%";
  $("#singlePreviewArea").style.setProperty("--pdf-page-scale", val + "%");
});

$("#fFile").addEventListener("change", () => {
  processSingleFiles($("#fFile").files);
  $("#fFile").value = ""; // чтобы можно было повторно выбрать те же файлы
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

/** Добавляет ВСЕ переданные файлы как отдельные блоки (в отличие от
    группового режима, где из перетащенных файлов берётся только первый). */
async function processSingleFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  files.forEach((file) => {
    singleFiles.push({
      id: ++singleFileIdSeq,
      file,
      doc_type: "",
      number: "",
      doc_date: todayIso(),
      counterparty: "",
      amount: "",
      comment: "",
    });
  });
  $("#fFileName").textContent = singleFiles.length + " файл(ов) выбрано";
  $("#singleCountInput").value = singleFiles.length;
  updateSingleDropZoneVisibility();
  renderSingleCards();
  updateSingleSaveButtonState();
  await renderSinglePreviews();
}

function renderSingleCards() {
  const list = $("#singleCardsList");
  list.innerHTML = singleFiles
    .map((entry, idx) => {
      const typeOptions =
        `<option value="" ${entry.doc_type ? "" : "selected"}>— выбрать —</option>` +
        config.docTypes.map((t) => `<option value="${escapeHtml(t)}" ${t === entry.doc_type ? "selected" : ""}>${escapeHtml(t)}</option>`).join("");
      const cpOptions =
        `<option value="" ${entry.counterparty ? "" : "selected"}>—</option>` +
        config.counterparties.map((c) => `<option value="${escapeHtml(c)}" ${c === entry.counterparty ? "selected" : ""}>${escapeHtml(c)}</option>`).join("");
      return `
      <div class="group-card${isSingleEntryFilled(entry) ? " group-card-filled" : ""}" data-single="${idx}">
        <div class="group-card-header">
          <span class="single-card-filename" title="${escapeHtml(entry.file.name)}">${escapeHtml(entry.file.name)}</span>
          <span class="group-card-actions">
            <button type="button" class="icon-btn pdf-page-btn-danger" data-single-remove="${idx}" title="Убрать файл">✕</button>
          </span>
        </div>
        <div class="form-grid group-fields-grid">
          <label class="f-type compact">Вид документа
            <span class="group-field-with-add">
              <select data-single-field="doc_type" data-single-idx="${idx}">${typeOptions}</select>
              <button type="button" class="icon-btn" data-single-add-type="${idx}" title="Добавить новый вид">+</button>
            </span>
          </label>
          <label class="f-date compact">Дата <input type="date" data-single-field="doc_date" data-single-idx="${idx}" value="${entry.doc_date || ""}"></label>
          <label class="f-number">Номер документа <input type="text" data-single-field="number" data-single-idx="${idx}" value="${escapeHtml(entry.number)}"></label>
          <label class="f-cp">Контрагент
            <span class="group-field-with-add">
              <select data-single-field="counterparty" data-single-idx="${idx}">${cpOptions}</select>
              <button type="button" class="icon-btn" data-single-add-cp="${idx}" title="Добавить нового контрагента">+</button>
            </span>
          </label>
          <label class="f-amount">Сумма <input type="text" data-single-field="amount" data-single-idx="${idx}" value="${escapeHtml(entry.amount)}"></label>
          <label class="f-comment full">Комментарий <textarea rows="1" data-single-field="comment" data-single-idx="${idx}">${escapeHtml(entry.comment)}</textarea></label>
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
      const idx = Number(el.dataset.singleIdx);
      singleFiles[idx][el.dataset.singleField] = el.value;
      updateSingleCardFilledState(idx);
      updateSingleSaveButtonState();
    });
  });

  list.querySelectorAll("[data-single-add-type]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.singleAddType);
      const name = window.prompt("Новый вид документа:");
      if (!name || !name.trim()) return;
      addDocType(name);
      saveConfig();
      singleFiles[idx].doc_type = name.trim();
      renderSingleCards();
      updateSingleSaveButtonState();
    });
  });
  list.querySelectorAll("[data-single-add-cp]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.singleAddCp);
      const name = window.prompt("Новый контрагент:");
      if (!name || !name.trim()) return;
      const saved = addCounterparty(name);
      saveConfig();
      singleFiles[idx].counterparty = saved;
      renderSingleCards();
    });
  });

  list.querySelectorAll("[data-single-remove]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.singleRemove);
      singleFiles.splice(idx, 1);
      $("#singleCountInput").value = singleFiles.length;
      $("#fFileName").textContent = singleFiles.length ? singleFiles.length + " файл(ов) выбрано" : "Файлы не выбраны";
      updateSingleDropZoneVisibility();
      renderSingleCards();
      renderSinglePreviews();
      updateSingleSaveButtonState();
    });
  });
}

function updateSingleCardFilledState(idx) {
  const card = $(`.group-card[data-single="${idx}"]`);
  if (!card) return;
  card.classList.toggle("group-card-filled", isSingleEntryFilled(singleFiles[idx]));
}

/** Превью списка файлов: первая страница для PDF, картинка как есть,
    иконка-заглушка для прочих типов файлов. */
async function renderSinglePreviews() {
  const myToken = ++singlePdfRenderToken;
  const container = $("#singlePreviewArea");
  container.innerHTML = "";

  for (let i = 0; i < singleFiles.length; i++) {
    if (myToken !== singlePdfRenderToken) return;
    const entry = singleFiles[i];
    const wrap = document.createElement("div");
    wrap.className = "pdf-page";
    wrap.dataset.single = String(i);
    const label = document.createElement("div");
    label.className = "pdf-page-label";
    label.textContent = entry.file.name;

    const isPdf = entry.file.type === "application/pdf" || /\.pdf$/i.test(entry.file.name);
    const isImage = entry.file.type.startsWith("image/");

    if (isPdf) {
      const canvas = document.createElement("canvas");
      wrap.appendChild(canvas);
      wrap.appendChild(label);
      container.appendChild(wrap);
      try {
        await ensureGroupVendorLoaded();
        if (myToken !== singlePdfRenderToken) return;
        const buf = await entry.file.arrayBuffer();
        const loadingTask = window.pdfjsLib.getDocument({ data: new Uint8Array(buf) });
        const pdfDoc = await loadingTask.promise;
        if (myToken !== singlePdfRenderToken) return;
        const page = await pdfDoc.getPage(1);
        const baseViewport = page.getViewport({ scale: 1 });
        const scale = GROUP_PDF_RENDER_WIDTH / baseViewport.width;
        const viewport = page.getViewport({ scale });
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
      } catch (e) {
        label.textContent = entry.file.name + " (превью недоступно)";
      }
    } else if (isImage) {
      try {
        const img = document.createElement("img");
        img.src = URL.createObjectURL(entry.file);
        img.style.width = "100%";
        img.style.borderRadius = "4px";
        wrap.appendChild(img);
        wrap.appendChild(label);
        container.appendChild(wrap);
      } catch (e) {
        wrap.classList.add("pdf-page-generic");
        wrap.innerHTML = `<div class="pdf-page-generic-icon">🖼️</div>`;
        wrap.appendChild(label);
        container.appendChild(wrap);
      }
    } else {
      wrap.classList.add("pdf-page-generic");
      wrap.innerHTML = `<div class="pdf-page-generic-icon">📄</div>`;
      wrap.appendChild(label);
      container.appendChild(wrap);
    }
  }
}

function updateSingleSaveButtonState() {
  const ready = singleFiles.some((entry) => isSingleEntryFilled(entry));
  $("#btnDocSave").disabled = !ready;
}

$("#btnDocSave").addEventListener("click", async () => {
  const ready = singleFiles.filter((entry) => isSingleEntryFilled(entry));
  const skipped = singleFiles.length - ready.length;
  if (!ready.length) return;
  if (skipped > 0 && !confirm(`${ready.length} файл(ов) готово к добавлению, ${skipped} будет пропущено (не заполнены вид и номер документа). Продолжить?`)) {
    return;
  }

  const firstStage = orderedStages()[0];
  for (const entry of ready) {
    const ts = nowIso();
    const doc = {
      id: state.nextDocId++,
      doc_type: entry.doc_type,
      number: entry.number,
      doc_date: entry.doc_date,
      counterparty: entry.counterparty,
      amount: entry.amount,
      comment: entry.comment,
      stage_id: firstStage.id,
      created_at: ts,
      updated_at: ts,
      files: [],
    };
    state.documents.push(doc);
    await attachFileToDoc(doc, entry.file, firstStage.id);
  }

  await saveState();
  await saveConfig();
  $("#modalDoc").classList.remove("open");
  renderTable();
});

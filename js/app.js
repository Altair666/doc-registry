/* ==========================================================================
   Интерфейс: рендеринг таблицы, карточки документа, справочников (стадии,
   виды документов, контрагенты) и обработка событий.
   ========================================================================== */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

const NEW_OPTION_VALUE = "__new__";

/** HTML цветного бейджа стадии. Если передан stage — берёт его цвет,
    иначе (стадия удалена/переименована) — нейтральный серый с fallbackName. */
function stageBadge(stage, fallbackName) {
  const name = stage ? stage.name : fallbackName || "—";
  const color = stage && stage.color ? stage.color : "#94a3b8";
  const fg = textColorFor(color);
  return `<span class="badge" style="background:${color};color:${fg}">${escapeHtml(name)}</span>`;
}

function todayIso() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Комбо-виджет: <select> со списком + пункт "+ Добавить новое...".
 * При выборе этого пункта select прячется, а на его месте (то же поле,
 * та же ширина) появляется текстовый input — значение вводится прямо
 * туда, без отдельных блоков снизу. Enter/потеря фокуса — сохранить
 * и добавить в справочник, Escape — отменить.
 */
function setupCombo({ selectEl, inputEl, getOptions, addOption, includeEmpty, onChange }) {
  let lastValue = "";

  function populate(selected) {
    const opts = getOptions();
    lastValue = selected || "";
    const emptyOpt = includeEmpty ? `<option value="">—</option>` : "";
    const opsHtml = opts
      .map((o) => `<option value="${escapeHtml(o)}" ${o === selected ? "selected" : ""}>${escapeHtml(o)}</option>`)
      .join("");
    selectEl.innerHTML = emptyOpt + opsHtml + `<option value="${NEW_OPTION_VALUE}">+ Добавить новое...</option>`;
    if (!selected) selectEl.value = includeEmpty ? "" : opts[0] || "";
    selectEl.style.display = "";
    inputEl.style.display = "none";
    inputEl.value = "";
    if (onChange) onChange();
  }

  function startAdding() {
    selectEl.style.display = "none";
    inputEl.style.display = "";
    inputEl.value = "";
    inputEl.focus();
  }

  function commit() {
    const val = inputEl.value.trim();
    if (val) {
      addOption(val);
      populate(val);
    } else {
      populate(lastValue);
    }
  }

  selectEl.addEventListener("change", () => {
    if (selectEl.value === NEW_OPTION_VALUE) {
      startAdding();
    } else {
      lastValue = selectEl.value;
    }
  });
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      populate(lastValue);
    }
  });
  inputEl.addEventListener("blur", commit);

  return {
    populate,
    commit,
    getValue: () => selectEl.value,
  };
}

/* -------------------------------------------------------------------------
   Версия приложения и патч-ноуты
   ------------------------------------------------------------------------- */

$("#versionBadge").textContent = "v" + APP_VERSION;
$("#versionBadge").addEventListener("click", () => {
  $("#changelogList").innerHTML = CHANGELOG.map(
    (c) => `
    <div class="changelog-entry">
      <span class="changelog-version">v${escapeHtml(c.version)}</span>
      <span class="changelog-date">${escapeHtml(c.date)}</span>
      <div class="changelog-notes">${escapeHtml(c.notes)}</div>
    </div>`
  ).join("");
  $("#modalChangelog").classList.add("open");
});
$("#btnChangelogClose").addEventListener("click", () => $("#modalChangelog").classList.remove("open"));

/* -------------------------------------------------------------------------
   Вход в приложение / подключение папки
   ------------------------------------------------------------------------- */

function enterApp() {
  $("#gate").style.display = "none";
  $("#mainApp").style.display = "block";
  $("#btnCatalogs").disabled = false;
  $("#btnAdd").disabled = false;
  $("#folderStatus").textContent = "Папка подключена: " + (dirHandle.name || "");
  $("#btnConnect").textContent = "Сменить папку";
  applyColumnWidths();
  renderStagesSelects();
  renderTable();

  // Небольшая подстраховка: пересчитываем ширину ещё раз чуть позже —
  // на случай если при первом расчёте разметка ещё не устоялась.
  setTimeout(() => {
    try {
      updateTableTotalWidth();
    } catch (e) {
      /* не критично — таблица просто останется на текущей ширине */
    }
  }, 200);
}

$("#btnConnect").addEventListener("click", async () => {
  if (dirHandle && $("#btnConnect").textContent.includes("Подтвердить")) {
    const ok = await verifyPermission(dirHandle, true);
    if (ok) {
      await loadState();
      await loadConfig();
      enterApp();
    } else {
      alert("Доступ не подтверждён. Попробуйте выбрать папку заново.");
    }
    return;
  }
  const ok = await connectFolder();
  if (ok) enterApp();
});

$("#btnConnectGate").addEventListener("click", async () => {
  const ok = await connectFolder();
  if (ok) enterApp();
});

(async function init() {
  if (!window.showDirectoryPicker) {
    $("#warnBanner").style.display = "block";
    $("#btnConnect").disabled = true;
    $("#btnConnectGate").disabled = true;
    return;
  }
  const result = await tryRestoreFolder();
  if (result === true) {
    enterApp();
  } else if (result === "needs-confirmation") {
    $("#folderStatus").textContent = "Доступ к папке нужно подтвердить";
    $("#btnConnect").textContent = "Подтвердить доступ к папке";
  }
})();

/* -------------------------------------------------------------------------
   Стадии — вспомогательные функции
   ------------------------------------------------------------------------- */

function getStage(id) {
  return state.stages.find((s) => s.id === id) || null;
}

function orderedStages() {
  return [...state.stages].sort((a, b) => a.order_index - b.order_index);
}

function getNextStage(currentStageId) {
  const ordered = orderedStages();
  const idx = ordered.findIndex((s) => s.id === currentStageId);
  if (idx === -1 || idx === ordered.length - 1) return null;
  return ordered[idx + 1];
}

function renderStagesSelects() {
  const stages = orderedStages();
  $("#filterStage").innerHTML =
    '<option value="">Все стадии</option>' +
    stages.map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join("");
}

/* -------------------------------------------------------------------------
   Редактируемые списки (справочники): вид документа / контрагент
   ------------------------------------------------------------------------- */

const typeCombo = setupCombo({
  selectEl: $("#fType"),
  inputEl: $("#fTypeInput"),
  getOptions: () => config.docTypes,
  addOption: (v) => addDocType(v),
  includeEmpty: false,
  onChange: () => updateSaveButtonState(),
});

const counterpartyCombo = setupCombo({
  selectEl: $("#fCounterparty"),
  inputEl: $("#fCounterpartyInput"),
  getOptions: () => config.counterparties,
  addOption: (v) => addCounterparty(v),
  includeEmpty: true,
});

/* -------------------------------------------------------------------------
   Таблица документов
   ------------------------------------------------------------------------- */

/** Значения для фильтра по ПКМ на заголовке столбца. */
const COLUMN_DEFS = {
  document: (d) => buildDocLabel(d),
  type: (d) => d.doc_type || "—",
  counterparty: (d) => d.counterparty || "—",
  amount: (d) => d.amount || "—",
  stage: (d) => {
    const s = getStage(d.stage_id);
    return s ? s.name : "—";
  },
  files: (d) => String(d.files.length),
};

let columnFilters = {}; // { colKey: "выбранное значение" }

function renderTable() {
  const search = $("#search").value.trim().toLowerCase();
  const stageFilter = $("#filterStage").value;

  let rows = state.documents.filter((d) => {
    if (stageFilter && String(d.stage_id) !== stageFilter) return false;
    for (const key of Object.keys(columnFilters)) {
      if (COLUMN_DEFS[key] && COLUMN_DEFS[key](d) !== columnFilters[key]) return false;
    }
    if (!search) return true;
    const hay = [d.number, d.doc_type, d.counterparty, buildDocLabel(d)].join(" ").toLowerCase();
    return hay.includes(search);
  });
  rows = [...rows].sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""));

  const body = $("#docsBody");
  body.innerHTML = rows
    .map((d) => {
      const stage = getStage(d.stage_id);
      return `
      <tr data-id="${d.id}">
        <td>${escapeHtml(buildDocLabel(d))}</td>
        <td>${escapeHtml(d.doc_type || "—")}</td>
        <td>${escapeHtml(d.counterparty || "—")}</td>
        <td>${escapeHtml(d.amount || "—")}</td>
        <td>${stageBadge(stage)}</td>
        <td>${d.files.length}</td>
        <td class="col-actions"><button type="button" class="btn btn-secondary btn-small row-open" data-id="${d.id}">Продвинуть →</button></td>
      </tr>`;
    })
    .join("");

  $$("#registryTable thead th[data-col]").forEach((th) => {
    th.classList.toggle("th-filtered", Object.prototype.hasOwnProperty.call(columnFilters, th.dataset.col));
  });

  $$("#docsBody .row-open").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openCard(Number(btn.dataset.id));
    });
  });

  $("#emptyState").style.display = rows.length ? "none" : "block";
  updateTableTotalWidth();
}

$("#search").addEventListener("input", renderTable);
$("#filterStage").addEventListener("change", renderTable);

/* -------------------------------------------------------------------------
   Добавление / редактирование документа
   ------------------------------------------------------------------------- */

/** Показывает имя выбранного файла рядом со стилизованной кнопкой «Выбрать файл». */
function wireFileNameDisplay(inputId, nameId) {
  const input = $("#" + inputId);
  const nameEl = $("#" + nameId);
  if (!input || !nameEl) return;
  input.addEventListener("change", () => {
    nameEl.textContent = input.files[0] ? input.files[0].name : "Файл не выбран";
  });
}
wireFileNameDisplay("fFile", "fFileName");
wireFileNameDisplay("advanceFile", "advanceFileName");

/** Кнопку «Сохранить» можно нажать только если: прикреплён файл,
    выбран вид документа и указан номер документа. */
function updateSaveButtonState() {
  const hasFile = $("#fFile").files && $("#fFile").files.length > 0;
  const typeReady = $("#fType").style.display !== "none" && !!$("#fType").value && $("#fType").value !== NEW_OPTION_VALUE;
  const hasNumber = $("#fNumber").value.trim().length > 0;
  $("#btnDocSave").disabled = !(hasFile && typeReady && hasNumber);
}

$("#btnAdd").addEventListener("click", () => {
  $("#modalDocTitle").textContent = "Новый документ";
  ["fNumber", "fAmount", "fComment"].forEach((id) => ($("#" + id).value = ""));
  $("#fFile").value = "";
  $("#fFileName").textContent = "Файл не выбран";
  $("#fDate").value = "";
  $("#fDate").disabled = true;
  typeCombo.populate(null);
  counterpartyCombo.populate(null);
  $("#modalDoc").dataset.mode = "create";
  $("#modalDoc").classList.add("open");
  updateSaveButtonState();
  if (typeof resetGroupModeUI === "function") resetGroupModeUI();
});

// Дата активируется, как только прикреплён файл, и сразу проставляется сегодняшним числом
$("#fFile").addEventListener("change", () => {
  if ($("#modalDoc").dataset.mode !== "create") return;
  if ($("#fFile").files[0]) {
    $("#fDate").disabled = false;
    if (!$("#fDate").value) $("#fDate").value = todayIso();
  }
  updateSaveButtonState();
});

$("#fType").addEventListener("change", updateSaveButtonState);
$("#fTypeInput").addEventListener("input", updateSaveButtonState);
$("#fTypeInput").addEventListener("blur", updateSaveButtonState);
$("#fNumber").addEventListener("input", updateSaveButtonState);

$("#btnDocCancel").addEventListener("click", () => $("#modalDoc").classList.remove("open"));

$("#btnDocSave").addEventListener("click", async () => {
  typeCombo.commit();
  counterpartyCombo.commit();

  const typeVal = $("#fType").value;
  const cpVal = $("#fCounterparty").value;

  if (!typeVal) {
    alert("Укажите вид документа (или добавьте новый)");
    return;
  }
  const number = $("#fNumber").value.trim();
  if (!number) {
    alert("Укажите имя документа (номер)");
    return;
  }

  const payload = {
    doc_type: typeVal,
    number,
    doc_date: $("#fDate").value,
    counterparty: cpVal,
    amount: $("#fAmount").value,
    comment: $("#fComment").value,
  };

  const firstStage = orderedStages()[0];
  if (!firstStage) {
    alert("Нет ни одной стадии. Создайте стадию сначала (в Справочниках).");
    return;
  }
  const ts = nowIso();
  const doc = {
    id: state.nextDocId++,
    ...payload,
    stage_id: firstStage.id,
    created_at: ts,
    updated_at: ts,
    files: [],
  };
  state.documents.push(doc);

  const fileInput = $("#fFile");
  if (fileInput.files[0]) {
    await attachFileToDoc(doc, fileInput.files[0], doc.stage_id);
  }

  await saveState();
  await saveConfig();
  $("#modalDoc").classList.remove("open");
  renderTable();
});

/* -------------------------------------------------------------------------
   Карточка документа
   ------------------------------------------------------------------------- */

function openCard(id) {
  currentDocId = id;
  const doc = state.documents.find((d) => d.id === id);
  if (!doc) return;
  renderCard(doc);
  $("#modalCard").classList.add("open");
}

function renderCard(doc) {
  const stage = getStage(doc.stage_id);
  $("#cardTitle").textContent = buildDocLabel(doc);
  $("#cardMeta").textContent = doc.counterparty ? `Контрагент: ${doc.counterparty}` : "";
  const stageColor = (stage && stage.color) || "#94a3b8";
  $("#cardStage").textContent = stage ? stage.name : "—";
  $("#cardStage").style.background = stageColor;
  $("#cardStage").style.color = textColorFor(stageColor);

  const stages = orderedStages();
  $("#advanceTarget").innerHTML = stages
    .map((s) => `<option value="${s.id}" ${s.id === doc.stage_id ? "selected" : ""}>${escapeHtml(s.name)}</option>`)
    .join("");
  const nextStage = getNextStage(doc.stage_id);
  if (nextStage) $("#advanceTarget").value = nextStage.id;

  $("#advanceFile").value = "";
  $("#advanceFileName").textContent = "Файл не выбран";

  const filesSorted = [...doc.files].sort((a, b) => b.version - a.version);
  const filesBody = $("#filesBody");
  if (!filesSorted.length) {
    filesBody.innerHTML = `<tr><td colspan="4" class="muted">Файлов пока нет</td></tr>`;
  } else {
    filesBody.innerHTML = filesSorted
      .map((f) => {
        const fStage = getStage(f.stage_id);
        return `
        <tr>
          <td>${stageBadge(fStage, f.stage_name)}</td>
          <td><a class="file-link" data-file="${f.stored_filename}">${escapeHtml(f.custom_name)}</a></td>
          <td>${escapeHtml(f.uploaded_at)}</td>
          <td><button class="btn btn-danger btn-small" data-del-file="${f.id}">Удалить</button></td>
        </tr>`;
      })
      .join("");

    filesBody.querySelectorAll("a[data-file]").forEach((a) => {
      a.addEventListener("click", async (e) => {
        e.preventDefault();
        try {
          const fh = await dirHandle.getFileHandle(a.dataset.file, { create: false });
          const file = await fh.getFile();
          const url = URL.createObjectURL(file);
          window.open(url, "_blank");
        } catch (err) {
          alert("Файл не найден на диске (возможно, был удалён или перемещён вручную).");
        }
      });
    });

    filesBody.querySelectorAll("button[data-del-file]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm("Удалить этот файл безвозвратно (и с диска тоже)?")) return;
        await deleteFileEntry(doc, Number(btn.dataset.delFile));
        renderCard(doc);
        renderTable();
      });
    });
  }
}

$("#btnCardClose").addEventListener("click", () => $("#modalCard").classList.remove("open"));

$("#btnDeleteDoc").addEventListener("click", async () => {
  if (!confirm("Удалить документ из реестра? (файлы на диске останутся, если явно их не удаляли)")) return;
  state.documents = state.documents.filter((d) => d.id !== currentDocId);
  await saveState();
  $("#modalCard").classList.remove("open");
  renderTable();
});

$("#advanceForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const doc = state.documents.find((d) => d.id === currentDocId);
  const targetStageId = Number($("#advanceTarget").value);
  const fileInput = $("#advanceFile");

  if (fileInput.files[0]) {
    await attachFileToDoc(doc, fileInput.files[0], targetStageId);
  }

  doc.stage_id = targetStageId;
  doc.updated_at = nowIso();

  await saveState();
  renderTable();
  openCard(currentDocId);
});

/* -------------------------------------------------------------------------
   Стадии — теперь часть модалки «Справочники»
   ------------------------------------------------------------------------- */

function renderStagesList() {
  const stages = orderedStages();
  const list = $("#stagesList");
  list.innerHTML = stages
    .map(
      (s, i) => `
    <div class="stage-row" data-id="${s.id}">
      <span class="stage-order">${i + 1}</span>
      <span class="color-swatch-wrap" title="Изменить цвет бейджа">
        <input type="color" value="${s.color || "#94a3b8"}" data-color-id="${s.id}">
        <span class="pencil-icon">✎</span>
      </span>
      <input type="text" value="${escapeHtml(s.name)}" data-id="${s.id}">
      <button class="btn btn-secondary btn-small" data-up="${s.id}" ${i === 0 ? "disabled" : ""}>↑</button>
      <button class="btn btn-secondary btn-small" data-down="${s.id}" ${i === stages.length - 1 ? "disabled" : ""}>↓</button>
      <button class="btn btn-danger btn-small" data-del="${s.id}">✕</button>
    </div>`
    )
    .join("");

  list.querySelectorAll("input[data-id]").forEach((inp) => {
    inp.addEventListener("change", async () => {
      const stage = getStage(Number(inp.dataset.id));
      stage.name = inp.value;
      await saveState();
      renderStagesSelects();
    });
  });
  list.querySelectorAll("input[data-color-id]").forEach((inp) => {
    inp.addEventListener("input", async () => {
      const stage = getStage(Number(inp.dataset.colorId));
      stage.color = inp.value;
      await saveState();
    });
  });
  list.querySelectorAll("button[data-up]").forEach((btn) => {
    btn.addEventListener("click", () => moveStage(Number(btn.dataset.up), -1));
  });
  list.querySelectorAll("button[data-down]").forEach((btn) => {
    btn.addEventListener("click", () => moveStage(Number(btn.dataset.down), 1));
  });
  list.querySelectorAll("button[data-del]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = Number(btn.dataset.del);
      if (state.documents.some((d) => d.stage_id === id)) {
        alert("Стадия используется документами, удалить нельзя");
        return;
      }
      if (!confirm("Удалить эту стадию?")) return;
      state.stages = state.stages.filter((s) => s.id !== id);
      await saveState();
      renderStagesList();
      renderStagesSelects();
    });
  });
}

async function moveStage(id, dir) {
  const stages = orderedStages();
  const idx = stages.findIndex((s) => s.id === id);
  const newIdx = idx + dir;
  if (newIdx < 0 || newIdx >= stages.length) return;
  [stages[idx].order_index, stages[newIdx].order_index] = [stages[newIdx].order_index, stages[idx].order_index];
  await saveState();
  renderStagesList();
}

$("#stageAddForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("#newStageName");
  const name = input.value.trim();
  if (!name) return;
  const maxOrder = state.stages.reduce((m, s) => Math.max(m, s.order_index), -1);
  state.stages.push({ id: state.nextStageId++, name, order_index: maxOrder + 1 });
  await saveState();
  input.value = "";
  renderStagesList();
  renderStagesSelects();
});

/* -------------------------------------------------------------------------
   Модалка «Справочники» (виды документов, контрагенты, стадии)
   ------------------------------------------------------------------------- */

$("#btnCatalogs").addEventListener("click", () => {
  renderCatalogTypes();
  renderCatalogCounterparties();
  renderStagesList();
  $("#modalCatalogs").classList.add("open");
});

$("#btnCatalogsClose").addEventListener("click", async () => {
  $("#modalCatalogs").classList.remove("open");
  await saveConfig();
  await saveState();
  renderStagesSelects();
  renderTable();
});

function renderCatalogTypes() {
  const list = $("#catalogTypesList");
  list.innerHTML = config.docTypes
    .map(
      (t, i) => `
    <div class="stage-row" data-i="${i}">
      <input type="text" value="${escapeHtml(t)}" data-type-name="${i}" placeholder="Вид документа (напр. УПД)">
      <button class="btn btn-danger btn-small" data-type-del="${i}">✕</button>
    </div>`
    )
    .join("");

  list.querySelectorAll("input[data-type-name]").forEach((inp) => {
    inp.addEventListener("change", async () => {
      config.docTypes[Number(inp.dataset.typeName)] = inp.value.trim();
      await saveConfig();
      renderTable();
    });
  });
  list.querySelectorAll("button[data-type-del]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const i = Number(btn.dataset.typeDel);
      const name = config.docTypes[i];
      if (state.documents.some((d) => d.doc_type === name)) {
        alert("Этот вид документа используется в реестре, удалить нельзя");
        return;
      }
      if (!confirm("Удалить этот вид документа?")) return;
      config.docTypes.splice(i, 1);
      await saveConfig();
      renderCatalogTypes();
    });
  });
}

$("#catalogTypeAddForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("#newTypeName").value;
  if (!name.trim()) return;
  addDocType(name);
  await saveConfig();
  $("#newTypeName").value = "";
  renderCatalogTypes();
});

function renderCatalogCounterparties() {
  const list = $("#catalogCounterpartiesList");
  list.innerHTML = config.counterparties
    .map(
      (c, i) => `
    <div class="stage-row" data-i="${i}">
      <input type="text" value="${escapeHtml(c)}" data-cp-name="${i}">
      <button class="btn btn-danger btn-small" data-cp-del="${i}">✕</button>
    </div>`
    )
    .join("");

  list.querySelectorAll("input[data-cp-name]").forEach((inp) => {
    inp.addEventListener("change", async () => {
      config.counterparties[Number(inp.dataset.cpName)] = inp.value.trim();
      await saveConfig();
      renderTable();
    });
  });
  list.querySelectorAll("button[data-cp-del]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const i = Number(btn.dataset.cpDel);
      const name = config.counterparties[i];
      if (state.documents.some((d) => d.counterparty === name)) {
        alert("Этот контрагент используется в реестре, удалить нельзя");
        return;
      }
      if (!confirm("Удалить этого контрагента?")) return;
      config.counterparties.splice(i, 1);
      await saveConfig();
      renderCatalogCounterparties();
    });
  });
}

$("#catalogCounterpartyAddForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("#newCounterpartyName").value;
  if (!name.trim()) return;
  addCounterparty(name);
  await saveConfig();
  $("#newCounterpartyName").value = "";
  renderCatalogCounterparties();
});

/* -------------------------------------------------------------------------
   Закрытие модалок по клику на фон.
   Окно документа ("modalDoc") сюда не включено намеренно — оно содержит
   форму, и случайный клик мимо не должен стирать введённые данные.
   Закрыть его можно только кнопкой «Отмена».
   ------------------------------------------------------------------------- */

$$(".modal-overlay").forEach((ov) => {
  if (ov.id === "modalDoc") return;
  ov.addEventListener("click", (e) => {
    if (e.target === ov) ov.classList.remove("open");
  });
});

/* -------------------------------------------------------------------------
   Изменение ширины столбцов таблицы реестра (перетаскивание границы
   заголовка). Граница между двумя столбцами при перетягивании забирает
   ширину у одного и отдаёт другому (как в Excel/типичных таблицах) —
   поэтому общая ширина таблицы и её правая граница НЕ меняются, а
   двигается только та граница, которую тянете. Итоговые ширины
   сохраняются в config.columnWidths (config.json).
   ------------------------------------------------------------------------- */

/** Выставляет width таблицы = сумма ширин всех столбцов. Вызывается один
    раз при входе в приложение — дальше сумма не меняется сама по себе,
    т.к. ресайз всегда переносит ширину между соседними столбцами. */
/** Выставляет width таблицы = сумма ширин всех столбцов. Если эта сумма
    меньше ширины блока (.table-scroll) — растягивает первый столбец
    ("Документ"), чтобы таблица не была уже страницы. Если сумма больше —
    ничего не подгоняет, просто появляется горизонтальный скролл (это
    нормально — так и должно быть, когда столбцы шире страницы). */
/** Выставляет width таблицы = сумма ширин всех столбцов. Если эта сумма
    меньше ширины блока (.table-scroll) — растягивает первый столбец
    ("Документ"), чтобы таблица не была уже страницы; если места стало
    МЕНЬШЕ (например, появился вертикальный скролл страницы после
    добавления строк) — растяжение уменьшается обратно. "Истинная"
    (не растянутая) ширина первого столбца хранится в data-own-width,
    чтобы растяжение каждый раз считалось с нуля, а не накапливалось.
    Если сумма столбцов больше блока — ничего не подгоняет, просто
    появляется горизонтальный скролл (это нормально). */
function updateTableTotalWidth() {
  const table = $("#registryTable");
  const scrollEl = $(".table-scroll");
  const ths = $$("#registryTable thead th[data-width-key]");
  if (!ths.length) return;

  const firstTh = ths[0];
  const ownFirstWidth = parseFloat(firstTh.dataset.ownWidth) || parseFloat(firstTh.style.width) || 100;

  let restSum = 0;
  for (let i = 1; i < ths.length; i++) {
    restSum += parseFloat(ths[i].style.width) || 0;
  }

  // Небольшой запас (не только математический — реальный браузер может
  // округлить суммарную ширину в бо́льшую сторону на пару пикселей из-за
  // border-collapse/дробных значений), иначе таблица иногда всё равно
  // оказывается на волосок шире блока и появляется ненужный скролл.
  const SAFETY_MARGIN = 4;
  const available = scrollEl ? scrollEl.clientWidth - SAFETY_MARGIN : 0;
  const firstWidth = available > 0 ? Math.max(ownFirstWidth, available - restSum) : ownFirstWidth;

  firstTh.style.width = firstWidth + "px";
  table.style.width = firstWidth + restSum + "px";
}
window.addEventListener("resize", () => updateTableTotalWidth());

function applyColumnWidths() {
  const ths = $$("#registryTable thead th[data-width-key]");
  ths.forEach((th) => {
    const saved = config.columnWidths && config.columnWidths[th.dataset.widthKey];
    if (typeof saved === "number" && saved >= 50) th.style.width = saved + "px";
  });
  if (ths.length) ths[0].dataset.ownWidth = parseFloat(ths[0].style.width) || 100;
  updateTableTotalWidth();
}

function makeColumnsResizable() {
  const ths = $$("#registryTable thead th[data-width-key]");
  ths.forEach((th, idx) => {
    if (idx === ths.length - 1) return; // у последнего столбца нет соседа справа — не тянем
    const nextTh = ths[idx + 1];
    const resizer = document.createElement("div");
    resizer.className = "col-resizer";
    th.appendChild(resizer);

    resizer.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startWidth = parseFloat(th.style.width) || th.getBoundingClientRect().width || 100;
      const nextStartWidth = parseFloat(nextTh.style.width) || nextTh.getBoundingClientRect().width || 100;
      const combined = startWidth + nextStartWidth;
      resizer.classList.add("active");

      function onMove(ev) {
        let newWidth = Math.round(startWidth + (ev.clientX - startX));
        newWidth = Math.max(50, Math.min(combined - 50, newWidth));
        th.style.width = newWidth + "px";
        nextTh.style.width = combined - newWidth + "px";
        if (idx === 0) th.dataset.ownWidth = newWidth;
        updateTableTotalWidth();
      }
      async function onUp() {
        resizer.classList.remove("active");
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        if (idx === 0) th.dataset.ownWidth = parseFloat(th.style.width);
        if (!config.columnWidths) config.columnWidths = {};
        config.columnWidths[th.dataset.widthKey] = parseFloat(th.style.width);
        config.columnWidths[nextTh.dataset.widthKey] = parseFloat(nextTh.style.width);
        await saveConfig();
      }
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  });
}
makeColumnsResizable();

/* -------------------------------------------------------------------------
   Фильтрация по клику правой кнопкой мыши на заголовке столбца.
   Работает на всех столбцах реестра (Документ, Вид, Контрагент, Сумма,
   Стадия, Файлы) — на каждом из них можно выбрать одно значение из
   списка встречающихся в реестре, чтобы отфильтровать таблицу. У каждого
   столбца свой независимый фильтр, несколько фильтров можно сочетать.
   ------------------------------------------------------------------------- */

function closeColumnFilterMenu() {
  $$(".col-filter-menu").forEach((m) => m.remove());
}

function showColumnFilterMenu(e, key) {
  closeColumnFilterMenu();

  const values = Array.from(new Set(state.documents.map(COLUMN_DEFS[key]))).sort((a, b) =>
    a.localeCompare(b, "ru")
  );

  const menu = document.createElement("div");
  menu.className = "col-filter-menu";

  const allItem = document.createElement("div");
  allItem.className = "col-filter-item" + (!Object.prototype.hasOwnProperty.call(columnFilters, key) ? " active" : "");
  allItem.textContent = "Все";
  allItem.addEventListener("click", () => {
    delete columnFilters[key];
    closeColumnFilterMenu();
    renderTable();
  });
  menu.appendChild(allItem);

  if (values.length) {
    const divider = document.createElement("div");
    divider.className = "col-filter-divider";
    menu.appendChild(divider);
  }

  values.forEach((v) => {
    const item = document.createElement("div");
    item.className = "col-filter-item" + (columnFilters[key] === v ? " active" : "");
    item.textContent = v;
    item.addEventListener("click", () => {
      columnFilters[key] = v;
      closeColumnFilterMenu();
      renderTable();
    });
    menu.appendChild(item);
  });

  document.body.appendChild(menu);

  // Позиционируем и подправляем, если меню вылезает за край экрана
  const menuRect = menu.getBoundingClientRect();
  let left = e.clientX;
  let top = e.clientY;
  if (left + menuRect.width > window.innerWidth) left = window.innerWidth - menuRect.width - 8;
  if (top + menuRect.height > window.innerHeight) top = window.innerHeight - menuRect.height - 8;
  menu.style.left = Math.max(8, left) + "px";
  menu.style.top = Math.max(8, top) + "px";
}

function wireColumnFilters() {
  $$("#registryTable thead th[data-col]").forEach((th) => {
    th.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      showColumnFilterMenu(e, th.dataset.col);
    });
  });
}
wireColumnFilters();

document.addEventListener("click", (e) => {
  if (!e.target.closest(".col-filter-menu")) closeColumnFilterMenu();
});
document.addEventListener("contextmenu", (e) => {
  if (!e.target.closest("th[data-col]")) closeColumnFilterMenu();
});

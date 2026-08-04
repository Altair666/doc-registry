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
  renderStagesSelects();
  renderTable();
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

function renderTable() {
  const search = $("#search").value.trim().toLowerCase();
  const stageFilter = $("#filterStage").value;

  let rows = state.documents.filter((d) => {
    if (stageFilter && String(d.stage_id) !== stageFilter) return false;
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
        <td><span class="badge">${escapeHtml(stage ? stage.name : "—")}</span></td>
        <td>${d.files.length}</td>
        <td><button type="button" class="btn btn-secondary btn-small row-open" data-id="${d.id}">Открыть →</button></td>
      </tr>`;
    })
    .join("");

  $$("#docsBody .row-open").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openCard(Number(btn.dataset.id));
    });
  });

  $("#emptyState").style.display = rows.length ? "none" : "block";
}

$("#search").addEventListener("input", renderTable);
$("#filterStage").addEventListener("change", renderTable);

/* -------------------------------------------------------------------------
   Добавление / редактирование документа
   ------------------------------------------------------------------------- */

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
  $("#fDate").value = "";
  $("#fDate").disabled = true;
  typeCombo.populate(null);
  counterpartyCombo.populate(null);
  $("#modalDoc").dataset.mode = "create";
  $("#modalDoc").classList.add("open");
  updateSaveButtonState();
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
  $("#cardStage").textContent = stage ? stage.name : "—";

  const stages = orderedStages();
  $("#advanceTarget").innerHTML = stages
    .map((s) => `<option value="${s.id}" ${s.id === doc.stage_id ? "selected" : ""}>${escapeHtml(s.name)}</option>`)
    .join("");
  const nextStage = getNextStage(doc.stage_id);
  if (nextStage) $("#advanceTarget").value = nextStage.id;

  $("#advanceFile").value = "";

  const filesSorted = [...doc.files].sort((a, b) => b.version - a.version);
  const filesBody = $("#filesBody");
  if (!filesSorted.length) {
    filesBody.innerHTML = `<tr><td colspan="4" class="muted">Файлов пока нет</td></tr>`;
  } else {
    filesBody.innerHTML = filesSorted
      .map((f) => {
        const fStage = getStage(f.stage_id);
        const stageLabel = f.stage_name || (fStage ? fStage.name : "—");
        return `
        <tr>
          <td><span class="badge">${escapeHtml(stageLabel)}</span></td>
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

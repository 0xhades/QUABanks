const state = {
  view: "home",
  packet: null,
  bankId: null,
  bank: null,
  bankCatalog: [],
  lectureId: null,
  sectionId: null,
  questionId: null,
  search: "",
  settingsPanel: null,
  expandedPanels: new Set(),
  mobilePane: "tree",
  dirty: false,
  authAvailable: null,
  session: null,
  authStage: "access",
  authMode: "login",
  exportBusy: { pdf: false, pptx: false },
  exportRuns: { pdf: 0, pptx: 0 },
};

const $ = (selector) => document.querySelector(selector);
const rootDocument = () => state.packet?.document;
const lectures = () => rootDocument()?.lectures || [];
const allSections = () => lectures().flatMap((lecture) => lecture.sections || []);
const currentLecture = () => lectures().find((lecture) => lecture.id === state.lectureId) || null;
const sections = () => currentLecture()?.sections || [];
const currentSection = () => sections().find((section) => section.id === state.sectionId) || null;
const currentQuestion = () => currentSection()?.questions.find((question) => question.id === state.questionId) || null;

function allQuestions() {
  return allSections().flatMap((section) => section.questions || []);
}

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function slug(value) {
  const result = String(value || "new-question")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return result || "new-question";
}

function uniqueId(base, collection) {
  const used = new Set(collection.map((item) => item.id));
  let candidate = slug(base);
  let suffix = 2;
  while (used.has(candidate)) candidate = `${slug(base)}-${suffix++}`;
  return candidate;
}

function markDirty() {
  state.dirty = true;
  const label = $("#save-state");
  label.innerHTML = '<span class="status-dot unsaved"></span> unsaved changes';
}

function markSaved(message = "draft saved") {
  state.dirty = false;
  $("#save-state").innerHTML = '<span class="status-dot"></span> ' + esc(message);
}

let toastTimer;
function toast(message, error = false) {
  const node = $("#toast");
  node.textContent = message;
  node.className = `toast visible${error ? " error" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.className = "toast"; }, 3300);
}

function isLocalEditorHost() {
  return ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);
}

function setAuthError(message = "") {
  const node = $("#auth-error");
  if (!node) return;
  node.textContent = message;
  node.hidden = !message;
}

function setAuthMode(mode) {
  state.authMode = mode === "register" ? "register" : "login";
  const login = $("#login-form");
  const register = $("#register-form");
  const loginButton = $("#login-mode-button");
  const registerButton = $("#register-mode-button");
  if (login) login.hidden = state.authMode !== "login";
  if (register) register.hidden = state.authMode !== "register";
  if (loginButton) {
    loginButton.classList.toggle("active", state.authMode === "login");
    loginButton.setAttribute("aria-selected", String(state.authMode === "login"));
  }
  if (registerButton) {
    registerButton.classList.toggle("active", state.authMode === "register");
    registerButton.setAttribute("aria-selected", String(state.authMode === "register"));
  }
}

function showAuthGate(stage = "access", message = "") {
  state.authStage = stage === "personal" ? "personal" : "access";
  const gate = $("#auth-gate");
  const access = $("#access-form");
  const personal = $("#personal-auth");
  const description = $("#auth-description");
  if (!gate) return;
  gate.hidden = false;
  document.body.classList.add("auth-locked");
  if (access) access.hidden = state.authStage !== "access";
  if (personal) personal.hidden = state.authStage !== "personal";
  if (description) description.textContent = state.authStage === "access"
    ? "This workspace is shared with your cohort. Enter the access code to continue."
    : "Access granted. Log in with your PIN or create your contributor account.";
  setAuthError(message);
  if (state.authStage === "access") $("#access-code-input")?.focus();
  else if (state.authMode === "register") $("#register-name-input")?.focus();
  else $("#login-pin-input")?.focus();
}

function hideAuthGate(user = null) {
  state.session = user;
  const gate = $("#auth-gate");
  const actions = $("#user-session-actions");
  const name = $("#user-session-name");
  if (gate) gate.hidden = true;
  document.body.classList.remove("auth-locked");
  if (actions) actions.hidden = !user;
  if (name) name.textContent = user?.display_name ? `${user.display_name} · ${user.role}` : "";
  setAuthError("");
}

function authErrorMessage(data, fallback) {
  return data && typeof data.error === "string" ? data.error : fallback;
}

async function jsonResponse(response) {
  return response.json().catch(() => ({}));
}

async function apiFetch(input, init = {}) {
  const response = await fetch(input, { credentials: "same-origin", ...init });
  if (response.status === 401 && state.authAvailable) {
    const body = await response.clone().json().catch(() => ({}));
    const siteGate = String(body?.error || "").toLowerCase().includes("site access");
    state.session = null;
    showAuthGate(siteGate ? "access" : "personal", body?.error || "Please sign in again.");
  }
  return response;
}

function setShellView(view) {
  if (state.view !== view) cancelActiveExports();
  state.view = view;
  const inEditor = view === "editor";
  const home = $("#bank-home");
  const editor = $("#editor-view");
  const editorActions = $("#editor-actions");
  const back = $("#back-banks-button");
  const saveState = $("#save-state");
  if (home) home.hidden = inEditor;
  if (editor) editor.hidden = !inEditor;
  if (editorActions) editorActions.hidden = !inEditor;
  if (back) back.hidden = !inEditor;
  if (saveState) {
    saveState.hidden = false;
    if (!inEditor) saveState.innerHTML = '<span class="status-dot"></span> local library';
  }
}

function bankImageSrc(path) {
  if (!path) return "";
  return imageSrc(path);
}

function formatBankDate(value) {
  if (!value || value === "reference") return "Built-in template";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Saved locally";
  return `Updated ${date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
}

function bankKindLabel(kind) {
  return kind === "reference" ? "REFERENCE" : kind === "example" ? "EXAMPLE" : "SAVED";
}

function renderHome(catalog = state.bankCatalog) {
  state.bankCatalog = catalog;
  const bankCount = catalog.length;
  const lectureCount = catalog.reduce((sum, bank) => sum + Number(bank.lecture_count || 0), 0);
  const questionCount = catalog.reduce((sum, bank) => sum + Number(bank.question_count || 0), 0);
  $("#home-bank-count").textContent = String(bankCount);
  $("#home-lecture-count").textContent = String(lectureCount);
  $("#home-question-count").textContent = String(questionCount);
  $("#bank-library-label").textContent = `${bankCount} packet${bankCount === 1 ? "" : "s"}`;
  const list = $("#bank-list");
  if (!catalog.length) {
    list.innerHTML = '<div class="bank-empty panel"><strong>No banks yet.</strong><span>Create one or import a normalized packet to begin.</span></div>';
    return;
  }
  list.innerHTML = catalog.map((bank) => {
    const image = bankImageSrc(bank.cover_image);
    const cover = image
      ? `<div class="bank-cover"><img src="${esc(image)}" alt="Example image from ${esc(bank.title)}" loading="lazy" onerror="this.closest('.bank-cover').classList.add('missing')"><span class="bank-cover-fallback">${esc(String(bank.title || "Q").slice(0, 1).toUpperCase())}</span></div>`
      : `<div class="bank-cover bank-cover-empty"><span>${esc(String(bank.title || "Q").slice(0, 1).toUpperCase())}</span></div>`;
    return `<article class="bank-card panel">
      ${cover}
      <div class="bank-card-body">
        <div class="bank-card-head"><span class="bank-status ${esc(bank.kind)}">${bankKindLabel(bank.kind)}</span><span class="bank-card-date">${esc(formatBankDate(bank.updated_at))}</span></div>
        <h3>${esc(bank.title)}</h3>
        <p class="bank-card-week">${esc(bank.week)} <span>·</span> ${esc(bank.subtitle)}</p>
        <p class="bank-card-description">${esc(bank.description)}</p>
        <div class="bank-card-meta"><span>${esc(bank.lecture_count)} lectures</span><span>${esc(bank.section_count)} sections</span><span>${esc(bank.question_count)} questions</span>${Number(bank.media_count || 0) ? `<span>${esc(bank.media_count)} images</span>` : ""}</div>
        <div class="bank-card-actions"><button class="button button-primary" data-action="open-bank" data-bank-id="${esc(bank.id)}" type="button">${bank.kind === "reference" ? "Open reference" : "Open editor"}</button>${bank.kind === "reference" ? '<span class="bank-readonly">Immutable source</span>' : '<span class="bank-readonly">Local packet</span>'}</div>
      </div>
    </article>`;
  }).join("");
}

async function refreshBankCatalog() {
  const response = await apiFetch("/api/banks", { cache: "no-store" });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "could not load bank catalog");
  renderHome(Array.isArray(data.banks) ? data.banks : []);
}

function showCreateBankForm(show = true) {
  const form = $("#new-bank-form");
  if (!form) return;
  form.hidden = !show;
  if (show) {
    $("#new-bank-title").focus();
    form.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
}

async function openBank(bankId) {
  cancelActiveExports();
  const response = await apiFetch(`/api/banks/${encodeURIComponent(bankId)}`, { cache: "no-store" });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "could not open bank");
  state.bankId = data.bank?.id || bankId;
  state.bank = data.bank || null;
  state.packet = normalizePacket(data.packet);
  state.search = "";
  state.settingsPanel = null;
  state.mobilePane = "tree";
  selectFirstItem();
  setShellView("editor");
  markSaved(state.bank?.kind === "reference" ? "reference loaded" : state.bank?.kind === "example" ? "example loaded" : "bank loaded");
  renderAll();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function showHome(options = {}) {
  if (state.view === "editor" && state.dirty && !options.force && !window.confirm("You have unsaved changes. Return to the bank list and discard them?")) return;
  cancelActiveExports();
  state.view = "home";
  state.dirty = false;
  setShellView("home");
  showCreateBankForm(false);
  try {
    await refreshBankCatalog();
  } catch (error) {
    toast(error instanceof Error ? error.message : "could not load bank catalog", true);
  }
}

async function createBank(event) {
  event.preventDefault();
  const title = $("#new-bank-title").value.trim();
  const week = $("#new-bank-week").value.trim();
  const description = $("#new-bank-description").value.trim();
  if (!title) return;
  const submit = event.currentTarget.querySelector('button[type="submit"]');
  submit.disabled = true;
  submit.textContent = "Creating…";
  try {
    const response = await apiFetch("/api/banks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, week, description }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "could not create bank");
    showCreateBankForm(false);
    await openBank(data.bank.id);
    toast("New question bank created");
  } finally {
    submit.disabled = false;
    submit.textContent = "Create and open editor";
  }
}

async function importHomePacket(file) {
  const packet = normalizePacket(JSON.parse(await file.text()));
  const response = await apiFetch("/api/banks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ packet }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "could not import packet");
  await openBank(data.bank.id);
  toast("Packet imported as a new local bank");
}

function setSelection(lectureId, sectionId, questionId) {
  state.lectureId = lectureId;
  const lecture = lectures().find((item) => item.id === lectureId);
  const section = (lecture?.sections || []).find((item) => item.id === sectionId) || lecture?.sections?.[0];
  state.sectionId = section?.id || null;
  state.questionId = questionId || section?.questions?.[0]?.id || null;
  state.settingsPanel = null;
  state.expandedPanels.clear();
  renderAll();
}

function selectFirstItem() {
  const lecture = lectures()[0];
  const section = lecture?.sections?.[0];
  state.lectureId = lecture?.id || null;
  state.sectionId = section?.id || null;
  state.questionId = section?.questions?.[0]?.id || null;
  state.settingsPanel = null;
  state.expandedPanels.clear();
}

function normalizePacket(packet) {
  if (!packet || packet.schema_version !== "pdf-template-v1" || !packet.document) {
    throw new Error("Expected a pdf-template-v1 packet");
  }
  // Migrate the original flat packet shape once at the editor boundary.  The
  // saved draft and every new download use lectures[].sections[], while old
  // packets remain importable without a destructive rewrite by the renderer.
  if (!Array.isArray(packet.document.lectures) || packet.document.lectures.length === 0) {
    if (!Array.isArray(packet.document.sections) || packet.document.sections.length === 0) {
      throw new Error("The document needs at least one lecture");
    }
    const grouped = new Map();
    for (const legacySection of packet.document.sections) {
      const sourceLecture = legacySection.lecture || { id: legacySection.id, title: legacySection.title };
      const lectureId = String(sourceLecture.id || legacySection.id);
      let lecture = grouped.get(lectureId);
      if (!lecture) {
        lecture = { id: lectureId, title: sourceLecture.title || legacySection.title, sections: [] };
        grouped.set(lectureId, lecture);
      }
      const section = { ...legacySection };
      delete section.lecture;
      lecture.sections.push(section);
    }
    packet.document.lectures = [...grouped.values()];
    delete packet.document.sections;
  }
  if (!packet.document.lectures.every((lecture) => Array.isArray(lecture.sections) && lecture.sections.length > 0)) {
    throw new Error("Every lecture needs at least one section");
  }
  for (const lecture of packet.document.lectures) {
    lecture.sections ||= [];
    lecture.description ||= "";
    const sourceSections = [...lecture.sections];
    const additionalSections = [];
    const usedSectionIds = new Set(sourceSections.map((section) => String(section?.id || "")));
    for (const section of sourceSections) {
      section.questions ||= [];
      section.hints ||= [];
      const openQuestions = [];
      const retainedQuestions = [];
      for (const question of section.questions) {
        if (!question || typeof question !== "object") {
          retainedQuestions.push(question);
          continue;
        }
        if (!Array.isArray(question.options)) question.options = [];
        if (!Array.isArray(question.notes)) question.notes = [];
        if (!Array.isArray(question.media)) question.media = question.image ? [{ path: question.image, alt_text: question.caption || "", caption: question.caption || "" }] : [];
        if (!Array.isArray(question.lecture_refs)) question.lecture_refs = [];
        const declaredChoice = ["mcq", "multi_select"].includes(question.type);
        if (declaredChoice && (question.options.length < 2 || question.options.length > 6)) {
          const originalType = question.type;
          question.type = "other";
          if (!question.notes.some((note) => note?.kind === "warning" && String(note.text || "").includes("choice options"))) {
            question.notes.push({
              kind: "warning",
              text: `The source is labeled ${String(originalType).toUpperCase()} but has ${question.options.length} choice options; it was opened as an open response so the editor will not fabricate choices.`,
            });
          }
        }
        if (question.type === "multi_select" && !question.correct_answers) {
          question.correct_answers = question.answer ? [question.answer] : [];
        }
        if (section.layout === "mcq_two_column" && !["mcq", "multi_select"].includes(String(question.type))) {
          const warning = "This question was moved to an open-response section because an MCQ section only accepts questions with answer choices.";
          if (!question.notes.some((note) => note?.kind === "warning" && String(note.text || "") === warning)) {
            question.notes.push({ kind: "warning", text: warning });
          }
          openQuestions.push(question);
        } else {
          retainedQuestions.push(question);
        }
      }
      section.questions = retainedQuestions;
      if (openQuestions.length > 0) {
        const baseId = `${String(section.id || "section")}-open-responses`;
        let sectionId = baseId;
        let suffix = 2;
        while (usedSectionIds.has(sectionId)) sectionId = `${baseId}-${suffix++}`;
        usedSectionIds.add(sectionId);
        additionalSections.push({
          id: sectionId,
          title: `${String(section.title || "Questions")} — open responses`,
          layout: "seq_single_column",
          hints: [],
          questions: openQuestions,
        });
      }
    }
    lecture.sections = [...sourceSections.filter((section) => !section || section.questions?.length !== 0), ...additionalSections];
  }
  return packet;
}

function counts(section) {
  return {
    questions: section.questions.length,
    hints: section.hints?.length || 0,
    media: section.questions.reduce((total, question) => total + (question.media?.length || (question.image ? 1 : 0)), 0),
  };
}

function renderNav() {
  const query = state.search.trim().toLowerCase();
  const html = lectures().map((lecture) => {
    const lectureMatches = `${lecture.title} ${lecture.description || ""}`.toLowerCase().includes(query);
    const matchingSections = (lecture.sections || []).map((section) => {
      const sectionMatches = lectureMatches || section.title.toLowerCase().includes(query);
      const matchingQuestions = (section.questions || []).filter((question) =>
        sectionMatches || `${question.number} ${question.stem}`.toLowerCase().includes(query));
      return { section, matchingQuestions };
    }).filter(({ matchingQuestions }) => !query || matchingQuestions.length > 0);
    if (query && matchingSections.length === 0) return "";
    const selectedLecture = lecture.id === state.lectureId;
    const lectureQuestions = (lecture.sections || []).reduce((sum, section) => sum + section.questions.length, 0);
    const sectionTree = selectedLecture ? `<div class="nested-section-list">${matchingSections.map(({ section, matchingQuestions }) => {
      const selectedSection = section.id === state.sectionId;
      const count = counts(section);
      const questions = selectedSection ? `<div class="question-list">${matchingQuestions.map((question) => `
        <div class="question-link ${question.id === state.questionId ? "selected" : ""}">
          <button class="question-select" data-action="select-question" data-lecture-id="${esc(lecture.id)}" data-section-id="${esc(section.id)}" data-question-id="${esc(question.id)}" type="button"${question.id === state.questionId ? ' aria-current="true"' : ""} title="${esc(question.stem || "Untitled question")}">
            <span class="question-number">${esc(question.number)}</span><span class="question-stem">${esc(question.stem || "Untitled question")}</span>
          </button>
          <button class="tree-duplicate" data-action="duplicate-question" data-lecture-id="${esc(lecture.id)}" data-section-id="${esc(section.id)}" data-question-id="${esc(question.id)}" type="button" title="Duplicate question" aria-label="Duplicate question ${esc(question.number)}">⧉</button>
        </div>`).join("")}</div>` : "";
      return `<div class="section-item ${selectedSection ? "selected" : ""}">
        <button class="section-heading" data-action="select-section" data-lecture-id="${esc(lecture.id)}" data-section-id="${esc(section.id)}" type="button" aria-expanded="${selectedSection}">
          <span class="tree-node-copy"><span class="tree-node-kind">Section</span><span class="section-item-title">${esc(section.title)}</span>
          <span class="section-item-meta"><span>${count.questions} Qs</span><span>·</span><span>${count.media} media</span>${count.hints ? `<span class="hint-indicator">· ${count.hints} hints</span>` : ""}</span></span>
          <span class="tree-chevron" aria-hidden="true">${selectedSection ? "−" : "+"}</span>
        </button>
        ${questions}
      </div>`;
    }).join("")}</div>` : "";
    return `<div class="lecture-item ${selectedLecture ? "selected" : ""}">
      <button class="lecture-heading" data-action="select-lecture" data-lecture-id="${esc(lecture.id)}" type="button" aria-expanded="${selectedLecture}">
        <span class="tree-node-copy"><span class="tree-node-kind">Lecture</span><span class="section-item-title">${esc(lecture.title)}</span>
        <span class="section-item-meta"><span>${lectureQuestions} Qs</span><span>·</span><span>${lecture.sections.length} sections</span></span></span>
        <span class="tree-chevron" aria-hidden="true">${selectedLecture ? "−" : "+"}</span>
      </button>
      ${sectionTree}
    </div>`;
  }).join("");
  $("#section-list").innerHTML = html || '<div class="subtle" style="padding:15px 7px">No lectures, sections, or questions match that search.</div>';
}

function input(label, value, bind, options = {}) {
  const { type = "text", placeholder = "", className = "", min, max, readonly = false } = options;
  return `<label class="field ${className}"><span>${esc(label)}</span><input type="${type}" value="${esc(value)}" data-bind="${esc(bind)}" placeholder="${esc(placeholder)}"${min !== undefined ? ` min="${min}"` : ""}${max !== undefined ? ` max="${max}"` : ""}${readonly ? " readonly" : ""}></label>`;
}

function textarea(label, value, bind, options = {}) {
  const { placeholder = "", className = "" } = options;
  return `<label class="field ${className}"><span>${esc(label)}</span><textarea data-bind="${esc(bind)}" placeholder="${esc(placeholder)}">${esc(value)}</textarea></label>`;
}

function select(label, value, bind, values) {
  return `<label class="field"><span>${esc(label)}</span><select data-bind="${esc(bind)}">${values.map((item) => `<option value="${esc(item.value)}"${item.value === value ? " selected" : ""}>${esc(item.label)}</option>`).join("")}</select></label>`;
}

function renderHints(section) {
  const hints = section.hints || [];
  return `<details class="form-section disclosure-card" data-disclosure="hints"${state.expandedPanels.has("hints") ? " open" : ""}>
    <summary><span><span class="tree-node-kind">Optional appendix</span><strong>End-of-lecture hints</strong></span><span class="disclosure-meta">${hints.length} ${hints.length === 1 ? "hint" : "hints"}<span class="disclosure-chevron" aria-hidden="true"></span></span></summary>
    <div class="disclosure-content"><div class="form-section-heading"><p class="subtle">Hints become an appendix page only when they exist. They stay attached to this lecture.</p><button class="button button-small button-secondary" data-action="add-hint" type="button">+ Add hint</button></div>
    <div class="hints-editor">${hints.map((hint, index) => `<div class="note-row">
      <input class="inline-input" data-bind="section.hints.${index}.title" value="${esc(hint.title || `Hint ${index + 1}`)}" placeholder="Short title">
      <input class="inline-input" data-bind="section.hints.${index}.text" value="${esc(hint.text)}" placeholder="Hint text">
      <button class="button button-small button-danger" data-action="remove-hint" data-index="${index}" type="button">×</button>
    </div>`).join("") || '<div class="subtle">No appendix page will be emitted for this lecture.</div>'}</div></div>
  </details>`;
}

function renderOptions(question) {
  if (!["mcq", "multi_select"].includes(question.type)) return "";
  const correct = question.correct_answers || (question.answer ? [question.answer] : []);
  return `<div class="form-section">
    <div class="form-section-heading"><h3>${question.type === "multi_select" ? "Answer choices · multi-select" : "Answer choices · single choice"}</h3><button class="button button-small button-secondary" data-action="add-option" type="button">+ Add option</button></div>
    <div class="options-editor">${question.options.map((option, index) => `<div class="option-row">
      <span class="option-label">${esc(option.label || String.fromCharCode(65 + index))}</span>
      <input class="inline-input" data-bind="question.options.${index}.text" value="${esc(option.text)}" placeholder="Option text">
      <label class="chip"><input type="checkbox" data-action="toggle-correct" data-label="${esc(option.label)}"${correct.includes(option.label) ? " checked" : ""}> correct</label>
      <button class="button button-small button-danger" data-action="remove-option" data-index="${index}" type="button">×</button>
    </div>`).join("")}</div>
    <p class="subtle" style="margin-top:9px">${question.type === "multi_select" ? "Select every correct choice." : "Select exactly one correct choice."}</p>
  </div>`;
}

function renderNotes(question) {
  const notes = question.notes || [];
  return `<details class="form-section disclosure-card" data-disclosure="notes"${state.expandedPanels.has("notes") ? " open" : ""}>
    <summary><span><span class="tree-node-kind">Optional</span><strong>Notes under question</strong></span><span class="disclosure-meta">${notes.length} ${notes.length === 1 ? "note" : "notes"}<span class="disclosure-chevron" aria-hidden="true"></span></span></summary>
    <div class="disclosure-content"><div class="disclosure-actions"><button class="button button-small button-secondary" data-action="add-note" type="button">+ Add note</button></div>
    <div class="notes-editor">${notes.map((note, index) => `<div class="note-row">
      <label class="note-kind"><span>Note type</span><select class="inline-input" data-bind="question.notes.${index}.kind"><option value="note"${note.kind === "note" ? " selected" : ""}>note</option><option value="instruction"${note.kind === "instruction" ? " selected" : ""}>instruction</option><option value="warning"${note.kind === "warning" ? " selected" : ""}>warning</option><option value="source_limit"${note.kind === "source_limit" ? " selected" : ""}>source limit</option></select></label>
      <label class="note-copy"><span>Note text</span><textarea class="inline-input" data-bind="question.notes.${index}.text" placeholder="Write the note shown below the question">${esc(note.text)}</textarea></label>
      <button class="button button-small button-danger note-remove" data-action="remove-note" data-index="${index}" type="button" aria-label="Remove note ${index + 1}">×</button>
    </div>`).join("") || '<div class="subtle">No notes attached.</div>'}</div></div>
  </details>`;
}

function renderProvenance(question) {
  question.lecture_refs ||= [];
  const bank = question.bank_source || { name: "", question_number: "", page_numbers: [] };
  return `<div class="form-section">
    <div class="form-section-heading"><h3>Traceability</h3><span>never hidden from the final JSON</span></div>
    <div class="form-section-heading" style="margin:7px 0"><h3 style="font-size:13px">Lecture references</h3><button class="button button-small button-secondary" data-action="add-lecture-ref" type="button">+ Add reference</button></div>
    <div class="source-row" style="display:grid;gap:7px">${question.lecture_refs.map((ref, index) => `<div class="field-inline">
      <input class="inline-input" data-bind="question.lecture_refs.${index}.lecture_title" value="${esc(ref.lecture_title)}" placeholder="Lecture title">
      <input class="inline-input" data-bind="question.lecture_refs.${index}.slide_numbers" value="${esc((ref.slide_numbers || []).join(", "))}" placeholder="Slides, e.g. 3, 4">
      <button class="button button-small button-danger" data-action="remove-lecture-ref" data-index="${index}" type="button">×</button>
    </div>`).join("") || '<div class="subtle">No lecture slide reference yet.</div>'}</div>
    <div class="form-section-heading" style="margin:17px 0 7px"><h3 style="font-size:13px">Bank source</h3></div>
    ${input("Bank name", bank.name || "", "question.bank_source.name", { placeholder: "Original question-bank name" })}
    <div class="field-grid">${input("Question number", bank.question_number || "", "question.bank_source.question_number", { placeholder: "e.g. 127" })}${input("Source pages", (bank.page_numbers || []).join(", "), "question.bank_source.page_numbers", { placeholder: "e.g. 28, 29" })}</div>
  </div>`;
}

function renderMedia(question) {
  question.media ||= [];
  return `<details class="form-section disclosure-card" data-disclosure="media"${state.expandedPanels.has("media") ? " open" : ""}>
    <summary><span><span class="tree-node-kind">Optional</span><strong>Question media</strong></span><span class="disclosure-meta">${question.media.length} ${question.media.length === 1 ? "image" : "images"}<span class="disclosure-chevron" aria-hidden="true"></span></span></summary>
    <div class="disclosure-content"><div class="form-section-heading"><p class="subtle">Use a packet-relative path, such as <code>assets/sample/neck-ospe-x.png</code>.</p><button class="button button-small button-secondary" data-action="add-media" type="button">+ Add image</button></div>
    <div class="media-editor">${question.media.map((media, index) => `<div class="media-row">
      <div style="flex:1;display:grid;gap:6px">${input("Image path", media.path, `question.media.${index}.path`, { placeholder: "assets/..." })}${input("Alt text", media.alt_text, `question.media.${index}.alt_text`, { placeholder: "Accessible description" })}${input("Caption", media.caption || "", `question.media.${index}.caption`, { placeholder: "Optional caption" })}</div>
      <button class="button button-small button-danger" data-action="remove-media" data-index="${index}" type="button">Remove</button>
    </div>`).join("") || '<div class="subtle">No images attached to this question.</div>'}</div></div>
  </details>`;
}

function renderEditor() {
  const lecture = currentLecture();
  const section = currentSection();
  const question = currentQuestion();
  $("#add-question-button").disabled = !section;
  $("#add-section-button").disabled = !lecture;
  $("#editor-title").textContent = section ? `${lecture?.title || "Lecture"} · ${section.title}` : lecture?.title || "Question bank";
  const q = question;
  const document = rootDocument();
  const typeValues = [
    { value: "mcq", label: "MCQ · single choice" },
    { value: "multi_select", label: "Multi-select" },
    { value: "seq", label: "SEQ · short essay" },
    { value: "ospe", label: "OSPE · image station" },
    { value: "other", label: "Other · free response" },
    { value: "explain_why", label: "Explain why" },
  ];
  const bankSettings = state.settingsPanel === "bank" ? `<div class="form-section settings-card">
      <div class="form-section-heading"><h3>Packet setup</h3><span>the renderer reads this metadata</span></div>
      <div class="field-grid">${input("Packet title", document.title, "document.title", { placeholder: "e.g. MED45 Question Bank" })}${input("Week / label", document.week, "document.week", { placeholder: "e.g. Week 1" })}</div>
      <div class="field-grid">${input("Subtitle", document.subtitle || "", "document.subtitle", { placeholder: "Optional context line" })}${input("Output filename", document.output_name || "", "document.output_name", { placeholder: "optional-name.pdf" })}</div>
    </div>` : "";
  const lectureSettings = lecture && state.settingsPanel === "lecture" ? `<div class="form-section settings-card">
      <div class="form-section-heading"><h3>Lecture identity</h3><span class="chip">${esc(lecture.id)}</span></div>
      <div class="field-grid">${input("Lecture ID", lecture.id, "lecture.id")}${input("Lecture display title", lecture.title, "lecture.title")}</div>
      ${textarea("Lecture description", lecture.description || "", "lecture.description", { placeholder: "Optional description shown in the content tree." })}
    </div>` : "";
  $("#editor-form").innerHTML = `
    <div class="editor-scope-bar">
      <div class="scope-summary"><span class="tree-node-kind">Bank</span><strong>${esc(document.title || "Untitled bank")}</strong><small>${esc(document.week || "No label")}</small></div>
      <button class="button button-small button-quiet" data-action="toggle-bank-settings" type="button" aria-expanded="${state.settingsPanel === "bank"}">${state.settingsPanel === "bank" ? "Close bank settings" : "Bank settings"}</button>
      ${lecture ? `<div class="scope-divider" aria-hidden="true"></div><div class="scope-summary"><span class="tree-node-kind">Lecture</span><strong>${esc(lecture.title || "Untitled lecture")}</strong><small>${esc((lecture.sections || []).length)} sections</small></div><button class="button button-small button-quiet" data-action="toggle-lecture-settings" type="button" aria-expanded="${state.settingsPanel === "lecture"}">${state.settingsPanel === "lecture" ? "Close lecture settings" : "Lecture settings"}</button>` : ""}
    </div>
    ${bankSettings}${lectureSettings}
    ${!lecture ? '<div class="empty-editor form-section"><p>Select a lecture from the content tree, or add a lecture to start building a packet.</p></div>' : `
    ${!section ? '<div class="empty-editor"><p>This lecture has no selected section. Add a section from the toolbar.</p></div>' : `
    <div class="form-section">
      <div class="form-section-heading"><h3>Question section</h3><span class="chip">${esc(section.id)}</span></div>
      <div class="field-grid">${input("Section title", section.title, "section.title")}${select("Page layout", section.layout, "section.layout", [{ value: "mcq_two_column", label: "MCQ · two columns" }, { value: "seq_single_column", label: "Single column" }, { value: "explain_why", label: "Explain why" }])}</div>
    </div>
    ${q ? `<div class="form-section">
      <div class="form-section-heading"><h3>Question ${esc(q.number)}</h3><div class="form-actions-right"><span class="chip">${esc(q.id)}</span><button class="button button-small button-secondary" data-action="duplicate-question" type="button">Duplicate</button><button class="button button-small button-danger" data-action="remove-question" type="button">Delete question</button></div></div>
      <div class="field-grid">${input("Question number", q.number, "question.number", { type: "number", min: 1 })}${select("Question shape", q.type, "question.type", typeValues)}</div>
      ${textarea("Question / prompt", q.stem, "question.stem", { placeholder: "Write the question exactly as it should appear." })}
      ${textarea("Case or station context", q.case || "", "question.case", { placeholder: "Optional vignette, specimen instruction, or station context." })}
    </div>
    ${renderOptions(q)}
    ${renderProvenance(q)}
    <div class="form-section">
      <div class="form-section-heading"><h3>Answer and Tutor layer</h3><span>optional for prompts; useful for Show mode</span></div>
      ${q.type === "mcq" || q.type === "multi_select" ? "" : textarea("Answer / key", q.answer || "", "question.answer", { placeholder: "Answer, rubric, or accepted response." })}
      ${textarea("Tutor explanation", q.explanation || "", "question.explanation", { placeholder: "Why this answer is correct, or how the Tutor should explain it." })}
    </div>
    ${renderNotes(q)}
    ${renderMedia(q)}
    ` : '<div class="empty-editor"><p>This section has no questions yet. Add the first one from the toolbar.</p></div>'}
    ${renderHints(section)}
    <div class="form-actions"><button class="button button-danger" data-action="remove-section" type="button">Delete section</button><button class="button button-danger" data-action="remove-lecture" type="button">Delete lecture</button><span class="subtle">Changes are held in the browser until you save the draft.</span></div>`}`}`;
}

function imageSrc(path) {
  const raw = String(path || "");
  if (raw.startsWith("r2://")) return `/assets/${raw.slice(5).replace(/^\/+/, "")}`;
  const clean = raw.replace(/^\.?\//, "").replace(/^assets\//, "");
  return `/assets/${clean}`;
}

function renderPreview() {
  const lecture = currentLecture();
  const section = currentSection();
  const question = currentQuestion();
  const node = $("#paper-preview");
  const count = allSections().reduce((sum, item) => sum + item.questions.length, 0);
  $("#preview-count").textContent = `${count} question${count === 1 ? "" : "s"}`;
  if (!section || !question) {
    $("#preview-label").textContent = section ? "lecture overview" : "select a question";
    node.innerHTML = section ? `<div class="paper-topline"><div><div class="paper-kicker">${esc(lecture?.title || "Lecture")} · section</div><div class="paper-title">${esc(section.title)}</div></div><span class="paper-type">${esc(section.questions.length)} Qs</span></div>${(section.hints || []).length ? `<div class="paper-hint-block"><h4>Hints appendix</h4>${section.hints.map((hint) => `<div class="paper-hint"><b>${esc(hint.title || "Hint")}</b> · ${esc(hint.text)}</div>`).join("")}</div>` : '<p class="subtle" style="margin-top:18px">No hints appendix will be emitted.</p>'}` : '<div class="empty-preview">Choose a lecture and question to see the Week 1 paper treatment.</div>';
    return;
  }
  $("#preview-label").textContent = `question ${question.number} · ${question.type}`;
  const choice = ["mcq", "multi_select"].includes(question.type);
  const correct = question.correct_answers || (question.answer ? [question.answer] : []);
  const notes = (question.notes || []).map((note) => `<div class="paper-note">${esc(note.text)}</div>`).join("");
  const refs = (question.lecture_refs || []).map((ref) => `${esc(ref.lecture_title)} · slide${(ref.slide_numbers || []).length > 1 ? "s" : ""} ${esc((ref.slide_numbers || []).join(", "))}`).join("; ");
  const bank = question.bank_source?.name ? `${esc(question.bank_source.name)}${question.bank_source.question_number ? ` · Q${esc(question.bank_source.question_number)}` : ""}${question.bank_source.page_numbers?.length ? ` · p.${esc(question.bank_source.page_numbers.join(", "))}` : ""}` : "";
  const media = (question.media || (question.image ? [{ path: question.image, caption: question.caption }] : [])).map((item) => `<figure class="paper-media"><img src="${esc(imageSrc(item.path))}" alt="${esc(item.alt_text || item.caption || "question image")}" onerror="this.closest('figure').classList.add('missing')"><figcaption>${esc(item.caption || item.alt_text || "Question image")}</figcaption></figure>`).join("");
  node.innerHTML = `<div class="paper-topline"><div><div class="paper-kicker">${esc(lecture?.title || "Lecture")} · ${esc(section.title)}</div><div class="paper-title">${esc(rootDocument().title || "Question packet")}</div></div><span class="paper-type">${esc(question.type)}</span></div>
    ${question.case ? `<div class="paper-case"><b>Case / station</b><br>${esc(question.case)}</div>` : ""}
    <div class="paper-stem">${esc(question.number)}. ${esc(question.stem || "Untitled question")}</div>
    ${choice ? `<div class="paper-options">${(question.options || []).map((option) => `<div class="paper-option"><b>${esc(option.label)}</b><span>${esc(option.text)}</span></div>`).join("")}</div>` : ""}
    ${notes}${question.answer ? `<div class="paper-answer"><b>Answer:</b> ${esc(choice ? correct.map((label) => (question.options.find((item) => item.label === label)?.text || label)).join("; ") : question.answer)}</div>` : ""}
    ${question.explanation ? `<div class="paper-explanation"><b>Tutor explanation:</b> ${esc(question.explanation)}</div>` : ""}
    ${media}
    ${refs ? `<div class="paper-meta"><b>Lecture source:</b> ${refs}</div>` : ""}
    ${bank ? `<div class="paper-meta"><b>Bank source:</b> ${bank}</div>` : ""}`;
}

function renderAll() {
  if (state.view !== "editor" || !state.packet) return;
  renderNav();
  renderEditor();
  renderPreview();
  renderMobilePane();
}

function renderMobilePane() {
  const editorView = $("#editor-view");
  if (!editorView) return;
  editorView.dataset.mobilePane = state.mobilePane;
  document.querySelectorAll(".mobile-tab").forEach((button) => {
    const active = button.dataset.pane === state.mobilePane;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
  });
}

function parseList(value) {
  return String(value || "").split(",").map((item) => Number(item.trim())).filter((item) => Number.isInteger(item) && item > 0);
}

function bindValue(target) {
  const bind = target.dataset.bind;
  if (!bind) return false;
  const parts = bind.split(".");
  const document = rootDocument();
  const lecture = currentLecture();
  const section = currentSection();
  const question = currentQuestion();
  if (parts[0] === "document" && document) {
    document[parts[1]] = target.value;
  } else if (parts[0] === "lecture" && lecture) {
    lecture[parts[1]] = target.value;
    if (parts[1] === "id") state.lectureId = target.value;
  } else if (parts[0] === "section" && section) {
    if (parts[1] === "hints") {
      const hint = section.hints[Number(parts[2])];
      if (hint) hint[parts[3]] = target.value;
    } else if (parts[1] === "lecture") {
      // Kept only for drafts imported from the legacy flat form. New packets
      // store the lecture identity on the parent lecture object.
      section.lecture ||= {};
      section.lecture[parts[2]] = target.value;
    } else {
      section[parts[1]] = target.value;
      if (parts[1] === "title" && !section.lecture?.title) section.lecture.title = target.value;
    }
  } else if (parts[0] === "question" && question) {
    if (parts[1] === "options") {
      const option = question.options[Number(parts[2])];
      if (option) option[parts[3]] = target.value;
    } else if (parts[1] === "notes") {
      const note = question.notes[Number(parts[2])];
      if (note) note[parts[3]] = target.value;
    } else if (parts[1] === "lecture_refs") {
      const ref = question.lecture_refs[Number(parts[2])];
      if (ref) ref[parts[3]] = parts[3] === "slide_numbers" ? parseList(target.value) : target.value;
    } else if (parts[1] === "bank_source") {
      question.bank_source ||= {};
      question.bank_source[parts[2]] = parts[2] === "page_numbers" ? parseList(target.value) : target.value;
    } else if (parts[1] === "media") {
      const media = question.media[Number(parts[2])];
      if (media) media[parts[3]] = target.value;
    } else {
      const previousType = question.type;
      question[parts[1]] = parts[1] === "number" ? Number(target.value) || 1 : target.value;
      if (parts[1] === "type") {
        const newType = question.type;
        if (["mcq", "multi_select"].includes(newType)) {
          question.options ||= [{ label: "A", text: "" }, { label: "B", text: "" }];
          if (question.options.length < 2) {
            question.options.push({ label: "B", text: "" });
          }
          const labels = question.options.map((option) => option.label);
          const previousAnswers = question.correct_answers || [];
          const validAnswers = previousAnswers.filter((answer) => labels.includes(answer));
          question.correct_answers = validAnswers.length ? validAnswers : [labels[0]];
          question.answer = question.correct_answers[0];
          section.layout = "mcq_two_column";
        } else {
          const wasChoice = ["mcq", "multi_select"].includes(previousType);
          question.correct_answers = undefined;
          if (wasChoice || /^[A-F]$/.test(String(question.answer || ""))) question.answer = "";
          section.layout = newType === "explain_why" ? "explain_why" : "seq_single_column";
        }
        renderEditor();
      }
    }
  }
  markDirty();
  renderNav();
  renderPreview();
  return true;
}

function addQuestion() {
  const section = currentSection();
  if (!section) return;
  const number = Math.max(0, ...section.questions.map((question) => Number(question.number) || 0)) + 1;
  const id = uniqueId(`${section.id}-question-${number}`, allQuestions());
  const type = section.layout === "seq_single_column" ? "seq" : section.layout === "explain_why" ? "explain_why" : "mcq";
  const question = { id, number, type, stem: "New question", answer: "", notes: [], lecture_refs: [], media: [] };
  if (type === "mcq") {
    question.options = [{ label: "A", text: "" }, { label: "B", text: "" }];
    question.answer = "A";
    question.correct_answers = ["A"];
  }
  section.questions.push(question);
  state.questionId = id;
  markDirty();
  renderAll();
}

function duplicateQuestion() {
  const section = currentSection();
  const question = currentQuestion();
  if (!section || !question) return;
  const index = section.questions.findIndex((item) => item.id === question.id);
  if (index < 0) return;
  const copy = typeof structuredClone === "function"
    ? structuredClone(question)
    : JSON.parse(JSON.stringify(question));
  copy.id = uniqueId(`${question.id}-copy`, allQuestions());
  copy.number = Math.max(0, ...section.questions.map((item) => Number(item.number) || 0)) + 1;
  section.questions.splice(index + 1, 0, copy);
  state.questionId = copy.id;
  markDirty();
  renderAll();
  toast(`Duplicated question ${question.number} as ${copy.number}`);
}

function newQuestionForSection(section) {
  const number = Math.max(0, ...section.questions.map((question) => Number(question.number) || 0)) + 1;
  const id = uniqueId(`${section.id}-question-${number}`, allQuestions());
  const type = section.layout === "seq_single_column" ? "seq" : section.layout === "explain_why" ? "explain_why" : "mcq";
  const question = { id, number, type, stem: "New question", answer: "", notes: [], lecture_refs: [], media: [] };
  if (type === "mcq") {
    question.options = [{ label: "A", text: "" }, { label: "B", text: "" }];
    question.answer = "A";
    question.correct_answers = ["A"];
  }
  section.questions.push(question);
  return question;
}

function addLecture() {
  const id = uniqueId("new-lecture", lectures());
  const section = { id: uniqueId(`${id}-section-1`, allSections()), title: "Section 1", layout: "mcq_two_column", questions: [], hints: [] };
  const lecture = { id, title: "New lecture", description: "", sections: [section] };
  newQuestionForSection(section);
  rootDocument().lectures.push(lecture);
  state.lectureId = id;
  state.sectionId = section.id;
  state.questionId = section.questions[0].id;
  markDirty();
  renderAll();
}

function addSection() {
  const lecture = currentLecture();
  if (!lecture) return addLecture();
  const id = uniqueId(`${lecture.id}-section-${lecture.sections.length + 1}`, allSections());
  const section = { id, title: `Section ${lecture.sections.length + 1}`, layout: "mcq_two_column", questions: [], hints: [] };
  newQuestionForSection(section);
  lecture.sections.push(section);
  state.sectionId = id;
  state.questionId = section.questions[0].id;
  markDirty();
  renderAll();
}

function handleAction(target) {
  const action = target.dataset.action;
  if (!action) return;
  const lecture = currentLecture();
  const section = currentSection();
  const question = currentQuestion();
  if (action === "mobile-pane") {
    state.mobilePane = target.dataset.pane || "tree";
    renderMobilePane();
    return;
  }
  if (action === "select-lecture") return setSelection(target.dataset.lectureId);
  if (action === "select-section") return setSelection(target.dataset.lectureId, target.dataset.sectionId);
  if (action === "select-question") {
    state.mobilePane = "editor";
    return setSelection(target.dataset.lectureId, target.dataset.sectionId, target.dataset.questionId);
  }
  if (action === "toggle-bank-settings") {
    state.settingsPanel = state.settingsPanel === "bank" ? null : "bank";
    return renderEditor();
  }
  if (action === "toggle-lecture-settings") {
    state.settingsPanel = state.settingsPanel === "lecture" ? null : "lecture";
    return renderEditor();
  }
  if (action === "add-lecture") return addLecture();
  if (action === "add-section") return addSection();
  if (action === "add-question") return addQuestion();
  if (action === "duplicate-question") {
    // The tree exposes a duplicate control on every question. Select that
    // question first so the action cannot accidentally duplicate the editor's
    // previously selected question when the small tree button is clicked.
    if (target.dataset.questionId) {
      state.lectureId = target.dataset.lectureId || state.lectureId;
      state.sectionId = target.dataset.sectionId || state.sectionId;
      state.questionId = target.dataset.questionId;
    }
    return duplicateQuestion();
  }
  if (action === "remove-section" && section) {
    if ((lecture?.sections || []).length === 1) {
      if (!window.confirm(`This is the only section in “${lecture.title}”. Delete the whole lecture?`)) return;
      return removeLecture();
    }
    if (!window.confirm(`Delete “${section.title}” from this lecture?`)) return;
    lecture.sections = lecture.sections.filter((item) => item.id !== section.id);
    state.sectionId = lecture.sections[0]?.id || null;
    state.questionId = lecture.sections[0]?.questions?.[0]?.id || null;
  } else if (action === "remove-question" && section && question) {
    section.questions = section.questions.filter((item) => item.id !== question.id);
    state.questionId = section.questions[0]?.id || null;
  } else if (action === "remove-lecture" && lecture) {
    return removeLecture();
  } else if (action === "add-option" && question) {
    if (question.options.length >= 6) {
      toast("A choice question can have at most six options.", true);
      return;
    }
    const label = String.fromCharCode(65 + question.options.length);
    question.options.push({ label, text: "" });
  } else if (action === "remove-option" && question) {
    if (question.options.length <= 2) {
      toast("Keep at least two answer choices.", true);
      return;
    }
    question.options.splice(Number(target.dataset.index), 1);
    question.options.forEach((option, index) => { option.label = String.fromCharCode(65 + index); });
    question.correct_answers = (question.correct_answers || []).filter((label) => question.options.some((option) => option.label === label));
  } else if (action === "toggle-correct" && question) {
    const label = target.dataset.label;
    const values = new Set(question.correct_answers || (question.answer ? [question.answer] : []));
    if (target.checked) values.add(label); else values.delete(label);
    question.correct_answers = [...values];
    if (question.type === "mcq") {
      question.correct_answers = question.correct_answers.slice(-1);
      question.answer = question.correct_answers[0] || "";
    }
  } else if (action === "add-note" && question) {
    state.expandedPanels.add("notes");
    question.notes ||= []; question.notes.push({ kind: "note", text: "" });
  } else if (action === "remove-note" && question) {
    question.notes.splice(Number(target.dataset.index), 1);
  } else if (action === "add-media" && question) {
    state.expandedPanels.add("media");
    question.media ||= []; question.media.push({ path: "", alt_text: "", caption: "" });
  } else if (action === "remove-media" && question) {
    question.media.splice(Number(target.dataset.index), 1);
  } else if (action === "add-lecture-ref" && question) {
    question.lecture_refs ||= []; question.lecture_refs.push({ lecture_title: currentLecture()?.title || section.title, slide_numbers: [] });
  } else if (action === "remove-lecture-ref" && question) {
    question.lecture_refs.splice(Number(target.dataset.index), 1);
  } else if (action === "add-hint" && section) {
    state.expandedPanels.add("hints");
    section.hints ||= []; section.hints.push({ id: uniqueId(`${section.id}-hint`, section.hints), title: `Hint ${section.hints.length + 1}`, text: "" });
  } else if (action === "remove-hint" && section) {
    section.hints.splice(Number(target.dataset.index), 1);
  }
  if (action !== "select-section" && action !== "select-question") markDirty();
  renderAll();
}

function removeLecture() {
  const lecture = currentLecture();
  if (!lecture) return;
  if (!window.confirm(`Delete “${lecture.title}” and all of its sections from this draft?`)) return;
  rootDocument().lectures = lectures().filter((item) => item.id !== lecture.id);
  const nextLecture = rootDocument().lectures[0];
  state.lectureId = nextLecture?.id || null;
  state.sectionId = nextLecture?.sections?.[0]?.id || null;
  state.questionId = nextLecture?.sections?.[0]?.questions?.[0]?.id || null;
  markDirty();
  renderAll();
}

async function saveDraft(showMessage = true) {
  // The seeded Example packet is read-only for contributors. They can still
  // experiment in memory and export a snapshot, but only an admin may persist
  // changes back to the built-in bank.
  if (state.authAvailable && state.bank?.kind === "example" && state.session?.role !== "admin") {
    if (showMessage) toast("Example is read-only; create a bank to save changes");
    return;
  }
  const targetId = state.bankId === "reference" ? "example" : state.bankId;
  const endpoint = targetId ? `/api/banks/${encodeURIComponent(targetId)}` : "/api/packet";
  const response = await apiFetch(endpoint, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ packet: state.packet, revision: state.bank?.revision }) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "could not save draft");
  // The server may canonicalize legacy packets (for example, moving a
  // choice-labelled question with no options out of an MCQ section). Keep the
  // browser state in sync so the next render/export uses the same packet that
  // was persisted.
  if (data.packet) state.packet = normalizePacket(data.packet);
  if (targetId === "example" && state.bankId === "reference") {
    state.bankId = "example";
    state.bank = data.bank || state.bank;
  } else if (data.bank) {
    state.bank = data.bank;
  }
  markSaved("draft saved");
  if (showMessage) toast(state.bankId ? "Bank saved locally" : "Draft saved separately from sample_packet.json");
}

function exportButton(format) {
  return format === "pdf" ? $("#render-button") : $("#pptx-button");
}

function idleExportLabel(format) {
  return format === "pdf" ? "Render PDF" : "Save as PPTX";
}

function beginExport(format) {
  if (state.exportBusy[format]) return null;
  state.exportBusy[format] = true;
  const run = ++state.exportRuns[format];
  const button = exportButton(format);
  if (button) {
    button.disabled = true;
    button.textContent = format === "pdf" ? "Preparing PDF…" : "Preparing PPTX…";
  }
  return { format, run, bankId: state.bankId };
}

function exportIsCurrent(context) {
  return context && state.exportRuns[context.format] === context.run && state.bankId === context.bankId;
}

function finishExport(context) {
  if (!context || state.exportRuns[context.format] !== context.run) return;
  state.exportBusy[context.format] = false;
  const button = exportButton(context.format);
  if (button) {
    button.disabled = false;
    button.textContent = idleExportLabel(context.format);
  }
}

function cancelActiveExports() {
  for (const format of ["pdf", "pptx"]) {
    state.exportRuns[format] += 1;
    state.exportBusy[format] = false;
    const button = exportButton(format);
    if (button) {
      button.disabled = false;
      button.textContent = idleExportLabel(format);
    }
  }
}

async function waitForExport(statusUrl, format, label, context) {
  const deadline = Date.now() + 30 * 60_000;
  while (Date.now() < deadline) {
    if (!exportIsCurrent(context)) return null;
    const response = await apiFetch(statusUrl, { cache: "no-store" });
    if (!exportIsCurrent(context)) return null;
    const data = await response.json().catch(() => ({}));
    if (!exportIsCurrent(context)) return null;
    if (!response.ok) throw new Error(data.error || `${label} status could not be read`);
    const job = data.job || {};
    if (job.status === "completed") {
      const url = job.downloads?.[format];
      if (!url) throw new Error(`${label} completed without a download URL`);
      return url;
    }
    if (job.status === "failed") throw new Error(job.error || `${label} failed in the export container`);
    const attempt = Number(job.attempts || 0);
    const suffix = job.status === "running"
      ? `Rendering ${format.toUpperCase()}…`
      : attempt > 0
        ? `Retrying ${format.toUpperCase()} (${Math.min(attempt + 1, 3)}/3)…`
        : `Queued ${format.toUpperCase()}…`;
    const button = exportButton(format);
    if (button) button.textContent = suffix;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`${label} timed out while waiting for the export worker`);
}

function artifactSignatureIsValid(bytes, format) {
  if (format === "pdf") {
    return bytes.length >= 5
      && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44
      && bytes[3] === 0x46 && bytes[4] === 0x2d;
  }
  return bytes.length >= 4
    && bytes[0] === 0x50 && bytes[1] === 0x4b
    && ((bytes[2] === 0x03 && bytes[3] === 0x04)
      || (bytes[2] === 0x05 && bytes[3] === 0x06)
      || (bytes[2] === 0x07 && bytes[3] === 0x08));
}

async function downloadArtifact(url, filename, format, newTab = false) {
  const response = await apiFetch(url, { cache: "no-store" });
  if (!response.ok) {
    const data = await response.clone().json().catch(() => ({}));
    throw new Error(data.error || `${format.toUpperCase()} artifact could not be downloaded`);
  }
  const blob = await response.blob();
  const bytes = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
  if (!artifactSignatureIsValid(bytes, format)) {
    const contentType = response.headers.get("content-type") || blob.type || "unknown content type";
    throw new Error(`Export server returned ${contentType} instead of a valid ${format.toUpperCase()} file`);
  }
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.target = newTab ? "_blank" : "_self";
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
}

async function renderPdf() {
  const context = beginExport("pdf");
  if (!context) return;
  try {
    await saveDraft(false);
    if (!exportIsCurrent(context)) return;
    const response = await apiFetch("/api/render", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bank_id: state.bankId, revision: state.bank?.revision, packet: state.packet }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || data.error_detail || "renderer rejected this packet");
    $("#pipeline-render").classList.add("active");
    const url = data.preview_url || (data.status_url ? await waitForExport(data.status_url, "pdf", "PDF export", context) : null);
    if (!exportIsCurrent(context)) return;
    if (!url) throw new Error("PDF export completed without a preview URL");
    toast("PDF rendered. Opening the deterministic preview…");
    await downloadArtifact(url, `${slug(rootDocument()?.title || "question-packet")}.pdf`, "pdf", true);
  } finally {
    finishExport(context);
  }
}

async function exportPptx() {
  const context = beginExport("pptx");
  if (!context) return;
  try {
    await saveDraft(false);
    if (!exportIsCurrent(context)) return;
    const response = await apiFetch("/api/export-pptx", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bank_id: state.bankId, revision: state.bank?.revision, packet: state.packet }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || data.error_detail || "editable PowerPoint export failed");
    const url = data.download_url || data.preview_url || (data.status_url ? await waitForExport(data.status_url, "pptx", "PowerPoint export", context) : null);
    if (!exportIsCurrent(context)) return;
    if (!url) throw new Error("PowerPoint export completed without a download URL");
    await downloadArtifact(url, `${slug(rootDocument()?.title || "question-packet")}-editable.pptx`, "pptx");
    toast("Editable PPTX downloaded");
  } finally {
    finishExport(context);
  }
}

function downloadJson() {
  const blob = new Blob([`${JSON.stringify(state.packet, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = `${slug(rootDocument().title || "question-packet")}.json`; anchor.click();
  URL.revokeObjectURL(url); toast("Normalized packet downloaded");
}

async function resetDraft() {
  if (state.authAvailable && (state.bankId === "example" || state.bankId === "reference")) {
    await openBank("example");
    toast("Example packet restored");
    return;
  }
  if (state.bankId && state.bankId !== "example") {
    const response = await apiFetch(`/api/banks/${encodeURIComponent(state.bankId)}`, { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "could not restore this bank");
    state.packet = normalizePacket(data.packet);
    state.bank = data.bank || state.bank;
    selectFirstItem();
    $("#pipeline-render").classList.remove("active");
    markSaved(state.bankId === "reference" ? "reference restored" : "bank restored");
    renderAll();
    toast(state.bankId === "reference" ? "Reference packet restored" : "Saved bank restored");
    return;
  }
  const response = await apiFetch("/api/reset", { method: "POST" });
  const data = await response.json();
  state.packet = normalizePacket(data.packet); selectFirstItem();
  state.bankId = "example";
  state.bank = null;
  $("#pipeline-render").classList.remove("active"); markSaved("sample restored"); renderAll(); toast("Draft reset to the untouched sample packet");
}

async function importJson(file) {
  const packet = JSON.parse(await file.text());
  state.packet = normalizePacket(packet); selectFirstItem();
  markDirty(); renderAll(); toast("JSON imported into an unsaved draft");
}

function lectureImportString(value) {
  if (typeof value === "string") return value.trim();
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function lectureImportClone(value) {
  return typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

function lectureImportOptions(value) {
  if (!Array.isArray(value)) return [];
  return value.map((candidate, index) => {
    const option = candidate && typeof candidate === "object" && !Array.isArray(candidate) ? candidate : { text: candidate };
    const text = lectureImportString(option.text ?? option.value ?? option.label);
    if (!text) return null;
    return { label: String.fromCharCode(65 + index), text };
  }).filter(Boolean).slice(0, 6);
}

function lectureImportChoiceLabels(answer, options, explicit) {
  const candidates = Array.isArray(explicit) && explicit.length ? explicit : [answer];
  const labels = [];
  for (const candidate of candidates) {
    const raw = lectureImportString(candidate);
    if (!raw) continue;
    const first = raw.charAt(0).toUpperCase();
    if (/^[A-F]$/.test(first) && (!raw.charAt(1) || /[.)\-:\s]/.test(raw.charAt(1))) && options.some((option) => option.label === first)) {
      if (!labels.includes(first)) labels.push(first);
      continue;
    }
    const match = options.find((option) => option.text.toLowerCase() === raw.toLowerCase());
    if (match && !labels.includes(match.label)) labels.push(match.label);
  }
  return labels;
}

function lectureImportNotes(question, mediaNotice) {
  const notes = Array.isArray(question.notes) ? question.notes.map((note) => {
    const row = note && typeof note === "object" ? note : { text: note };
    const text = lectureImportString(row.text);
    const kind = ["note", "warning", "instruction", "source_limit"].includes(row.kind) ? row.kind : "note";
    return text ? { kind, text } : null;
  }).filter(Boolean) : [];
  if (mediaNotice && ((Array.isArray(question.media) && question.media.length) || question.image)) {
    notes.push({ kind: "source_limit", text: mediaNotice });
  }
  return notes;
}

function lectureImportQuestion(source, index, sectionId, usedQuestions, mediaNotice) {
  const question = source && typeof source === "object" ? source : {};
  const rawType = lectureImportString(question.type || question.question_type).toLowerCase();
  const options = lectureImportOptions(question.options);
  const declaredChoice = ["mcq", "multi_select"].includes(rawType);
  const rawOptionCount = Array.isArray(question.options) ? question.options.length : 0;
  const malformedChoice = declaredChoice && (rawOptionCount < 2 || rawOptionCount > 6 || options.length < 2);
  const type = malformedChoice
    ? "other"
    : ["mcq", "multi_select", "seq", "ospe", "other", "explain_why"].includes(rawType)
      ? rawType
      : options.length >= 2 ? "mcq" : "seq";
  const stem = lectureImportString(question.stem || question.question || question.prompt);
  if (!stem) return null;
  const id = uniqueId(question.id || `${sectionId}-question-${Number(question.number) || index + 1}`, usedQuestions);
  const number = Math.max(1, Number(question.number) || index + 1);
  const result = { id, number, type, stem, notes: [], lecture_refs: [], media: [] };
  const caseText = lectureImportString(question.case || question.shared_vignette);
  if (caseText) result.case = caseText;
  if (["mcq", "multi_select"].includes(type) && options.length >= 2) {
    result.options = options;
    const labels = lectureImportChoiceLabels(question.answer, options, question.correct_answers);
    if (labels.length) {
      result.correct_answers = type === "mcq" ? labels.slice(-1) : labels;
      result.answer = result.correct_answers.join(", ");
    } else {
      const rawAnswer = lectureImportString(question.answer);
      if (rawAnswer) result.answer = rawAnswer;
    }
  } else {
    const answer = lectureImportString(question.answer);
    if (answer) result.answer = answer;
  }
  const explanation = lectureImportString(question.explanation);
  if (explanation) result.explanation = explanation;
  if (Array.isArray(question.source_refs)) result.source_refs = question.source_refs.map(lectureImportString).filter(Boolean);
  if (Array.isArray(question.lecture_refs)) result.lecture_refs = lectureImportClone(question.lecture_refs);
  if (question.bank_source && typeof question.bank_source === "object") {
    const bank = { name: lectureImportString(question.bank_source.name) || "Question bank" };
    if (question.bank_source.bank_id) bank.bank_id = lectureImportString(question.bank_source.bank_id);
    if (question.bank_source.question_number !== undefined) bank.question_number = question.bank_source.question_number;
    if (Array.isArray(question.bank_source.page_numbers)) bank.page_numbers = question.bank_source.page_numbers.map(Number).filter((page) => Number.isInteger(page) && page > 0);
    result.bank_source = bank;
  }
  result.notes = lectureImportNotes(question, mediaNotice);
  if (malformedChoice) {
    result.notes.push({
      kind: "warning",
      text: `The source is labeled ${rawType.toUpperCase()} but has ${rawOptionCount} usable options; it was imported as open-ended so the editor will not fabricate choices.`,
    });
  }
  return result;
}

function normalizeLectureImport(payload) {
  if (!payload || (payload.schema_version !== "aounmed-lecture-v1" && payload.document_type !== "lecture")) {
    throw new Error("Expected a lecture.json export (aounmed-lecture-v1)");
  }
  const fallbackLecture = payload.lecture && typeof payload.lecture === "object" ? payload.lecture : {};
  const candidates = Array.isArray(payload.lectures) ? payload.lectures : Array.isArray(payload.sections)
    ? [{ ...fallbackLecture, sections: payload.sections }] : [];
  const mediaNotice = lectureImportString(payload.media?.message) || "Visual media was omitted from this text-only lecture.json export; add it separately before publishing.";
  const usedLectureIds = [...lectures()];
  const usedSectionIds = [...allSections()];
  const usedQuestionIds = [...allQuestions()];
  const importedLectures = [];
  for (const candidate of candidates) {
    const lecture = candidate && typeof candidate === "object" ? candidate : {};
    const title = lectureImportString(lecture.title || fallbackLecture.title) || "Imported lecture";
    const lectureId = uniqueId(lecture.id || title, [...usedLectureIds, ...importedLectures]);
    const importedSections = [];
    const sourceSections = Array.isArray(lecture.sections) ? lecture.sections : [];
    for (const sourceSection of sourceSections) {
      const rawSection = sourceSection && typeof sourceSection === "object" ? sourceSection : {};
      const sourceQuestions = Array.isArray(rawSection.questions) ? rawSection.questions : [];
      const sectionId = uniqueId(rawSection.id || `${lectureId}-${rawSection.title || "section"}`, [...usedSectionIds, ...importedSections]);
      const questions = sourceQuestions.map((question, index) => lectureImportQuestion(
        question,
        index,
        sectionId,
        [...usedQuestionIds, ...importedSections.flatMap((item) => item.questions)],
        mediaNotice
      )).filter(Boolean);
      if (!questions.length) continue;
      const layout = ["mcq_two_column", "seq_single_column", "explain_why"].includes(rawSection.layout)
        ? rawSection.layout
        : questions.every((question) => ["mcq", "multi_select"].includes(question.type)) ? "mcq_two_column" : "seq_single_column";
      const section = {
        id: sectionId,
        title: lectureImportString(rawSection.title) || `${title} · Questions`,
        lecture: { id: lectureId, title },
        layout,
        hints: Array.isArray(rawSection.hints) ? lectureImportClone(rawSection.hints) : [],
        questions,
      };
      importedSections.push(section);
      usedSectionIds.push(section);
      usedQuestionIds.push(...questions);
    }
    if (!importedSections.length) continue;
    const importedLecture = {
      id: lectureId,
      title,
      description: lectureImportString(lecture.description),
      sections: importedSections,
    };
    importedLectures.push(importedLecture);
    usedLectureIds.push(importedLecture);
  }
  if (!importedLectures.length) throw new Error("lecture.json did not contain any usable questions");
  return { lectures: importedLectures, mediaNotice };
}

async function importLectureJson(file) {
  const payload = JSON.parse(await file.text());
  const imported = normalizeLectureImport(payload);
  rootDocument().lectures.push(...imported.lectures);
  const firstLecture = imported.lectures[0];
  state.lectureId = firstLecture.id;
  state.sectionId = firstLecture.sections[0]?.id || null;
  state.questionId = firstLecture.sections[0]?.questions[0]?.id || null;
  markDirty();
  renderAll();
  const count = imported.lectures.reduce((total, lecture) => total + lecture.sections.length, 0);
  toast(`Added ${count} lecture section${count === 1 ? "" : "s"} from lecture.json · text only`);
}

async function bootstrapSession() {
  let response;
  try {
    response = await fetch("/api/session", { cache: "no-store", credentials: "same-origin" });
  } catch (caught) {
    // The editor's original Bun server predates the Cloudflare auth API. Keep
    // that local workflow usable, but never fail open on a deployed host.
    if (isLocalEditorHost()) {
      state.authAvailable = false;
      hideAuthGate(null);
      return true;
    }
    state.authAvailable = true;
    showAuthGate("access", "The authentication service is unavailable. Please try again.");
    return false;
  }
  if (response.status === 404 && isLocalEditorHost()) {
    state.authAvailable = false;
    hideAuthGate(null);
    return true;
  }
  const data = await jsonResponse(response);
  if (!response.ok) {
    state.authAvailable = true;
    showAuthGate("access", authErrorMessage(data, "The authentication service is unavailable."));
    return false;
  }
  state.authAvailable = true;
  if (!data.access_granted) {
    state.session = null;
    showAuthGate("access");
    return false;
  }
  if (!data.user) {
    state.session = null;
    showAuthGate("personal");
    return false;
  }
  hideAuthGate(data.user);
  return true;
}

async function submitAuthForm(event, endpoint, payload, successMessage) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const submit = form.querySelector('button[type="submit"]');
  const originalLabel = submit?.textContent || "Continue";
  if (submit) {
    submit.disabled = true;
    submit.textContent = "Checking…";
  }
  setAuthError("");
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await jsonResponse(response);
    if (!response.ok) {
      setAuthError(authErrorMessage(data, "Could not complete that request."));
      return;
    }
    if (endpoint === "/api/access/unlock") {
      setAuthMode("login");
      showAuthGate("personal");
      toast("Workspace unlocked");
      return;
    }
    hideAuthGate(data.user || null);
    await refreshBankCatalog();
    setShellView("home");
    toast(successMessage);
  } catch (caught) {
    setAuthError(caught instanceof Error ? caught.message : "Network error. Please try again.");
  } finally {
    if (submit) {
      submit.disabled = false;
      submit.textContent = originalLabel;
    }
  }
}

async function logout() {
  const response = await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
  if (!response.ok && response.status !== 401) {
    const data = await jsonResponse(response);
    throw new Error(authErrorMessage(data, "Could not log out."));
  }
  state.session = null;
  state.bank = null;
  state.bankId = null;
  showAuthGate("access");
  $("#access-form")?.reset();
  $("#login-form")?.reset();
  $("#register-form")?.reset();
  toast("Logged out");
}

async function init() {
  try {
    if (!(await bootstrapSession())) return;
    setShellView("home");
    await refreshBankCatalog();
  } catch (error) {
    toast(error instanceof Error ? error.message : "could not load bank catalog", true);
  }
}

document.addEventListener("click", (event) => {
  const authMode = event.target.closest("[data-auth-mode]");
  if (authMode) {
    setAuthMode(authMode.dataset.authMode);
    setAuthError("");
    return;
  }
  const target = event.target.closest("[data-action]");
  if (target?.dataset.action === "open-bank") {
    openBank(target.dataset.bankId).catch((error) => toast(error.message, true));
    return;
  }
  if (target) handleAction(target);
});
document.addEventListener("input", (event) => {
  if (event.target.id === "search-input") { state.search = event.target.value; renderNav(); return; }
  bindValue(event.target);
});
document.addEventListener("change", (event) => {
  if (event.target.dataset.action === "toggle-correct") { handleAction(event.target); return; }
  bindValue(event.target);
});
document.addEventListener("toggle", (event) => {
  const disclosure = event.target.closest?.("[data-disclosure]");
  if (!disclosure) return;
  if (disclosure.open) state.expandedPanels.add(disclosure.dataset.disclosure);
  else state.expandedPanels.delete(disclosure.dataset.disclosure);
}, true);
$("#add-lecture-button").addEventListener("click", addLecture);
$("#add-section-button").addEventListener("click", addSection);
$("#add-question-button").addEventListener("click", addQuestion);
$("#save-button").addEventListener("click", () => saveDraft().catch((error) => toast(error.message, true)));
$("#pptx-button").addEventListener("click", () => exportPptx().catch((error) => toast(error.message, true)));
$("#render-button").addEventListener("click", () => renderPdf().catch((error) => toast(error.message, true)));
$("#reset-button").addEventListener("click", () => resetDraft().catch((error) => toast(error.message, true)));
$("#download-json-button").addEventListener("click", downloadJson);
$("#import-json-input").addEventListener("change", (event) => { const [file] = event.target.files; if (file) importJson(file).catch((error) => toast(error.message, true)); event.target.value = ""; });
$("#import-lecture-input").addEventListener("change", (event) => { const [file] = event.target.files; if (file) importLectureJson(file).catch((error) => toast(error.message, true)); event.target.value = ""; });
$("#create-bank-button").addEventListener("click", () => showCreateBankForm(true));
$("#cancel-create-bank-button").addEventListener("click", () => showCreateBankForm(false));
$("#new-bank-form").addEventListener("submit", (event) => createBank(event).catch((error) => toast(error.message, true)));
$("#home-import-input").addEventListener("change", (event) => { const [file] = event.target.files; if (file) importHomePacket(file).catch((error) => toast(error.message, true)); event.target.value = ""; });
$("#back-banks-button").addEventListener("click", () => showHome());
$("#access-form").addEventListener("submit", (event) => {
  const code = $("#access-code-input").value.trim();
  submitAuthForm(event, "/api/access/unlock", { code }, "Workspace unlocked").catch((error) => setAuthError(error.message));
});
$("#login-form").addEventListener("submit", (event) => {
  const pin = $("#login-pin-input").value.trim();
  submitAuthForm(event, "/api/auth/login", { pin }, "Welcome back").catch((error) => setAuthError(error.message));
});
$("#register-form").addEventListener("submit", (event) => {
  const displayName = $("#register-name-input").value.trim();
  const pin = $("#register-pin-input").value.trim();
  submitAuthForm(event, "/api/auth/register", { display_name: displayName, pin }, "Account created").catch((error) => setAuthError(error.message));
});
$("#logout-button").addEventListener("click", () => logout().catch((error) => toast(error.message, true)));

init();

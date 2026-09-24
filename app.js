import {
  addCoffee,
  backupState,
  deleteCoffee,
  getCoffee,
  importBackupData,
  listCoffees,
  markBackedUp,
  readBackupData,
  requestPersistentStorage,
  updateCoffee,
} from "./db.js";
import { createBackup, readBackupFile, saveBackup } from "./backup.js";
import { validateCoffeeImport } from "./validation.js";

const state = {
  coffees: [],
  validatedImport: null,
  selectedRating: null,
  validationVersion: 0,
  renderVersion: 0,
  cardUrls: new Set(),
  detailUrls: new Set(),
  installPrompt: null,
  serviceWorkerRegistration: null,
  updateRequested: false,
};

const coffeeGrid = document.querySelector("#coffeeGrid");
const emptyState = document.querySelector("#emptyState");
const importDialog = document.querySelector("#importDialog");
const detailDialog = document.querySelector("#detailDialog");
const restoreDialog = document.querySelector("#restoreDialog");
const jsonInput = document.querySelector("#jsonInput");
const validationErrors = document.querySelector("#validationErrors");
const validationStatus = document.querySelector("#validationStatus");
const importPreview = document.querySelector("#importPreview");
const previewContent = document.querySelector("#previewContent");
const saveCoffeeButton = document.querySelector("#saveCoffeeButton");
const saveError = document.querySelector("#saveError");
const searchInput = document.querySelector("#searchInput");
const statusFilter = document.querySelector("#statusFilter");
const backupBanner = document.querySelector("#backupBanner");
const changesChannel =
  "BroadcastChannel" in window ? new BroadcastChannel("meu-cafe-changes") : null;

function announceChange() {
  changesChannel?.postMessage("changed");
}

changesChannel?.addEventListener("message", () => {
  loadCoffees().catch(console.error);
});

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function methodLabel(method) {
  return method === "v60" ? "V60" : "Prensa francesa";
}

function formatTime(seconds) {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function ratingText(rating) {
  if (rating === null || rating === undefined) return "Sem nota";
  return `${"★".repeat(rating)}${"☆".repeat(5 - rating)}`;
}

function releaseUrls(urls) {
  urls.forEach((url) => URL.revokeObjectURL(url));
  urls.clear();
}

async function updateBackupBanner() {
  const { revision, backedUpRevision } = await backupState();
  backupBanner.hidden = revision === 0 || revision <= backedUpRevision;
}

async function loadCoffees() {
  state.coffees = await listCoffees();
  await renderCoffees();
  await updateBackupBanner();
}

function filteredCoffees() {
  const query = searchInput.value.trim().toLocaleLowerCase("pt-BR");
  const filter = statusFilter.value;
  return state.coffees.filter((record) => {
    const coffee = record.import_data.coffee;
    const searchable = [
      coffee.name,
      coffee.roaster,
      coffee.country,
      coffee.region,
      coffee.process,
    ]
      .filter(Boolean)
      .join(" ")
      .toLocaleLowerCase("pt-BR");
    const filterMatches =
      filter === "all" ||
      record.status === filter ||
      (filter === "favorites" && record.rating !== null && record.rating >= 4);
    return (!query || searchable.includes(query)) && filterMatches;
  });
}

async function renderCoffees() {
  const renderVersion = ++state.renderVersion;
  releaseUrls(state.cardUrls);
  coffeeGrid.replaceChildren();
  const records = filteredCoffees();
  emptyState.hidden = state.coffees.length !== 0;
  if (state.coffees.length > 0 && records.length === 0) {
    coffeeGrid.append(element("p", "muted", "Nenhum café corresponde aos filtros."));
    return;
  }

  const template = document.querySelector("#coffeeCardTemplate");
  for (const record of records) {
    if (renderVersion !== state.renderVersion) return;
    const coffee = record.import_data.coffee;
    const fragment = template.content.cloneNode(true);
    const image = fragment.querySelector(".coffee-photo");
    image.src = "./icon.svg";
    image.alt = `Pacote do café ${coffee.name}`;
    fragment.querySelector(".card-roaster").textContent =
      coffee.roaster ?? "Torrefação não informada";
    fragment.querySelector(".card-name").textContent = coffee.name;
    fragment.querySelector(".card-origin").textContent =
      [coffee.country, coffee.region].filter(Boolean).join(" · ") ||
      "Origem não informada";
    fragment.querySelector(".method-chip").textContent =
      `${methodLabel(record.import_data.recommendation.method)} · ${record.import_data.recommendation.dose_g} g`;
    fragment.querySelector(".rating-display").textContent = ratingText(record.rating);
    fragment.querySelector(".card-button").addEventListener("click", async () => {
      try {
        await openDetail(record.id);
      } catch (error) {
        window.alert(error.message);
      }
    });
    coffeeGrid.append(fragment);

    if (record.has_package_photo) {
      const complete = await getCoffee(record.id);
      if (renderVersion !== state.renderVersion) return;
      const photo = complete.photos.packagePhoto;
      if (photo?.blob) {
        const url = URL.createObjectURL(photo.blob);
        state.cardUrls.add(url);
        image.src = url;
      }
    }
  }
}

searchInput.addEventListener("input", renderCoffees);
statusFilter.addEventListener("change", renderCoffees);

function openImport() {
  document.querySelector("#importForm").reset();
  state.validationVersion += 1;
  state.validatedImport = null;
  validationErrors.replaceChildren();
  validationStatus.textContent = "";
  importPreview.hidden = true;
  previewContent.replaceChildren();
  saveError.textContent = "";
  saveCoffeeButton.disabled = true;
  importDialog.showModal();
}

document.querySelector("#newCoffeeButton").addEventListener("click", openImport);
document.querySelector("#emptyAddButton").addEventListener("click", openImport);

document.querySelectorAll("[data-close]").forEach((button) => {
  button.addEventListener("click", () => {
    const dialog = document.querySelector(`#${button.dataset.close}`);
    if (dialog === detailDialog) releaseUrls(state.detailUrls);
    dialog.close();
  });
});

function renderValidationErrors(errors) {
  validationErrors.replaceChildren(
    ...errors.map((message) => element("li", null, message)),
  );
}

function renderImportPreview(data) {
  previewContent.replaceChildren();
  const grid = element("div", "preview-grid");
  [
    ["Café", data.coffee.name],
    ["Torrefação", data.coffee.roaster ?? "Não informada"],
    [
      "Origem",
      [data.coffee.country, data.coffee.region].filter(Boolean).join(" · ") ||
        "Não informada",
    ],
    ["Processo", data.coffee.process ?? "Não informado"],
    [
      "Recomendação",
      `${methodLabel(data.recommendation.method)} · ${data.recommendation.dose_g} g`,
    ],
    ["Receitas", "6 combinações validadas"],
  ].forEach(([label, value]) => {
    const item = element("div");
    item.append(element("strong", null, label), element("p", "muted", value));
    grid.append(item);
  });
  previewContent.append(grid);
  const reason = element("p");
  reason.append(element("strong", null, "Por que: "));
  reason.append(document.createTextNode(data.recommendation.reason));
  previewContent.append(reason);
  if (data.analysis.uncertainties.length > 0) {
    const list = element("ul");
    data.analysis.uncertainties.forEach((item) => list.append(element("li", null, item)));
    previewContent.append(element("strong", null, "Pontos para conferir"), list);
  }
}

function cleanJsonInput(value) {
  const trimmed = value.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fenced ? fenced[1].trim() : trimmed;
}

async function validateInput() {
  const version = ++state.validationVersion;
  validationErrors.replaceChildren();
  validationStatus.textContent = "Validando…";
  importPreview.hidden = true;
  state.validatedImport = null;
  saveCoffeeButton.disabled = true;
  await Promise.resolve();

  let data;
  try {
    const cleaned = cleanJsonInput(jsonInput.value);
    if (cleaned.length > 250_000) {
      throw new Error("O JSON excede o limite de 250 mil caracteres.");
    }
    data = JSON.parse(cleaned);
  } catch (error) {
    validationStatus.textContent = "";
    renderValidationErrors([
      error.message.includes("250 mil")
        ? error.message
        : "O texto colado não é um JSON válido.",
    ]);
    return false;
  }
  const result = validateCoffeeImport(data);
  if (version !== state.validationVersion) return false;
  if (!result.valid) {
    validationStatus.textContent = "";
    renderValidationErrors(result.errors);
    return false;
  }
  state.validatedImport = data;
  validationStatus.textContent = "Formato válido";
  renderImportPreview(data);
  importPreview.hidden = false;
  saveCoffeeButton.disabled = false;
  return true;
}

document.querySelector("#validateButton").addEventListener("click", validateInput);
jsonInput.addEventListener("input", () => {
  state.validationVersion += 1;
  state.validatedImport = null;
  validationStatus.textContent = "";
  importPreview.hidden = true;
  saveCoffeeButton.disabled = true;
});
document.querySelector("#packagePhoto").addEventListener("change", () => {
  saveCoffeeButton.disabled = !state.validatedImport;
});

async function loadDrawable(file) {
  if ("createImageBitmap" in window) {
    const bitmap = await createImageBitmap(file);
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      close: () => bitmap.close(),
    };
  }
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.src = url;
  await image.decode();
  return {
    source: image,
    width: image.naturalWidth,
    height: image.naturalHeight,
    close: () => URL.revokeObjectURL(url),
  };
}

async function compressImage(file) {
  if (!file) return null;
  if (file.size > 30 * 1024 * 1024) {
    throw new Error("Cada foto original deve ter no máximo 30 MB.");
  }
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
    throw new Error("Use imagens JPEG, PNG ou WebP.");
  }
  const image = await loadDrawable(file);
  const scale = Math.min(1, 1440 / Math.max(image.width, image.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(image.width * scale);
  canvas.height = Math.round(image.height * scale);
  canvas.getContext("2d").drawImage(image.source, 0, 0, canvas.width, canvas.height);
  image.close();
  let blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.78));
  if (blob?.size > 1.5 * 1024 * 1024) {
    blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.62));
  }
  if (!blob) throw new Error("Não foi possível processar uma das imagens.");
  if (blob.size > 1.5 * 1024 * 1024) {
    throw new Error("A foto continuou muito grande após a compressão.");
  }
  return {
    blob,
    name: file.name.replace(/\.[^.]+$/, ".jpg").slice(0, 200),
    type: "image/jpeg",
  };
}

document.querySelector("#importForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  saveError.textContent = "";
  if (!state.validatedImport && !(await validateInput())) return;
  const packageFile = document.querySelector("#packagePhoto").files[0];
  const cardFile = document.querySelector("#cardPhoto").files[0];
  saveCoffeeButton.disabled = true;
  saveCoffeeButton.textContent = "Salvando…";
  try {
    const packagePhoto = await compressImage(packageFile);
    const cardPhoto = await compressImage(cardFile);
    await requestPersistentStorage().catch(() => false);
    await addCoffee(state.validatedImport, { packagePhoto, cardPhoto });
    announceChange();
    importDialog.close();
    await loadCoffees();
  } catch (error) {
    saveError.textContent = error.message;
  } finally {
    saveCoffeeButton.textContent = "Salvar café";
    saveCoffeeButton.disabled = !state.validatedImport;
  }
});

function appendFact(grid, label, value) {
  const item = element("div");
  item.append(
    element("strong", null, label),
    element("p", "muted", value ?? "Não informado"),
  );
  grid.append(item);
}

const GRIND_LABELS = {
  fine: "Fina",
  "medium-fine": "Média-fina",
  medium: "Média",
  "medium-coarse": "Média-grossa",
  coarse: "Grossa",
};

const METHOD_OPTIONS = [
  ["v60", "V60"],
  ["french_press", "Prensa"],
];
const DOSE_OPTIONS = [10, 15, 30];

function renderRecipe(recipe, recommended) {
  const card = element("article", `recipe-card${recommended ? " recommended" : ""}`);
  const heading = element("div", "recipe-heading");
  heading.append(element("h4", null, `${methodLabel(recipe.method)} · ${recipe.dose_g} g`));
  if (recommended) heading.append(element("span", "tag", "Recomendado"));
  card.append(heading);

  const grind = [
    GRIND_LABELS[recipe.grind.relative] ?? recipe.grind.relative,
    recipe.grind.grinder_setting,
  ]
    .filter(Boolean)
    .join(" · ");
  const stats = element("dl", "recipe-stats");
  [
    ["Água", `${recipe.water_g} g`],
    ["Proporção", `1:${recipe.ratio}`],
    ["Temperatura", `${recipe.temperature_c} °C`],
    ["Moagem", grind],
    ["Tempo total", formatTime(recipe.total_time_seconds)],
  ].forEach(([label, value]) => {
    const item = element("div");
    item.append(element("dt", null, label), element("dd", null, value));
    stats.append(item);
  });
  card.append(stats);

  const list = element("ol");
  recipe.steps.forEach((step) => {
    const water =
      step.target_total_water_g === null ? "" : ` — até ${step.target_total_water_g} g`;
    list.append(
      element("li", null, `${formatTime(step.at_seconds)}: ${step.action}${water}`),
    );
  });
  card.append(list, element("p", null, recipe.rationale));
  if (recipe.capacity_warning) {
    card.append(element("p", "error", "Preparo grande: confirme a capacidade."));
  }
  return card;
}

function segmentedGroup(label, options, onSelect) {
  const group = element("div", "segmented-group");
  group.append(element("span", "segmented-label", label));
  const row = element("div", "segmented");
  row.setAttribute("role", "group");
  row.setAttribute("aria-label", label);
  const buttons = options.map((option) => {
    const button = element(
      "button",
      "segment",
      option.recommended ? `${option.label} ★` : option.label,
    );
    button.type = "button";
    if (option.recommended) {
      button.setAttribute("aria-label", `${option.label} (recomendado)`);
    }
    button.addEventListener("click", () => onSelect(option.value));
    row.append(button);
    return [option.value, button];
  });
  group.append(row);
  return {
    node: group,
    select(value) {
      buttons.forEach(([optionValue, button]) => {
        button.setAttribute("aria-pressed", String(optionValue === value));
      });
    },
    focus(value) {
      buttons.find(([optionValue]) => optionValue === value)?.[1].focus();
    },
  };
}

function renderRecipeViewer(data) {
  const recommended = data.recommendation;
  let method = recommended.method;
  let dose = recommended.dose_g;

  const section = element("section", "detail-section recipe-viewer");
  section.append(element("h3", null, "Receitas"));

  const methodGroup = segmentedGroup(
    "Método",
    METHOD_OPTIONS.map(([value, label]) => ({
      value,
      label,
      recommended: value === recommended.method,
    })),
    (value) => {
      method = value;
      update();
    },
  );
  const doseGroup = segmentedGroup(
    "Gramatura",
    DOSE_OPTIONS.map((value) => ({
      value,
      label: `${value} g`,
      recommended: value === recommended.dose_g,
    })),
    (value) => {
      dose = value;
      update();
    },
  );
  const picker = element("div", "recipe-picker");
  picker.append(methodGroup.node, doseGroup.node);

  const content = element("div", "recipe-content");
  content.setAttribute("aria-live", "polite");
  section.append(picker, content);

  function update() {
    methodGroup.select(method);
    doseGroup.select(dose);
    const recipe = data.recipes.find(
      (item) => item.method === method && item.dose_g === dose,
    );
    const isRecommended = method === recommended.method && dose === recommended.dose_g;
    content.replaceChildren();
    if (isRecommended) {
      const reason = element("div", "recommendation");
      reason.append(
        element("p", "eyebrow", "Recomendado para este café"),
        element("p", null, recommended.reason),
      );
      content.append(reason);
    } else {
      const back = element(
        "button",
        "secondary back-to-recommended",
        `Voltar à recomendada (${methodLabel(recommended.method)} · ${recommended.dose_g} g)`,
      );
      back.type = "button";
      back.addEventListener("click", () => {
        method = recommended.method;
        dose = recommended.dose_g;
        update();
        methodGroup.focus(method);
      });
      content.append(back);
    }
    if (recipe) content.append(renderRecipe(recipe, isRecommended));
  }

  update();
  return section;
}

async function openDetail(id) {
  releaseUrls(state.detailUrls);
  const record = await getCoffee(id);
  state.selectedRating = record.rating;
  const data = record.import_data;
  document.querySelector("#detailRoaster").textContent =
    data.coffee.roaster ?? "Torrefação não informada";
  document.querySelector("#detailName").textContent = data.coffee.name;
  const body = document.querySelector("#detailBody");
  body.replaceChildren();

  const hero = element("section", "detail-hero");
  [
    [record.photos.packagePhoto, `Pacote do café ${data.coffee.name}`],
    [record.photos.cardPhoto, `Cartilha do café ${data.coffee.name}`],
  ].forEach(([photo, alt]) => {
    if (!photo?.blob) return;
    const url = URL.createObjectURL(photo.blob);
    state.detailUrls.add(url);
    const image = element("img");
    image.src = url;
    image.alt = alt;
    hero.append(image);
  });
  const about = element("details", "detail-section about");
  about.append(element("summary", null, "Sobre o café"));
  about.append(hero);

  const factsSection = element("section", "about-section");
  factsSection.append(element("h3", null, "Café"));
  const facts = element("div", "fact-grid");
  [
    ["País", data.coffee.country],
    ["Região", data.coffee.region],
    ["Produtor", data.coffee.producer],
    ["Fazenda", data.coffee.farm],
    ["Variedade", data.coffee.variety],
    [
      "Altitude",
      data.coffee.altitude_m === null ? null : `${data.coffee.altitude_m} m`,
    ],
    ["Processo", data.coffee.process],
    ["Torra", data.coffee.roast_profile],
  ].forEach(([label, value]) => appendFact(facts, label, value));
  factsSection.append(
    facts,
    element(
      "p",
      null,
      `Notas oficiais: ${data.coffee.official_sensory_notes.join(", ") || "não informadas"}`,
    ),
  );

  const analysis = element("section", "about-section");
  analysis.append(
    element("h3", null, "Análise inicial"),
    element("p", null, data.analysis.summary),
    element("p", "muted", data.analysis.expected_cup_profile),
  );
  about.append(factsSection, analysis);

  body.append(renderRecipeViewer(data), renderReviewForm(record), about);
  detailDialog.showModal();
  detailDialog.scrollTop = 0;
}

function updateRatingButtons(rating, container) {
  state.selectedRating = rating;
  container.querySelectorAll("[data-rating-option]").forEach((button) => {
    const option =
      button.dataset.ratingOption === "none"
        ? null
        : Number(button.dataset.ratingOption);
    button.setAttribute("aria-pressed", String(option === rating));
    if (button.classList.contains("rating-button")) {
      button.classList.toggle(
        "active",
        rating !== null && Number(button.dataset.ratingOption) <= rating,
      );
    }
  });
}

function renderReviewForm(record) {
  const section = element("section", "detail-section");
  section.append(element("h3", null, "Minha avaliação"));
  const form = element("form", "review-form");
  const ratingRow = element("div", "rating-row");
  ratingRow.setAttribute("role", "group");
  ratingRow.setAttribute("aria-label", "Nota de zero a cinco");
  const zero = element("button", "secondary rating-clear", "0");
  zero.type = "button";
  zero.dataset.ratingOption = "0";
  zero.addEventListener("click", () => updateRatingButtons(0, ratingRow));
  ratingRow.append(zero);
  for (let rating = 1; rating <= 5; rating += 1) {
    const button = element("button", "rating-button", "★");
    button.type = "button";
    button.dataset.ratingOption = String(rating);
    button.setAttribute("aria-label", `${rating} estrela${rating > 1 ? "s" : ""}`);
    button.addEventListener("click", () => updateRatingButtons(rating, ratingRow));
    ratingRow.append(button);
  }
  const clear = element("button", "secondary rating-clear", "Sem nota");
  clear.type = "button";
  clear.dataset.ratingOption = "none";
  clear.addEventListener("click", () => updateRatingButtons(null, ratingRow));
  ratingRow.append(clear);
  updateRatingButtons(record.rating, ratingRow);

  const commentLabel = element("label");
  commentLabel.append(element("span", null, "Comentário"));
  const comment = element("textarea");
  comment.rows = 4;
  comment.maxLength = 4000;
  comment.value = record.comment;
  commentLabel.append(comment);

  const statusLabel = element("label");
  statusLabel.append(element("span", null, "Status"));
  const status = element("select");
  [
    ["active", "Em uso"],
    ["finished", "Finalizado"],
  ].forEach(([value, label]) => {
    const option = element("option", null, label);
    option.value = value;
    option.selected = value === record.status;
    status.append(option);
  });
  statusLabel.append(status);

  const message = element("p", "error");
  const submit = element("button", "primary", "Salvar avaliação");
  submit.type = "submit";
  form.append(ratingRow, commentLabel, statusLabel, message, submit);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submit.disabled = true;
    try {
      await updateCoffee(record.id, {
        rating: state.selectedRating,
        comment: comment.value,
        status: status.value,
      }, record.updated_at);
      announceChange();
      releaseUrls(state.detailUrls);
      detailDialog.close();
      await loadCoffees();
    } catch (error) {
      message.textContent = error.message;
    } finally {
      submit.disabled = false;
    }
  });
  const remove = element("button", "danger", "Excluir café");
  remove.type = "button";
  remove.addEventListener("click", async () => {
    if (
      !window.confirm(
        `Excluir definitivamente “${record.import_data.coffee.name}” deste aparelho?`,
      )
    ) {
      return;
    }
    try {
      await deleteCoffee(record.id, record.updated_at);
      announceChange();
      releaseUrls(state.detailUrls);
      detailDialog.close();
      await loadCoffees();
    } catch (error) {
      message.textContent = error.message;
    }
  });
  section.append(form, remove);
  return section;
}

async function exportBackup() {
  const buttons = [
    document.querySelector("#exportButton"),
    document.querySelector("#bannerBackupButton"),
  ];
  buttons.forEach((button) => {
    button.disabled = true;
  });
  try {
    const snapshot = await readBackupData();
    const backup = await createBackup(snapshot.items);
    const saved = await saveBackup(backup);
    if (saved) {
      await markBackedUp(snapshot.revision);
      await updateBackupBanner();
    }
  } catch (error) {
    window.alert(`Não foi possível criar o backup: ${error.message}`);
  } finally {
    buttons.forEach((button) => {
      button.disabled = false;
    });
  }
}

document.querySelector("#exportButton").addEventListener("click", exportBackup);
document.querySelector("#bannerBackupButton").addEventListener("click", exportBackup);
document.querySelector("#restoreButton").addEventListener("click", () => {
  document.querySelector("#restoreForm").reset();
  document.querySelector("#restoreError").textContent = "";
  restoreDialog.showModal();
});

document.querySelector("#restoreForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const errorNode = document.querySelector("#restoreError");
  const button = document.querySelector("#restoreSubmitButton");
  errorNode.textContent = "";
  button.disabled = true;
  button.textContent = "Verificando…";
  try {
    const result = await readBackupFile(document.querySelector("#backupFile").files[0]);
    if (!result.valid) throw new Error(result.errors.slice(0, 3).join(" "));
    const localIdentities = new Set(state.coffees.map((record) => record.identity));
    const conflicts = result.items.filter((item) =>
      localIdentities.has(item.record.identity),
    ).length;
    let conflictStrategy = "keep";
    if (conflicts > 0) {
      conflictStrategy = window.confirm(
        `${conflicts} cafés já existem. OK substitui pelos dados do backup; Cancelar mantém os dados locais.`,
      )
        ? "replace"
        : "keep";
    }
    if (!window.confirm(`Continuar a restauração de ${result.items.length} cafés?`)) return;
    const outcome = await importBackupData(result.items, conflictStrategy);
    announceChange();
    restoreDialog.close();
    await loadCoffees();
    window.alert(
      `${outcome.imported} adicionados; ${outcome.replaced} substituídos; ${outcome.skipped} mantidos.`,
    );
  } catch (error) {
    errorNode.textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = "Restaurar";
  }
});

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  state.installPrompt = event;
  document.querySelector("#installButton").hidden = false;
});

document.querySelector("#installButton").addEventListener("click", async () => {
  if (!state.installPrompt) return;
  await state.installPrompt.prompt();
  state.installPrompt = null;
  document.querySelector("#installButton").hidden = true;
});

window.addEventListener("appinstalled", () => {
  document.querySelector("#installButton").hidden = true;
});

function showAvailableUpdate(registration) {
  state.serviceWorkerRegistration = registration;
  document.querySelector("#updateBanner").hidden = false;
}

document.querySelector("#applyUpdateButton").addEventListener("click", () => {
  state.updateRequested = true;
  state.serviceWorkerRegistration?.waiting?.postMessage("SKIP_WAITING");
});

if ("serviceWorker" in navigator) {
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading || !state.updateRequested) return;
    reloading = true;
    window.location.reload();
  });
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("./service-worker.js")
      .then((registration) => {
        if (registration.waiting) showAvailableUpdate(registration);
        registration.addEventListener("updatefound", () => {
          const worker = registration.installing;
          worker?.addEventListener("statechange", () => {
            if (worker.state === "installed" && navigator.serviceWorker.controller) {
              showAvailableUpdate(registration);
            }
          });
        });
      })
      .catch(console.error);
  });
}

loadCoffees().catch((error) => {
  coffeeGrid.replaceChildren(
    element(
      "p",
      "error",
      `Não foi possível abrir o armazenamento local: ${error.message}`,
    ),
  );
});


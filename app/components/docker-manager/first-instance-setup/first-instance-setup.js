import {
  ADVANCED_INSTANCE_MODEL_SLOTS,
  PRIMARY_INSTANCE_MODEL_SLOTS,
  bindInstanceDefaultDirtyTracking,
  buildInstanceEnvText,
  defaultInstanceName,
  normalizeInstanceDefaults,
  readInstanceDefaultsFromForm
} from "../instance-defaults.js";
import { shouldShowSetupShowcase } from "../setup-showcase/setup-showcase.js";

const FIRST_INSTANCE_SETUP_CLASS = "dm-first-instance-setup";
const FIRST_INSTANCE_SETUP_PREFIX = "firstSetup";
const STEP_MODELS = "models";
const STEP_FIRST_INSTANCE = "first-instance";

const acknowledgedOps = new Set();

function asText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function createEl(tagName, className = "", text = "") {
  const el = document.createElement(tagName);
  if (className) el.className = className;
  if (text) el.textContent = text;
  return el;
}

function clearChildren(element) {
  if (!element) return;
  while (element.firstChild) element.removeChild(element.firstChild);
  while (element.children && element.children.length) element.removeChild(element.children[0]);
}

function slotFieldId(slotId, field) {
  return `${FIRST_INSTANCE_SETUP_PREFIX}${slotId}${field}`;
}

function createProviderSelect(slot, value) {
  const select = createEl("select", "dm-select");
  select.id = slotFieldId(slot.id, "Provider");
  select.setAttribute("aria-label", `${slot.label} provider`);
  for (const [optionValue, label] of slot.providerOptions || []) {
    const option = createEl("option", "", label);
    option.value = optionValue;
    if (optionValue === value) option.selected = true;
    select.appendChild(option);
  }
  select.value = value || slot.defaultProvider;
  return select;
}

function createModelRows(slots, defaults) {
  const grid = createEl("div", "dm-model-grid");
  const normalized = normalizeInstanceDefaults(defaults);
  for (const slot of slots) {
    const entry = normalized.models[slot.id] || {};
    const section = createEl("div", "dm-model-section");
    section.appendChild(createEl("div", "dm-model-label", slot.label));

    const controls = createEl("div", "dm-model-controls");
    const row = createEl("div", "dm-model-row");
    row.appendChild(createProviderSelect(slot, entry.provider || slot.defaultProvider));

    const model = createEl("input", "dm-text-input");
    model.id = slotFieldId(slot.id, "Model");
    model.type = "text";
    model.autocomplete = "off";
    model.value = entry.model || "";
    model.placeholder = slot.modelPlaceholder || "";
    model.setAttribute("aria-label", `${slot.label} model`);
    row.appendChild(model);

    controls.appendChild(row);

    const apiKey = createEl("input", "dm-text-input dm-model-api-key");
    apiKey.id = slotFieldId(slot.id, "ApiKey");
    apiKey.type = "password";
    apiKey.autocomplete = "off";
    apiKey.value = entry.apiKey || "";
    apiKey.placeholder = slot.keyPlaceholder || "";
    apiKey.setAttribute("aria-label", `${slot.label} API key`);
    controls.appendChild(apiKey);

    section.appendChild(controls);
    grid.appendChild(section);
  }
  return grid;
}

function hasLocalInstance(state = {}) {
  return Array.isArray(state?.containers) && state.containers.some((container) =>
    asText(container?.containerId) || asText(container?.containerName)
  );
}

function shouldShowFirstInstanceSetup(state = {}) {
  const progress = state?.progress || null;
  const opId = asText(progress?.opId);
  const targetTag = asText(progress?.targetTag);
  if (!opId || !targetTag) return false;
  if (acknowledgedOps.has(opId)) return false;
  if (!shouldShowSetupShowcase(progress)) return false;
  return !hasLocalInstance(state);
}

function setStep(panel, step) {
  const nextStep = step === STEP_FIRST_INSTANCE ? STEP_FIRST_INSTANCE : STEP_MODELS;
  panel.dataset.step = nextStep;

  const modelsStep = panel.querySelector(".dm-first-instance-step-models");
  const runStep = panel.querySelector(".dm-first-instance-step-run");
  if (modelsStep) modelsStep.classList.toggle("hidden", nextStep !== STEP_MODELS);
  if (runStep) runStep.classList.toggle("hidden", nextStep !== STEP_FIRST_INSTANCE);

  const title = panel.querySelector(".dm-first-instance-title");
  if (title) title.textContent = nextStep === STEP_FIRST_INSTANCE ? "Start your first Instance" : "Choose Instance defaults";

  const description = panel.querySelector(".dm-first-instance-description");
  if (description) {
    description.textContent = nextStep === STEP_FIRST_INSTANCE
      ? "Use the defaults you just chose for the first Instance, or save them for later."
      : "Choose the providers and models Agent Zero should use for new Instances.";
  }

  const back = panel.querySelector(".dm-first-instance-back");
  if (back) back.classList.toggle("hidden", nextStep !== STEP_FIRST_INSTANCE);

  const primary = panel.querySelector(".dm-first-instance-primary");
  if (primary) primary.textContent = "Continue";
}

function createRunChoice(state) {
  const progress = state?.progress || null;
  const runBlock = createEl("div", "dm-first-instance-run");

  const field = createEl("div", "dm-field dm-first-instance-name-field");
  const fieldLabel = createEl("label", "", "Instance name");
  fieldLabel.setAttribute("for", "firstSetupInstanceName");
  field.appendChild(fieldLabel);
  const nameInput = createEl("input", "dm-text-input");
  nameInput.id = "firstSetupInstanceName";
  nameInput.type = "text";
  nameInput.maxLength = 64;
  nameInput.autocomplete = "off";
  nameInput.value = defaultInstanceName(asText(progress?.targetTag) || "latest", state);
  field.appendChild(nameInput);
  field.appendChild(createEl("div", "dm-field-hint", "The name is only for the first Instance. Model defaults stay reusable."));
  runBlock.appendChild(field);

  const label = createEl("label", "dm-checkbox-line dm-first-instance-check");
  const checkbox = document.createElement("input");
  checkbox.id = "firstSetupRunInstance";
  checkbox.type = "checkbox";
  label.appendChild(checkbox);
  label.appendChild(createEl("span", "", "Start my first Instance when the download finishes"));
  runBlock.appendChild(label);

  return runBlock;
}

function createFirstInstanceSetup(state, actions, onDone) {
  const progress = state?.progress || null;
  const instanceDefaults = normalizeInstanceDefaults(state?.instanceDefaults);
  const section = createEl("section", FIRST_INSTANCE_SETUP_CLASS);
  section.setAttribute("aria-label", "Choose Instance defaults");

  const head = createEl("div", "dm-first-instance-head");
  head.appendChild(createEl("h3", "dm-first-instance-title", "Choose Instance defaults"));
  head.appendChild(createEl("p", "dm-first-instance-description", "Choose the providers and models Agent Zero should use for new Instances."));
  section.appendChild(head);

  const layout = createEl("div", "dm-first-instance-layout");

  const modelsPane = createEl("div", "dm-first-instance-step dm-first-instance-step-models");
  const primaryField = createEl("div", "dm-field dm-model-defaults");
  primaryField.appendChild(createEl("div", "dm-field-label", "Main and Utility"));
  primaryField.appendChild(createModelRows(PRIMARY_INSTANCE_MODEL_SLOTS, instanceDefaults));
  primaryField.appendChild(createEl("div", "dm-field-hint", "Using a subscription provider? Leave keys empty and connect it during Agent Zero onboarding."));
  modelsPane.appendChild(primaryField);

  const advanced = createEl("details", "dm-advanced dm-first-instance-advanced");
  const summary = createEl("summary", "", "Advanced");
  advanced.appendChild(summary);
  const advancedBody = createEl("div", "dm-advanced-body");
  const advancedField = createEl("div", "dm-field dm-model-defaults");
  advancedField.appendChild(createEl("div", "dm-field-label", "Embedding model"));
  advancedField.appendChild(createModelRows(ADVANCED_INSTANCE_MODEL_SLOTS, instanceDefaults));
  advancedBody.appendChild(advancedField);
  advanced.appendChild(advancedBody);
  modelsPane.appendChild(advanced);
  layout.appendChild(modelsPane);

  const runPane = createEl("div", "dm-first-instance-step dm-first-instance-step-run hidden");
  runPane.appendChild(createRunChoice(state));
  layout.appendChild(runPane);
  section.appendChild(layout);

  const actionRow = createEl("div", "dm-first-instance-actions");
  const back = createEl("button", "dm-text-button dm-first-instance-back hidden", "< Back to model configuration");
  back.type = "button";
  back.addEventListener("click", () => setStep(section, STEP_MODELS));
  actionRow.appendChild(back);

  const primary = createEl("button", "button confirm dm-first-instance-primary", "Continue");
  primary.type = "button";
  primary.addEventListener("click", async () => {
    const defaults = readInstanceDefaultsFromForm(section, FIRST_INSTANCE_SETUP_PREFIX);
    const envResult = buildInstanceEnvText(defaults);
    if (!envResult.ok) {
      window.toastFrontendError?.(envResult.message, "Agent Zero");
      return;
    }

    if (section.dataset.step !== STEP_FIRST_INSTANCE) {
      setStep(section, STEP_FIRST_INSTANCE);
      return;
    }

    const ok = await actions?.confirmFirstInstanceSetup?.({
      opId: asText(progress?.opId),
      targetTag: asText(progress?.targetTag),
      instanceDefaults: defaults,
      runFirstInstance: section.querySelector("#firstSetupRunInstance")?.checked === true,
      instanceName: section.querySelector("#firstSetupInstanceName")?.value || ""
    });
    if (!ok) return;
    acknowledgedOps.add(asText(progress?.opId));
    onDone?.();
  });
  actionRow.appendChild(primary);
  section.appendChild(actionRow);

  bindInstanceDefaultDirtyTracking(section, FIRST_INSTANCE_SETUP_PREFIX);
  setStep(section, STEP_MODELS);
  return section;
}

function mountFirstInstanceSetup(parent, state = {}, actions = {}, onDone = null) {
  if (!parent) return null;
  let panel = parent.querySelector(`.${FIRST_INSTANCE_SETUP_CLASS}`);
  if (!panel) {
    panel = createFirstInstanceSetup(state, actions, onDone);
    parent.appendChild(panel);
  }
  return panel;
}

function unmountFirstInstanceSetup(parent) {
  const panel = parent?.querySelector?.(`.${FIRST_INSTANCE_SETUP_CLASS}`);
  if (panel) panel.remove();
}

export {
  FIRST_INSTANCE_SETUP_CLASS,
  mountFirstInstanceSetup,
  shouldShowFirstInstanceSetup,
  unmountFirstInstanceSetup
};

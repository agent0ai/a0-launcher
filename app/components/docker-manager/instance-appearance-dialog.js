import {
  INSTANCE_COLOR_OPTIONS,
  INSTANCE_ICON_OPTIONS,
  createInstanceIcon,
  isInstanceImageIcon,
  instanceColorTone,
  normalizedInstanceColorId,
  normalizedInstanceIconId
} from "./card-visuals.js";

function closeDialog(dialog) {
  dialog?.remove();
  window.dockerManagerActions?.syncInstanceTabBounds?.();
}

function setSelected(container, selector, value, attribute) {
  container.querySelectorAll(selector).forEach((button) => {
    const selected = button.dataset[attribute] === value;
    button.classList.toggle("is-selected", selected);
    if (button.tagName === "BUTTON") button.setAttribute("aria-pressed", String(selected));
  });
}

function openInstanceAppearanceDialog({ title, currentColor, currentIcon, favicon, onSave }) {
  closeDialog(document.getElementById("instanceAppearanceDialog"));

  let color = normalizedInstanceColorId(currentColor);
  let icon = normalizedInstanceIconId(currentIcon);
  let customIcon = isInstanceImageIcon(currentIcon) ? currentIcon : "";
  const dialog = document.createElement("div");
  dialog.id = "instanceAppearanceDialog";
  dialog.className = "dm-dialog-backdrop";
  dialog.setAttribute("role", "presentation");
  dialog.innerHTML = `
    <div class="dm-dialog dm-appearance-dialog" role="dialog" aria-modal="true" aria-labelledby="instanceAppearanceTitle">
      <div class="dm-dialog-header">
        <h2 id="instanceAppearanceTitle" class="dm-dialog-title"></h2>
        <button class="button dm-dialog-close" type="button" data-close aria-label="Close">×</button>
      </div>
      <div class="dm-dialog-body dm-appearance-body">
        <section class="dm-appearance-section" aria-labelledby="instanceIconLabel">
          <div id="instanceIconLabel" class="dm-field-label">Icon</div>
          <div class="dm-icon-options"></div>
          <div class="dm-icon-upload-error" role="alert" hidden></div>
        </section>
        <section class="dm-appearance-section" aria-labelledby="instanceColourLabel">
          <div id="instanceColourLabel" class="dm-field-label">Colour</div>
          <div class="dm-color-swatches"></div>
        </section>
      </div>
      <div class="dm-dialog-footer">
        <button class="button" type="button" data-close>Cancel</button>
        <button class="button confirm" type="button" data-save>Save</button>
      </div>
    </div>`;

  dialog.querySelector("#instanceAppearanceTitle").textContent = title || "Instance Colour/Icon";
  const iconOptions = dialog.querySelector(".dm-icon-options");
  function renderIcons() {
    iconOptions.replaceChildren();
    const options = [
      { id: "custom", label: customIcon ? "Uploaded image" : "Upload image" },
      INSTANCE_ICON_OPTIONS[0],
      ...INSTANCE_ICON_OPTIONS.slice(1)
    ];
    for (const option of options) {
      const button = document.createElement("button");
      button.className = `dm-icon-option${option.id === icon ? " is-selected" : ""}`;
      button.type = "button";
      button.dataset.icon = option.id;
      button.setAttribute("aria-label", option.label);
      button.setAttribute("aria-pressed", String(option.id === icon));
      const label = document.createElement("span");
      label.textContent = option.label;
      if (option.id === "custom" && !customIcon) {
        button.dataset.upload = "";
        button.innerHTML = '<span class="material-symbols-outlined" aria-hidden="true">upload</span>';
        button.append(label);
      } else {
        button.append(createInstanceIcon({ icon: option.id === "custom" ? customIcon : option.id, favicon }), label);
        button.addEventListener("click", () => {
          icon = option.id;
          setSelected(iconOptions, ".dm-icon-option", icon, "icon");
        });
      }
      if (option.id === "custom" && customIcon) {
        const upload = document.createElement("div");
        upload.className = "dm-upload-icon";
        const replace = document.createElement("button");
        replace.type = "button";
        replace.className = "dm-icon-replace";
        replace.dataset.upload = "";
        replace.title = "Replace uploaded image";
        replace.setAttribute("aria-label", replace.title);
        replace.innerHTML = '<span class="material-symbols-outlined" aria-hidden="true">edit</span>';
        upload.append(button, replace);
        iconOptions.appendChild(upload);
      } else {
        iconOptions.appendChild(button);
      }
    }
  }
  renderIcons();

  iconOptions.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-upload]");
    if (!button) return;
    const save = dialog.querySelector("[data-save]");
    const error = dialog.querySelector(".dm-icon-upload-error");
    button.disabled = save.disabled = true;
    error.hidden = true;
    try {
      const result = await window.dockerManagerActions?.chooseInstanceIcon?.();
      if (!result || !dialog.isConnected) return;
      if (result.message) throw new Error(result.message);
      const image = new Image();
      image.src = result.dataUrl;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 96;
      const scale = Math.min(96 / image.naturalWidth, 96 / image.naturalHeight);
      const width = image.naturalWidth * scale;
      const height = image.naturalHeight * scale;
      canvas.getContext("2d").drawImage(image, (96 - width) / 2, (96 - height) / 2, width, height);
      customIcon = canvas.toDataURL("image/png");
      icon = "custom";
      renderIcons();
      iconOptions.querySelector('[data-icon="custom"]')?.focus();
    } catch (e) {
      error.textContent = e?.name === "EncodingError" ? "This image could not be opened." : e?.message || "Unable to upload image.";
      error.hidden = false;
    } finally {
      button.disabled = save.disabled = false;
    }
  });

  const colorOptions = dialog.querySelector(".dm-color-swatches");
  const customColor = document.createElement("label");
  customColor.className = `dm-color-swatch-option${color.startsWith("#") ? " is-selected" : ""}`;
  const picker = document.createElement("input");
  picker.type = "color";
  picker.className = "dm-custom-color";
  picker.setAttribute("aria-label", "Custom colour");
  picker.value = instanceColorTone(color)?.fg || "#7dd3fc";
  customColor.dataset.color = picker.value;
  const customLabel = document.createElement("span");
  customLabel.className = "dm-color-swatch-label";
  customLabel.textContent = "Custom";
  customColor.append(picker, customLabel);
  const selectCustomColor = () => {
    color = normalizedInstanceColorId(picker.value);
    customColor.dataset.color = color;
    setSelected(colorOptions, ".dm-color-swatch-option", color, "color");
  };
  picker.addEventListener("click", selectCustomColor);
  picker.addEventListener("input", selectCustomColor);
  colorOptions.appendChild(customColor);
  for (const option of INSTANCE_COLOR_OPTIONS) {
    const colorId = normalizedInstanceColorId(option.id);
    const button = document.createElement("button");
    button.className = `dm-color-swatch-option${colorId === color ? " is-selected" : ""}`;
    button.type = "button";
    button.dataset.color = colorId;
    button.setAttribute("aria-pressed", String(colorId === color));

    const swatch = document.createElement("span");
    swatch.className = `dm-color-swatch${colorId ? "" : " is-auto"}`;
    swatch.style.setProperty("--dm-swatch-fg", option.fg);
    swatch.style.setProperty("--dm-swatch-bg", option.bg);
    swatch.style.setProperty("--dm-swatch-border", option.border);

    const label = document.createElement("span");
    label.className = "dm-color-swatch-label";
    label.textContent = option.label;
    button.append(swatch, label);
    button.addEventListener("click", () => {
      color = colorId;
      setSelected(colorOptions, ".dm-color-swatch-option", color, "color");
    });
    colorOptions.appendChild(button);
  }

  const close = () => closeDialog(dialog);
  dialog.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", close));
  dialog.addEventListener("mousedown", (event) => {
    if (event.target === dialog) close();
  });
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });
  dialog.querySelector("[data-save]").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    if (await onSave?.({ color, icon: icon === "custom" ? customIcon : icon }) !== false) close();
    else button.disabled = false;
  });

  window.dockerManagerActions?.hideInstanceTabView?.();
  document.body.appendChild(dialog);
  window.setTimeout(() => dialog.querySelector(`.dm-icon-option[data-icon="${icon}"]`)?.focus(), 0);
}

export { openInstanceAppearanceDialog };

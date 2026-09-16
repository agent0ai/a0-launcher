const VERSION_TONES = [
  { fg: "#7dd3fc", bg: "rgba(14, 116, 144, 0.14)", border: "rgba(125, 211, 252, 0.24)" },
  { fg: "#86efac", bg: "rgba(22, 101, 52, 0.15)", border: "rgba(134, 239, 172, 0.22)" },
  { fg: "#f9a8d4", bg: "rgba(157, 23, 77, 0.14)", border: "rgba(249, 168, 212, 0.22)" },
  { fg: "#fcd34d", bg: "rgba(146, 64, 14, 0.14)", border: "rgba(252, 211, 77, 0.2)" },
  { fg: "#c4b5fd", bg: "rgba(91, 33, 182, 0.14)", border: "rgba(196, 181, 253, 0.22)" },
  { fg: "#67e8f9", bg: "rgba(21, 94, 117, 0.14)", border: "rgba(103, 232, 249, 0.2)" },
  { fg: "#fda4af", bg: "rgba(159, 18, 57, 0.14)", border: "rgba(253, 164, 175, 0.22)" }
];

const INSTANCE_COLOR_OPTIONS = Object.freeze([
  { id: "", label: "Automatic", fg: "#9ca3af", bg: "rgba(148, 163, 184, 0.12)", border: "rgba(148, 163, 184, 0.26)" },
  { id: "blue", label: "Blue", fg: "#7dd3fc", bg: "rgba(14, 116, 144, 0.14)", border: "rgba(125, 211, 252, 0.24)" },
  { id: "green", label: "Green", fg: "#86efac", bg: "rgba(22, 101, 52, 0.15)", border: "rgba(134, 239, 172, 0.22)" },
  { id: "rose", label: "Rose", fg: "#f9a8d4", bg: "rgba(157, 23, 77, 0.14)", border: "rgba(249, 168, 212, 0.22)" },
  { id: "amber", label: "Amber", fg: "#fcd34d", bg: "rgba(146, 64, 14, 0.14)", border: "rgba(252, 211, 77, 0.2)" },
  { id: "violet", label: "Violet", fg: "#c4b5fd", bg: "rgba(91, 33, 182, 0.14)", border: "rgba(196, 181, 253, 0.22)" },
  { id: "cyan", label: "Cyan", fg: "#67e8f9", bg: "rgba(21, 94, 117, 0.14)", border: "rgba(103, 232, 249, 0.2)" },
  { id: "coral", label: "Coral", fg: "#fda4af", bg: "rgba(159, 18, 57, 0.14)", border: "rgba(253, 164, 175, 0.22)" }
]);

const INSTANCE_ICON_OPTIONS = Object.freeze([
  { id: "", label: "Favicon" },
  { id: "language", label: "Globe" },
  { id: "smart_toy", label: "Agent" },
  { id: "psychology", label: "Mind" },
  { id: "terminal", label: "Terminal" },
  { id: "rocket_launch", label: "Rocket" },
  { id: "hub", label: "Network" },
  { id: "science", label: "Lab" },
  { id: "code", label: "Code" },
  { id: "memory", label: "Memory" },
  { id: "explore", label: "Compass" },
  { id: "bolt", label: "Energy" },
  { id: "shield", label: "Shield" },
  { id: "auto_awesome", label: "Spark" },
  { id: "favorite", label: "Heart" }
]);

const INSTANCE_ICON_IDS = new Set(INSTANCE_ICON_OPTIONS.filter((item) => item.id).map((item) => item.id));

const INSTANCE_COLOR_TONES = new Map(
  INSTANCE_COLOR_OPTIONS
    .filter((item) => item.id)
    .map((item) => [item.id, { fg: item.fg, bg: item.bg, border: item.border }])
);

function hashText(value) {
  const text = String(value || "");
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function normalizedInstanceColorId(value) {
  const id = String(value || "").trim().toLowerCase();
  return INSTANCE_COLOR_TONES.has(id) || /^#[0-9a-f]{6}$/.test(id) ? id : "";
}

function isInstanceImageIcon(value) {
  return typeof value === "string" && value.length <= 96 * 1024
    && /^data:image\/(?:png|jpeg|gif|webp|svg\+xml|x-icon|vnd.microsoft.icon);base64,[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function normalizedInstanceIconId(value) {
  if (isInstanceImageIcon(value)) return "custom";
  const id = String(value || "").trim().toLowerCase();
  return INSTANCE_ICON_IDS.has(id) ? id : "";
}

function instanceIconName(value) {
  const id = normalizedInstanceIconId(value);
  return INSTANCE_ICON_OPTIONS.find((item) => item.id === id)?.icon || id || "language";
}

function createInstanceIcon({ icon, favicon, loading } = {}) {
  const id = normalizedInstanceIconId(icon);
  if (loading || (id && id !== "custom")) {
    const symbol = document.createElement("span");
    symbol.className = "material-symbols-outlined";
    symbol.setAttribute("aria-hidden", "true");
    symbol.textContent = loading ? "progress_activity" : instanceIconName(id);
    return symbol;
  }
  const image = document.createElement("img");
  const fallback = new URL("../../assets/darkSymbol.svg", import.meta.url).href;
  image.className = "dm-instance-favicon";
  image.alt = "";
  image.src = id === "custom" ? icon : favicon || fallback;
  image.addEventListener("error", () => { image.src = fallback; }, { once: true });
  return image;
}

function instanceColorTone(value) {
  const id = normalizedInstanceColorId(value);
  if (id.startsWith("#")) return { fg: id, bg: `${id}24`, border: `${id}3d` };
  return INSTANCE_COLOR_TONES.get(id) || null;
}

function toneForSeed(seed, color = "") {
  const selected = instanceColorTone(color);
  if (selected) return selected;
  return VERSION_TONES[hashText(seed) % VERSION_TONES.length];
}

function versionVisualLabel(value, fallback = "Version") {
  const raw = String(value || "").trim();
  if (!raw) return fallback;
  const tag = raw.includes(":") ? raw.slice(raw.lastIndexOf(":") + 1) : raw;
  return tag.replace(/^v(?=\d)/i, "") || fallback;
}

function createVersionVisual(value, options = {}) {
  const seed = String(options.seed || value || options.fallback || "version");
  const label = versionVisualLabel(value, options.fallback || "Version");
  const tone = toneForSeed(seed);
  const visual = document.createElement("div");
  const lengthClass = label.length > 14 ? " is-compact" : label.length > 8 ? " is-long" : "";
  visual.className = `dm-card-visual dm-card-version-visual${lengthClass}`;
  visual.style.setProperty("--dm-version-fg", tone.fg);
  visual.style.setProperty("--dm-version-bg", tone.bg);
  visual.style.setProperty("--dm-version-border", tone.border);
  visual.setAttribute("aria-hidden", "true");

  const text = document.createElement("span");
  text.className = "dm-card-version-text";
  text.textContent = label;
  visual.appendChild(text);
  return visual;
}

function createInstanceVisual(value, options = {}) {
  const label = String(value || "").trim() || "Instance";
  const badge = versionVisualLabel(options.badge || options.version || "", "");
  const seed = String(options.seed || value || badge || "instance");
  const tone = toneForSeed(seed, options.color || "");
  const lengthClass = label.length > 14 ? " is-compact" : label.length > 10 ? " is-long" : "";
  const visual = document.createElement("div");
  visual.className = `dm-card-visual dm-card-instance-visual${lengthClass}`;
  visual.style.setProperty("--dm-version-fg", tone.fg);
  visual.style.setProperty("--dm-version-bg", tone.bg);
  visual.style.setProperty("--dm-version-border", tone.border);
  visual.setAttribute("aria-label", badge ? `${label}, version ${badge}` : label);

  const text = document.createElement("span");
  text.className = "dm-card-instance-name";
  text.textContent = label;
  visual.appendChild(text);

  if (badge) {
    const chip = document.createElement("span");
    chip.className = "dm-card-instance-version";
    chip.textContent = badge;
    visual.appendChild(chip);
  }

  return visual;
}

export {
  INSTANCE_COLOR_OPTIONS,
  INSTANCE_ICON_OPTIONS,
  createInstanceVisual,
  createVersionVisual,
  instanceColorTone,
  instanceIconName,
  createInstanceIcon,
  isInstanceImageIcon,
  normalizedInstanceColorId,
  normalizedInstanceIconId,
  versionVisualLabel
};

const SHOWCASE_ASSET_BASE = "assets/setup-showcase";

const SETUP_SHOWCASE_SLIDES = Object.freeze([
  Object.freeze({
    id: "ui-first",
    title: "Manage Everything Through UI",
    description: "Configure models, plugins, and runtime behavior from Agent Zero's interface instead of editing JSON or YAML by hand.",
    mediaType: "image",
    media: `${SHOWCASE_ASSET_BASE}/everything-is-ui.png`,
    mediaLabel: "Agent Zero model settings configured through the UI."
  }),
  Object.freeze({
    id: "plugin-hub",
    title: "Plugin Hub",
    description: "Browse 100+ community plugins, then scan them for security risks before they become part of your workspace.",
    mediaType: "image",
    media: `${SHOWCASE_ASSET_BASE}/plugin-hub-view.png`,
    mediaLabel: "Agent Zero Plugin Hub with community plugins and categories."
  }),
  Object.freeze({
    id: "dox",
    title: "DOX Keeps Project Context Close",
    description: "Initialize AGENTS.md guidance so agents follow local rules, edit precisely, and keep the documentation current as the project changes.",
    mediaType: "image",
    media: `${SHOWCASE_ASSET_BASE}/dox.png`,
    mediaLabel: "DOX self-documenting AGENTS.md project context artwork."
  }),
  Object.freeze({
    id: "create-plugin",
    title: "Create Your Own Plugin",
    description: "Use the built-in a0-create-plugin skill to scaffold Agent Zero plugins with the right files, hooks, and conventions.",
    mediaType: "image",
    media: `${SHOWCASE_ASSET_BASE}/a0-create-plugin-skill.png`,
    mediaLabel: "Agent Zero skill list showing the a0-create-plugin skill."
  }),
  Object.freeze({
    id: "time-travel",
    title: "Time Travel",
    description: "Experiment freely with Git-backed rollback handled by Agent Zero. Inspect a snapshot, travel back, and keep working.",
    mediaType: "image",
    media: `${SHOWCASE_ASSET_BASE}/timetravel.png`,
    mediaLabel: "Agent Zero Time Travel interface with snapshots and diffs."
  }),
  Object.freeze({
    id: "space-agent",
    title: "Space Agent",
    description: "Let the AI reshape the workspace, build tools into the running interface, and extend itself through simple SKILL.md files.",
    mediaType: "video",
    media: `${SHOWCASE_ASSET_BASE}/space-agent-demo.webm`,
    mediaLabel: "Space Agent workspace with AI-built tools running inside the interface."
  }),
  Object.freeze({
    id: "a0-cli",
    title: "A0 CLI: Your Browser and Computer",
    description: "Connect host files, Host Web Browser, and Computer Use beyond the Agent Zero sandbox when A0 CLI is installed.",
    mediaType: "video",
    media: `${SHOWCASE_ASSET_BASE}/computer-use.webm`,
    mediaLabel: "A0 CLI connected to Host Web Browser and Computer Use on the user's desktop."
  })
]);

let activeShowcaseIndex = 0;

function asText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function clearChildren(element) {
  if (!element) return;
  while (element.firstChild) element.removeChild(element.firstChild);
  while (element.children && element.children.length) element.removeChild(element.children[0]);
}

function normalizeIndex(index) {
  const count = SETUP_SHOWCASE_SLIDES.length;
  if (!count) return 0;
  const n = Number(index);
  if (!Number.isFinite(n)) return 0;
  return ((Math.trunc(n) % count) + count) % count;
}

function currentIndex(showcase = null) {
  const stored = Number(showcase?.dataset?.showcaseIndex);
  return normalizeIndex(Number.isFinite(stored) ? stored : activeShowcaseIndex);
}

function currentSlide(showcase = null) {
  return SETUP_SHOWCASE_SLIDES[currentIndex(showcase)] || SETUP_SHOWCASE_SLIDES[0];
}

function createMedia(slide) {
  const media = document.createElement(slide.mediaType === "video" ? "video" : "img");
  media.className = "dm-setup-showcase-media";
  media.setAttribute("aria-label", slide.mediaLabel);

  if (slide.mediaType === "video") {
    media.src = slide.media;
    media.autoplay = true;
    media.loop = true;
    media.muted = true;
    media.playsInline = true;
    media.setAttribute("muted", "");
    media.setAttribute("playsinline", "");
    media.setAttribute("preload", "metadata");
  } else {
    media.src = slide.media;
    media.alt = slide.mediaLabel;
    media.loading = "lazy";
  }

  return media;
}

function updateShowcase(showcase) {
  if (!showcase) return;
  const index = currentIndex(showcase);
  const slide = currentSlide(showcase);
  showcase.dataset.showcaseIndex = String(index);
  activeShowcaseIndex = index;

  const mediaFrame = showcase.querySelector(".dm-setup-showcase-media-frame");
  if (mediaFrame) {
    clearChildren(mediaFrame);
    mediaFrame.appendChild(createMedia(slide));
  }

  const title = showcase.querySelector(".dm-setup-showcase-title");
  if (title) title.textContent = slide.title;

  const description = showcase.querySelector(".dm-setup-showcase-description");
  if (description) description.textContent = slide.description;

  const dots = showcase.querySelector(".dm-setup-showcase-dots");
  if (dots) {
    clearChildren(dots);
    SETUP_SHOWCASE_SLIDES.forEach((item, itemIndex) => {
      const dot = document.createElement("button");
      dot.type = "button";
      dot.className = `dm-setup-showcase-dot${itemIndex === index ? " active" : ""}`;
      dot.setAttribute("aria-label", `Show ${item.title}`);
      dot.setAttribute("aria-current", itemIndex === index ? "true" : "false");
      dot.addEventListener("click", () => setShowcaseIndex(showcase, itemIndex));
      dots.appendChild(dot);
    });
  }
}

function setShowcaseIndex(showcase, index) {
  if (!showcase) return;
  activeShowcaseIndex = normalizeIndex(index);
  showcase.dataset.showcaseIndex = String(activeShowcaseIndex);
  updateShowcase(showcase);
}

function moveShowcase(showcase, delta) {
  setShowcaseIndex(showcase, currentIndex(showcase) + delta);
}

function createSetupShowcase() {
  const showcase = document.createElement("section");
  showcase.className = "dm-setup-showcase";
  showcase.dataset.showcaseIndex = String(activeShowcaseIndex);
  showcase.setAttribute("aria-label", "Agent Zero capabilities while the image downloads");

  const mediaFrame = document.createElement("div");
  mediaFrame.className = "dm-setup-showcase-media-frame";
  showcase.appendChild(mediaFrame);

  const copy = document.createElement("div");
  copy.className = "dm-setup-showcase-copy";

  const title = document.createElement("h3");
  title.className = "dm-setup-showcase-title";
  copy.appendChild(title);

  const description = document.createElement("p");
  description.className = "dm-setup-showcase-description";
  copy.appendChild(description);

  const controls = document.createElement("div");
  controls.className = "dm-setup-showcase-controls";

  const previous = document.createElement("button");
  previous.type = "button";
  previous.className = "button dm-icon-button dm-setup-showcase-arrow";
  previous.setAttribute("aria-label", "Previous Agent Zero capability");
  previous.addEventListener("click", () => moveShowcase(showcase, -1));
  const previousIcon = document.createElement("span");
  previousIcon.className = "material-symbols-outlined";
  previousIcon.setAttribute("aria-hidden", "true");
  previousIcon.textContent = "chevron_left";
  previous.appendChild(previousIcon);
  controls.appendChild(previous);

  const dots = document.createElement("div");
  dots.className = "dm-setup-showcase-dots";
  dots.setAttribute("role", "tablist");
  dots.setAttribute("aria-label", "Agent Zero capability slides");
  controls.appendChild(dots);

  const next = document.createElement("button");
  next.type = "button";
  next.className = "button dm-icon-button dm-setup-showcase-arrow";
  next.setAttribute("aria-label", "Next Agent Zero capability");
  next.addEventListener("click", () => moveShowcase(showcase, 1));
  const nextIcon = document.createElement("span");
  nextIcon.className = "material-symbols-outlined";
  nextIcon.setAttribute("aria-hidden", "true");
  nextIcon.textContent = "chevron_right";
  next.appendChild(nextIcon);
  controls.appendChild(next);

  copy.appendChild(controls);
  showcase.appendChild(copy);
  updateShowcase(showcase);
  return showcase;
}

function mountSetupShowcase(parent) {
  if (!parent) return null;
  let showcase = parent.querySelector(".dm-setup-showcase");
  if (!showcase) {
    showcase = createSetupShowcase();
    parent.appendChild(showcase);
  } else {
    updateShowcase(showcase);
  }
  return showcase;
}

function unmountSetupShowcase(parent) {
  const showcase = parent?.querySelector?.(".dm-setup-showcase");
  if (showcase) showcase.remove();
}

function shouldShowSetupShowcase(progress = null) {
  if (!progress || asText(progress.type) !== "install" || asText(progress.status) !== "running") return false;
  if (progress.canCancel === true) return true;
  const hasDownloadProgress = progress.downloadProgress !== null && progress.downloadProgress !== undefined && progress.downloadProgress !== "";
  const hasExtractProgress = progress.extractProgress !== null && progress.extractProgress !== undefined && progress.extractProgress !== "";
  if ((hasDownloadProgress && Number.isFinite(Number(progress.downloadProgress))) ||
      (hasExtractProgress && Number.isFinite(Number(progress.extractProgress)))) {
    return true;
  }
  return /download|extract/i.test(asText(progress.message) || asText(progress.phase));
}

export {
  SETUP_SHOWCASE_SLIDES,
  mountSetupShowcase,
  shouldShowSetupShowcase,
  unmountSetupShowcase
};

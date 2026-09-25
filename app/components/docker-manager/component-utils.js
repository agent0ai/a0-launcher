function byId(id) { return document.getElementById(id); }

function asText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function compactText(value, fallback = "") {
  const text = String(value || "").trim();
  return text || fallback;
}

function clearChildren(element) {
  if (!element) return;
  while (element.firstChild) element.removeChild(element.firstChild);
  while (element.children && element.children.length) element.removeChild(element.children[0]);
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function makeButton(label, className, disabled = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  button.disabled = !!disabled;
  return button;
}

function focusableWithin(root) {
  return Array.from(root.querySelectorAll("button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex='-1'])"))
    .filter((el) => !el.hidden);
}

function setPageBlocked(blocked) {
  const page = document.querySelector(".dm-page");
  if (!page) return;
  if ("inert" in page) page.inert = !!blocked;
  if (blocked) page.setAttribute("aria-hidden", "true");
  else page.removeAttribute("aria-hidden");
}

function closeDialog(dialog) {
  if (dialog && dialog.parentNode) dialog.parentNode.removeChild(dialog);
}

export {
  byId,
  asText,
  compactText,
  clearChildren,
  escapeHtml,
  makeButton,
  focusableWithin,
  setPageBlocked,
  closeDialog
};

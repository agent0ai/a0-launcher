function asText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function percentValue(progress) {
  if (progress === null || progress === undefined || progress === "") return null;
  const value = Number(progress);
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, value));
}

function timestampMs(value) {
  const text = asText(value);
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function estimatedProgressFromSteps(steps = []) {
  if (!Array.isArray(steps) || steps.length < 2) return null;
  let doneCount = 0;
  let activeIndex = -1;

  steps.forEach((step, index) => {
    const status = asText(step?.status);
    if (status === "done") doneCount += 1;
    if (activeIndex === -1 && ["running", "current"].includes(status)) activeIndex = index;
  });

  if (doneCount >= steps.length) return 100;
  if (activeIndex === -1) return null;
  return ((doneCount + 0.5) / steps.length) * 100;
}

function estimateEtaText({
  startedAt = "",
  status = "",
  progress = null,
  fallbackProgress = null,
  nowMs = Date.now(),
  minElapsedMs = 15_000
} = {}) {
  if (asText(status) !== "running") return "";
  const startedMs = timestampMs(startedAt);
  if (startedMs === null) return "";

  const elapsedMs = Math.max(0, Number(nowMs) - startedMs);
  if (!Number.isFinite(elapsedMs) || elapsedMs < minElapsedMs) return "";

  const primary = percentValue(progress);
  const fallback = percentValue(fallbackProgress);
  const effectiveProgress = primary !== null && primary > 0 ? primary : fallback;
  if (effectiveProgress === null || effectiveProgress <= 2 || effectiveProgress >= 99.5) return "";

  const remainingMs = (elapsedMs / effectiveProgress) * (100 - effectiveProgress);
  if (!Number.isFinite(remainingMs) || remainingMs <= 0 || remainingMs > 24 * 60 * 60 * 1000) return "";
  if (remainingMs < 60_000) return "<1 min remaining";

  const minutes = Math.max(1, Math.ceil(remainingMs / 60_000));
  return `~${minutes} min remaining`;
}

function progressMetaText({
  progress = null,
  indeterminate = false,
  startedAt = "",
  status = "",
  fallbackProgress = null,
  nowMs = Date.now()
} = {}) {
  const numericProgress = percentValue(progress);
  const percentText = !indeterminate && numericProgress !== null ? `${Math.round(numericProgress)}%` : "";
  const etaText = estimateEtaText({ startedAt, status, progress: numericProgress, fallbackProgress, nowMs });
  return [percentText, etaText].filter(Boolean).join(" · ");
}

export {
  estimateEtaText,
  estimatedProgressFromSteps,
  progressMetaText
};

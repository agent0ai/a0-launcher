import { openAddRemoteInstanceDialog } from "../remote-instance-dialog.js";
import { openCloneInstanceDialog } from "../clone-instance-dialog.js";
import {
  activeTopologyNodeIdsFromTabs,
  activityEventsFromLogs,
  allNodesHavePositions,
  edgeStatusLabel,
  findTopologyEdge,
  findTopologyNode,
  graphElementsFromState,
  installedRunnableVersions,
  topologyStructureKey,
  topologyState
} from "./topology-model.js";

const root = document.getElementById("dmTopology");
const graphEl = document.getElementById("dmTopologyGraph");
const bubblesEl = document.getElementById("dmTopologyBubbles");
const activityEl = document.getElementById("dmTopologyActivity");
const emptyEl = document.getElementById("dmTopologyEmpty");
const inspectorEl = document.getElementById("dmTopologyInspector");
const statusEl = document.getElementById("dmTopologyStatus");
const newNodeBtn = document.getElementById("dmTopologyNewNode");
const linkBtn = document.getElementById("dmTopologyLink");
const fitBtn = document.getElementById("dmTopologyFit");
const refreshBtn = document.getElementById("dmTopologyRefresh");
const ACTIVITY_REFRESH_MS = 2500;

let cy = null;
let currentState = window.__dmLastState || {};
let selectedNodeId = "";
let selectedEdgeId = "";
let linkSourceId = "";
let saveTimer = 0;
let hasRunInitialLayout = false;
let renderedStructureKey = "";
let bubbleSeq = 0;
let activeBubbles = [];
let activityNodeId = "";
let activityCloseTimer = 0;
let activityRefreshTimer = 0;
let activityRequestSeq = 0;
let activitySnapshot = null;
let activityExpanded = false;
let selectedActivityEventKey = "";
const edgeProbeResults = new Map();
const probeInFlightEdgeIds = new Set();
const edgeA2aSetupResults = new Map();
const a2aSetupInFlightEdgeIds = new Set();
const messageDrafts = new Map();
const topologyMessageResults = new Map();
const messageInFlightKeys = new Set();
const positionOverrides = new Map();
const activityCache = new Map();

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function tabIsActive() {
  return root?.closest(".dm-tab-content")?.classList.contains("active") === true;
}

function actions() {
  return window.dockerManagerActions || {};
}

function topology() {
  return topologyState(currentState);
}

function visibleText(value, fallback = "") {
  return String(value || fallback || "").trim();
}

function endpointLabel(node = {}, fallback = "Instance") {
  return visibleText(node.label, fallback);
}

function currentNodePositions() {
  if (!cy) return [];
  return cy.nodes().map((node) => ({
    id: node.id(),
    position: {
      x: Math.round(node.position("x")),
      y: Math.round(node.position("y"))
    }
  }));
}

function rememberNodePositions(nodes = []) {
  for (const node of Array.isArray(nodes) ? nodes : []) {
    const id = typeof node?.id === "string" ? node.id : "";
    const x = Number(node?.position?.x);
    const y = Number(node?.position?.y);
    if (!id || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    positionOverrides.set(id, { x, y });
  }
}

function graphElementsWithPositionOverrides() {
  return graphElementsFromState(currentState).map((element) => {
    if (element?.group !== "nodes") return element;
    const override = positionOverrides.get(element.data?.id || "");
    return override ? { ...element, position: { ...override } } : element;
  });
}

function closeDialog(dialog) {
  if (dialog?.parentNode) dialog.parentNode.removeChild(dialog);
}

async function copyText(value, label = "Copied") {
  const text = String(value || "").trim();
  if (!text) return;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.left = "-1000px";
      textarea.style.top = "-1000px";
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    }
    window.toastFrontendSuccess?.(`${label} copied.`, "Agent Zero", 2, "dm-topology-copy");
  } catch {
    window.toastFrontendError?.("Unable to copy.", "Agent Zero");
  }
}

function persistentCommunicationBubbles() {
  return activeTopologyNodeIdsFromTabs(currentState).map((item) => ({
    nodeId: item.nodeId,
    text: item.loading
      ? (item.active ? "User loading UI" : "UI loading")
      : (item.active ? "User viewing" : "UI open"),
    tone: "user"
  }));
}

function updateBubblePositions() {
  if (!cy || !bubblesEl) return;
  const now = Date.now();
  activeBubbles = activeBubbles.filter((bubble) => bubble.expiresAt > now);
  const bubbleNodes = [];
  const allBubbles = [...persistentCommunicationBubbles(), ...activeBubbles];
  const nodeBubbleCounts = new Map();

  for (const bubble of allBubbles) {
    const node = cy.getElementById(bubble.nodeId);
    if (!node || !node.length) continue;
    const nodeCount = nodeBubbleCounts.get(bubble.nodeId) || 0;
    nodeBubbleCounts.set(bubble.nodeId, nodeCount + 1);
    const position = node.renderedPosition();
    const element = document.createElement("div");
    element.className = `dm-topology-bubble dm-topology-bubble-${bubble.tone || "info"}`;
    element.style.left = `${Math.round(position.x)}px`;
    element.style.top = `${Math.round(position.y - 48 - nodeCount * 42)}px`;
    element.textContent = bubble.text;
    bubbleNodes.push(element);
  }

  bubblesEl.replaceChildren(...bubbleNodes);
  bubblesEl.classList.toggle("hidden", !bubbleNodes.length);
}

function showNodeBubble(nodeId, text, tone = "info", durationMs = 4200) {
  const id = typeof nodeId === "string" ? nodeId : "";
  const label = String(text || "").trim();
  if (!id || !label) return;

  const now = Date.now();
  activeBubbles = activeBubbles
    .filter((bubble) => bubble.expiresAt > now && !(bubble.nodeId === id && bubble.text === label))
    .slice(-7);
  activeBubbles.push({
    id: `bubble_${++bubbleSeq}`,
    nodeId: id,
    text: label.slice(0, 90),
    tone,
    expiresAt: now + durationMs
  });
  updateBubblePositions();
  window.setTimeout(updateBubblePositions, durationMs + 40);
}

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function activityIcon(kind = "") {
  const icons = {
    a2a: "hub",
    code: "terminal",
    done: "check_circle",
    error: "error",
    log: "notes",
    message: "forum",
    response: "quickreply",
    shell: "terminal",
    tool: "construction"
  };
  return icons[kind] || "notes";
}

function activityStatusText(snapshot = {}) {
  if (snapshot.loading) return "Reading runtime logs";
  if (snapshot.error) return snapshot.error;
  if (snapshot.status) return snapshot.status;
  const fetched = snapshot.fetchedAt ? "Live activity" : "Recent activity";
  return snapshot.aborted ? `${fetched} - truncated` : fetched;
}

function activityEventKey(event = {}, index = 0) {
  return [
    index,
    event.kind || "",
    event.title || "",
    event.detail || "",
    event.time || ""
  ].join(":");
}

function renderActivityEvent(event = {}, index = 0) {
  const key = activityEventKey(event, index);
  const selected = selectedActivityEventKey === key;
  const full = event.full && event.full !== event.detail ? event.full : "";
  return `
    <button class="dm-topology-activity-event is-${escapeHtml(event.kind || "log")}${selected ? " is-selected" : ""}" type="button" data-activity-event-key="${escapeHtml(key)}" aria-expanded="${selected ? "true" : "false"}">
      <span class="material-symbols-outlined" aria-hidden="true">${activityIcon(event.kind)}</span>
      <div>
        <span class="dm-topology-activity-event-topline">
          <strong>${escapeHtml(event.title || "Runtime event")}</strong>
          ${event.time ? `<em>${escapeHtml(event.time)}</em>` : ""}
        </span>
        ${event.detail ? `<span class="dm-topology-activity-detail">${escapeHtml(event.detail)}</span>` : ""}
        ${selected && full ? `<span class="dm-topology-activity-full">${escapeHtml(full)}</span>` : ""}
      </div>
    </button>
  `;
}

function activityEmptyText(node = {}) {
  if (node.kind === "remote") return "Remote activity is not available in local Docker logs.";
  if (node.available === false) return "Instance unavailable.";
  return "No recent activity in the latest logs.";
}

function renderActivityLoading() {
  return `
    <div class="dm-topology-activity-event is-loading">
      <span class="material-symbols-outlined dm-icon-spin" aria-hidden="true">progress_activity</span>
      <div>
        <strong>Checking runtime</strong>
        <span>Reading the latest bounded log snapshot.</span>
      </div>
    </div>
  `;
}

function renderActivityEmpty(node = {}, snapshot = {}) {
  const icon = snapshot.error ? "error" : "schedule";
  return `
    <div class="dm-topology-activity-empty">
      <span class="material-symbols-outlined" aria-hidden="true">${icon}</span>
      <span>${escapeHtml(activityEmptyText(node))}</span>
    </div>
  `;
}

function renderActivityList(node = {}, snapshot = {}, events = []) {
  if (snapshot.loading && !events.length) return renderActivityLoading();

  const visibleLimit = activityExpanded ? 14 : 6;
  const visibleEvents = events.slice(0, visibleLimit);
  if (!visibleEvents.length) return renderActivityEmpty(node, snapshot);

  const hiddenCount = Math.max(0, events.length - visibleEvents.length);
  const moreHtml = hiddenCount
    ? `<div class="dm-topology-activity-more">${hiddenCount} more recent events</div>`
    : "";
  return `${visibleEvents.map(renderActivityEvent).join("")}${moreHtml}`;
}

function renderActivityPreview() {
  if (!activityEl || !activityNodeId) return;
  const node = findTopologyNode(currentState, activityNodeId);
  if (!node) {
    hideActivityPreview();
    return;
  }

  const snapshot = activitySnapshot || activityCache.get(activityNodeId) || { loading: true, events: [] };
  const events = Array.isArray(snapshot.events) ? snapshot.events : [];
  const status = activityStatusText(snapshot);
  const listHtml = renderActivityList(node, snapshot, events);

  activityEl.innerHTML = `
    <div class="dm-topology-activity-header">
      <span class="material-symbols-outlined" aria-hidden="true">${node.kind === "remote" ? "public" : "monitoring"}</span>
      <div>
        <strong>${escapeHtml(node.label || "Instance")}</strong>
        <span>${escapeHtml(status)}</span>
      </div>
      <div class="dm-topology-activity-header-actions">
        <button class="button icon-only" type="button" data-activity-refresh title="Refresh activity" aria-label="Refresh activity">
          <span class="material-symbols-outlined${snapshot.loading ? " dm-icon-spin" : ""}" aria-hidden="true">${snapshot.loading ? "progress_activity" : "refresh"}</span>
        </button>
        <button class="button" type="button" data-activity-expand aria-pressed="${activityExpanded ? "true" : "false"}">
          <span class="material-symbols-outlined" aria-hidden="true">${activityExpanded ? "unfold_less" : "unfold_more"}</span>
          <span>${activityExpanded ? "Compact" : "Expand"}</span>
        </button>
        <button class="button icon-only" type="button" data-activity-close title="Close activity" aria-label="Close activity">
          <span class="material-symbols-outlined" aria-hidden="true">close</span>
        </button>
      </div>
    </div>
    <div class="dm-topology-activity-list">${listHtml}</div>
  `;
  activityEl.classList.toggle("is-expanded", activityExpanded);
  activityEl.classList.remove("hidden");
  updateActivityPreviewPosition();
  window.requestAnimationFrame(updateActivityPreviewPosition);
}

function updateActivityPreviewPosition() {
  if (!cy || !activityEl || !activityNodeId || activityEl.classList.contains("hidden")) return;
  const graphShell = graphEl?.parentElement;
  const node = cy.getElementById(activityNodeId);
  if (!graphShell || !node || !node.length) return;

  const rect = graphShell.getBoundingClientRect();
  const position = node.renderedPosition();
  const preferredWidth = activityExpanded ? 470 : 330;
  const width = Math.round(Math.min(preferredWidth, Math.max(248, rect.width - 24)));
  const height = activityEl.offsetHeight || 210;
  const x = clampNumber(Math.round(position.x - width / 2), 12, Math.max(12, rect.width - width - 12));
  let y = Math.round(position.y - height - 62);
  let below = false;
  if (y < 12) {
    y = Math.round(position.y + 58);
    below = true;
  }
  if (y + height > rect.height - 12) {
    y = Math.max(12, Math.round(rect.height - height - 12));
  }

  activityEl.style.width = `${width}px`;
  activityEl.style.left = `${x}px`;
  activityEl.style.top = `${y}px`;
  activityEl.classList.toggle("is-below", below);
}

function stopActivityRefresh() {
  window.clearInterval(activityRefreshTimer);
  activityRefreshTimer = 0;
}

function hideActivityPreview() {
  activityNodeId = "";
  activitySnapshot = null;
  selectedActivityEventKey = "";
  activityRequestSeq += 1;
  window.clearTimeout(activityCloseTimer);
  stopActivityRefresh();
  activityEl?.classList.add("hidden");
}

function hideActivityPreviewSoon(nodeId = "") {
  if (nodeId && nodeId !== activityNodeId) return;
  if (nodeId && selectedNodeId === nodeId) return;
  window.clearTimeout(activityCloseTimer);
  activityCloseTimer = window.setTimeout(() => hideActivityPreview(), 180);
}

async function refreshActivityPreview(nodeId = activityNodeId) {
  if (!nodeId || nodeId !== activityNodeId) return;
  const node = findTopologyNode(currentState, nodeId);
  if (!node) {
    hideActivityPreview();
    return;
  }

  if (node.kind !== "local" || !node.containerId || node.available === false) {
    activitySnapshot = {
      nodeId,
      loading: false,
      status: node.kind === "remote" ? "Remote Instance" : "Not available",
      events: []
    };
    activityCache.set(nodeId, activitySnapshot);
    renderActivityPreview();
    return;
  }

  const requestSeq = ++activityRequestSeq;
  const cached = activityCache.get(nodeId);
  if (!cached) {
    activitySnapshot = { nodeId, loading: true, status: "Reading runtime logs", events: [] };
    renderActivityPreview();
  }

  try {
    const logs = await actions().getLocalInstanceLogs?.(node.containerId, { maxLines: 360 });
    if (requestSeq !== activityRequestSeq || nodeId !== activityNodeId) return;
    activitySnapshot = {
      nodeId,
      loading: false,
      fetchedAt: logs?.fetchedAt || "",
      aborted: !!logs?.aborted,
      events: activityEventsFromLogs(logs, 18)
    };
    activityCache.set(nodeId, activitySnapshot);
  } catch (error) {
    if (requestSeq !== activityRequestSeq || nodeId !== activityNodeId) return;
    activitySnapshot = {
      nodeId,
      loading: false,
      error: error?.message || "Unable to read runtime logs",
      events: []
    };
    activityCache.set(nodeId, activitySnapshot);
  }
  renderActivityPreview();
}

function showActivityPreview(nodeId = "") {
  if (!nodeId) return;
  window.clearTimeout(activityCloseTimer);
  if (activityNodeId === nodeId && !activityEl?.classList.contains("hidden")) {
    updateActivityPreviewPosition();
    if (!activityRefreshTimer) {
      refreshActivityPreview(nodeId);
      activityRefreshTimer = window.setInterval(() => refreshActivityPreview(nodeId), ACTIVITY_REFRESH_MS);
    }
    return;
  }
  const changed = activityNodeId !== nodeId;
  if (changed) selectedActivityEventKey = "";
  activityNodeId = nodeId;
  activitySnapshot = activityCache.get(nodeId) || { nodeId, loading: true, events: [] };
  renderActivityPreview();
  if (changed || !activityRefreshTimer) {
    stopActivityRefresh();
    refreshActivityPreview(nodeId);
    activityRefreshTimer = window.setInterval(() => refreshActivityPreview(nodeId), ACTIVITY_REFRESH_MS);
  }
}

function edgeEndpointNodes(edge = {}) {
  return {
    source: findTopologyNode(currentState, edge.source),
    target: findTopologyNode(currentState, edge.target)
  };
}

function showEdgeBubbles(edge = {}, sourceText = "A2A ready", targetText = "A2A ready", tone = "link") {
  if (!edge?.source || !edge?.target) return;
  showNodeBubble(edge.source, sourceText, tone);
  showNodeBubble(edge.target, targetText, tone);
}

function renderStatus() {
  const t = topology();
  const localCount = t.nodes.filter((node) => node.kind === "local" && node.available !== false).length;
  const remoteCount = t.nodes.filter((node) => node.kind === "remote" && node.available !== false).length;
  const connectedCount = t.edges.filter((edge) => edge.status === "connected").length;
  const pending = linkSourceId ? " - linking" : "";
  statusEl.textContent = `${localCount} local / ${remoteCount} remote / ${connectedCount} connected${pending}`;
}

function cytoscapeStyle() {
  return [
    {
      selector: "node",
      style: {
        "background-color": "data(bg)",
        "border-color": "data(border)",
        "border-width": 2,
        "color": "data(fg)",
        "font-family": "Rubik, Arial, Helvetica, sans-serif",
        "font-size": 12,
        "font-weight": 600,
        "height": 74,
        "label": "data(label)",
        "shape": "round-rectangle",
        "text-halign": "center",
        "text-margin-y": -3,
        "text-max-width": 118,
        "text-valign": "center",
        "text-wrap": "wrap",
        "width": 132
      }
    },
    {
      selector: "node:selected",
      style: {
        "border-color": "#ffffff",
        "border-width": 3
      }
    },
    {
      selector: ".remote-node",
      style: {
        "shape": "round-diamond"
      }
    },
    {
      selector: ".missing-node",
      style: {
        "background-color": "#1f242b",
        "border-style": "dashed",
        "color": "#9ca3af",
        "opacity": 0.72
      }
    },
    {
      selector: "edge",
      style: {
        "curve-style": "bezier",
        "color": "#cbd5e1",
        "font-family": "Rubik, Arial, Helvetica, sans-serif",
        "font-size": 10,
        "label": "data(label)",
        "line-color": "#5d6b78",
        "target-arrow-color": "#5d6b78",
        "target-arrow-shape": "triangle",
        "text-background-color": "#11151a",
        "text-background-opacity": 0.92,
        "text-background-padding": 3,
        "text-margin-y": -8,
        "text-rotation": "autorotate",
        "width": 2
      }
    },
    {
      selector: "edge:selected",
      style: {
        "line-color": "#f8fafc",
        "target-arrow-color": "#f8fafc",
        "width": 3
      }
    },
    {
      selector: ".status-connected",
      style: {
        "line-color": "#34d399",
        "target-arrow-color": "#34d399",
        "width": 3
      }
    },
    {
      selector: ".metadata-edge",
      style: {
        "line-style": "dashed",
        "target-arrow-shape": "none"
      }
    },
    {
      selector: ".status-missing-endpoint, .status-missing-network, .status-network-conflict, .status-not-attached",
      style: {
        "line-color": "#f59e0b",
        "target-arrow-color": "#f59e0b",
        "line-style": "dashed"
      }
    }
  ];
}

function ensureGraph() {
  if (cy || !graphEl || !tabIsActive()) return cy;
  if (typeof window.cytoscape !== "function") {
    emptyEl?.classList.remove("hidden");
    if (emptyEl) {
      emptyEl.innerHTML = `
        <span class="material-symbols-outlined" aria-hidden="true">error</span>
        <strong>Topology graph unavailable</strong>
      `;
    }
    return null;
  }

  cy = window.cytoscape({
    container: graphEl,
    elements: [],
    minZoom: 0.28,
    maxZoom: 2.2,
    wheelSensitivity: 0.18,
    style: cytoscapeStyle()
  });

  cy.on("tap", "node", (event) => {
    const nodeId = event.target.id();
    if (linkSourceId && linkSourceId !== nodeId) {
      createEdge(linkSourceId, nodeId);
      return;
    }
    selectedNodeId = nodeId;
    selectedEdgeId = "";
    cy.elements().unselect();
    event.target.select();
    showActivityPreview(nodeId);
    renderInspector();
  });

  cy.on("tap", "edge", (event) => {
    selectedNodeId = "";
    selectedEdgeId = event.target.id();
    cy.elements().unselect();
    event.target.select();
    hideActivityPreview();
    renderInspector();
  });

  cy.on("tap", (event) => {
    if (event.target !== cy) return;
    selectedNodeId = "";
    selectedEdgeId = "";
    hideActivityPreview();
    renderInspector();
  });

  cy.on("mouseover", "node", (event) => showActivityPreview(event.target.id()));
  cy.on("mousemove", "node", (event) => showActivityPreview(event.target.id()));
  cy.on("mouseout", "node", (event) => hideActivityPreviewSoon(event.target.id()));
  cy.on("dragfree", "node", scheduleLayoutSave);
  cy.on("pan zoom resize drag position layoutstop", () => {
    updateBubblePositions();
    updateActivityPreviewPosition();
  });
  return cy;
}

function runLayout(options = {}) {
  if (!cy) return;
  const t = topology();
  const layoutName = allNodesHavePositions(t) ? "preset" : "cose";
  cy.layout({
    name: layoutName,
    animate: false,
    fit: options.fit === true,
    padding: 44,
    nodeDimensionsIncludeLabels: true
  }).run();
  hasRunInitialLayout = true;
  updateBubblePositions();
  updateActivityPreviewPosition();
}

function renderGraph() {
  const t = topology();
  renderStatus();
  if (!ensureGraph()) {
    renderInspector();
    return;
  }

  const elements = graphElementsWithPositionOverrides();
  const structureKey = topologyStructureKey(t);
  const structureChanged = renderedStructureKey !== structureKey;
  const shouldRunLayout = !hasRunInitialLayout || structureChanged;
  emptyEl?.classList.toggle("hidden", elements.some((item) => item.group === "nodes"));

  cy.batch(() => {
    cy.elements().remove();
    cy.add(elements);
  });

  if (shouldRunLayout) runLayout({ fit: true });
  else {
    updateBubblePositions();
    updateActivityPreviewPosition();
  }
  renderedStructureKey = structureKey;
  if (selectedNodeId) cy.getElementById(selectedNodeId).select();
  if (selectedEdgeId) cy.getElementById(selectedEdgeId).select();
  if (activityNodeId && !findTopologyNode(currentState, activityNodeId)) hideActivityPreview();
  renderInspector();
}

function scheduleLayoutSave() {
  if (!cy) return;
  const nodes = currentNodePositions();
  rememberNodePositions(nodes);
  updateBubblePositions();
  updateActivityPreviewPosition();
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(async () => {
    await actions().saveTopologyLayout?.({ nodes });
  }, 450);
}

function selectedLocalNode() {
  const node = findTopologyNode(currentState, selectedNodeId);
  return node?.kind === "local" && node?.available !== false && node?.containerId ? node : null;
}

async function createEdge(source, target) {
  linkSourceId = "";
  root?.classList.remove("is-linking");
  linkBtn?.classList.remove("active");
  const ok = await actions().createTopologyEdge?.({ source, target });
  if (ok) await actions().refresh?.();
}

function openNewNodeDialog() {
  const existing = document.getElementById("topologyNodeDialog");
  if (existing) existing.remove();

  const selected = selectedLocalNode();
  const dialog = document.createElement("div");
  dialog.id = "topologyNodeDialog";
  dialog.className = "dm-dialog-backdrop";
  dialog.innerHTML = `
    <div class="dm-dialog dm-topology-node-dialog" role="dialog" aria-modal="true" aria-labelledby="topologyNodeTitle">
      <div class="dm-dialog-header">
        <h2 id="topologyNodeTitle" class="dm-dialog-title">New topology node</h2>
        <button class="button dm-dialog-close" type="button" data-dialog-close aria-label="Close">&times;</button>
      </div>
      <div class="dm-dialog-body dm-topology-choice-list">
        <button class="dm-topology-choice" type="button" data-choice="fresh">
          <span class="material-symbols-outlined" aria-hidden="true">add_box</span>
          <span>Fresh Instance</span>
        </button>
        <button class="dm-topology-choice" type="button" data-choice="clone"${selected ? "" : " disabled"}>
          <span class="material-symbols-outlined" aria-hidden="true">content_copy</span>
          <span>Clone selected</span>
        </button>
        <button class="dm-topology-choice" type="button" data-choice="remote">
          <span class="material-symbols-outlined" aria-hidden="true">public</span>
          <span>Add remote Instance</span>
        </button>
      </div>
    </div>
  `;

  dialog.querySelectorAll("[data-dialog-close]").forEach((btn) => {
    btn.addEventListener("click", () => closeDialog(dialog));
  });
  dialog.addEventListener("mousedown", (event) => {
    if (event.target === dialog) closeDialog(dialog);
  });
  dialog.querySelector("[data-choice='fresh']")?.addEventListener("click", () => {
    closeDialog(dialog);
    openFreshInstanceDialog();
  });
  dialog.querySelector("[data-choice='clone']")?.addEventListener("click", async () => {
    closeDialog(dialog);
    const local = selectedLocalNode();
    if (!local) {
      window.toastFrontendWarning?.("Select a local Instance first.", "Agent Zero");
      return;
    }
    openCloneInstanceDialog({
      containerId: local.containerId,
      instanceName: local.label
    });
  });
  dialog.querySelector("[data-choice='remote']")?.addEventListener("click", () => {
    closeDialog(dialog);
    openAddRemoteInstanceDialog({
      title: "Add remote Instance",
      submitLabel: "Add node",
      onAdded: async () => actions().refresh?.()
    });
  });

  document.body.appendChild(dialog);
  window.setTimeout(() => dialog.querySelector(".dm-topology-choice:not([disabled])")?.focus(), 0);
}

function openFreshInstanceDialog() {
  const versions = installedRunnableVersions(currentState);
  if (!versions.length) {
    window.toastFrontendWarning?.("Install a version first.", "Agent Zero");
    window.dispatchEvent(new CustomEvent("dm:navigate", {
      detail: { tab: "installs", userInitiated: false, source: "topology-fresh-instance" }
    }));
    return;
  }

  const existing = document.getElementById("topologyFreshDialog");
  if (existing) existing.remove();
  const dialog = document.createElement("div");
  dialog.id = "topologyFreshDialog";
  dialog.className = "dm-dialog-backdrop";
  dialog.innerHTML = `
    <form class="dm-dialog" role="dialog" aria-modal="true" aria-labelledby="topologyFreshTitle">
      <div class="dm-dialog-header">
        <h2 id="topologyFreshTitle" class="dm-dialog-title">Fresh Instance</h2>
        <button class="button dm-dialog-close" type="button" data-dialog-close aria-label="Close">&times;</button>
      </div>
      <div class="dm-dialog-body">
        <div class="dm-field">
          <label for="topologyFreshVersion">Version</label>
          <select id="topologyFreshVersion" class="dm-text-input">
            ${versions.map((version) => `<option value="${escapeHtml(version.id)}">${escapeHtml(version.label)}</option>`).join("")}
          </select>
        </div>
        <div class="dm-field">
          <label for="topologyFreshName">Instance name</label>
          <input id="topologyFreshName" class="dm-text-input" type="text" maxlength="80" autocomplete="off" placeholder="Agent Zero">
        </div>
      </div>
      <div class="dm-dialog-footer">
        <button class="button" type="button" data-dialog-close>Cancel</button>
        <button class="button confirm" type="submit">Run Instance</button>
      </div>
    </form>
  `;

  const form = dialog.querySelector("form");
  dialog.querySelectorAll("[data-dialog-close]").forEach((btn) => {
    btn.addEventListener("click", () => closeDialog(dialog));
  });
  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const tag = dialog.querySelector("#topologyFreshVersion")?.value || "";
    const instanceName = dialog.querySelector("#topologyFreshName")?.value || "";
    closeDialog(dialog);
    await actions().activateTag?.(tag, {
      instanceName,
      portMappings: "0:80",
      dataLossAck: "proceed_without_backup"
    });
  });

  document.body.appendChild(dialog);
  window.setTimeout(() => dialog.querySelector("#topologyFreshVersion")?.focus(), 0);
}

function toggleLinkMode() {
  if (!selectedNodeId) {
    window.toastFrontendWarning?.("Select a node first.", "Agent Zero");
    return;
  }
  linkSourceId = linkSourceId ? "" : selectedNodeId;
  root?.classList.toggle("is-linking", !!linkSourceId);
  linkBtn?.classList.toggle("active", !!linkSourceId);
  renderStatus();
}

function renderConnectionDetails(edge = {}) {
  const connection = edge.connection && typeof edge.connection === "object" ? edge.connection : null;
  if (!connection) return "";
  const hints = Array.isArray(connection.hints) ? connection.hints : [];
  const networkName = connection.networkName || edge.networkName || "";
  const networkHtml = networkName
    ? `<div class="dm-topology-detail-row">
        <span>Network</span>
        <button class="dm-topology-copy-value" type="button" data-copy-value="${escapeHtml(networkName)}" data-copy-label="Network name">${escapeHtml(networkName)}</button>
      </div>`
    : "";
  const hintHtml = hints.map((hint) => {
    const alias = hint.alias || "";
    const internalUrl = hint.internalUrl || "";
    const a2aEndpoint = hint.a2aEndpoint || "";
    const a2aHtml = a2aEndpoint
      ? `<div class="dm-topology-detail-row">
          <span>A2A endpoint</span>
          <button class="dm-topology-copy-value" type="button" data-copy-value="${escapeHtml(a2aEndpoint)}" data-copy-label="A2A endpoint">${escapeHtml(a2aEndpoint)}</button>
        </div>`
      : "";
    return `
      <div class="dm-topology-hint">
        <div class="dm-topology-detail-row">
          <span>Alias</span>
          <button class="dm-topology-copy-value" type="button" data-copy-value="${escapeHtml(alias)}" data-copy-label="Alias">${escapeHtml(alias)}</button>
        </div>
        <div class="dm-topology-detail-row">
          <span>Internal URL</span>
          <button class="dm-topology-copy-value" type="button" data-copy-value="${escapeHtml(internalUrl)}" data-copy-label="Internal URL">${escapeHtml(internalUrl)}</button>
        </div>
        ${a2aHtml}
      </div>
    `;
  }).join("");
  if (!networkHtml && !hintHtml) return "";
  return `<div class="dm-topology-connection-details">${networkHtml}${hintHtml}</div>`;
}

function a2aSetupText(edge = {}) {
  const connection = edge.connection && typeof edge.connection === "object" ? edge.connection : null;
  if (!connection) return "";

  const { source, target } = edgeEndpointNodes(edge);
  const hints = Array.isArray(connection.hints) ? connection.hints : [];
  const hintByNode = new Map(hints.map((hint) => [hint.nodeId, hint]));
  const sourceHint = hintByNode.get(edge.source) || {};
  const targetHint = hintByNode.get(edge.target) || {};
  const sourceLabel = endpointLabel(source, "Source Instance");
  const targetLabel = endpointLabel(target, "Target Instance");
  const sourceEndpoint = sourceHint.a2aEndpoint || sourceHint.internalUrl || "";
  const targetEndpoint = targetHint.a2aEndpoint || targetHint.internalUrl || "";
  const lines = [
    `Agent Zero A2A local link: ${sourceLabel} <-> ${targetLabel}`,
    `Network: ${connection.networkName || edge.networkName || ""}`.trim(),
    `${sourceLabel} role: ${source?.role || "peer"}`,
    `${sourceLabel} alias: ${sourceHint.alias || ""}`,
    `${sourceLabel} endpoint: ${sourceEndpoint}`,
    `${targetLabel} role: ${target?.role || "peer"}`,
    `${targetLabel} alias: ${targetHint.alias || ""}`,
    `${targetLabel} endpoint: ${targetEndpoint}`,
    "Use these internal URLs from inside either connected Agent Zero container."
  ];
  return lines.filter((line) => !line.endsWith(": ") && line !== "Network:").join("\n");
}

function edgeEndpointLabel(edge = {}, side = "source") {
  const node = findTopologyNode(currentState, side === "target" ? edge.target : edge.source);
  return endpointLabel(node, side === "target" ? "Target" : "Source");
}

function nodeLabelById(nodeId = "") {
  return endpointLabel(findTopologyNode(currentState, nodeId), "Instance");
}

function probeStatusText(probe = {}) {
  if (probe.ok) {
    const status = Number.isFinite(Number(probe.statusCode)) ? `HTTP ${Number(probe.statusCode)}` : "reached";
    const elapsed = Number.isFinite(Number(probe.elapsedMs)) ? ` in ${Number(probe.elapsedMs)} ms` : "";
    return `${status}${elapsed}`;
  }
  return probe.error || "No response";
}

function messageDraftKey(kind = "node", id = "") {
  return `${kind}:${id || ""}`;
}

function messageResultKey(edgeId = "", sourceNodeId = "", targetNodeId = "") {
  return edgeId
    ? `edge:${edgeId}:${sourceNodeId || ""}:${targetNodeId || ""}`
    : `node:${targetNodeId || ""}`;
}

function messageResultPending(result = {}) {
  if (result?.pending === true) return true;
  const state = String(result?.state || "").toLowerCase();
  return !!result?.taskId && state && !["completed", "failed", "canceled"].includes(state);
}

function messageStatusText(result = {}) {
  const elapsed = Number.isFinite(Number(result.elapsedMs)) ? ` in ${Number(result.elapsedMs)} ms` : "";
  if (messageResultPending(result)) {
    return `${result.response || "A2A task accepted and still running"}${elapsed}`;
  }
  if (result.ok) {
    return result.response ? `${result.response}${elapsed}` : `Message sent${elapsed}`;
  }
  return result.error || "Message failed";
}

function renderMessageResult(key = "") {
  const inFlight = messageInFlightKeys.has(key);
  const result = topologyMessageResults.get(key);
  if (!inFlight && !result) return "";
  const ok = result?.ok === true;
  const pending = messageResultPending(result);
  const toneClass = inFlight || pending ? "is-running" : ok ? "is-ok" : "is-error";
  const icon = inFlight || pending ? "progress_activity" : ok ? "check_circle" : "error";
  const text = inFlight ? "Sending message..." : messageStatusText(result);
  return `
    <div class="dm-topology-message-result ${toneClass}">
      <span class="material-symbols-outlined${inFlight || pending ? " dm-icon-spin" : ""}" aria-hidden="true">${icon}</span>
      <span>${escapeHtml(text)}</span>
    </div>
  `;
}

function renderMessageComposerForEdge(edge = {}) {
  if (!edge?.connection || edge.status !== "connected") return "";
  const sourceLabel = edgeEndpointLabel(edge, "source");
  const targetLabel = edgeEndpointLabel(edge, "target");
  const draftKey = messageDraftKey("edge", edge.id);
  const sourceToTargetKey = messageResultKey(edge.id, edge.source, edge.target);
  const targetToSourceKey = messageResultKey(edge.id, edge.target, edge.source);
  const sourceToTargetBusy = messageInFlightKeys.has(sourceToTargetKey);
  const targetToSourceBusy = messageInFlightKeys.has(targetToSourceKey);
  const draft = messageDrafts.get(draftKey) || "";
  return `
    <div class="dm-topology-message-panel">
      <label class="dm-field">
        <span>Message</span>
        <textarea class="dm-text-input dm-topology-message-input" rows="3" maxlength="8000" data-topology-message-text data-message-key="${escapeHtml(draftKey)}">${escapeHtml(draft)}</textarea>
      </label>
      <div class="dm-topology-message-actions">
        <button class="button" type="button" data-topology-action="message-source-target"${sourceToTargetBusy ? " disabled" : ""}>
          <span class="material-symbols-outlined${sourceToTargetBusy ? " dm-icon-spin" : ""}" aria-hidden="true">${sourceToTargetBusy ? "progress_activity" : "east"}</span>
          <span>${escapeHtml(sourceLabel)} -&gt; ${escapeHtml(targetLabel)}</span>
        </button>
        <button class="button" type="button" data-topology-action="message-target-source"${targetToSourceBusy ? " disabled" : ""}>
          <span class="material-symbols-outlined${targetToSourceBusy ? " dm-icon-spin" : ""}" aria-hidden="true">${targetToSourceBusy ? "progress_activity" : "west"}</span>
          <span>${escapeHtml(targetLabel)} -&gt; ${escapeHtml(sourceLabel)}</span>
        </button>
      </div>
      ${renderMessageResult(sourceToTargetKey)}
      ${renderMessageResult(targetToSourceKey)}
    </div>
  `;
}

function renderMessageComposerForNode(node = {}) {
  if (!canOpenTopologyNode(node)) return "";
  const draftKey = messageDraftKey("node", node.id);
  const resultKey = messageResultKey("", "", node.id);
  const busy = messageInFlightKeys.has(resultKey);
  const draft = messageDrafts.get(draftKey) || "";
  return `
    <div class="dm-topology-message-panel">
      <label class="dm-field">
        <span>Message</span>
        <textarea class="dm-text-input dm-topology-message-input" rows="3" maxlength="8000" data-topology-message-text data-message-key="${escapeHtml(draftKey)}">${escapeHtml(draft)}</textarea>
      </label>
      <div class="dm-topology-message-actions">
        <button class="button" type="button" data-topology-action="message-node"${busy ? " disabled" : ""}>
          <span class="material-symbols-outlined${busy ? " dm-icon-spin" : ""}" aria-hidden="true">${busy ? "progress_activity" : "forum"}</span>
          <span>Send to Instance</span>
        </button>
      </div>
      ${renderMessageResult(resultKey)}
    </div>
  `;
}

function renderProbeDetails(edge = {}) {
  const inFlight = probeInFlightEdgeIds.has(edge.id);
  const result = edgeProbeResults.get(edge.id);
  if (!inFlight && !result) return "";

  const status = inFlight
    ? "Testing A2A..."
    : result?.ok ? "A2A reachable" : "A2A not reachable";
  const toneClass = inFlight ? "is-running" : result?.ok ? "is-ok" : "is-error";
  const rows = Array.isArray(result?.probes) ? result.probes : [];
  const rowHtml = rows.map((probe) => `
    <div class="dm-topology-probe-row">
      <span>${escapeHtml(nodeLabelById(probe.fromNodeId))} -> ${escapeHtml(nodeLabelById(probe.toNodeId))}</span>
      <strong>${escapeHtml(probeStatusText(probe))}</strong>
    </div>
  `).join("");

  return `
    <div class="dm-topology-probe-details ${toneClass}">
      <div class="dm-topology-probe-summary">
        <span class="material-symbols-outlined${inFlight ? " dm-icon-spin" : ""}" aria-hidden="true">${inFlight ? "progress_activity" : result?.ok ? "check_circle" : "error"}</span>
        <strong>${escapeHtml(status)}</strong>
      </div>
      ${rowHtml}
    </div>
  `;
}

function renderA2aSetupDetails(edge = {}) {
  const inFlight = a2aSetupInFlightEdgeIds.has(edge.id);
  const result = edgeA2aSetupResults.get(edge.id);
  if (!inFlight && !result) return "";

  const status = inFlight
    ? "Enabling A2A..."
    : result?.ok ? "Real A2A ready" : "A2A setup failed";
  const toneClass = inFlight ? "is-running" : result?.ok ? "is-ok" : "is-error";
  const endpoints = Array.isArray(result?.endpoints) ? result.endpoints : [];
  const endpointHtml = endpoints.map((endpoint) => `
    <div class="dm-topology-probe-row">
      <span>${escapeHtml(nodeLabelById(endpoint.nodeId))}</span>
      <strong>${escapeHtml(endpoint.enabled ? (endpoint.displayUrl || "enabled") : "not enabled")}</strong>
    </div>
  `).join("");

  return `
    <div class="dm-topology-probe-details ${toneClass}">
      <div class="dm-topology-probe-summary">
        <span class="material-symbols-outlined${inFlight ? " dm-icon-spin" : ""}" aria-hidden="true">${inFlight ? "progress_activity" : result?.ok ? "verified" : "error"}</span>
        <strong>${escapeHtml(status)}</strong>
      </div>
      ${endpointHtml}
    </div>
  `;
}

function recordProbeResult(result = null) {
  if (!result?.edgeId) return;
  edgeProbeResults.set(result.edgeId, result);
  renderInspector();
}

function showProbeBubbles(result = null) {
  const probes = Array.isArray(result?.probes) ? result.probes : [];
  for (const probe of probes) {
    const tone = probe.ok ? "link" : "error";
    showNodeBubble(probe.fromNodeId, probe.ok ? "A2A request sent" : "A2A request failed", tone);
    showNodeBubble(probe.toNodeId, probe.ok ? "A2A reached" : "No A2A response", tone);
  }
}

async function runEdgeProbe(edge = {}) {
  if (!edge?.id || probeInFlightEdgeIds.has(edge.id)) return null;
  probeInFlightEdgeIds.add(edge.id);
  renderInspector();
  try {
    const result = await actions().probeTopologyEdge?.(edge.id);
    if (result) {
      recordProbeResult(result);
      showProbeBubbles(result);
    }
    return result || null;
  } finally {
    probeInFlightEdgeIds.delete(edge.id);
    renderInspector();
  }
}

function recordA2aSetupResult(result = null) {
  if (!result?.edgeId) return;
  edgeA2aSetupResults.set(result.edgeId, result);
  renderInspector();
}

function showA2aSetupBubbles(result = null) {
  const endpoints = Array.isArray(result?.endpoints) ? result.endpoints : [];
  for (const endpoint of endpoints) {
    showNodeBubble(endpoint.nodeId, result?.ok ? "A2A server ready" : "A2A setup failed", result?.ok ? "link" : "error");
  }
}

async function prepareA2a(edge = {}) {
  if (!edge?.id || a2aSetupInFlightEdgeIds.has(edge.id)) return null;
  a2aSetupInFlightEdgeIds.add(edge.id);
  renderInspector();
  try {
    const result = await actions().prepareTopologyA2aEdge?.(edge.id);
    if (result) {
      recordA2aSetupResult(result);
      showA2aSetupBubbles(result);
    }
    return result || null;
  } finally {
    a2aSetupInFlightEdgeIds.delete(edge.id);
    renderInspector();
  }
}

function readMessageDraft(key = "") {
  return String(messageDrafts.get(key) || "").trim();
}

function bubblePreview(prefix = "", text = "", fallback = "") {
  const value = String(text || fallback || "").trim().replace(/\s+/g, " ");
  const label = prefix ? `${prefix}: ` : "";
  return `${label}${value}`.slice(0, 90);
}

function showMessageBubbles(result = {}) {
  if (!result?.targetNodeId) return;
  const ok = result.ok === true;
  const pending = messageResultPending(result);
  const messageText = bubblePreview("Sent", result.message, "Message sent");
  const responseText = pending
    ? bubblePreview("", result.response, "Still working")
    : bubblePreview("Reply", result.response, "Message received");
  if (result.direction === "node_to_node") {
    if (result.sourceNodeId) {
      showNodeBubble(result.sourceNodeId, ok ? messageText : "Message failed", ok ? "link" : "error", ok ? 9000 : 4200);
    }
    showNodeBubble(result.targetNodeId, ok ? responseText : "No delivery", ok ? "link" : "error", ok ? 9000 : 4200);
    return;
  }
  showNodeBubble(result.targetNodeId, ok ? bubblePreview("User", result.message, "Message received") : "Message failed", ok ? "user" : "error", ok ? 9000 : 4200);
}

async function sendInspectorMessage(payload = {}, draftKey = "", resultKey = "") {
  const message = readMessageDraft(draftKey);
  if (!message) {
    window.toastFrontendWarning?.("Enter a message first.", "Agent Zero");
    return null;
  }
  if (messageInFlightKeys.has(resultKey)) return null;

  messageInFlightKeys.add(resultKey);
  renderInspector();
  try {
    const result = await actions().sendTopologyMessage?.({ ...payload, message });
    if (result) {
      topologyMessageResults.set(resultKey, result);
      if (result.ok) messageDrafts.set(draftKey, "");
      showMessageBubbles({ ...result, message });
    }
    return result || null;
  } finally {
    messageInFlightKeys.delete(resultKey);
    renderInspector();
  }
}

function canOpenTopologyNode(node = null) {
  if (!node || node.available === false) return false;
  if (node.kind === "remote") return !!node.instanceId;
  if (node.kind === "local") return !!node.containerId;
  return false;
}

function renderInspectorActionGroup(title = "", icon = "tune", bodyHtml = "") {
  const body = String(bodyHtml || "").trim();
  if (!body) return "";
  return `
    <section class="dm-topology-control-group">
      <div class="dm-topology-control-title">
        <span class="material-symbols-outlined" aria-hidden="true">${escapeHtml(icon)}</span>
        <span>${escapeHtml(title)}</span>
      </div>
      <div class="dm-topology-inspector-actions">
        ${body}
      </div>
    </section>
  `;
}

function renderInspector() {
  if (!inspectorEl) return;
  const node = findTopologyNode(currentState, selectedNodeId);
  const edge = findTopologyEdge(currentState, selectedEdgeId);

  if (edge) {
    const hasConnection = !!edge.connection;
    const isProbing = probeInFlightEdgeIds.has(edge.id);
    const isPreparingA2a = a2aSetupInFlightEdgeIds.has(edge.id);
    const { source, target } = edgeEndpointNodes(edge);
    const sourceLabel = edgeEndpointLabel(edge, "source");
    const targetLabel = edgeEndpointLabel(edge, "target");
    inspectorEl.innerHTML = `
      <div class="dm-topology-inspector-header">
        <span class="material-symbols-outlined" aria-hidden="true">conversion_path</span>
        <div>
          <h2>${escapeHtml(edge.label || "Topology link")}</h2>
          <p>${escapeHtml(edgeStatusLabel(edge))}</p>
        </div>
      </div>
      ${renderConnectionDetails(edge)}
      ${renderProbeDetails(edge)}
      ${renderA2aSetupDetails(edge)}
      ${renderMessageComposerForEdge(edge)}
      <div class="dm-topology-control-groups">
        ${renderInspectorActionGroup("A2A", "hub", `
          <button class="button" type="button" data-topology-action="copy-a2a"${hasConnection ? "" : " disabled"}>
            <span class="material-symbols-outlined" aria-hidden="true">content_copy</span>
            <span>Copy setup</span>
          </button>
          <button class="button" type="button" data-topology-action="probe"${hasConnection && edge.status === "connected" && !isProbing ? "" : " disabled"}>
            <span class="material-symbols-outlined${isProbing ? " dm-icon-spin" : ""}" aria-hidden="true">${isProbing ? "progress_activity" : "wifi_tethering"}</span>
            <span>${isProbing ? "Testing..." : "Test A2A"}</span>
          </button>
          <button class="button" type="button" data-topology-action="prepare-a2a"${hasConnection && edge.status === "connected" && !isPreparingA2a ? "" : " disabled"}>
            <span class="material-symbols-outlined${isPreparingA2a ? " dm-icon-spin" : ""}" aria-hidden="true">${isPreparingA2a ? "progress_activity" : "verified"}</span>
            <span>${isPreparingA2a ? "Enabling..." : "Enable A2A"}</span>
          </button>
        `)}
        ${renderInspectorActionGroup("Instances", "open_in_new", `
          <button class="button" type="button" data-topology-action="open-source"${canOpenTopologyNode(source) ? "" : " disabled"}>
            <span class="material-symbols-outlined" aria-hidden="true">open_in_new</span>
            <span>Open ${escapeHtml(sourceLabel)}</span>
          </button>
          <button class="button" type="button" data-topology-action="open-target"${canOpenTopologyNode(target) ? "" : " disabled"}>
            <span class="material-symbols-outlined" aria-hidden="true">open_in_new</span>
            <span>Open ${escapeHtml(targetLabel)}</span>
          </button>
        `)}
        ${renderInspectorActionGroup("Link", "lan", `
          <button class="button confirm" type="button" data-topology-action="connect"${edge.canConnect ? "" : " disabled"}>
            <span class="material-symbols-outlined" aria-hidden="true">lan</span>
            <span>Connect locally</span>
          </button>
          <button class="button" type="button" data-topology-action="disconnect"${edge.canDisconnect ? "" : " disabled"}>
            <span class="material-symbols-outlined" aria-hidden="true">link_off</span>
            <span>Disconnect</span>
          </button>
          <button class="button danger" type="button" data-topology-action="delete-edge">
            <span class="material-symbols-outlined" aria-hidden="true">delete</span>
            <span>Delete link</span>
          </button>
        `)}
      </div>
    `;
    return;
  }

  if (node) {
    const role = node.role || "peer";
    const canUseLocalActions = node.kind === "local" && node.available !== false && !!node.containerId;
    inspectorEl.innerHTML = `
      <div class="dm-topology-inspector-header">
        <span class="material-symbols-outlined" aria-hidden="true">${node.kind === "remote" ? "public" : "deployed_code"}</span>
        <div>
          <h2>${escapeHtml(node.label || "Instance")}</h2>
          <p>${escapeHtml(node.kind === "remote" ? "Remote Instance" : node.state || "Local Instance")}</p>
        </div>
      </div>
      <label class="dm-field dm-topology-role-field">
        <span>Role</span>
        <select class="dm-text-input" data-topology-role>
          ${["peer", "coordinator", "worker", "tool"].map((option) =>
            `<option value="${option}"${option === role ? " selected" : ""}>${option}</option>`
          ).join("")}
        </select>
      </label>
      ${renderMessageComposerForNode(node)}
      <div class="dm-topology-control-groups">
        ${renderInspectorActionGroup("Instance", "deployed_code", `
          <button class="button confirm" type="button" data-topology-action="open-ui"${node.available === false ? " disabled" : ""}>
            <span class="material-symbols-outlined" aria-hidden="true">open_in_new</span>
            <span>Open UI</span>
          </button>
          <button class="button" type="button" data-topology-action="start"${canUseLocalActions ? "" : " disabled"}>
            <span class="material-symbols-outlined" aria-hidden="true">play_arrow</span>
            <span>Start</span>
          </button>
          <button class="button" type="button" data-topology-action="clone"${canUseLocalActions ? "" : " disabled"}>
            <span class="material-symbols-outlined" aria-hidden="true">content_copy</span>
            <span>Clone</span>
          </button>
        `)}
      </div>
    `;
    return;
  }

  inspectorEl.innerHTML = `
    <div class="dm-topology-inspector-empty">
      <span class="material-symbols-outlined" aria-hidden="true">ads_click</span>
      <strong>Select a node or link</strong>
    </div>
  `;
}

async function handleInspectorAction(action) {
  const node = findTopologyNode(currentState, selectedNodeId);
  const edge = findTopologyEdge(currentState, selectedEdgeId);
  if (action === "connect" && edge) {
    const ok = await actions().connectTopologyEdge?.(edge.id);
    if (ok) {
      showEdgeBubbles(edge, "A2A link ready", "A2A link ready", "link");
      await runEdgeProbe(edge);
    }
    return;
  }
  if (action === "probe" && edge) {
    await runEdgeProbe(edge);
    return;
  }
  if (action === "prepare-a2a" && edge) {
    await prepareA2a(edge);
    return;
  }
  if ((action === "message-source-target" || action === "message-target-source") && edge) {
    const fromSource = action === "message-source-target";
    const sourceNodeId = fromSource ? edge.source : edge.target;
    const targetNodeId = fromSource ? edge.target : edge.source;
    await sendInspectorMessage(
      { edgeId: edge.id, sourceNodeId, targetNodeId },
      messageDraftKey("edge", edge.id),
      messageResultKey(edge.id, sourceNodeId, targetNodeId)
    );
    return;
  }
  if (action === "disconnect" && edge) {
    const ok = await actions().disconnectTopologyEdge?.(edge.id);
    if (ok) showEdgeBubbles(edge, "Link paused", "Link paused", "info");
    return;
  }
  if (action === "delete-edge" && edge) {
    selectedEdgeId = "";
    await actions().deleteTopologyEdge?.(edge.id);
    return;
  }
  if (action === "copy-a2a" && edge) {
    const text = a2aSetupText(edge);
    if (text) {
      await copyText(text, "A2A setup");
      showEdgeBubbles(edge, "A2A details copied", "A2A details copied", "link");
    }
    return;
  }
  if ((action === "open-source" || action === "open-target") && edge) {
    const nodeId = action === "open-target" ? edge.target : edge.source;
    const endpoint = findTopologyNode(currentState, nodeId);
    if (!canOpenTopologyNode(endpoint)) return;
    if (endpoint?.kind === "remote") await actions().openRemoteInstance?.(endpoint.instanceId);
    else if (endpoint?.kind === "local") await actions().openUi?.(endpoint.containerId);
    showNodeBubble(nodeId, "User opened UI", "user");
    return;
  }
  if (action === "open-ui" && node) {
    if (node.kind === "remote") await actions().openRemoteInstance?.(node.instanceId);
    else await actions().openUi?.(node.containerId);
    showNodeBubble(node.id, "User opened UI", "user");
    return;
  }
  if (action === "message-node" && node) {
    await sendInspectorMessage(
      { targetNodeId: node.id },
      messageDraftKey("node", node.id),
      messageResultKey("", "", node.id)
    );
    return;
  }
  if (action === "start" && node?.kind === "local" && node.available !== false && node.containerId) {
    await actions().startLocalInstance?.(node.containerId);
    showNodeBubble(node.id, "Starting", "info");
    return;
  }
  if (action === "clone" && node?.kind === "local" && node.available !== false && node.containerId) {
    openCloneInstanceDialog({
      containerId: node.containerId,
      instanceName: node.label
    });
  }
}

function bindControls() {
  newNodeBtn?.addEventListener("click", openNewNodeDialog);
  linkBtn?.addEventListener("click", toggleLinkMode);
  fitBtn?.addEventListener("click", () => {
    if (!cy) return;
    cy.resize();
    cy.fit(undefined, 44);
    updateBubblePositions();
    updateActivityPreviewPosition();
  });
  refreshBtn?.addEventListener("click", () => actions().refresh?.());
  activityEl?.addEventListener("mouseenter", () => window.clearTimeout(activityCloseTimer));
  activityEl?.addEventListener("mouseleave", () => hideActivityPreviewSoon(activityNodeId));
  activityEl?.addEventListener("click", (event) => {
    event.stopPropagation();
    const closeButton = event.target?.closest?.("[data-activity-close]");
    if (closeButton) {
      hideActivityPreview();
      return;
    }
    const refreshButton = event.target?.closest?.("[data-activity-refresh]");
    if (refreshButton) {
      refreshActivityPreview(activityNodeId);
      return;
    }
    const expandButton = event.target?.closest?.("[data-activity-expand]");
    if (expandButton) {
      activityExpanded = !activityExpanded;
      renderActivityPreview();
      return;
    }
    const eventButton = event.target?.closest?.("[data-activity-event-key]");
    if (eventButton) {
      const key = eventButton.dataset.activityEventKey || "";
      selectedActivityEventKey = selectedActivityEventKey === key ? "" : key;
      if (selectedActivityEventKey) activityExpanded = true;
      renderActivityPreview();
    }
  });
  inspectorEl?.addEventListener("click", (event) => {
    const copyButton = event.target?.closest?.("[data-copy-value]");
    if (copyButton) {
      copyText(copyButton.dataset.copyValue || "", copyButton.dataset.copyLabel || "Value");
      return;
    }
    const button = event.target?.closest?.("[data-topology-action]");
    if (!button) return;
    handleInspectorAction(button.dataset.topologyAction || "");
  });
  inspectorEl?.addEventListener("input", (event) => {
    const messageInput = event.target?.closest?.("[data-topology-message-text]");
    if (!messageInput) return;
    messageDrafts.set(messageInput.dataset.messageKey || "", messageInput.value || "");
  });
  inspectorEl?.addEventListener("change", (event) => {
    const roleSelect = event.target?.closest?.("[data-topology-role]");
    if (!roleSelect || !selectedNodeId) return;
    actions().setTopologyNodeRole?.(selectedNodeId, roleSelect.value || "peer");
  });
}

function init() {
  bindControls();
  window.addEventListener("dm:state", (event) => {
    currentState = event.detail || {};
    renderGraph();
  });
  window.addEventListener("dm:nav", (event) => {
    if (event?.detail?.tab !== "topology") return;
    window.setTimeout(() => {
      ensureGraph();
      if (cy) {
        cy.resize();
        renderGraph();
        updateBubblePositions();
        updateActivityPreviewPosition();
      }
    }, 0);
  });
  renderGraph();
}

init();

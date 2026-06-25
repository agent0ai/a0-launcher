const NODE_TONES = {
  blue: { fg: "#7dd3fc", bg: "#12384a", border: "#38bdf8" },
  green: { fg: "#86efac", bg: "#173d27", border: "#4ade80" },
  rose: { fg: "#f9a8d4", bg: "#4a1830", border: "#f472b6" },
  amber: { fg: "#fcd34d", bg: "#493414", border: "#fbbf24" },
  violet: { fg: "#c4b5fd", bg: "#31204c", border: "#a78bfa" },
  cyan: { fg: "#67e8f9", bg: "#173f45", border: "#22d3ee" },
  coral: { fg: "#fda4af", bg: "#4b1d25", border: "#fb7185" },
  local: { fg: "#93c5fd", bg: "#172b45", border: "#60a5fa" },
  remote: { fg: "#d8b4fe", bg: "#312047", border: "#c084fc" },
  missing: { fg: "#9ca3af", bg: "#20242b", border: "#6b7280" }
};

function topologyState(state = {}) {
  const topology = state?.topology && typeof state.topology === "object" ? state.topology : {};
  return {
    version: 1,
    networkName: typeof topology.networkName === "string" ? topology.networkName : "a0-launcher-topology",
    nodes: Array.isArray(topology.nodes) ? topology.nodes : [],
    edges: Array.isArray(topology.edges) ? topology.edges : []
  };
}

function nodeTone(node = {}) {
  if (node.missing || node.available === false) return NODE_TONES.missing;
  const color = typeof node.instanceColor === "string" ? node.instanceColor : "";
  if (NODE_TONES[color]) return NODE_TONES[color];
  return node.kind === "remote" ? NODE_TONES.remote : NODE_TONES.local;
}

function shortNodeKind(node = {}) {
  if (node.kind === "remote") return "Remote";
  return "Local";
}

function nodeSubtitle(node = {}) {
  if (node.missing || node.available === false) return "Missing";
  if (node.kind === "remote") return node.url || "Remote";
  const state = typeof node.state === "string" && node.state ? node.state : "local";
  const version = typeof node.versionTag === "string" && node.versionTag ? node.versionTag : "";
  return version ? `${state} - ${version}` : state;
}

function edgeStatusLabel(edge = {}) {
  const status = typeof edge.status === "string" ? edge.status : "";
  if (status === "connected") return "Connected";
  if (status === "metadata") return "Reference";
  if (status === "missing_endpoint") return "Missing endpoint";
  if (status === "missing_network") return "Network missing";
  if (status === "network_conflict") return "Name conflict";
  if (status === "not_attached") return "Not attached";
  return edge.mode === "local_network" ? "Ready" : "Reference";
}

function edgeClasses(edge = {}) {
  const classes = ["topology-edge"];
  const status = typeof edge.status === "string" ? edge.status : "";
  if (status) classes.push(`status-${status.replace(/_/g, "-")}`);
  if (edge.mode === "metadata") classes.push("metadata-edge");
  return classes.join(" ");
}

function graphElementsFromState(state = {}) {
  const topology = topologyState(state);
  const elements = [];

  for (const node of topology.nodes) {
    if (!node?.id) continue;
    const tone = nodeTone(node);
    elements.push({
      group: "nodes",
      data: {
        id: node.id,
        label: node.label || "Instance",
        subtitle: nodeSubtitle(node),
        role: node.role || "peer",
        kind: shortNodeKind(node),
        fg: tone.fg,
        bg: tone.bg,
        border: tone.border,
        missing: node.missing === true || node.available === false
      },
      classes: [
        "topology-node",
        node.kind === "remote" ? "remote-node" : "local-node",
        node.missing || node.available === false ? "missing-node" : "",
        `role-${node.role || "peer"}`
      ].filter(Boolean).join(" "),
      position: node.position && Number.isFinite(Number(node.position.x)) && Number.isFinite(Number(node.position.y))
        ? { x: Number(node.position.x), y: Number(node.position.y) }
        : undefined
    });
  }

  for (const edge of topology.edges) {
    if (!edge?.id || !edge.source || !edge.target) continue;
    elements.push({
      group: "edges",
      data: {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        label: edgeStatusLabel(edge),
        name: edge.label || edgeStatusLabel(edge)
      },
      classes: edgeClasses(edge)
    });
  }

  return elements;
}

function allNodesHavePositions(topology = {}) {
  const nodes = Array.isArray(topology.nodes) ? topology.nodes : [];
  return nodes.length > 0 && nodes.every((node) =>
    Number.isFinite(Number(node?.position?.x)) && Number.isFinite(Number(node?.position?.y))
  );
}

function topologyStructureKey(topology = {}) {
  const normalized = topologyState({ topology });
  const nodeKey = normalized.nodes
    .map((node) => [
      node?.id || "",
      node?.kind || "",
      node?.available === false || node?.missing === true ? "missing" : "available"
    ].join(":"))
    .sort()
    .join(",");
  const edgeKey = normalized.edges
    .map((edge) => [
      edge?.id || "",
      edge?.source || "",
      edge?.target || "",
      edge?.mode || ""
    ].join(":"))
    .sort()
    .join(",");
  return `${nodeKey}|${edgeKey}`;
}

function findTopologyNode(state = {}, nodeId = "") {
  return topologyState(state).nodes.find((node) => node?.id === nodeId) || null;
}

function findTopologyEdge(state = {}, edgeId = "") {
  return topologyState(state).edges.find((edge) => edge?.id === edgeId) || null;
}

function installedRunnableVersions(state = {}) {
  return (Array.isArray(state?.versions) ? state.versions : [])
    .filter((version) => ["installed", "update_available"].includes(version?.availability))
    .map((version) => ({
      id: version.id,
      label: version.displayVersion || version.id,
      category: version.category || ""
    }))
    .filter((version) => version.id);
}

function activeTopologyNodeIdsFromTabs(state = {}) {
  const snapshot = state?.instanceTabs && typeof state.instanceTabs === "object" ? state.instanceTabs : {};
  const tabs = Array.isArray(snapshot.tabs) ? snapshot.tabs : [];
  const activeTabId = typeof snapshot.activeTabId === "string" ? snapshot.activeTabId : "";
  const byNodeId = new Map();

  for (const tab of tabs) {
    if (!tab || typeof tab !== "object") continue;
    const kind = typeof tab.kind === "string" ? tab.kind : "";
    if (kind !== "local" && kind !== "remote") continue;
    const id = kind === "remote"
      ? (typeof tab.instanceId === "string" ? tab.instanceId : "")
      : (typeof tab.containerId === "string" ? tab.containerId : "");
    if (!id) continue;

    const nodeId = `${kind === "remote" ? "remote" : "local"}:${id}`;
    const existing = byNodeId.get(nodeId) || { nodeId, active: false, loading: false };
    const isActive = tab.active === true || (activeTabId && tab.id === activeTabId);
    byNodeId.set(nodeId, {
      nodeId,
      active: existing.active || isActive,
      loading: existing.loading || tab.loading === true
    });
  }

  return [...byNodeId.values()].sort((a, b) => a.nodeId.localeCompare(b.nodeId));
}

function stripActivityAnsi(value) {
  return String(value || "")
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
    .replace(/\[(?:\d{1,3}(?:;\d{1,3})*)?m/g, "");
}

function cleanActivityLine(value) {
  return stripActivityAnsi(value)
    .replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s+/, "")
    .replace(/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:,\d+)?\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function activityTime(value) {
  const raw = stripActivityAnsi(value);
  let match = raw.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d+)?Z\s+/);
  if (match) return match[2];
  match = raw.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})(?:,\d+)?\s+/);
  return match ? match[2] : "";
}

function activityDetail(value, max = 180) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, max);
}

function activityEvent(kind, title, detail, text, line) {
  const full = activityDetail(text, 900);
  return {
    kind,
    title,
    detail: detail === "" ? "" : activityDetail(detail || full, 180),
    full,
    time: activityTime(line)
  };
}

function activityEventFromLine(line = "") {
  const text = cleanActivityLine(line);
  if (!text) return null;
  if (/^(Runtime|Session|Reset):\s/i.test(text)) return null;
  if (/^[-=#]{4,}/.test(text)) return null;
  if (/^\(?venv\)?\s+root@/i.test(text)) return null;
  if (/^(INFO|DEBUG):?\s+.*\b(WebSocket|socket\.io)\b/i.test(text)) return null;
  if (/\b(WebSocket disconnected|reaped unknown pid|namespace=\/ws|socket\.io)\b/i.test(text)) return null;
  if (/^[{}\][,\s]+$/.test(text)) return null;
  if (/^"[A-Za-z_][A-Za-z0-9_ -]*"\s*:\s*/.test(text)) return null;

  let match = text.match(/\[A2A\]\s+Processing task\s+([a-f0-9-]+)/i);
  if (match) {
    return activityEvent("a2a", "A2A task started", match[1].slice(0, 8), text, line);
  }

  match = text.match(/\[A2A\]\s+Completed task\s+([a-f0-9-]+)/i);
  if (match) {
    return activityEvent("done", "A2A task completed", match[1].slice(0, 8), text, line);
  }

  match = text.match(/\[A2A\]\s+Error processing task\s+([a-f0-9-]+):?\s*(.*)$/i);
  if (match) {
    return activityEvent("error", "A2A task failed", match[2] || match[1].slice(0, 8), text, line);
  }

  match = text.match(/(?:^|:\s*)Using tool '([^']+)'/i);
  if (match) {
    return activityEvent("tool", "Using tool", match[1], text, line);
  }

  match = text.match(/(?:^|:\s*)Response from tool '([^']+)'/i);
  if (match) {
    return activityEvent("response", "Tool response", match[1], text, line);
  }

  match = text.match(/(?:^|:\s*)Code:\s*(.+)$/i);
  if (match) {
    return activityEvent("code", "Executing code", match[1], text, line);
  }

  if (/Remote user message/i.test(text)) {
    return activityEvent("message", "Remote user message", "", text, line);
  }

  if (/Detected shell prompt/i.test(text)) {
    return activityEvent("shell", "Shell ready", "", text, line);
  }

  if (/\b(Error|Traceback|Exception|failed)\b/i.test(text)) {
    return activityEvent("error", "Runtime event", text, text, line);
  }

  match = text.match(/^A0:\s*(.+)$/i);
  if (match) {
    return activityEvent("message", "Agent output", match[1], text, line);
  }

  if (text.length < 12 || text.length > 260) return null;
  return activityEvent("log", "Runtime log", text, text, line);
}

function activityEventsFromLogs(logs = {}, limit = 8) {
  const lines = Array.isArray(logs?.lines) ? logs.lines : [];
  const events = [];
  let lastKey = "";

  for (const entry of lines) {
    const event = activityEventFromLine(typeof entry === "string" ? entry : entry?.line);
    if (!event) continue;
    const key = `${event.kind}:${event.title}:${event.detail}`;
    if (key === lastKey) continue;
    lastKey = key;
    events.push(event);
  }

  return events.slice(-Math.max(1, Math.min(20, Number(limit) || 8))).reverse();
}

export {
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
};

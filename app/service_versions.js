/* global window, document */

function $(id) {
  return document.getElementById(id);
}

const CANONICAL_LOCAL_TAGS = new Set(['local', 'development', 'main']);

function isErrorResponse(obj) {
  return !!obj && typeof obj === 'object' && typeof obj.message === 'string' && !Array.isArray(obj.versions);
}

let bannerTimer = null;
let bannerHideTimer = null;
let lastOpErrorBanner = null;

function hideBanner() {
  const el = $('banner');
  if (!el) return;

  if (bannerHideTimer) {
    clearTimeout(bannerHideTimer);
    bannerHideTimer = null;
  }

  el.classList.add('is-hiding');
  bannerHideTimer = setTimeout(() => {
    el.classList.add('hidden');
    el.classList.remove('is-hiding');
    el.classList.remove('error', 'info');
    el.textContent = '';
  }, 180);
}

function setBanner(type, message, timeoutSeconds) {
  const el = $('banner');
  if (!el) return;

  if (bannerTimer) {
    clearTimeout(bannerTimer);
    bannerTimer = null;
  }
  if (bannerHideTimer) {
    clearTimeout(bannerHideTimer);
    bannerHideTimer = null;
  }

  if (!message) {
    hideBanner();
    return;
  }

  el.classList.remove('hidden');
  el.classList.remove('is-hiding');
  el.classList.remove('error', 'info');
  el.classList.add(type === 'error' ? 'error' : 'info');
  el.textContent = message;

  const defaultSeconds = (type === 'error') ? 0 : 3;
  const sRaw = (typeof timeoutSeconds === 'number' && Number.isFinite(timeoutSeconds)) ? timeoutSeconds : defaultSeconds;
  const s = Math.max(0, sRaw);
  if (s > 0) {
    bannerTimer = setTimeout(() => {
      hideBanner();
    }, Math.floor(s * 1000));
  }
}

function formatLocalTime(iso) {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return String(iso);
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return String(iso);
  }
}

function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  const shown = i === 0 ? String(Math.floor(v)) : v.toFixed(v >= 10 ? 1 : 2);
  return `${shown} ${units[i]}`;
}

async function initHeaderLogo() {
  const img = $('headerLogo');
  if (!img) return;

  try {
    const dataUrl = await window.electronAPI?.getShellIconDataUrl?.();
    if (typeof dataUrl === 'string' && dataUrl.startsWith('data:image/')) {
      img.src = dataUrl;
      img.classList.remove('hidden');
    }
  } catch {
    // ignore
  }
}

function showDataLossModal(opts) {
  const title = (opts && opts.title) ? String(opts.title) : 'Before you continue';
  const detail = (opts && opts.detail) ? String(opts.detail) : '';

  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    const modal = document.createElement('div');
    modal.className = 'modal';

    const h = document.createElement('div');
    h.className = 'modal-title';
    h.textContent = title;

    const p = document.createElement('div');
    p.className = 'modal-text';
    p.textContent =
      'Changing versions can reset your data. Choose one option to continue, or cancel.';

    const d = document.createElement('div');
    d.className = 'modal-detail';
    d.textContent = detail;

    const actions = document.createElement('div');
    actions.className = 'modal-actions';

    const btnBackup = document.createElement('button');
    btnBackup.className = 'btn btn-primary';
    btnBackup.type = 'button';
    btnBackup.textContent = 'I have a backup';

    const btnProceed = document.createElement('button');
    btnProceed.className = 'btn';
    btnProceed.type = 'button';
    btnProceed.textContent = 'Proceed without backup';

    const btnCancel = document.createElement('button');
    btnCancel.className = 'btn';
    btnCancel.type = 'button';
    btnCancel.textContent = 'Cancel';

    function cleanup(result) {
      try {
        overlay.remove();
      } catch {
        // ignore
      }
      resolve(result);
    }

    btnBackup.addEventListener('click', () => cleanup('has_backup'));
    btnProceed.addEventListener('click', () => cleanup('proceed_without_backup'));
    btnCancel.addEventListener('click', () => cleanup(null));

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) cleanup(null);
    });

    actions.appendChild(btnCancel);
    actions.appendChild(btnProceed);
    actions.appendChild(btnBackup);

    modal.appendChild(h);
    modal.appendChild(p);
    if (detail) modal.appendChild(d);
    modal.appendChild(actions);

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
  });
}

function statusLabel(v, latestDisplay) {
  if (v.isActive) {
    const s = typeof v.activeState === 'string' ? v.activeState : '';
    const running = !s || String(s).toLowerCase() === 'running';
    return running
      ? { text: 'Active', className: 'status status-active' }
      : { text: 'Stopped', className: 'status status-unavailable' };
  }
  if (v.availability === 'installing') return { text: 'In progress', className: 'status status-installed' };
  if (v.availability === 'update_available') {
    const suffix = latestDisplay ? ` - ${latestDisplay}` : '';
    return { text: `Update Available${suffix}`, className: 'status status-update' };
  }
  if (v.installability === 'not_yet_available') return { text: 'Not yet available', className: 'status status-unavailable' };
  if (v.availability === 'installed') return { text: 'Installed', className: 'status status-installed' };
  return { text: 'Available', className: 'status status-available' };
}

function beginButtonBusy(btn, label) {
  if (!btn) return () => {};
  const prevText = btn.textContent;
  btn.disabled = true;
  if (label) btn.textContent = label;
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    btn.disabled = false;
    btn.textContent = prevText;
  };
}

function getRunningOperationForVersion(v) {
  if (!lastProgress || typeof lastProgress !== 'object') return null;
  if (lastProgress.status !== 'running') return null;
  if (!v || typeof v !== 'object' || typeof v.id !== 'string') return null;
  const t = typeof lastProgress.targetVersionTag === 'string' ? lastProgress.targetVersionTag : '';
  if (!t) return null;
  return t === v.id ? lastProgress : null;
}

function operationLabelForVersion(v, op) {
  const type = op && typeof op.type === 'string' ? op.type : '';
  if (type === 'update') return 'Updating...';
  if (type === 'activate') return 'Starting...';
  if (type === 'start') return 'Starting...';
  if (type === 'stop') return 'Stopping...';
  if (v && v.differsFromPublished === true) return 'Syncing...';
  const dl =
    op && typeof op.downloadProgress === 'number' && Number.isFinite(op.downloadProgress) ? op.downloadProgress : null;
  const ex =
    op && typeof op.extractProgress === 'number' && Number.isFinite(op.extractProgress) ? op.extractProgress : null;
  if (typeof dl === 'number' && dl < 100) return 'Downloading...';
  if (typeof ex === 'number' && ex < 100) return 'Extracting...';

  const m = lastProgress && typeof lastProgress.message === 'string' ? lastProgress.message.trim().toLowerCase() : '';
  if (m === 'extracting') return 'Extracting...';
  return 'Downloading...';
}

function badgeClass(name) {
  if (name === 'latest') return 'badge badge-latest';
  if (name === 'testing') return 'badge badge-testing';
  if (name === 'canonical') return 'badge badge-canonical';
  return 'badge';
}

function renderList(container, items, renderItem) {
  if (!container) return;
  container.innerHTML = '';
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'subtitle';
    empty.textContent = 'Nothing to show yet.';
    container.appendChild(empty);
    return;
  }
  for (const item of items) {
    container.appendChild(renderItem(item));
  }
}

function createVersionRow(v, opts) {
  const el = document.createElement('div');
  el.className = 'item';

  const left = document.createElement('div');
  const title = document.createElement('div');
  title.className = 'item-title';

  const name = document.createElement('span');
  name.textContent = v.displayVersion;
  title.appendChild(name);

  if (Array.isArray(v.channelBadges)) {
    for (const b of v.channelBadges) {
      const badge = document.createElement('span');
      badge.className = badgeClass(b);
      badge.textContent = b;
      title.appendChild(badge);
    }
  }

  if (opts && Array.isArray(opts.extraBadges)) {
    for (const b of opts.extraBadges) {
      const badge = document.createElement('span');
      badge.className = badgeClass(b);
      badge.textContent = b;
      title.appendChild(badge);
    }
  }

  const meta = document.createElement('div');
  meta.className = 'item-meta';
  const metaParts = [];
  if (v.matchHint) metaParts.push(v.matchHint);
  if (v.digestHint) metaParts.push(v.digestHint);
  if (v.publishedAt) metaParts.push(`Published: ${formatLocalTime(v.publishedAt)}`);
  meta.textContent = metaParts.join(' - ');

  left.appendChild(title);
  if (meta.textContent) left.appendChild(meta);

  const actions = document.createElement('div');
  actions.className = 'item-actions';

  const status = statusLabel(v, opts && opts.latestDisplayVersion ? opts.latestDisplayVersion : '');
  const statusEl = document.createElement('span');
  statusEl.className = status.className;
  statusEl.textContent = status.text;
  actions.appendChild(statusEl);

  if (opts && typeof opts.renderActions === 'function') {
    const extra = opts.renderActions(v);
    if (extra) actions.appendChild(extra);
  }

  el.appendChild(left);
  el.appendChild(actions);
  return el;
}

function renderState(state) {
  const isOffline = !!state.offline;

  const openUiBtn = $('openUiBtn');
  if (openUiBtn) {
    const url = state && typeof state === 'object' ? state.uiUrl : null;
    const hasUrl = typeof url === 'string' && url.trim();
    let hint = 'Start Agent Zero to enable';
    if (!hasUrl) {
      const active = (state && Array.isArray(state.versions))
        ? state.versions.find((v) => v && v.isActive)
        : null;
      const s = active && typeof active.activeState === 'string' ? active.activeState : '';
      const running = !!active && (!s || String(s).toLowerCase() === 'running');
      if (running) hint = 'Agent Zero is starting. Please wait...';
    }
    openUiBtn.disabled = !hasUrl;
    openUiBtn.title = hasUrl ? '' : hint;
  }

  const keepSelect = $('keepCountSelect');
  if (keepSelect && state.retentionPolicy && typeof state.retentionPolicy.keepCount === 'number') {
    keepSelect.value = String(state.retentionPolicy.keepCount);
  }

  {
    const prefs = state && typeof state === 'object' ? state.portPreferences : null;
    const uiInput = $('portUiInput');
    const sshInput = $('portSshInput');

    if (prefs && typeof prefs === 'object') {
      if (uiInput && document.activeElement !== uiInput && typeof prefs.ui === 'number') {
        uiInput.value = String(prefs.ui);
      }
      if (sshInput && document.activeElement !== sshInput && typeof prefs.ssh === 'number') {
        sshInput.value = String(prefs.ssh);
      }
    }
  }

  const storageUsed = $('storageUsed');
  const storageFree = $('storageFree');
  const storageEstimate = $('storageEstimate');
  const storage = state && typeof state === 'object' ? state.storage : null;

  if (storageUsed) {
    const v = storage && storage.usedBytes !== undefined ? storage.usedBytes : null;
    storageUsed.textContent = v === null ? 'Unavailable' : formatBytes(v);
  }
  if (storageFree) {
    const v = storage && storage.freeBytes !== undefined ? storage.freeBytes : null;
    storageFree.textContent = v === null ? 'Unavailable' : formatBytes(v);
  }
  if (storageEstimate) {
    const v = storage && storage.estimateAfterUpdateBytes !== undefined ? storage.estimateAfterUpdateBytes : null;
    storageEstimate.textContent = v === null ? 'Unavailable' : formatBytes(v);
  }

  const official = [];
  const local = [];

  for (const v of state.versions || []) {
    if (v.category === 'official_release') official.push(v);
    if (v.category === 'local_build') local.push(v);
  }

  // Display the first-class "testing" preview together with local builds (as the first item).
  {
    const testing = (state.versions || []).find((v) => v && v.id === 'testing') || null;
    if (testing) {
      for (let i = official.length - 1; i >= 0; i -= 1) {
        if (official[i] && official[i].id === 'testing') official.splice(i, 1);
      }
      if (!local.some((v) => v && v.id === 'testing')) {
        local.unshift(testing);
      }
    }
  }

  const latest = official.find((v) => Array.isArray(v.channelBadges) && v.channelBadges.includes('latest'));
  const latestDisplayVersion = latest ? latest.displayVersion : '';
  const latestTag = latest ? latest.id : '';

  const officialSubtitle = $('officialSubtitle');
  if (officialSubtitle) {
    if (state.offline) {
      const last = state.lastSyncedAt ? `Last check: ${formatLocalTime(state.lastSyncedAt)}` : 'Last check time unknown';
      officialSubtitle.textContent = `Offline - ${last}`;
    } else {
      const activeLocal = local.find((v) => v.isActive);
      const last = state.lastSyncedAt ? `Last check: ${formatLocalTime(state.lastSyncedAt)}` : '';
      if (activeLocal && latestDisplayVersion) {
        officialSubtitle.textContent = `New official version available: ${latestDisplayVersion}${last ? ` - ${last}` : ''}`;
      } else if (state.lastSyncedAt) {
        officialSubtitle.textContent = `Last check: ${formatLocalTime(state.lastSyncedAt)}`;
      } else {
        officialSubtitle.textContent = '';
      }
    }
  }

  renderList($('officialList'), official, (v) =>
    createVersionRow(v, {
      latestDisplayVersion,
      renderActions: (vv) => {
        const api = window.serviceVersionsAPI;
        if (!api) return null;

        const canUpdate =
          vv.isActive &&
          vv.availability === 'update_available' &&
          latestDisplayVersion &&
          latestTag &&
          !isOffline;

        const canActivate =
          !vv.isActive &&
          vv.availability === 'installed' &&
          vv.availability !== 'installing';

        const canInstall =
          !vv.isActive &&
          vv.availability !== 'installed' &&
          vv.installability !== 'not_yet_available' &&
          vv.availability !== 'installing' &&
          !isOffline;

        const wrap = document.createElement('div');
        wrap.className = 'action-buttons';

        const op = getRunningOperationForVersion(vv);
        if (op) {
          const btnBusy = document.createElement('button');
          btnBusy.className = 'btn btn-small';
          btnBusy.type = 'button';
          btnBusy.disabled = true;
          btnBusy.textContent = operationLabelForVersion(vv, op);
          wrap.appendChild(btnBusy);
          return wrap;
        }

        if (vv.isActive) {
          // Keep Stop/Start in the same place where "Use" would be for inactive versions.
          const s = typeof vv.activeState === 'string' ? vv.activeState : '';
          const running = !s || String(s).toLowerCase() === 'running';

          if (canUpdate) {
            const btnUpdate = document.createElement('button');
            btnUpdate.className = 'btn btn-primary btn-small';
            btnUpdate.type = 'button';
            btnUpdate.textContent = `Update to ${latestDisplayVersion}`;
            btnUpdate.addEventListener('click', async () => {
              const ack = await showDataLossModal({
                title: 'Update Agent Zero',
                detail: `Target version: ${latestDisplayVersion} (${latestTag})`
              });
              if (!ack) return;
              const restoreBtn = beginButtonBusy(btnUpdate, 'Updating...');
              setBanner('info', 'Starting update...');
              try {
                const res = await api.updateToLatest(ack);
                if (isErrorResponse(res)) {
                  setBanner('error', res.message);
                  restoreBtn();
                  return;
                }
                setBanner('info', 'Update started.');
              } catch (e) {
                restoreBtn();
                setBanner('error', e && e.message ? e.message : 'Update failed');
              }
            });
            wrap.appendChild(btnUpdate);
          }

          const btnToggle = document.createElement('button');
          btnToggle.className = running ? 'btn btn-danger btn-small' : 'btn btn-primary btn-small';
          btnToggle.type = 'button';
          btnToggle.textContent = running ? 'Stop' : 'Start';
          btnToggle.addEventListener('click', async () => {
            const restoreBtn = beginButtonBusy(btnToggle, running ? 'Stopping...' : 'Starting...');
            setBanner('info', running ? 'Stopping...' : 'Starting...');
            try {
              const res = running ? await api.stopActive() : await api.startActive();
              if (isErrorResponse(res)) {
                setBanner('error', res.message);
                restoreBtn();
                return;
              }
              setBanner('info', running ? 'Stop requested.' : 'Start requested.');
            } catch (e) {
              restoreBtn();
              setBanner('error', e && e.message ? e.message : running ? 'Stop failed' : 'Start failed');
            }
          });
          wrap.appendChild(btnToggle);
          return wrap;
        }

        if (canUpdate) {
          const btnUpdate = document.createElement('button');
          btnUpdate.className = 'btn btn-primary btn-small';
          btnUpdate.type = 'button';
          btnUpdate.textContent = `Update to ${latestDisplayVersion}`;
          btnUpdate.addEventListener('click', async () => {
            const ack = await showDataLossModal({
              title: 'Update Agent Zero',
              detail: `Target version: ${latestDisplayVersion} (${latestTag})`
            });
            if (!ack) return;
            const restoreBtn = beginButtonBusy(btnUpdate, 'Updating...');
            setBanner('info', 'Starting update...');
            try {
              const res = await api.updateToLatest(ack);
              if (isErrorResponse(res)) {
                setBanner('error', res.message);
                restoreBtn();
                return;
              }
              setBanner('info', 'Update started.');
            } catch (e) {
              restoreBtn();
              setBanner('error', e && e.message ? e.message : 'Update failed');
            }
          });
          wrap.appendChild(btnUpdate);
        }

        if (canActivate) {
          const btnActivate = document.createElement('button');
          btnActivate.className = 'btn btn-small';
          btnActivate.type = 'button';
          btnActivate.textContent = `Use ${vv.displayVersion}`;
          btnActivate.addEventListener('click', async () => {
            const ack = await showDataLossModal({
              title: 'Switch Agent Zero version',
              detail: `Target version: ${vv.displayVersion} (${vv.id})`
            });
            if (!ack) return;
            const restoreBtn = beginButtonBusy(btnActivate, 'Starting...');
            setBanner('info', 'Starting switch...');
            try {
              const res = await api.activateVersion(vv.id, ack);
              if (isErrorResponse(res)) {
                setBanner('error', res.message);
                restoreBtn();
                return;
              }
              setBanner('info', 'Switch started.');
            } catch (e) {
              restoreBtn();
              setBanner('error', e && e.message ? e.message : 'Switch failed');
            }
          });
          wrap.appendChild(btnActivate);
        }

        const canSyncPublished =
          (vv.availability === 'installed' || vv.availability === 'update_available') &&
          vv.installability === 'installable' &&
          vv.differsFromPublished === true &&
          !isOffline;

        if (canSyncPublished) {
          const btnSync = document.createElement('button');
          btnSync.className = 'btn btn-small';
          btnSync.type = 'button';
          btnSync.textContent = 'Sync';
          btnSync.addEventListener('click', async () => {
            const ok = window.confirm(
              'Sync will replace the locally installed image for this version with the published version. Continue?'
            );
            if (!ok) return;
            const restoreBtn = beginButtonBusy(btnSync, 'Syncing...');
            setBanner('info', 'Starting sync...');
            try {
              const res = await api.installOrSync(vv.id);
              if (isErrorResponse(res)) {
                setBanner('error', res.message);
                restoreBtn();
                return;
              }
              setBanner('info', 'Sync started.');
            } catch (e) {
              restoreBtn();
              setBanner('error', e && e.message ? e.message : 'Sync failed');
            }
          });
          wrap.appendChild(btnSync);
        }

        if (canInstall) {
          const btn = document.createElement('button');
          btn.className = 'btn btn-small';
          btn.type = 'button';
          btn.textContent = 'Install';
          btn.addEventListener('click', async () => {
            const restoreBtn = beginButtonBusy(btn, 'Downloading...');
            setBanner('info', 'Starting install...');
            try {
              const res = await api.installOrSync(vv.id);
              if (isErrorResponse(res)) {
                setBanner('error', res.message);
                restoreBtn();
                return;
              }
              setBanner('info', 'Install started.');
            } catch (e) {
              restoreBtn();
              setBanner('error', e && e.message ? e.message : 'Install failed');
            }
          });
          wrap.appendChild(btn);
        }

        return wrap.childNodes.length ? wrap : null;
      }
    })
  );

  renderList($('localList'), local, (v) =>
    createVersionRow(v, {
      extraBadges: CANONICAL_LOCAL_TAGS.has(v.id) ? ['canonical'] : [],
      renderActions: (vv) => {
        const api = window.serviceVersionsAPI;
        if (!api) return null;

        if (vv.id === 'testing') {
          const wrap = document.createElement('div');
          wrap.className = 'action-buttons';

          const op = getRunningOperationForVersion(vv);
          if (op) {
            const btnBusy = document.createElement('button');
            btnBusy.className = 'btn btn-small';
            btnBusy.type = 'button';
            btnBusy.disabled = true;
            btnBusy.textContent = operationLabelForVersion(vv, op);
            wrap.appendChild(btnBusy);
            return wrap;
          }

          if (vv.isActive) {
            const s = typeof vv.activeState === 'string' ? vv.activeState : '';
            const running = !s || String(s).toLowerCase() === 'running';

            const btnToggle = document.createElement('button');
            btnToggle.className = running ? 'btn btn-danger btn-small' : 'btn btn-primary btn-small';
            btnToggle.type = 'button';
            btnToggle.textContent = running ? 'Stop' : 'Start';
            btnToggle.addEventListener('click', async () => {
              const restoreBtn = beginButtonBusy(btnToggle, running ? 'Stopping...' : 'Starting...');
              setBanner('info', running ? 'Stopping...' : 'Starting...');
              try {
                const res = running ? await api.stopActive() : await api.startActive();
                if (isErrorResponse(res)) {
                  setBanner('error', res.message);
                  restoreBtn();
                  return;
                }
                setBanner('info', running ? 'Stop requested.' : 'Start requested.');
              } catch (e) {
                restoreBtn();
                setBanner('error', e && e.message ? e.message : running ? 'Stop failed' : 'Start failed');
              }
            });
            wrap.appendChild(btnToggle);
            return wrap;
          }

          const canActivate =
            !vv.isActive &&
            vv.availability === 'installed' &&
            vv.availability !== 'installing';

          if (canActivate) {
            const btnActivate = document.createElement('button');
            btnActivate.className = 'btn btn-small';
            btnActivate.type = 'button';
            btnActivate.textContent = `Use ${vv.displayVersion}`;
            btnActivate.addEventListener('click', async () => {
              const ack = await showDataLossModal({
                title: 'Switch Agent Zero version',
                detail: `Target version: ${vv.displayVersion} (${vv.id})`
              });
              if (!ack) return;
              const restoreBtn = beginButtonBusy(btnActivate, 'Starting...');
              setBanner('info', 'Starting switch...');
              try {
                const res = await api.activateVersion(vv.id, ack);
                if (isErrorResponse(res)) {
                  setBanner('error', res.message);
                  restoreBtn();
                  return;
                }
                setBanner('info', 'Switch started.');
              } catch (e) {
                restoreBtn();
                setBanner('error', e && e.message ? e.message : 'Switch failed');
              }
            });
            wrap.appendChild(btnActivate);
          }

          const canSyncPublished =
            (vv.availability === 'installed' || vv.availability === 'update_available') &&
            vv.installability === 'installable' &&
            vv.differsFromPublished === true &&
            !isOffline;

          if (canSyncPublished) {
            const btnSync = document.createElement('button');
            btnSync.className = 'btn btn-small';
            btnSync.type = 'button';
            btnSync.textContent = 'Sync';
            btnSync.addEventListener('click', async () => {
              const ok = window.confirm(
                'Sync will replace the locally installed image for this version with the published version. Continue?'
              );
              if (!ok) return;
              const restoreBtn = beginButtonBusy(btnSync, 'Syncing...');
              setBanner('info', 'Starting sync...');
              try {
                const res = await api.installOrSync(vv.id);
                if (isErrorResponse(res)) {
                  setBanner('error', res.message);
                  restoreBtn();
                  return;
                }
                setBanner('info', 'Sync started.');
              } catch (e) {
                restoreBtn();
                setBanner('error', e && e.message ? e.message : 'Sync failed');
              }
            });
            wrap.appendChild(btnSync);
          }

          const canInstall =
            !vv.isActive &&
            vv.availability !== 'installed' &&
            vv.installability !== 'not_yet_available' &&
            vv.availability !== 'installing' &&
            !isOffline;

          if (canInstall) {
            const btn = document.createElement('button');
            btn.className = 'btn btn-small';
            btn.type = 'button';
            btn.textContent = 'Install';
            btn.addEventListener('click', async () => {
              const restoreBtn = beginButtonBusy(btn, 'Downloading...');
              setBanner('info', 'Starting install...');
              try {
                const res = await api.installOrSync(vv.id);
                if (isErrorResponse(res)) {
                  setBanner('error', res.message);
                  restoreBtn();
                  return;
                }
                setBanner('info', 'Install started.');
              } catch (e) {
                restoreBtn();
                setBanner('error', e && e.message ? e.message : 'Install failed');
              }
            });
            wrap.appendChild(btn);
          }

          return wrap.childNodes.length ? wrap : null;
        }

        if (vv.availability !== 'installed') return null;

        const wrap = document.createElement('div');
        wrap.className = 'action-buttons';

        const op = getRunningOperationForVersion(vv);
        if (op) {
          const btnBusy = document.createElement('button');
          btnBusy.className = 'btn btn-small';
          btnBusy.type = 'button';
          btnBusy.disabled = true;
          btnBusy.textContent = operationLabelForVersion(vv, op);
          wrap.appendChild(btnBusy);
          return wrap;
        }

        if (vv.isActive) {
          const s = typeof vv.activeState === 'string' ? vv.activeState : '';
          const running = !s || String(s).toLowerCase() === 'running';

          const btnToggle = document.createElement('button');
          btnToggle.className = running ? 'btn btn-danger btn-small' : 'btn btn-primary btn-small';
          btnToggle.type = 'button';
          btnToggle.textContent = running ? 'Stop' : 'Start';
          btnToggle.addEventListener('click', async () => {
            const restoreBtn = beginButtonBusy(btnToggle, running ? 'Stopping...' : 'Starting...');
            setBanner('info', running ? 'Stopping...' : 'Starting...');
            try {
              const res = running ? await api.stopActive() : await api.startActive();
              if (isErrorResponse(res)) {
                setBanner('error', res.message);
                restoreBtn();
                return;
              }
              setBanner('info', running ? 'Stop requested.' : 'Start requested.');
            } catch (e) {
              restoreBtn();
              setBanner('error', e && e.message ? e.message : running ? 'Stop failed' : 'Start failed');
            }
          });
          wrap.appendChild(btnToggle);
          return wrap;
        }

        const btnActivate = document.createElement('button');
        btnActivate.className = 'btn btn-small';
        btnActivate.type = 'button';
        btnActivate.textContent = `Use ${vv.displayVersion}`;
        btnActivate.addEventListener('click', async () => {
          const ack = await showDataLossModal({
            title: 'Switch Agent Zero version',
            detail: `Target version: ${vv.displayVersion} (${vv.id})`
          });
          if (!ack) return;
          const restoreBtn = beginButtonBusy(btnActivate, 'Starting...');
          setBanner('info', 'Starting switch...');
          try {
            const res = await api.activateVersion(vv.id, ack);
            if (isErrorResponse(res)) {
              setBanner('error', res.message);
              restoreBtn();
              return;
            }
            setBanner('info', 'Switch started.');
          } catch (e) {
            restoreBtn();
            setBanner('error', e && e.message ? e.message : 'Switch failed');
          }
        });
        wrap.appendChild(btnActivate);

        const canSync =
          CANONICAL_LOCAL_TAGS.has(vv.id) &&
          vv.installability === 'installable' &&
          vv.differsFromPublished === true &&
          !isOffline;

        if (canSync) {
          const btnSync = document.createElement('button');
          btnSync.className = 'btn btn-small';
          btnSync.type = 'button';
          btnSync.textContent = 'Sync';
          btnSync.addEventListener('click', async () => {
            const ok = window.confirm('Sync will replace this local build with the published version. Continue?');
            if (!ok) return;
            const restoreBtn = beginButtonBusy(btnSync, 'Syncing...');
            setBanner('info', 'Starting sync...');
            try {
              const res = await api.installOrSync(vv.id);
              if (isErrorResponse(res)) {
                setBanner('error', res.message);
                restoreBtn();
                return;
              }
              setBanner('info', 'Sync started.');
            } catch (e) {
              restoreBtn();
              setBanner('error', e && e.message ? e.message : 'Sync failed');
            }
          });
          wrap.appendChild(btnSync);
        }

        return wrap;
      }
    })
  );

  renderList($('retainedList'), state.retainedInstances || [], (inst) => {
    const row = document.createElement('div');
    row.className = 'item';

    const left = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'item-title';

    const name = document.createElement('span');
    name.textContent = inst.versionTag && inst.versionTag.startsWith('v') ? inst.versionTag.slice(1) : inst.versionTag;
    title.appendChild(name);

    const meta = document.createElement('div');
    meta.className = 'item-meta';
    meta.textContent = `Retained: ${formatLocalTime(inst.retainedAt)}`;

    left.appendChild(title);
    left.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'item-actions';

    const btnRollback = document.createElement('button');
    btnRollback.className = 'btn btn-primary btn-small';
    btnRollback.type = 'button';
    btnRollback.textContent = 'Roll back';
    btnRollback.addEventListener('click', async () => {
      const api = window.serviceVersionsAPI;
      if (!api) return;
      const target = inst.versionTag && inst.versionTag.startsWith('v') ? inst.versionTag.slice(1) : inst.versionTag;
      const ack = await showDataLossModal({
        title: 'Roll back Agent Zero',
        detail: `Target version: ${target} (${inst.versionTag})`
      });
      if (!ack) return;
      setBanner('info', 'Starting rollback...');
      try {
        const res = await api.activateRetainedInstance(inst.containerId, ack);
        if (isErrorResponse(res)) {
          setBanner('error', res.message);
          return;
        }
        setBanner('info', 'Rollback started.');
      } catch (e) {
        setBanner('error', e && e.message ? e.message : 'Rollback failed');
      }
    });

    const btn = document.createElement('button');
    btn.className = 'btn btn-danger btn-small';
    btn.type = 'button';
    btn.textContent = 'Delete';
    btn.addEventListener('click', async () => {
      const api = window.serviceVersionsAPI;
      if (!api) return;
      const ok = window.confirm('Delete this retained instance? This cannot be undone.');
      if (!ok) return;
      setBanner('info', 'Deleting...');
      try {
        const res = await api.deleteRetainedInstance(inst.containerId);
        if (isErrorResponse(res)) {
          setBanner('error', res.message);
          return;
        }
        setBanner('info', 'Delete started.');
      } catch (e) {
        setBanner('error', e && e.message ? e.message : 'Delete failed');
      }
    });
    actions.appendChild(btnRollback);
    actions.appendChild(btn);

    row.appendChild(left);
    row.appendChild(actions);
    return row;
  });
}

let lastProgress = null;

function updateProgress(progress) {
  const panel = $('progressPanel');
  if (!panel) return;

  if (!progress || typeof progress !== 'object' || !progress.opId) {
    panel.classList.add('hidden');
    lastProgress = null;
    return;
  }

  const status = progress.status || '';
  const isRunning = status === 'running';
  if (!isRunning) {
    lastProgress = progress;
    // Keep it visible briefly in future; for now hide when not running.
    panel.classList.add('hidden');
    return;
  }

  panel.classList.remove('hidden');
  lastProgress = progress;

  const title = $('progressTitle');
  const dlLabel = $('progressDownloadLabel');
  const dlPct = $('progressPercent');
  const dlFill = $('progressFill');
  const exLabel = $('progressExtractLabel');
  const exPct = $('progressExtractPercent');
  const exFill = $('progressExtractFill');
  const msg = $('progressMessage');

  const target = progress.targetVersionTag ? ` ${progress.targetVersionTag}` : '';
  if (title) title.textContent = `${progress.type || 'operation'}${target}`;

  const setBar = (pctEl, fillEl, value) => {
    const v = Number.isFinite(Number(value)) ? Math.max(0, Math.min(100, Number(value))) : null;
    if (pctEl) pctEl.textContent = v === null ? '' : `${Math.floor(v)}%`;
    if (fillEl) {
      if (v === null) {
        fillEl.classList.add('indeterminate');
        fillEl.style.width = '35%';
      } else {
        fillEl.classList.remove('indeterminate');
        fillEl.style.transform = '';
        fillEl.style.width = `${v}%`;
      }
    }
  };

  const isPullOp = progress.type === 'install' || progress.type === 'update';
  const exBlock = exFill && typeof exFill.closest === 'function' ? exFill.closest('.progress-block') : null;
  if (!isPullOp) {
    if (dlLabel) dlLabel.textContent = 'Progress';
    if (exBlock) exBlock.style.display = 'none';
    setBar(dlPct, dlFill, progress.progress);
  } else {
    if (dlLabel) dlLabel.textContent = 'Download';
    if (exLabel) exLabel.textContent = 'Extract';
    if (exBlock) exBlock.style.display = '';
    setBar(dlPct, dlFill, progress.downloadProgress);
    setBar(exPct, exFill, progress.extractProgress);
  }

  const message = typeof progress.message === 'string' ? progress.message : '';
  if (msg) msg.textContent = message;

  const cancelBtn = $('cancelBtn');
  if (cancelBtn) {
    const canCancel = progress.type === 'install' || progress.type === 'update';
    cancelBtn.disabled = !canCancel;
    cancelBtn.style.display = canCancel ? 'inline-flex' : 'none';
  }

  {
    const running = progress && typeof progress === 'object' && progress.status === 'running';
    const uiInput = $('portUiInput');
    const sshInput = $('portSshInput');
    if (uiInput) uiInput.disabled = !!running;
    if (sshInput) sshInput.disabled = !!running;
  }

  if (progress && typeof progress === 'object' && progress.status !== 'running') {
    const opId = typeof progress.opId === 'string' ? progress.opId : '';
    const err = typeof progress.error === 'string' ? progress.error : '';
    if (opId && err && lastOpErrorBanner !== opId) {
      lastOpErrorBanner = opId;
      setBanner('error', err);
    }
  }
}

async function loadVersions() {
  const api = window.serviceVersionsAPI;
  if (!api) {
    setBanner('error', 'Agent Zero controls are not available.');
    return;
  }

  try {
    const state = await api.getState();
    if (isErrorResponse(state)) {
      setBanner('error', state.message);
      return;
    }
    renderState(state);
  } catch (e) {
    setBanner('error', e && e.message ? e.message : 'Failed to load state');
  }
}

async function initMeta() {
  try {
    const v = await window.electronAPI?.getContentVersion?.();
    if (v) $('contentVersion').textContent = `Content: ${v}`;
  } catch {
    // ignore
  }

  try {
    const v = await window.electronAPI?.getAppVersion?.();
    if (v) $('appVersion').textContent = `App: ${v}`;
  } catch {
    // ignore
  }
}

function initRetentionSelect() {
  const select = $('keepCountSelect');
  if (!select) return;

  select.innerHTML = '';
  for (let i = 0; i <= 20; i += 1) {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = String(i);
    select.appendChild(opt);
  }

  select.addEventListener('change', async () => {
    const api = window.serviceVersionsAPI;
    if (!api) return;
    const keepCount = Number(select.value);
    setBanner('info', 'Saving...');
    try {
      const res = await api.setRetentionPolicy(keepCount);
      if (isErrorResponse(res)) {
        setBanner('error', res.message);
        return;
      }
      setBanner('info', 'Saved.');
      await loadVersions();
    } catch (e) {
      setBanner('error', e && e.message ? e.message : 'Failed to save');
    }
  });
}

function initPortsInputs() {
  const uiInput = $('portUiInput');
  const sshInput = $('portSshInput');
  if (!uiInput || !sshInput) return;

  const parsePort = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return NaN;
    const p = Math.floor(n);
    if (p <= 0 || p > 65535) return NaN;
    return p;
  };

  const save = async () => {
    const api = window.serviceVersionsAPI;
    if (!api || typeof api.setPortPreferences !== 'function') return;

    const ui = parsePort(uiInput.value);
    const ssh = parsePort(sshInput.value);

    if (!Number.isFinite(ui) || !Number.isFinite(ssh)) {
      setBanner('error', 'Invalid port. Use an integer 1-65535.');
      return;
    }
    if (ui === ssh) {
      setBanner('error', 'Ports must be different.');
      return;
    }

    setBanner('info', 'Saving...');
    try {
      const res = await api.setPortPreferences({ ui, ssh });
      if (isErrorResponse(res)) {
        setBanner('error', res.message);
        return;
      }
      setBanner('info', 'Saved.');
      await loadVersions();
    } catch (e) {
      setBanner('error', e && e.message ? e.message : 'Failed to save');
    }
  };

  for (const el of [uiInput, sshInput]) {
    el.addEventListener('change', () => { save(); });
    el.addEventListener('keydown', (ev) => {
      if (ev && ev.key === 'Enter') {
        ev.preventDefault();
        el.blur();
        save();
      }
    });
  }
}

function initActions() {
  const refreshBtn = $('refreshBtn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
      const api = window.serviceVersionsAPI;
      if (!api) return;
      setBanner('info', 'Refreshing...');
      try {
        const state = await api.refresh();
        if (isErrorResponse(state)) {
          setBanner('error', state.message);
          return;
        }
        renderState(state);
        setBanner('', '');
      } catch (e) {
        setBanner('error', e && e.message ? e.message : 'Refresh failed');
      }
    });
  }

  const openUiBtn = $('openUiBtn');
  if (openUiBtn) {
    openUiBtn.addEventListener('click', async () => {
      const api = window.serviceVersionsAPI;
      if (!api || typeof api.openUi !== 'function') return;
      setBanner('', '');
      try {
        const res = await api.openUi();
        if (isErrorResponse(res)) {
          setBanner('error', res.message);
        }
      } catch (e) {
        setBanner('error', e && e.message ? e.message : 'Unable to open UI');
      }
    });
  }

  const homepageBtn = $('homepageBtn');
  if (homepageBtn) {
    homepageBtn.addEventListener('click', async () => {
      const api = window.serviceVersionsAPI;
      if (!api || typeof api.openHomepage !== 'function') return;
      setBanner('', '');
      try {
        const res = await api.openHomepage();
        if (isErrorResponse(res)) {
          setBanner('error', res.message);
        }
      } catch (e) {
        setBanner('error', e && e.message ? e.message : 'Unable to open homepage');
      }
    });
  }

  const cancelBtn = $('cancelBtn');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', async () => {
      const api = window.serviceVersionsAPI;
      if (!api || !lastProgress || !lastProgress.opId) return;
      setBanner('info', 'Canceling...');
      try {
        const res = await api.cancel(lastProgress.opId);
        if (isErrorResponse(res)) {
          setBanner('error', res.message);
          return;
        }
        if (!res || res.canceled !== true) {
          setBanner('error', 'Unable to cancel this operation.');
          return;
        }
        setBanner('info', 'Cancel requested.');
      } catch (e) {
        setBanner('error', e && e.message ? e.message : 'Cancel failed');
      }
    });
  }
}

function initSubscriptions() {
  const api = window.serviceVersionsAPI;
  if (!api) return;

  api.onStateChange((state) => {
    if (isErrorResponse(state)) {
      setBanner('error', state.message);
      return;
    }
    renderState(state);
  });

  api.onProgress((progress) => {
    updateProgress(progress);
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  initHeaderLogo();
  initMeta();
  initRetentionSelect();
  initPortsInputs();
  initActions();
  initSubscriptions();
  await loadVersions();
});

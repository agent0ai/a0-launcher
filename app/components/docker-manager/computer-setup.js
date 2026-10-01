import { escapeHtml } from './component-utils.js';

const scopes = ['browser', 'computer_use', 'files', 'file_write', 'code_execution'];

export function waitForRestartedHost(events, tabID, initiallyConnected, timeoutMs = 45000) {
  let sawDisconnect = !initiallyConnected;
  let finish;
  let timer;
  const promise = new Promise((resolve, reject) => {
    finish = error => { clearTimeout(timer); events.removeEventListener('dm:state', listener); error ? reject(error) : resolve(); };
  });
  const listener = event => {
    const target = event.detail?.instanceTabs?.tabs?.find(item => item.id === tabID);
    if (!target) return finish(new Error('The computer connection was closed.'));
    const runtime = target.hostAccess || {};
    if (!runtime.connected) sawDisconnect = true;
    if (['error', 'needs_action'].includes(runtime.state) && !runtime.connected) {
      finish(new Error('The computer needs attention. Follow the step shown below.'));
    } else if (sawDisconnect && runtime.connected) finish();
  };
  events.addEventListener('dm:state', listener);
  timer = setTimeout(() => finish(new Error('Connection is taking longer than expected. Check the setup step below.')), timeoutMs);
  // Cancellation may occur while the save itself is still pending.
  promise.catch(() => {});
  return {promise, cancel: () => finish(new Error('Connection check cancelled.'))};
}

export function setupChoices(config = {}) {
  // New guided setup never inherits the legacy file/command defaults.
  const existing = config.configured === true;
  return Object.fromEntries(scopes.map(key => [key, existing && config.scopes?.[key] === true]));
}

export function verificationMessage(result, capability) {
  const evidence = result?.result;
  if (!['browser', 'computer_use'].includes(capability) || result?.accepted !== true || evidence?.verified !== true || evidence.capability !== capability) {
    throw new Error('Connection test did not return verified evidence. Try again.');
  }
  const required = capability === 'browser' ? ['test_page_input', 'fresh_capture'] : ['fresh_capture'];
  if (!Array.isArray(evidence.evidence) || !required.every(item => evidence.evidence.includes(item))) {
    throw new Error('Connection test evidence is incomplete. Try again.');
  }
  return capability === 'browser' ? 'Browser test passed: typing and capture checked on a temporary page.'
    : 'Computer test passed: fresh capture checked. Desktop input was not tested.';
}

export function localSetupSteps(tab) {
  const runtime = tab.hostAccess || {};
  const config = runtime.config || {};
  const enabled = config.configured === true && config.masterEnabled !== false;
  const details = runtime.gateway?.status || {};
  const result = [{id:'connection',state:runtime.connected ? 'ready':'action_on_computer',title:runtime.connected ? 'Computer connected':'Connect this computer',detail:!enabled ? 'Choose access above to connect this Launcher window.':runtime.message || 'Keep this Instance open in Launcher while using your computer.',action:enabled ? 'reconnect':'choose_access'}];
  for (const key of ['browser','computer_use']) {
    const label = key === 'browser' ? 'Browser':'Computer';
    const value = details[key] || {};
    const phase = value.setup?.state || value.status || '';
    const allowed = enabled && config.scopes?.[key] === true;
    const ready = allowed && ['ready','active','persistent','allow'].includes(phase);
    const receipt = details.setup_verifications?.[key];
    let verified = false;
    try {
      verificationMessage({accepted:true,result:receipt}, key);
      const age = Date.now() / 1000 - receipt.checked_at;
      verified = ready && runtime.connected === true && age >= 0 && age <= 300;
    } catch { /* Preparation alone is not verification. */ }
    const reasons = {
      accessibility_required:['Allow Accessibility','Allow Launcher in macOS Accessibility settings.'],
      screen_recording_required:['Allow Screen Recording','Approve the capture permission on this Mac.'],
      restart_required:['Restart Launcher','Save your work, then restart to apply the permission.']
    };
    const copy = reasons[phase];
    result.push({id:key,state:ready ? 'ready':phase === 'checking' ? 'checking':'action_on_computer',
      title:verified ? `${label} tested`:!allowed ? `Allow ${label.toLowerCase()} access`:copy?.[0] || `${label} ${ready ? 'prepared':'setup'}`,
      detail:verified ? (key === 'browser' ? 'Typing and capture checked on a temporary page.' : 'Fresh capture checked. Desktop input was not tested.') : !allowed ? 'Choose access above, then select Connect and check.':copy?.[1] || value.message || 'Select Connect and check to finish setup.',
      action:!allowed ? 'choose_access':phase === 'restart_required' ? 'restart_launcher':key === 'browser' ? 'prepare_browser':'setup_computer', reason:verified ? 'verified':phase});
  }
  return result;
}

export function openComputerSetup(initialTab, state, openAdvanced, resolveConfig = (_state, target) => target.hostAccess?.config || {}) {
  document.getElementById('hostAccessDialog')?.__hostAccessCleanup?.();
  document.getElementById('hostAccessDialog')?.remove();
  let tab = initialTab;
  let latest = state;
  let request = null;
  const requestKey = `a0.setup.request.${tab.id}`;
  let savedRequestID = sessionStorage.getItem(requestKey);
  let busy = false;
  let closed = false;
  let refreshBusy = false;
  let connectionWait = null;
  const originFocus = document.activeElement;
  const config = resolveConfig(state, tab);
  const choices = setupChoices(config);
  const dialog = document.createElement('div');
  dialog.id = 'hostAccessDialog';
  dialog.className = 'dm-dialog-backdrop';
  dialog.innerHTML = `<section class="dm-dialog dm-computer-setup" role="dialog" aria-modal="true" aria-labelledby="computerSetupTitle">
    <header class="dm-dialog-header"><div><small>${escapeHtml(tab.title || 'Agent Zero')} · On this computer</small><h2 id="computerSetupTitle">Connect your computer</h2></div><button type="button" class="button" data-close aria-label="Close setup">×</button></header>
    <div class="dm-dialog-body">
      <p>Choose what A0 can use. We’ll guide you through any browser or system permissions.</p>
      <div class="dm-setup-choices">${['browser','computer_use'].map(key => `<label><input type="checkbox" data-choice="${key}" ${choices[key] ? 'checked':''}> ${key === 'browser' ? 'Use my browser':'Use my computer'}</label>`).join('')}</div>
      <button type="button" class="button confirm" data-allow>Connect and check</button>
      <p class="dm-field-hint">Allows the selected access, connects, and checks it automatically. Approve any browser or system prompt on this computer.</p>
      <p class="dm-field-hint" data-consent>${config.configured ? 'Your other saved permissions stay unchanged.':'Files and command access stay off. You can choose them in Advanced settings.'}</p>
      <ol class="dm-setup-steps" data-steps aria-label="Setup progress"></ol>
      <p class="dm-field-hint" data-freshness role="status"></p>
      <details><summary>Continue setup from another device</summary><p>Sign in to the same Agent Zero server, then enter its setup code. This does not grant access.</p><label>Setup code <input class="dm-text-input" data-code maxlength="16" autocomplete="off" spellcheck="false" placeholder="ABCD-EFGH-JKLM"></label><button type="button" class="button" data-claim>Connect setup</button><p data-pair-state role="status"></p></details>
      <details><summary>Help with setup</summary><p>Browser access controls the selected browser profile. Computer access sees and controls desktop apps. Keep this Instance open and your computer awake.</p><p>On Safari, enable Show features for web developers under Advanced, then Allow remote automation in Developer settings. Chromium browsers may ask you to allow remote debugging.</p><p>On macOS, finish Accessibility before Screen Recording. Return here after changing a setting; we’ll check again.</p></details>
      <details><summary>Sign-in, tunnels and locked computers</summary><p>A tunnel connects to your server; Agent Zero’s UI login protects access to it. A persistent tunnel address does not keep your login session signed in, and it does not require locking your computer.</p><p>After signing in, you can choose to save credentials in Launcher’s secure storage. Launcher can then recover an expired Agent Zero session when those credentials remain valid and storage is available.</p><p>If a fresh sign-in or system unlock is needed, complete it on the computer. Your phone cannot unlock it. An offline computer alone does not tell us whether it is locked, signed out or asleep. Reconnecting does not clear a host-action hold.</p></details>
    </div>
    <footer class="dm-dialog-footer"><button type="button" class="button" data-advanced>Advanced settings</button><button type="button" class="button" data-refresh>Check again</button><button type="button" class="button confirm" data-close>Done</button></footer>
  </section>`;
  const style = document.createElement('style');
  style.textContent = `.dm-computer-setup{width:min(660px,calc(100vw - 32px));max-height:min(760px,calc(100dvh - 40px))}.dm-computer-setup .dm-dialog-body{display:block;overflow:auto}.dm-computer-setup h2{margin:8px 0 0;font-size:1.25rem}.dm-computer-setup p{line-height:1.45;margin:10px 0}.dm-setup-choices{display:flex;gap:20px;flex-wrap:wrap;margin:10px 0}.dm-setup-choices label{display:flex;align-items:center;gap:8px;min-height:44px}.dm-setup-steps{list-style:none;margin:20px 0;padding:0}.dm-setup-steps li{padding:14px 0;border-top:1px solid var(--color-border)}.dm-setup-steps li strong{display:block}.dm-setup-steps p{margin:6px 0;opacity:.8}.dm-setup-steps .button{margin-top:6px}.dm-computer-setup summary{cursor:pointer;min-height:44px;align-content:center}.dm-computer-setup .dm-dialog-footer{flex-wrap:wrap}.dm-computer-setup button:focus-visible,.dm-computer-setup input:focus-visible{outline:2px solid currentColor;outline-offset:3px}`;
  dialog.append(style);
  const testResult = document.createElement('p');
  testResult.setAttribute('role', 'status');
  testResult.hidden = true;
  dialog.querySelector('.dm-dialog-body').append(testResult);
  const renderSteps = steps => {
    if (closed || busy) return;
    dialog.querySelector('[data-steps]').innerHTML = steps.filter(s=>s.id === 'connection' ||
      (['browser','computer_use'].includes(s.id) && dialog.querySelector(`[data-choice="${s.id}"]`).checked)).map(step => {
      const ready = step.state === 'ready';
      const actions = {prepare_browser:'Prepare browser',setup_computer:'Check computer permissions',restart_launcher:'Restart Launcher',reconnect:'Reconnect',open_launcher:'Advanced settings'};
      const action = actions[step.action];
      const canTest = step.reason !== 'verified' && (ready || step.reason === 'ready_to_test') && ['browser','computer_use'].includes(step.id);
      if (ready) step = {...step, help_text:''};
      return `<li><strong>${ready ? '✓ ':''}${escapeHtml(step.title)}</strong><p>${escapeHtml(step.detail)}</p>${!ready && action ? `<button type="button" class="button" data-step="${escapeHtml(step.action)}" data-reason="${escapeHtml(step.reason || '')}">${action}</button>`:''}${canTest ? `<p>${step.id === 'browser' ? 'Opens a temporary test page to check typing and capture.':'Checks a fresh capture without clicking or typing. Approve any system prompt yourself.'}</p><button type="button" class="button" data-test="${step.id}">Test ${step.id === 'browser' ? 'browser':'computer'}</button>`:''}${step.help_text ? `<details><summary>Show me how</summary><p>${escapeHtml(step.help_text)}</p></details>`:''}</li>`;
    }).join('');
  };
  const refresh = async () => {
    if (closed || refreshBusy || document.hidden) return;
    refreshBusy = true;
    try {
      const result = await window.dockerManagerActions.hostSetup(tab.id,'status');
      if (closed) return;
      // This assistant controls this computer only, never another connected host.
      const localID = tab.hostAccess?.gateway?.id;
      renderSteps(localID && result.host_id === localID && Array.isArray(result.steps) ? result.steps : localSetupSteps(tab));
      dialog.querySelector('[data-freshness]').textContent = localID && result.host_id === localID ? 'Server and computer checked just now.':'Server checked. Complete local setup in this Launcher window.';
      if (savedRequestID || (request && !['cancelled','confirmed'].includes(request.state))) {
        request = await window.dockerManagerActions.hostSetup(tab.id,'read',{request_id:savedRequestID || request.request_id});
        savedRequestID=null;
        if (!closed) dialog.querySelector('[data-pair-state]').textContent = request.state === 'confirmed'
          ? 'Confirmed on the other device. Review the choices above and allow access here.'
          : `Check “${request.host_label}” on the other device and confirm this computer.`;
      }
    } catch (error) {
      if (!closed) { renderSteps(localSetupSteps(tab)); dialog.querySelector('[data-freshness]').textContent = error.message; }
    } finally { refreshBusy = false; }
  };
  const close = () => { dialog.__hostAccessCleanup(); dialog.remove(); window.dockerManagerActions?.syncInstanceTabBounds?.(); originFocus?.focus?.(); };
  dialog.addEventListener('change',event=> {
    if (event.target.matches('[data-choice]')) renderSteps(localSetupSteps(tab));
  });
  const onState = event => {
    latest = event.detail;
    const updated = latest.instanceTabs?.tabs?.find(item=>item.id === tab.id);
    if (!updated) { close();return; }
    tab = updated;
    renderSteps(localSetupSteps(tab));
  };
  dialog.addEventListener('keydown',event=> {
    if (event.key === 'Escape') close();
    if (event.key === 'Tab') {
      const items = [...dialog.querySelectorAll('button,input,summary')].filter(x=>!x.disabled && x.getClientRects().length);
      if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault();items.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault();items[0]?.focus(); }
    }
  });
  dialog.addEventListener('click',async event=> {
    const button = event.target.closest('button');
    if (!button || busy) return;
    if (button.hasAttribute('data-close')) { close();return; }
    if (button.hasAttribute('data-advanced') || button.dataset.step === 'open_launcher') { close();openAdvanced(tab,latest);return; }
    busy = true;button.disabled = true;
    try {
      if (button.hasAttribute('data-allow')) {
        if (request && request.state !== 'confirmed') throw new Error('Confirm this computer on the original device first.');
        for (const key of ['browser','computer_use']) choices[key] = dialog.querySelector(`[data-choice="${key}"]`).checked;
        if (!choices.browser && !choices.computer_use) throw new Error('Choose Browser or Computer access first.');
        const current = resolveConfig(latest,tab);
        const selected = {...setupChoices(current),browser:choices.browser,computer_use:choices.computer_use};
        testResult.hidden = false;
        testResult.textContent = 'Connecting your computer…';
        connectionWait = waitForRestartedHost(window, tab.id, tab.hostAccess?.connected === true);
        const result = await window.dockerManagerActions.setInstanceHostAccess(tab,{...current,configured:true,masterEnabled:true,scopes:selected});
        if (result === false) throw new Error('Access was not saved. Check the message and try again.');
        await connectionWait.promise;
        connectionWait = null;
        for (const capability of ['browser','computer_use']) {
          if (closed) break;
          if (!selected[capability]) continue;
          const step = localSetupSteps(tab).find(item => item.id === capability);
          if (capability === 'computer_use' && step.state !== 'ready') continue;
          testResult.textContent = capability === 'browser' ? 'Connecting your browser. Approve Chrome’s prompt if shown…' : 'Checking a fresh computer capture…';
          const verification = await window.dockerManagerActions.hostGatewayCommand(tab.id,'verify_host_setup',{capability});
          if (verification === false) throw new Error('The connection check needs attention. Follow the setup step below.');
          if (!closed) testResult.textContent = verificationMessage(verification, capability);
        }
      } else if (button.hasAttribute('data-claim')) {
        request = await window.dockerManagerActions.hostSetup(tab.id,'claim',{code:dialog.querySelector('[data-code]').value});
        sessionStorage.setItem(requestKey,request.request_id);
        for (const key of ['browser','computer_use']) dialog.querySelector(`[data-choice="${key}"]`).checked = request.capabilities.includes(key);
        dialog.querySelector('[data-pair-state]').textContent = `Confirm “${request.host_label}” on the original device. Then allow access here.`;
      } else if (button.dataset.test) {
        testResult.hidden = false;
        testResult.textContent = 'Checking the selected capability…';
        const result = await window.dockerManagerActions.hostGatewayCommand(tab.id,'verify_host_setup',{capability:button.dataset.test});
        if (result === false) throw new Error('Connection test did not complete. Check the host status and try again.');
        if (!closed) testResult.textContent = verificationMessage(result, button.dataset.test);
      } else if (button.dataset.step) {
        const action = {setup_computer:'setup_computer_use',restart_launcher:'restart_computer_use'}[button.dataset.step] || button.dataset.step;
        if (action === 'reconnect' && tab.hostAccess?.suppressed !== true) await window.dockerManagerActions.retryHostGateway(tab.id);
        else await window.dockerManagerActions.hostGatewayCommand(tab.id,action,{prompt:['accessibility_required','screen_recording_required'].includes(button.dataset.reason)});
      }
      await refresh();
    } catch (error) {
      if (!closed) { testResult.hidden = false; testResult.textContent = error.message; }
      window.toastFrontendError?.(error.message,'Computer setup');
    }
    finally { connectionWait?.cancel(); connectionWait=null; busy=false;button.disabled=false; await refresh(); }
  });
  const timer = window.setInterval(refresh,5000);
  dialog.__hostAccessCleanup = () => { closed=true;connectionWait?.cancel();clearInterval(timer);window.removeEventListener('dm:state',onState); };
  window.addEventListener('dm:state',onState);
  document.body.append(dialog);
  window.dockerManagerActions?.hideInstanceTabView?.();
  renderSteps(localSetupSteps(tab));
  dialog.querySelector('[data-close]').focus();
  void refresh();
  return true;
}

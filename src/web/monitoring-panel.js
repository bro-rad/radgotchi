/* Radgotchi monitoring: read-only, same-origin, dependency-free. */
(function () {
  'use strict';
  const byId = id => document.getElementById(id);
  function node(tag, text) {
    const element = document.createElement(tag);
    element.textContent = text;
    return element;
  }
  const count = value => Number.isSafeInteger(value) && value >= 0;
  const timestamp = value => value === null || (typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value)));
  function valid(data) {
    return data && ['unconfigured', 'connected', 'stale', 'error'].includes(data.sourceStatus) &&
      data.coverage === 'package-status-only' && data.containerIdentityAvailable === false &&
      timestamp(data.observedAt) && timestamp(data.lastSuccessAt) && count(data.reportedRows) &&
      Array.isArray(data.packages) && data.packages.every(pkg => pkg && typeof pkg.name === 'string' &&
        Array.isArray(pkg.versions) && pkg.versions.every(version => typeof version === 'string') &&
        count(pkg.reportedRows) && pkg.states && typeof pkg.states === 'object' && !Array.isArray(pkg.states) &&
        Object.values(pkg.states).every(count));
  }
  // Only currently observed feed/package evidence belongs here; never health.
  function observationExpression(data, selectedName = null) {
    const state = data.sourceStatus;
    const pkg = state === 'connected' && data.packages?.find(item => item.name === selectedName);
    if (pkg) {
      const entries = Object.entries(pkg.states).filter(([, value]) => value > 0);
      const complete = pkg.reportedRows > 0 && entries.reduce((sum, [, value]) => sum + value, 0) === pkg.reportedRows;
      let evidence = 'unknown';
      if (complete && entries.every(([name]) => name === 'running')) evidence = 'running';
      else if (complete && entries.every(([name]) => ['exited', 'stopped'].includes(name))) evidence = 'stopped';
      else if (complete && entries.every(([name]) => ['running', 'exited', 'stopped'].includes(name))) evidence = 'mixed';
      const faces = {running:'MOTIVATED', stopped:'BORED', mixed:'LONELY', unknown:'AWAKE'};
      return {face:faces[evidence], label:'Package · ' + evidence, scope:'package', evidence};
    }
    const faces = {
      connected: ['AWAKE', 'Feed connected'],
      unconfigured: ['BORED', 'Feed not configured'],
      stale: ['LONELY', 'Feed stale'],
      error: ['BROKEN', 'Feed unavailable'],
      waiting: ['BORED', 'Waiting for feed'],
      unauthorized: ['ANGRY', 'Feed login required']
    };
    const [face, label] = faces[state];
    return {face, label, scope:'feed', evidence:state};
  }
  let selectedName = null;
  let snapshot = null;
  let feedState = 'waiting';
  let requestMessage = '';
  let selections = [];
  function expression(state) {
    feedState = state;
    const {face, label, scope} = observationExpression({...snapshot, sourceStatus:state}, selectedName);
    const sprite = byId('web-sprite');
    sprite.src = '/assets/gotchi/' + face + '.png';
    sprite.alt = label;
    sprite.title = label;
    byId('request-status').textContent = (scope === 'package' ? label + ' · ' : '') + requestMessage;
    for (const [name, button] of selections) {
      button.ariaPressed = String(name === selectedName);
      button.className = 'header-btn node-id' + (name === selectedName ? ' active' : '');
    }
    byId('feed-selection').ariaPressed = String(selectedName === null);
    byId('feed-selection').className = 'header-btn' + (selectedName === null ? ' active' : '');
  }
  byId('feed-selection').onclick = () => { selectedName = null; expression(feedState); };
  function render(data) {
    if (!valid(data)) throw new Error('Unsupported monitoring response');
    snapshot = data;
    if (!data.packages.some(pkg => pkg.name === selectedName)) selectedName = null;
    const focusedName = selections.find(([, button]) => button === document.activeElement)?.[0];
    selections = [];
    byId('source-status').textContent = 'Source: ' + data.sourceStatus;
    byId('freshness').textContent = 'Observed: ' + (data.observedAt || '—') +
      ' · Last success: ' + (data.lastSuccessAt || '—');
    byId('reported-rows').textContent = String(data.reportedRows);
    byId('package-count').textContent = String(data.packages.length);
    const packages = data.packages.map(pkg => {
      const item = node('li', '');
      item.className = 'network-node';
      const info = node('div', ''); info.className = 'node-info';
      const top = node('div', ''); top.className = 'node-top-row';
      const name = node('button', pkg.name); name.className = 'header-btn node-id';
      name.type = 'button';
      name.title = 'Select package observations';
      name.onclick = () => { selectedName = pkg.name; expression(feedState); };
      selections.push([pkg.name, name]);
      const rows = node('span', pkg.reportedRows + ' rows'); rows.className = 'network-node-count';
      top.append(name, rows);
      const versions = node('p', 'Versions: ' + (pkg.versions.join(', ') || 'unknown'));
      versions.className = 'node-operator';
      const states = node('ul', ''); states.className = 'package-states';
      for (const [state, count] of Object.entries(pkg.states)) states.append(node('li', state + ': ' + count));
      info.append(top, versions, states);
      item.append(info);
      return item;
    });
    if (!packages.length) {
      const empty = node('li', 'No observations'); empty.className = 'network-empty'; packages.push(empty);
    }
    byId('package-list').replaceChildren(...packages);
    if (focusedName !== undefined) {
      const target = selections.find(([name]) => name === focusedName)?.[1] || byId('feed-selection');
      target.focus({preventScroll: true});
    }
    const messages = {
      connected: 'Connected · Refresh 30s',
      stale: 'Stale · Last successful observations · Refresh 30s',
      unconfigured: 'Not configured · Refresh 30s',
      error: 'Source error · Retained data stale · Refresh 30s'
    };
    requestMessage = messages[data.sourceStatus];
    expression(data.sourceStatus);
    armFreshness();
  }
  // Three nominal refresh intervals; age is observation time, not HTTP receipt.
  const OBSERVATION_STALE_AFTER_MS = 90000;
  let freshnessTimer;
  let freshnessGeneration = 0;
  function clearFreshness() {
    freshnessGeneration++;
    clearTimeout(freshnessTimer);
  }
  function armFreshness() {
    clearFreshness();
    if (snapshot?.sourceStatus !== 'connected') return;
    const remaining = Math.min(Date.parse(snapshot.observedAt), Date.parse(snapshot.lastSuccessAt), Date.now()) + OBSERVATION_STALE_AFTER_MS - Date.now();
    const generation = freshnessGeneration;
    const expire = () => {
      if (generation !== freshnessGeneration) return;
      byId('source-status').textContent = 'Source: stale';
      requestMessage = 'Stale · Last successful observations · Refresh 30s';
      expression('stale');
    };
    if (!Number.isFinite(remaining) || remaining <= 0) expire();
    else if (!stopped) freshnessTimer = setTimeout(expire, remaining);
  }
  let stopped = true;
  let timer;
  let controller;
  let requestTimeout;
  async function poll() {
    const request = new AbortController();
    controller = request;
    const active = () => !stopped && controller === request;
    const timeout = setTimeout(() => request.abort(), 10000);
    requestTimeout = timeout;
    try {
      const response = await fetch('/api/monitoring/package-status', {
        method: 'GET', credentials: 'same-origin', cache: 'no-store',
        redirect: 'error', headers: { Accept: 'application/json' }, signal: request.signal
      });
      if (!active()) return;
      if (response.status === 401) {
        clearFreshness();
        selectedName = null;
        snapshot = null;
        selections = [];
        stopped = true;
        byId('package-list').replaceChildren();
        byId('source-status').textContent = 'Source: unauthorized';
        byId('freshness').textContent = 'Observed: — · Last success: —';
        byId('reported-rows').textContent = '—';
        byId('package-count').textContent = '—';
        byId('login-link').hidden = false;
        requestMessage = 'Login required · Polling paused';
        expression('unauthorized');
        return;
      }
      if (!response.ok) throw new Error('Monitoring request failed');
      const data = await response.json();
      if (active()) {
        render(data);
      }
    } catch (_) {
      if (active()) {
        clearFreshness();
        byId('source-status').textContent = 'Source: unavailable (refresh failed)';
        requestMessage = 'Refresh failed · Retained data stale · Retry 30s';
        expression('error');
      }
    } finally {
      clearTimeout(timeout);
      if (active()) timer = setTimeout(() => { if (active()) return poll(); }, 30000);
    }
  }
  function start() {
    if (!stopped) return;
    stopped = false;
    requestMessage = 'Waiting for feed';
    expression('waiting');
    armFreshness();
    return poll();
  }
  function stop() {
    stopped = true;
    clearTimeout(timer);
    clearTimeout(requestTimeout);
    clearFreshness();
    if (controller) controller.abort();
  }
  globalThis.RadgotchiMonitoring = { render, start, stop, observationExpression };
  // The deferred classic script runs after the static shell has been parsed.
  if (document.currentScript) start();
}());

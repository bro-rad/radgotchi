/* Local adaptation of Radgotchi's MIT-licensed pomodoro UI (itsTylerIRL/radgotchi).
 * Original: chat.html, src/main/pomodoro.js, src/styles/chat-window.css.
 * No legacy bridge, XP, pet mutations, notifications, audio or auto-start.
 * Load after chat-window.css + companion-activities.css; call init(document, storage).
 * Storage is optional and must be supplied explicitly; never read global localStorage.
 * Mount: #companion-activities. Missing mount is a safe no-op. Call destroy on logout.
 * Arcade audit: src/chat/arcade.js delegates coinflip/blackjack to electronAPI;
 * src/main/arcade.js owns XP wagers, persistence and broadcasts. Neither is a
 * reusable standalone frontend game. No pretend XP economy or replacement game.
 */
(function (global) {
  'use strict';
  const mounted = new WeakMap();
  function init(document, storage) {
    const mount = document.getElementById('companion-activities');
    if (!mount) return {destroy() {}};
    if (mounted.has(mount)) return mounted.get(mount);
    const region = document.createElement('section');
    region.className = 'rg-activities';
    region.setAttribute('aria-label', 'Local focus timer');
    const heading = document.createElement('h2');
    heading.textContent = 'LOCAL FOCUS';
    const bar = document.createElement('div');
    bar.className = 'pomodoro-bar visible work-mode';
    const modeLabel = document.createElement('span');
    modeLabel.className = 'pomo-mode work'; modeLabel.textContent = 'WORK';
    const timer = document.createElement('span');
    timer.className = 'pomo-timer'; timer.textContent = '25:00';
    timer.setAttribute('role', 'timer'); timer.setAttribute('aria-live', 'off');
    const start = document.createElement('button');
    start.type = 'button'; start.className = 'pomo-btn start'; start.textContent = 'START WORK';
    const pause = document.createElement('button');
    pause.type = 'button'; pause.className = 'pomo-btn stop'; pause.textContent = 'PAUSE';
    const reset = document.createElement('button');
    reset.type = 'button'; reset.className = 'pomo-btn stop'; reset.textContent = 'RESET';
    const count = document.createElement('span'); count.className = 'pomo-count';
    const status = document.createElement('p');
    status.className = 'rg-activities-status';
    status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    let completed = 0, mode = 'work';
    const storageKey = 'radgotchi.local-focus.v1';
    try {
      const raw = storage?.getItem(storageKey);
      const data = typeof raw === 'string' && raw.length <= 1024 ? JSON.parse(raw) : null;
      if (data && data.version === 1 && Number.isInteger(data.completed) && data.completed >= 0 && data.completed <= 1000000) completed = data.completed;
    } catch (_) { /* Storage is optional, including malformed data/private mode. */ }
    function save() {
      try { storage?.setItem(storageKey, JSON.stringify({version: 1, completed})); }
      catch (_) { /* Keep working in memory if storage is unavailable. */ }
    }
    function duration() { return (mode === 'work' ? 25 : completed > 0 && completed % 4 === 0 ? 15 : 5) * 60 * 1000; }
    let remaining = duration(), deadline = 0, interval = null, destroyed = false;
    function stop() {
      if (interval !== null) clearInterval(interval);
      interval = null;
    }
    function render() {
      const seconds = Math.ceil(remaining / 1000);
      timer.textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
      start.textContent = remaining < duration() ? 'RESUME' : `START ${mode.toUpperCase()}`;
      modeLabel.textContent = mode.toUpperCase(); modeLabel.className = `pomo-mode ${mode}`;
      bar.className = `pomodoro-bar visible ${mode}-mode`;
      count.textContent = `LOCAL COMPLETED: ${completed}`;
      start.disabled = interval !== null;
      pause.disabled = interval === null;
    }
    function emit(type) {
      if (typeof global.CustomEvent === 'function') document.dispatchEvent(new global.CustomEvent(type));
    }
    function tick() {
      if (destroyed || interval === null) return;
      remaining = Math.max(0, deadline - Date.now());
      if (remaining === 0) {
        stop();
        status.textContent = `${mode.toUpperCase()} COMPLETE`;
        if (mode === 'work') { completed = Math.min(1000000, completed + 1); save(); }
        mode = mode === 'work' ? 'break' : 'work';
        remaining = duration();
        render();
        emit('radgotchi:pomodoro-complete');
      }
      render();
    }
    function onStart() {
      if (destroyed || interval !== null) return;
      deadline = Date.now() + remaining;
      interval = setInterval(tick, 250);
      render();
      emit('radgotchi:pomodoro-start');
    }
    function onPause() {
      if (destroyed || interval === null) return;
      tick(); stop(); render();
    }
    function onReset() {
      if (destroyed) return;
      stop(); remaining = duration(); status.textContent = 'RESET'; render();
    }
    const listeners = [[start, onStart], [pause, onPause], [reset, onReset]];
    for (const [button, handler] of listeners) button.addEventListener('click', handler);
    bar.append(modeLabel, timer, count, start, pause, reset);
    region.append(heading, bar, status); mount.append(region); render();
    const api = {destroy() {
      if (destroyed) return;
      destroyed = true; stop();
      for (const [button, handler] of listeners) button.removeEventListener('click', handler);
      region.remove(); mounted.delete(mount);
    }};
    mounted.set(mount, api);
    return api;
  }
  global.RadgotchiActivities = {init};
})(globalThis);

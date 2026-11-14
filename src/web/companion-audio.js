/* Radgotchi UI audio, derived from src/renderer/sounds.js (Tyler, MIT).
 * Explicit integration: RadgotchiAudio.init(document, storage), then play(name).
 * Optional #companion-audio receives a native opt-in button and volume slider.
 * Never imports the legacy bridge or auto-initializes. Volume alone is persisted;
 * every init starts muted. No samples, capture, streams, network or permissions.
 * Original selectChange/chatClose/sleep/pomodoro tones retain their score.
 * click retains original oscillators; original random noise layer is omitted.
 * Not restored: system/microphone listening, music/voice classification, dancing
 * and cross-window audio-level IPC (audio-reactive.js/chat/equalizer.js). These
 * need owner approval and a separately scoped consent/privacy design. No fake
 * infrastructure levels are used. Boot/XP/level/anthem/attention and message
 * cues are not wired: their original activity/privileged owners must authorize
 * integration. The data-audio-active indicator means ONLY our own UI sound.
 */
(function (global) {
  'use strict';
  // [waveform, Hz, offset seconds, duration seconds, envelope peak]
  const scores = Object.freeze({
    selectChange: [['square',440,0,.03,.18],['sine',660,.02,.04,.12]],
    click: [['square',220,0,.03,.25],['sine',440,0,.05,.2]],
    chatClose: [['square',600,0,.05,.15],['square',400,.04,.06,.12],['square',250,.09,.08,.1]],
    sleepStart: [['sine',600,0,.2,.15],['sine',500,.15,.2,.12],['sine',400,.3,.25,.1],['sine',300,.45,.3,.08]],
    sleepEnd: [['sine',400,0,.1,.1],['sine',500,.08,.1,.12],['sine',700,.16,.12,.15],['sine',900,.25,.15,.18]],
    pomodoroStart: [['sine',440,0,.15,.15],['sine',550,.12,.15,.15],['sine',660,.24,.2,.18]],
    pomodoroComplete: [['sine',880,0,.3,.2],['sine',1100,0,.25,.1],['sine',880,.35,.3,.15],['sine',1100,.35,.25,.08]]
  });
  const instances = new WeakMap();
  global.RadgotchiAudio = Object.freeze({init(document, storage) {
    if (instances.has(document)) return instances.get(document);
    const host = document.getElementById('companion-audio');
    let context, master, muted = true, destroyed = false, generation = 0;
    let volume = .5, nextTime = 0;
    const voices = new Set();
    const button = document.createElement('button');
    button.type = 'button'; button.id = 'rg-audio-toggle';
    function render() {
      button.textContent = muted ? 'SOUND OFF' : 'SOUND ON';
      button.setAttribute('aria-pressed', String(!muted));
      button.setAttribute('aria-label', muted ? 'Enable UI sounds' : 'Mute UI sounds');
    }
    function quiet() {
      muted = true; generation++; render();
      if (master) master.gain.value = 0;
      for (const voice of Array.from(voices)) voice.stop();
      host?.setAttribute('data-audio-active', 'false');
      if (context && context.state !== 'closed') {
        try { Promise.resolve(context.suspend()).catch(() => {}); } catch (_) {}
      }
    }
    async function toggle(event) {
      if (!event.isTrusted || destroyed || document.hidden) return;
      if (!muted) { quiet(); return; }
      const ticket = ++generation;
      try {
        if (!context) {
          const AudioContext = document.defaultView?.AudioContext || document.defaultView?.webkitAudioContext;
          if (!AudioContext) return;
          context = new AudioContext();
          master = context.createGain(); master.gain.value = 0; master.connect(context.destination);
        }
        await context.resume();
        if (destroyed || ticket !== generation || document.hidden || context.state !== 'running') return;
        muted = false; master.gain.value = volume; render();
      } catch (_) { quiet(); }
    }
    function play(name) {
      if (destroyed || muted || document.hidden || !context || context.state !== 'running' || volume === 0 ||
          !Object.prototype.hasOwnProperty.call(scores, name) || voices.size || context.currentTime < nextTime) return false;
      const now = context.currentTime;
      try {
        for (const [type, frequency, offset, duration, peak] of scores[name]) {
          const osc = context.createOscillator(), gain = context.createGain();
          const cleanup = () => {
            osc.onended = null; osc.disconnect(); gain.disconnect(); voices.delete(voice);
            if (!voices.size) host?.setAttribute('data-audio-active', 'false');
          };
          const voice = {stop() {try {osc.stop();} catch (_) {} cleanup();}};
          voices.add(voice); osc.onended = cleanup;
          const start = now + offset;
          osc.type = type; osc.frequency.setValueAtTime(frequency, start);
          gain.gain.setValueAtTime(0, start);
          gain.gain.linearRampToValueAtTime(peak, start + .01);
          gain.gain.exponentialRampToValueAtTime(.001, start + duration);
          osc.connect(gain); gain.connect(master); osc.start(start); osc.stop(start + duration);
        }
        nextTime = now + .08;
        host?.setAttribute('data-audio-active', 'true');
        return true;
      } catch (_) { quiet(); return false; }
    }
    button.addEventListener('click', toggle); render(); host?.appendChild(button);
    const label = document.createElement('label'); label.textContent = 'UI VOLUME ';
    const slider = document.createElement('input'); slider.type = 'range';
    slider.id = 'rg-audio-volume'; slider.min = '0'; slider.max = '0.5'; slider.step = '0.01';
    slider.setAttribute('aria-label', 'UI sound volume');
    const boundedVolume = value => {
      const n = Number(value); return Number.isFinite(n) ? Math.max(0, Math.min(.5, n)) : .5;
    };
    try { const saved = storage?.getItem('radgotchi-ui-audio-volume'); if (saved !== null && saved !== undefined) volume = boundedVolume(saved); } catch (_) {}
    slider.value = String(volume); label.appendChild(slider); host?.appendChild(label);
    function changeVolume() {
      volume = boundedVolume(slider.value); slider.value = String(volume);
      if (master) master.gain.value = muted ? 0 : volume;
      try { storage?.setItem('radgotchi-ui-audio-volume', String(volume)); } catch (_) {}
    }
    function visibility() { if (document.hidden) quiet(); }
    slider.addEventListener('input', changeVolume);
    document.addEventListener('visibilitychange', visibility);
    const api = {play, destroy() {
      if (destroyed) return;
      instances.delete(document);
      destroyed = true; quiet(); button.removeEventListener('click', toggle); button.remove();
      slider.removeEventListener('input', changeVolume); label.remove();
      document.removeEventListener('visibilitychange', visibility);
      if (master) master.disconnect();
      if (context) { try { Promise.resolve(context.close()).catch(() => {}); } catch (_) {} }
    }};
    instances.set(document, api); return api;
  }});
})(globalThis);

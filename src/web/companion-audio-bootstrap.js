/* Optional CSP-safe audio composition. Include deferred after companion-audio.js.
 * The mount and explicit script inclusion opt this page into UI controls only;
 * RadgotchiAudio still requires trusted user enable on every mount.
 */
(function (global) {
  'use strict';
  if (global.RadgotchiAudioBootstrap) return;
  let instance;
  function start() {
    if (instance || !document.getElementById('companion-audio') || !global.RadgotchiAudio) return;
    let storage;
    try { storage = global.localStorage; } catch (_) { /* Optional storage. */ }
    instance = global.RadgotchiAudio.init(document, storage);
    for (const [type, handler] of listeners) document.addEventListener(type, handler);
  }
  function onClick(event) {
    if (!event.isTrusted || event.defaultPrevented) return;
    const button = event.target?.closest?.('#rg-interactions-pet, #rg-interactions-pause');
    if (button && !button.disabled) instance?.play('click');
  }
  function onChange(event) {
    if (!event.isTrusted || event.defaultPrevented || event.target?.disabled) return;
    if (event.target?.matches?.('#rg-interactions-color, #rg-interactions-zoom')) instance?.play('selectChange');
  }
  // Only the activity owner emits these AFTER a real transition. Never infer
  // completion from text, elapsed wall time, reset, pause or a start-button click.
  const listeners = [
    ['click', onClick], ['change', onChange],
    ['radgotchi:pomodoro-start', () => instance?.play('pomodoroStart')],
    ['radgotchi:pomodoro-complete', () => instance?.play('pomodoroComplete')]
  ];
  function destroy() {
    if (!instance) return;
    for (const [type, handler] of listeners) document.removeEventListener(type, handler);
    instance.destroy(); instance = undefined;
  }
  global.RadgotchiAudioBootstrap = Object.freeze({start, destroy});
  global.addEventListener('pagehide', destroy);
  global.addEventListener('pageshow', start);
  start();
})(globalThis);

/* Explicit, CSP-safe composition of local-only companion features.
 * Monitoring retains sole ownership of feed/expression state and its auto-start. */
(function () {
  'use strict';
  let instances;
  function mount() {
    if (instances) return;
    let storage;
    try { storage = globalThis.localStorage; } catch (_) { /* Private/denied storage. */ }
    instances = [
      RadgotchiInteractions.init(document, storage),
      RadgotchiActivities.init(document, storage)
    ];
    if (globalThis.RadgotchiArcade && globalThis.RadgotchiCompanionTransport) {
      instances.push({destroy: RadgotchiArcade.init(document, RadgotchiCompanionTransport.create())});
    }
  }
  function unmount() {
    if (!instances) return;
    RadgotchiMonitoring.stop();
    for (const instance of instances) instance.destroy();
    instances = undefined;
  }
  mount();
  addEventListener('pagehide', unmount);
  addEventListener('pageshow', function () {
    if (instances) return;
    mount();
    RadgotchiMonitoring.start();
  });
}());

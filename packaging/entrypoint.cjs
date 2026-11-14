'use strict';
// Packaging-only gate: never allow fallback to the legacy headless runtime.
function validateEnvironment(env) {
  if (env.RADGOTCHI_COMPANION_DIR !== undefined && env.RADGOTCHI_COMPANION_DIR !== '/data/companion') throw new Error('configuration');
  if (env.RADGOTCHI_MONITORING_MODE !== '1') throw new Error('configuration');
  const origin = new URL(env.RADGOTCHI_MONITORING_ORIGIN);
  if (origin.protocol !== 'https:' || origin.origin !== env.RADGOTCHI_MONITORING_ORIGIN || origin.username || origin.password) throw new Error('configuration');
}
if (require.main === module) {
  try {
    validateEnvironment(process.env);
    process.env.RADGOTCHI_COMPANION_DIR='/data/companion';
    require('../headless.js');
  } catch {
    console.error('[Packaging] Invalid configuration; server not started');
    process.exitCode = 2;
  }
}
module.exports = {validateEnvironment};

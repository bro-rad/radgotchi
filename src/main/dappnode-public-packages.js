'use strict';

// Adapter for Dappmanager's existing public-packages projection, not full
// inventory: rows lack service/container identifiers. Never derive them from IP.
function summarizePublicPackages(rows) {
  const invalid = () => { throw new Error('invalid_public_inventory'); };
  if (!Array.isArray(rows) || rows.length > 4096) invalid();
  const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
  const states = new Set(['created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead', 'stopped', 'unknown']);
  const groups = new Map();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || !text(row.name, 256) || !text(row.version, 128) || !states.has(row.state)) invalid();
    let group = groups.get(row.name);
    if (!group) {
      group = {name: row.name, versions: [], reportedRows: 0, states: {}};
      groups.set(row.name, group);
    }
    if (!group.versions.includes(row.version)) group.versions.push(row.version);
    group.reportedRows++;
    group.states[row.state] = (group.states[row.state] || 0) + 1;
  }
  for (const group of groups.values()) group.versions.sort();
  return {coverage: 'package-status-only', containerIdentityAvailable: false,
    reportedRows: rows.length, packages: [...groups.values()]};
}
module.exports = {summarizePublicPackages};

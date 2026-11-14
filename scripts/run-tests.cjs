'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
function discoverTests(root) {
  function walk(dir) {
    return fs.readdirSync(dir, {withFileTypes:true}).flatMap(entry => {
      const file = path.join(dir, entry.name);
      return entry.isDirectory() ? walk(file) : entry.isFile() && /\.test\.(?:js|cjs)$/.test(entry.name) ? [file] : [];
    });
  }
  return [...walk(path.join(root, 'test')), ...walk(path.join(root, 'packaging/test'))].sort();
}
function testArgs(files, args) {
  if (args.some(arg => arg !== '--serial')) throw new Error('Usage: npm test -- [--serial]');
  if (!files.length) throw new Error('No tests discovered');
  return ['--test', ...(args.includes('--serial') ? ['--test-concurrency=1'] : []), ...files];
}
if (require.main === module) {
  try {
    const root = path.resolve(__dirname, '..');
    const result = spawnSync(process.execPath, testArgs(discoverTests(root), process.argv.slice(2)), {cwd:root, stdio:'inherit'});
    if (result.error) throw result.error;
    process.exitCode = result.status === null ? 1 : result.status;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = {discoverTests, testArgs};

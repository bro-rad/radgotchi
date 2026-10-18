'use strict';

// Node-only web launcher. Unlike `electron . --web`, this entry point never
// initializes Chromium, so it can run from SSH or systemd without X11/Wayland.

const dns = require('dns');
const fs = require('fs');
const os = require('os');
const path = require('path');

dns.setDefaultResultOrder('ipv4first');

const bootstrap = require('./src/main/bootstrap');

let webArgs;
try {
    webArgs = bootstrap.parseWebArgs(process.argv);
} catch (error) {
    console.error(error.message);
    process.exit(2);
}

function getUserDataDir() {
    if (process.env.RADGOTCHI_DATA_DIR) {
        return path.resolve(process.env.RADGOTCHI_DATA_DIR);
    }
    if (process.platform === 'win32') {
        return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'radgotchi');
    }
    if (process.platform === 'darwin') {
        return path.join(os.homedir(), 'Library', 'Application Support', 'radgotchi');
    }
    return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'radgotchi');
}

const userDataDir = getUserDataDir();
fs.mkdirSync(userDataDir, { recursive: true });

// The persistence and skill modules only need this small part of Electron's
// App API. Matching Electron's userData path keeps desktop and web state shared.
const headlessApp = {
    isPackaged: false,
    getPath(name) {
        if (name !== 'userData') throw new Error(`Unsupported headless app path: ${name}`);
        return userDataDir;
    },
};

const noWindow = () => null;

function start() {
    const services = bootstrap.initModules({
        app: headlessApp,
        screen: null,
        getMainWindow: noWindow,
        getChatWindow: noWindow,
    });
    bootstrap.loadState();
    bootstrap.startSession('headless web mode', '无头网页模式');
    bootstrap.startWebServer(services, webArgs);
}

let shuttingDown = false;
function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[Headless] ${signal} received; saving state...`);
    bootstrap.shutdown();
    process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

start();

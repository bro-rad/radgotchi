'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// Settings Window — desktop COMMS CONFIG window (settings.html)
// Electron is required lazily so llm.js can call syncColor() under the
// Node-only headless launcher, where there is never a settings window.
// ═══════════════════════════════════════════════════════════════════════════

const path = require('path');

let settingsWindow = null;
let _persistence = null;
let _getMainWindow = null;

function init({ persistence, getMainWindow }) {
    _persistence = persistence;
    _getMainWindow = getMainWindow;
}

function show() {
    if (settingsWindow) {
        settingsWindow.focus();
        return;
    }

    const { BrowserWindow, screen } = require('electron');
    const pb = screen.getPrimaryDisplay().bounds;
    const defaultBounds = {
        width: 500,
        height: 520,
        x: pb.x + Math.floor((pb.width - 500) / 2),
        y: pb.y + Math.floor((pb.height - 520) / 2)
    };
    const settingsBounds = _persistence.ensureBoundsOnDisplay(
        _persistence.getWindowState('settingsWindow', defaultBounds)
    );

    settingsWindow = new BrowserWindow({
        width: settingsBounds.width,
        height: settingsBounds.height,
        x: settingsBounds.x,
        y: settingsBounds.y,
        minWidth: 480,
        minHeight: 480,
        modal: false,
        resizable: true,
        minimizable: false,
        maximizable: false,
        frame: false,
        transparent: false,
        title: 'COMMS CONFIG',
        backgroundColor: '#0a0c0a',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: false,
            preload: path.join(__dirname, '..', '..', 'preload.js')
        }
    });

    settingsWindow.on('moved', () => _persistence.saveWindowState('settingsWindow', settingsWindow));
    settingsWindow.on('resized', () => _persistence.saveWindowState('settingsWindow', settingsWindow));

    settingsWindow.loadFile(path.join(__dirname, '..', '..', 'settings.html'));
    settingsWindow.setMenu(null);

    settingsWindow.webContents.on('did-finish-load', () => {
        const mainWindow = _getMainWindow && _getMainWindow();
        if (mainWindow && mainWindow.webContents) {
            mainWindow.webContents.executeJavaScript(`localStorage.getItem("radgotchi-color") || "#00ff9d"`)
                .then(color => syncColor(color))
                .catch(() => {
                    // Main window may be unavailable — non-critical
                });
        }
    });

    settingsWindow.on('closed', () => {
        settingsWindow = null;
    });
}

function syncColor(color) {
    if (!settingsWindow || !settingsWindow.webContents) return;
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) return;
    const hex = color.slice(1);
    // Wrapped in a block: executeJavaScript runs in the page's global scope,
    // so a bare `const` would throw on the second call
    settingsWindow.webContents.executeJavaScript(`{
        const hex = '${hex}';
        document.documentElement.style.setProperty('--term-green', '${color}');
        const r = Math.round(parseInt(hex.substr(0,2), 16) * 0.65);
        const g = Math.round(parseInt(hex.substr(2,2), 16) * 0.65);
        const b = Math.round(parseInt(hex.substr(4,2), 16) * 0.65);
        const dim = '#' + r.toString(16).padStart(2,'0') + g.toString(16).padStart(2,'0') + b.toString(16).padStart(2,'0');
        document.documentElement.style.setProperty('--term-dim', dim);
        const br = Math.round(parseInt(hex.substr(0,2), 16) * 0.25);
        const bg = Math.round(parseInt(hex.substr(2,2), 16) * 0.25);
        const bb = Math.round(parseInt(hex.substr(4,2), 16) * 0.25);
        document.documentElement.style.setProperty('--term-border', '#' + br.toString(16).padStart(2,'0') + bg.toString(16).padStart(2,'0') + bb.toString(16).padStart(2,'0'));
    }`).catch(() => {
        // Settings window may have closed — non-critical
    });
}

module.exports = { init, show, syncColor };

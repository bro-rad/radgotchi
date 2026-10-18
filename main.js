'use strict';

const { app, BrowserWindow, screen, session, desktopCapturer } = require('electron');
const dns = require('dns');
const path = require('path');

// Force IPv4 DNS resolution — prevents IPv6 lookup failures on dual-stack networks
dns.setDefaultResultOrder('ipv4first');

// ═══════════════════════════════════════════════════════════════════════════
// Modules
// ═══════════════════════════════════════════════════════════════════════════
const bootstrap     = require('./src/main/bootstrap');
const movement      = require('./src/main/movement');
const llm           = require('./src/main/llm');
const windows       = require('./src/main/windows');

// ═══════════════════════════════════════════════════════════════════════════
// Web mode flag (--web serves chat as HTTP server, no desktop UI)
// ═══════════════════════════════════════════════════════════════════════════
const isWebMode = process.argv.includes('--web');

// ═══════════════════════════════════════════════════════════════════════════
// Platform GPU configuration (must happen before app ready)
// ═══════════════════════════════════════════════════════════════════════════
const isLinux = process.platform === 'linux';
if (isLinux) {
    app.commandLine.appendSwitch('enable-transparent-visuals');
    app.commandLine.appendSwitch('disable-gpu');
    app.disableHardwareAcceleration();
}

// Gracefully handle GPU process failure instead of crashing
// no-sandbox disables Chromium sandbox for all child processes, needed for
// WASAPI audio loopback and GPU process on network drives / HDR displays.
// Security is maintained via contextIsolation + nodeIntegration:false.
app.commandLine.appendSwitch('no-sandbox');
app.on('gpu-info-update', () => {}); // prevent unhandled event
app.on('child-process-gone', (event, details) => {
    if (details.type === 'GPU' && details.reason !== 'clean-exit') {
        console.warn('GPU process gone, falling back to software rendering');
        app.disableHardwareAcceleration();
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// Single instance lock
// ═══════════════════════════════════════════════════════════════════════════
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock && !isWebMode) {
    app.quit();
} else {
    app.on('second-instance', () => {
        const mw = windows.getMainWindow();
        if (mw) {
            if (mw.isMinimized()) mw.restore();
            mw.focus();
            mw.show();
        }
    });
}

// ═══════════════════════════════════════════════════════════════════════════
// Web mode lifecycle (--web flag)
// ═══════════════════════════════════════════════════════════════════════════
function initializeWebMode() {
    let webArgs;
    try {
        webArgs = bootstrap.parseWebArgs(process.argv);
    } catch (e) {
        console.error(e.message);
        app.exit(2);
        return;
    }

    const services = bootstrap.initModules({
        app,
        screen,
        getMainWindow: windows.getMainWindow,
        getChatWindow: windows.getChatWindow,
    });
    bootstrap.loadState();
    bootstrap.startSession('web mode', '网页模式');
    bootstrap.startWebServer(services, webArgs);

    // Keep Electron alive — Electron may exit when no windows are open
    // even though the HTTP server is active on the Node event loop
    const { powerSaveBlocker } = require('electron');
    powerSaveBlocker.start('prevent-app-suspension');
}

// ═══════════════════════════════════════════════════════════════════════════
// App lifecycle
// ═══════════════════════════════════════════════════════════════════════════
function initializeApp() {
    const services = bootstrap.initModules({
        app,
        screen,
        getMainWindow: windows.getMainWindow,
        getChatWindow: windows.getChatWindow,
    });
    windows.init(services);
    bootstrap.loadState();

    // Create UI
    windows.createWindow();
    windows.registerChatIpc();
    windows.createTray();

    bootstrap.startSession();
    llm.startInitiativeTimer();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) windows.createWindow();
    });
}

app.whenReady().then(() => {
    // Web mode: skip all Electron UI, just serve HTTP
    if (isWebMode) {
        initializeWebMode();
        return;
    }

    // Display media request handler — platform-specific system audio capture
    session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
        if (process.platform === 'win32') {
            // Windows: WASAPI loopback via request.frame (avoids DXGI 10-bit HDR issue)
            callback({ video: request.frame, audio: 'loopback' });
        } else if (process.platform === 'darwin') {
            // macOS: ScreenCaptureKit captures system audio via loopback (macOS 13+)
            desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
                callback(sources.length > 0 ? { video: sources[0], audio: 'loopback' } : { video: request.frame, audio: 'loopback' });
            }).catch(() => callback({ video: request.frame, audio: 'loopback' }));
        } else {
            // Linux: provide screen source; renderer will fall back to monitor device if no audio tracks
            desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
                callback(sources.length > 0 ? { video: sources[0] } : { video: request.frame });
            }).catch(() => callback({ video: request.frame }));
        }
    });

    // Grant audio/display-capture permissions
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
        callback(permission === 'media' || permission === 'display-capture');
    });
    session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
        return permission === 'media' || permission === 'display-capture';
    });

    // Handle display removal - reposition to primary display
    screen.on('display-removed', () => {
        const mw = windows.getMainWindow();
        if (mw && !mw.isDestroyed()) {
            movement.stopMovement();
            const primary = screen.getPrimaryDisplay();
            const wb = primary.bounds;
            const wa = primary.workAreaSize;
            const [ww, wh] = mw.getSize();
            const nx = Math.max(wb.x, wb.x + wa.width - ww - 180);
            const ny = Math.max(wb.y, wb.y + wa.height - wh - 200);
            try { mw.setPosition(nx, ny); } catch (_) {}
        }
    });

    if (isLinux) setTimeout(initializeApp, 100);
    else initializeApp();
});

app.on('window-all-closed', () => {});

app.on('will-quit', () => {
    if (!isWebMode) windows.cleanup();
    bootstrap.shutdown();
});

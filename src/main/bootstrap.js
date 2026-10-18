'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// Bootstrap — module wiring and lifecycle shared by every entry point
// (Electron desktop, Electron --web, and the Node-only headless launcher).
// Callers supply the platform pieces: an `app`-like object, Electron's
// `screen` (or null), and window getters (which return null without a UI).
// ═══════════════════════════════════════════════════════════════════════════

const persistence      = require('./persistence');
const networkDiscovery = require('./network-discovery');
const xpSystem         = require('./xp-system');
const petNeeds         = require('./pet-needs');
const pomodoro         = require('./pomodoro');
const systemMonitor    = require('./system-monitor');
const movement         = require('./movement');
const sleepWork        = require('./sleep-work');
const petMemory        = require('./pet-memory');
const llm              = require('./llm');
const broadcast        = require('./broadcast');
const skillLoader      = require('./skill-loader');
const webServer        = require('./web-server');
const arcade           = require('./arcade');
const dailyContract    = require('./daily-contract');

// ═══════════════════════════════════════════════════════════════════════════
// Chat history & activity log
// ═══════════════════════════════════════════════════════════════════════════
const CHAT_HISTORY_CONFIG = { MAX_MESSAGES: 100, MAX_ACTIVITY_LOG: 50, MAX_RESPONSE_TIMES: 40 };
let chatHistory = [];
let activityLog = [];
let responseTimes = [];

function loadChatData() {
    try {
        const saved = persistence.loadChatDataFromDisk();
        if (saved) {
            chatHistory = (saved.chatHistory || []).slice(-CHAT_HISTORY_CONFIG.MAX_MESSAGES);
            activityLog = (saved.activityLog || []).slice(-CHAT_HISTORY_CONFIG.MAX_ACTIVITY_LOG);
            responseTimes = (saved.responseTimes || []).slice(-CHAT_HISTORY_CONFIG.MAX_RESPONSE_TIMES);
        }
    } catch (e) {
        console.error('Failed to load chat data:', e);
        chatHistory = [];
        activityLog = [];
        responseTimes = [];
    }
}

function saveChatData() {
    try {
        persistence.saveChatDataToDisk({
            chatHistory: chatHistory.slice(-CHAT_HISTORY_CONFIG.MAX_MESSAGES),
            activityLog: activityLog.slice(-CHAT_HISTORY_CONFIG.MAX_ACTIVITY_LOG),
            responseTimes: responseTimes.slice(-CHAT_HISTORY_CONFIG.MAX_RESPONSE_TIMES),
            lastSaved: Date.now()
        });
    } catch (e) {
        console.error('Failed to save chat data:', e);
    }
}

function addActivityLogEntry(type, message, messageZh) {
    const entry = { type, message, messageZh: messageZh || message, timestamp: Date.now() };
    activityLog.push(entry);
    if (activityLog.length % 5 === 0) saveChatData();
    broadcast.broadcastToWindows('activity-log-update', entry);
}

// ═══════════════════════════════════════════════════════════════════════════
// Module initialization
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Wire every core module together.
 * @returns the shared service bag passed to windows.init / webServer.init
 */
function initModules({ app, screen = null, getMainWindow, getChatWindow }) {
    const isLinux = process.platform === 'linux';

    persistence.init(app, screen);
    skillLoader.init(app);
    skillLoader.loadSkills();

    broadcast.init({ getMainWindow, getChatWindow });

    petNeeds.init({
        getMainWindow,
        getChatWindow,
        getIsSleeping: sleepWork.getIsSleeping,
        addActivityLogEntry,
    });

    xpSystem.init({
        persistence,
        getMainWindow,
        getChatWindow,
        isSleeping: sleepWork.getIsSleeping,
        isUserIdle: movement.getIsUserIdle,
        feedPet: petNeeds.feedPet,
        getPomosCompleted: pomodoro.getPomosCompleted,
        addActivityLogEntry,
        getNeeds: petNeeds.getNeeds,
    });

    pomodoro.init({
        addXp: xpSystem.addXp,
        feedPet: petNeeds.feedPet,
        addActivityLogEntry,
        getMainWindow,
        getChatWindow,
        isSleeping: sleepWork.getIsSleeping,
        stopSleepMode: sleepWork.stopSleepMode,
        startWorkAnimation: sleepWork.startWorkAnimation,
        stopWorkAnimation: sleepWork.stopWorkAnimation,
        saveXpData: xpSystem.saveXpData,
        xpData: xpSystem.getXpData,
    });

    movement.init({
        getMainWindow,
        getChatWindow,
        screen,
        isLinux,
        startIdleDecay: xpSystem.startIdleDecay,
        stopIdleDecay: xpSystem.stopIdleDecay,
        cancelAttentionEvent: xpSystem.cancelAttentionEvent,
    });

    sleepWork.init({
        getMainWindow,
        getChatWindow,
        xpSystem,
        movement,
        cancelAttentionEvent: xpSystem.cancelAttentionEvent,
        petMemory,
        addActivityLogEntry,
    });

    systemMonitor.init({ getMainWindow });

    llm.init({
        persistence,
        getMainWindow,
        getChatWindow,
        xpSystem,
        getSleepWork: () => sleepWork,
        getMovement: () => movement,
        petMemory,
        petNeeds,
        pomodoro,
    });

    networkDiscovery.init({
        getXpData: xpSystem.getXpData,
        getLlmConfig: llm.getLlmConfig,
        getRank: xpSystem.getRank,
        getIsSleeping: sleepWork.getIsSleeping,
        getIsVibing: sleepWork.getIsVibing,
        getPomodoroState: pomodoro.getState,
        getNeeds: petNeeds.getNeeds,
        getColor: () => llm.getSpriteState().color || '#ff3344',
    });

    petMemory.init({ persistence, llm });

    arcade.init({
        xpSystem,
        petNeeds,
        persistence,
        addActivityLogEntry,
    });

    dailyContract.init({
        persistence,
        addActivityLogEntry,
        addXp: xpSystem.addXp,
    });

    return {
        persistence,
        xpSystem,
        petNeeds,
        pomodoro,
        movement,
        sleepWork,
        llm,
        petMemory,
        systemMonitor,
        networkDiscovery,
        arcade,
        chatHistory: () => chatHistory,
        activityLog: () => activityLog,
        responseTimes: () => responseTimes,
        saveChatData,
        addActivityLogEntry,
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// Lifecycle
// ═══════════════════════════════════════════════════════════════════════════

function loadState() {
    llm.loadLlmConfig();
    const loadResult = xpSystem.loadXpData(petNeeds.getNeeds());
    if (loadResult && loadResult.pomosCompleted) {
        pomodoro.setPomosCompleted(loadResult.pomosCompleted);
    }
    petMemory.loadMemory();
    loadChatData();
    persistence.loadWindowStates();
}

/**
 * Start timers and restore last session's sleep / discovery state.
 * @param {string} modeLabel – e.g. 'web mode'; shown in the session-start log
 * @param {string} modeLabelZh – Chinese equivalent
 */
function startSession(modeLabel, modeLabelZh) {
    xpSystem.startPassiveXpGain();
    petNeeds.broadcastNeeds();
    petNeeds.startNeedsDecay();
    dailyContract.ensureToday();

    // Restore sleep mode if it was active last session
    if (xpSystem.getXpData().savedSleeping) {
        sleepWork.startSleepMode();
    }

    // Restore network discovery if it was active last session
    const ndState = persistence.getWindowState('networkDiscovery', {});
    if (ndState.enabled) {
        networkDiscovery.startNetworkDiscovery();
    }

    const { totalSessions } = xpSystem.getXpData();
    const suffix = modeLabel ? ` (${modeLabel})` : '';
    const suffixZh = modeLabelZh ? ` (${modeLabelZh})` : '';
    addActivityLogEntry('session-start',
        `Session started${suffix}. Session #${totalSessions}`,
        `会话开始${suffixZh}。第 ${totalSessions} 次会话`);
}

function startWebServer(services, { port, host }) {
    webServer.init(services);
    webServer.start(port, { host });
}

/**
 * Stop all timers and flush state to disk. Safe to call more than once.
 */
let _shutDown = false;
function shutdown() {
    if (_shutDown) return;
    _shutDown = true;

    webServer.stop();
    systemMonitor.stopSystemEventMonitoring();
    movement.stopMovement();
    movement.stopIdleDetection();
    xpSystem.stopPassiveXpGain();
    xpSystem.stopIdleDecay();
    xpSystem.stopAttentionEventChecks();
    petNeeds.stopNeedsDecay();
    pomodoro.stopPomodoro();
    networkDiscovery.stopNetworkDiscovery();
    xpSystem.saveXpData(petNeeds.getNeeds());
    petMemory.saveMemory();
    saveChatData();
}

// ═══════════════════════════════════════════════════════════════════════════
// CLI args for web mode
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Parse --port= and --host= from argv.
 * @returns {{ port: number, host: string }}
 * @throws on an invalid port
 */
function parseWebArgs(argv) {
    const portArg = argv.find(a => a.startsWith('--port='));
    const hostArg = argv.find(a => a.startsWith('--host='));

    let port = 7777;
    if (portArg) {
        port = Number(portArg.slice('--port='.length));
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            throw new Error(`Invalid port: ${portArg}. Expected --port=1..65535.`);
        }
    }

    const host = hostArg ? hostArg.slice('--host='.length) : '127.0.0.1';
    return { port, host };
}

module.exports = {
    initModules,
    loadState,
    startSession,
    startWebServer,
    shutdown,
    parseWebArgs,
};

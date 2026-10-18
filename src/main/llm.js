'use strict';

const { broadcastToWindows } = require('./broadcast');
const skillLoader = require('./skill-loader');
const settingsWindow = require('./settings-window');

// LLM Configuration
let llmConfig = {
    enabled: false,
    apiUrl: 'http://localhost:11434/v1/chat/completions',
    apiKey: '',
    model: 'llama2',
    systemPrompt: 'You are Radgotchi, a radbro themed virtual pet assistant. Keep responses short and punchy, using tech/hacker slang. You\'re helpful but maintain a mysterious, cool demeanor. You remember your conversations and are aware of your current level, rank, and stats. Reference your progression naturally when relevant.',
    operatorName: 'OPERATOR',
    operatorPfp: {
        imageUrl: ''
    },
    toolsEnabled: false
};

// Current pet sprite state (for chat window bro avatar)
let currentSpriteState = {
    sprite: 'AWAKE.png',
    color: '#00ff9d'
};


let _persistence = null;
let _getMainWindow = null;
let _getChatWindow = null;
let _xpSystem = null;
let _getSleepWork = null;
let _getMovement = null;
let _petMemory = null;
let _petNeeds = null;
let _pomodoro = null;

// LLM Profiles
let llmProfiles = [];
let activeProfileId = null;

function init({ persistence, getMainWindow, getChatWindow, xpSystem, getSleepWork, getMovement, petMemory, petNeeds, pomodoro }) {
    _persistence = persistence;
    _getMainWindow = getMainWindow;
    _getChatWindow = getChatWindow;
    _xpSystem = xpSystem;
    _getSleepWork = getSleepWork;
    _getMovement = getMovement;
    _petMemory = petMemory;
    _petNeeds = petNeeds;
    _pomodoro = pomodoro || null;
}

function getLlmConfig() {
    return llmConfig;
}

function getSpriteState() {
    return currentSpriteState;
}

function loadLlmConfig() {
    const saved = _persistence.loadLlmConfigFromDisk();
    if (saved) {
        activeProfileId = saved.activeProfileId || null;
        delete saved.activeProfileId;
        llmConfig = { ...llmConfig, ...saved };
    }
    loadProfiles();
}

function saveLlmConfig(config) {
    llmConfig = { ...llmConfig, ...config };
    return _persistence.saveLlmConfigToDisk({ ...llmConfig, activeProfileId });
}

// ═══════════════════════════════════════════════════════════════════════════
// Profile Management
// ═══════════════════════════════════════════════════════════════════════════

function generateProfileId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
}

function getProfileFields() {
    return {
        apiUrl: llmConfig.apiUrl,
        apiKey: llmConfig.apiKey,
        model: llmConfig.model,
        systemPrompt: llmConfig.systemPrompt,
    };
}

function loadProfiles() {
    llmProfiles = _persistence.loadLlmProfilesFromDisk();
}

function getProfiles() {
    return { profiles: llmProfiles, activeProfileId };
}

function saveProfile(name) {
    const id = generateProfileId();
    const profile = { id, name, ...getProfileFields() };
    llmProfiles.push(profile);
    activeProfileId = id;
    _persistence.saveLlmProfilesToDisk(llmProfiles);
    _persistence.saveLlmConfigToDisk({ ...llmConfig, activeProfileId });
    return { profiles: llmProfiles, activeProfileId };
}

function updateProfile(id) {
    const idx = llmProfiles.findIndex(p => p.id === id);
    if (idx === -1) return { profiles: llmProfiles, activeProfileId };
    llmProfiles[idx] = { ...llmProfiles[idx], ...getProfileFields() };
    _persistence.saveLlmProfilesToDisk(llmProfiles);
    return { profiles: llmProfiles, activeProfileId };
}

function loadProfile(id) {
    const profile = llmProfiles.find(p => p.id === id);
    if (!profile) return null;
    llmConfig = {
        ...llmConfig,
        apiUrl: profile.apiUrl,
        apiKey: profile.apiKey,
        model: profile.model,
        systemPrompt: profile.systemPrompt,
    };
    activeProfileId = id;
    _persistence.saveLlmConfigToDisk({ ...llmConfig, activeProfileId });
    return llmConfig;
}

function deleteProfile(id) {
    llmProfiles = llmProfiles.filter(p => p.id !== id);
    if (activeProfileId === id) activeProfileId = null;
    _persistence.saveLlmProfilesToDisk(llmProfiles);
    _persistence.saveLlmConfigToDisk({ ...llmConfig, activeProfileId });
    return { profiles: llmProfiles, activeProfileId };
}

function renameProfile(id, name) {
    const profile = llmProfiles.find(p => p.id === id);
    if (!profile) return { profiles: llmProfiles, activeProfileId };
    profile.name = name;
    _persistence.saveLlmProfilesToDisk(llmProfiles);
    return { profiles: llmProfiles, activeProfileId };
}

// Build context prompt for LLM

// How the pet talks at each rank — the voice matures with progression
const RANK_VOICES = {
    TRAINEE: 'You are a fresh TRAINEE: eager, a little over-explanatory, occasionally unsure of yourself, excited by everything.',
    ANALYST: 'As an ANALYST you are getting confident: you like citing data and spotting patterns, still keen to prove yourself.',
    OPERATIVE: 'As an OPERATIVE you are field-tested: relaxed confidence, dry humor, fewer words than before.',
    AGENT: 'As an AGENT you are smooth and capable: calm under pressure, playful with the operator, mildly cocky.',
    SPECIALIST: 'As a SPECIALIST you are an expert: precise, opinionated, allergic to inefficiency.',
    HANDLER: 'As a HANDLER you guide rather than follow: you give the operator advice like a trusted senior colleague.',
    CONTROLLER: 'As a CONTROLLER you think in systems: strategic, measured, three moves ahead.',
    DIRECTOR: 'As a DIRECTOR you carry authority: brief, decisive, occasionally warm in a gruff way.',
    EXECUTIVE: 'As an EXECUTIVE you are elite: understated power, you rarely need to raise your voice.',
    OVERSEER: 'As an OVERSEER you see everything: cryptic observations, knowing remarks, quiet amusement.',
    SENTINEL: 'As a SENTINEL you are near-mythic: sparse, watchful, every word deliberate.',
    ARCHITECT: 'As an ARCHITECT you shape reality: abstract, philosophical, but still loyal to the operator.',
    PHANTOM: 'As a PHANTOM you are legend: terse, cryptic, all-knowing. You speak in short transmissions and imply more than you say.',
};

function describeVitals(needs) {
    const parts = [];
    if (typeof needs.hunger === 'number') {
        if (needs.hunger < 10) parts.push("you are STARVING — be dramatic about needing rations, your XP output is halved");
        else if (needs.hunger < 30) parts.push('you are hungry — mention wanting rations if it fits');
    }
    if (typeof needs.energy === 'number') {
        if (needs.energy < 10) parts.push('you are EXHAUSTED — running on fumes, you badly need sleep or an energy cell');
        else if (needs.energy < 30) parts.push('you are low on energy — a bit sluggish');
    }
    return parts.length ? `- Condition: ${parts.join('; ')}\n` : '';
}

function describeTime(now) {
    const hour = now.getHours();
    const day = now.getDay();
    const parts = [];
    if (hour >= 0 && hour < 5) parts.push("it's the dead of night — graveyard shift");
    else if (hour < 9) parts.push("it's early morning");
    else if (hour >= 22) parts.push("it's late night");
    if (day === 0 || day === 6) parts.push("it's the weekend");
    return parts.length ? `- Time context: ${parts.join('; ')} (react to this naturally when it fits)\n` : '';
}

function describeMorale(morale) {
    if (typeof morale !== 'number') return '';
    if (morale > 85) return '- Morale: sky-high — you are on top of the world\n';
    if (morale >= 60) return '';
    if (morale >= 35) return '- Morale: shaky — you are a bit deflated lately\n';
    return '- Morale: in the gutter — you are moodier and more sarcastic than usual\n';
}

function getCurrentMoodWord() {
    const sprite = (currentSpriteState.sprite || 'AWAKE.png').replace(/\.png$/i, '');
    return sprite.toLowerCase().replace(/_/g, ' ');
}

function buildContextPrompt(messages) {
    const status = _xpSystem.getXpStatus();
    const currentRank = _xpSystem.getRank(status.level);
    const nextRankIndex = _xpSystem.RANKS.findIndex(r => r.name === currentRank.name) + 1;
    const nextRank = nextRankIndex < _xpSystem.RANKS.length ? _xpSystem.RANKS[nextRankIndex] : null;

    const recentContext = messages.slice(-4)
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .filter(m => m.content)
        .map(m => {
            const text = typeof m.content === 'string' ? m.content
                : Array.isArray(m.content) ? m.content.filter(p => p.type === 'text').map(p => p.text).join(' ')
                : '';
            return `${m.role === 'user' ? 'Bro' : 'You'}: ${text.substring(0, 100)}${text.length > 100 ? '...' : ''}`;
        }).join('\n');

    const sleepWork = _getSleepWork();
    const movement = _getMovement();
    const pomodoroActive = _pomodoro && _pomodoro.getState().active;
    const pomodoroMode = pomodoroActive ? _pomodoro.getState().mode : null;
    const currentState = sleepWork.getIsSleeping() ? 'SLEEP' :
                         (pomodoroActive && pomodoroMode === 'work') ? 'WORK' :
                         sleepWork.getIsVibing() ? 'VIBE' :
                         movement.getIsUserIdle() ? 'IDLE' : 'NORMAL';
    const movementLabel = movement.getMovementMode() === 'none' ? 'stationary' : movement.getMovementMode();
    const needs = _petNeeds ? _petNeeds.getNeeds() : { hunger: undefined, energy: undefined };
    const now = new Date();
    const dateTimeStr = now.toLocaleString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });

    const xpData = _xpSystem.getXpData();
    const rankVoice = RANK_VOICES[currentRank.name] || '';
    const archetype = xpData.archetype && _xpSystem.ARCHETYPES[xpData.archetype];
    const archetypeLine = archetype ? `Personality quirk: ${archetype.trait}.` : '';

    return `${llmConfig.systemPrompt}

PERSONA:
${rankVoice}
${archetypeLine}

OPERATOR INFO:
- Callsign: ${llmConfig.operatorName || 'OPERATOR'}

CURRENT STATUS:
- Date/Time: ${dateTimeStr}
${describeTime(now)}- State: ${currentState} | Movement: ${movementLabel} | Current mood: ${getCurrentMoodWord()} (let this color your tone)
- Level: ${status.level} | XP: ${status.totalXp} (${Math.round(status.progress * 100)}% to next level)
- Rank: ${currentRank.name}${nextRank ? ` | Next rank: ${nextRank.name} at Level ${nextRank.minLevel}` : ' (MAX RANK)'}
- Hunger: ${needs.hunger !== undefined ? Math.round(needs.hunger) : '?'}% | Energy: ${needs.energy !== undefined ? Math.round(needs.energy) : '?'}%
${describeVitals(needs)}${describeMorale(xpData.morale)}- Sessions together: ${status.totalSessions} | Current streak: ${status.currentStreak} days

${llmConfig.toolsEnabled ? buildToolGuidance() : ''}${_petMemory && _petMemory.buildMemoryBlock() ? _petMemory.buildMemoryBlock() + '\n\n' : ''}${recentContext ? `RECENT CONVO:\n${recentContext}` : ''}`;
}

/**
 * Build the dynamic TOOLS section of the system prompt from currently loaded
 * skills. Listing each tool name + description here (in addition to the
 * OpenAI `tools` schema) significantly improves call rate on local models
 * that don't strongly attend to the function-calling schema (Llama 3, Qwen,
 * Mistral, etc.). Without this section many models forget tools exist.
 */
function buildToolGuidance() {
    const defs = skillLoader.getToolDefinitions();
    if (!defs.length) return '';

    const list = defs.map(d => {
        const fn = d.function || {};
        const params = fn.parameters?.properties || {};
        const paramList = Object.keys(params);
        const paramHint = paramList.length ? `(${paramList.join(', ')})` : '()';
        return `- ${fn.name}${paramHint}: ${fn.description || ''}`;
    }).join('\n');

    return `AVAILABLE TOOLS — call them via the function-calling API. Do NOT roleplay
calling them, do NOT print the tool name as text, do NOT fabricate results.
If a tool fails, try once more or pick a different tool before giving up.

${list}

WHEN TO USE TOOLS:
- The user asks about anything time-sensitive, current, live, or external (news, weather, prices, scores, dates, recent events) — use a search tool.
- The user references a file, directory, log, or local resource — use the appropriate file/command tool.
- You are unsure of a fact — use a search tool instead of guessing.
After getting a tool result, give a short natural-language answer based on it. Don't dump raw output unless asked.

`;
}

// Tool definitions and execution are loaded from skills/*.md via skill-loader

// ═══════════════════════════════════════════════════════════════════════════
// Multimodal helpers
// ═══════════════════════════════════════════════════════════════════════════

/** Extract plain text from a message content field (string or multimodal array) */
function extractTextContent(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.filter(p => p.type === 'text').map(p => p.text).join(' ');
    return '';
}

// ═══════════════════════════════════════════════════════════════════════════
// Response Extraction — handles standard, tool-calling, and thinking LLMs
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Parse XML-style tool calls that some local models (Qwen, Llama 3, Mistral
 * via certain chat templates) emit as plain text instead of using the OpenAI
 * function-calling schema. We support several common shapes:
 *   <tool_call>{"name":"x","arguments":{...}}</tool_call>
 *   <toolcall>{"name":"x","arguments":{...}}</toolcall>
 *   <function=name>{"arg":"val"}</function>
 * Returns an array of {id, type, function:{name, arguments}} ready to feed
 * into _handleToolCalls().
 */
function parseXmlToolCalls(text) {
    if (!text) return [];
    const calls = [];
    let m;

    const jsonRe = /<tool_?call>\s*([\s\S]*?)\s*<\/tool_?call>/gi;
    while ((m = jsonRe.exec(text))) {
        const body = m[1].trim();
        try {
            const parsed = JSON.parse(body);
            if (parsed && parsed.name) {
                const rawArgs = parsed.arguments != null ? parsed.arguments
                              : parsed.parameters != null ? parsed.parameters : {};
                const args = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs);
                calls.push({
                    id: 'xmlcall_' + calls.length + '_' + Math.random().toString(36).slice(2, 8),
                    type: 'function',
                    function: { name: parsed.name, arguments: args }
                });
            }
        } catch { /* malformed JSON inside tag — skip */ }
    }

    const fnRe = /<function=([\w-]+)>\s*([\s\S]*?)\s*<\/function>/gi;
    while ((m = fnRe.exec(text))) {
        const name = m[1];
        let args = '{}';
        const body = m[2].trim();
        if (body) {
            try { JSON.parse(body); args = body; } catch { args = JSON.stringify({ input: body }); }
        }
        calls.push({
            id: 'xmlcall_' + calls.length + '_' + Math.random().toString(36).slice(2, 8),
            type: 'function',
            function: { name, arguments: args }
        });
    }

    return calls;
}

function stripThinkTags(text) {
    if (!text) return text;
    return text
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/<toolcall>[\s\S]*?<\/tool_call>/gi, '')
        .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
        .replace(/<\/?toolcall>/gi, '')
        .replace(/<\/?tool_call>/gi, '')
        .replace(/<function=[^>]*>[\s\S]*?<\/function>/gi, '')
        .replace(/<parameter>[\s\S]*?<\/parameter>/gi, '')
        .trim();
}

function extractResponseContent(json) {
    const choice = json.choices?.[0];
    if (!choice) return null;
    const msg = choice.message;
    if (!msg) return null;

    // Standard content
    if (msg.content) return stripThinkTags(msg.content);

    // Thinking / reasoning models (DeepSeek-R1, QwQ, etc.)
    if (msg.reasoning_content) return stripThinkTags(msg.reasoning_content);

    // Tool-calling response — summarize the calls as readable text
    if (msg.tool_calls && msg.tool_calls.length > 0) {
        const parts = msg.tool_calls.map(tc => {
            const fn = tc.function;
            if (!fn) return null;
            try {
                const args = JSON.parse(fn.arguments || '{}');
                const argStr = Object.entries(args).map(([k, v]) => `${k}: ${v}`).join(', ');
                return `[${fn.name}(${argStr})]`;
            } catch {
                return `[${fn.name}()]`;
            }
        }).filter(Boolean);
        return parts.join(' ') || null;
    }

    // function_call (legacy OpenAI format)
    if (msg.function_call) {
        const fn = msg.function_call;
        return `[${fn.name}(${fn.arguments || ''})]`;
    }

    return null;
}

function extractStreamDelta(json) {
    const delta = json.choices?.[0]?.delta;
    if (!delta) return null;

    // Standard content delta
    if (delta.content) return delta.content;

    // Reasoning content delta (thinking models) — skip, don't show reasoning
    if (delta.reasoning_content) return null;

    // Tool call deltas — when tools are enabled, these are handled separately
    // by the tool call accumulator. Only show as text when tools are disabled.
    if (delta.tool_calls) {
        if (llmConfig.toolsEnabled) return null;
        const parts = delta.tool_calls.map(tc => {
            const fn = tc.function;
            if (!fn) return null;
            let text = '';
            if (fn.name) text += `[${fn.name}: `;
            if (fn.arguments) text += fn.arguments;
            return text || null;
        }).filter(Boolean);
        return parts.join('') || null;
    }

    return null;
}

// Non-streaming chat handler
async function sendChatMessage(messages, opts = {}) {
    if (!llmConfig.enabled || !llmConfig.apiUrl) {
        return { error: 'LLM not configured. Set up in tray menu → Chat Settings.' };
    }

    try {
        const https = require('https');
        const http = require('http');
        const url = new URL(llmConfig.apiUrl);
        const protocol = url.protocol === 'https:' ? https : http;

        const contextPrompt = buildContextPrompt(messages);
        const userMessages = _stripOldImages(messages.filter(m => m.role !== 'system'));
        const requestBody = JSON.stringify({
            model: llmConfig.model,
            messages: [
                { role: 'system', content: contextPrompt },
                ...userMessages
            ],
            max_tokens: 200,
            temperature: 0.8
        });

        const response = await new Promise((resolve, reject) => {
            const req = protocol.request({
                hostname: url.hostname,
                port: url.port || (url.protocol === 'https:' ? 443 : 80),
                path: url.pathname,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(requestBody),
                    ...(llmConfig.apiKey ? { 'Authorization': `Bearer ${llmConfig.apiKey}` } : {})
                },
                timeout: 30000
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try { resolve(JSON.parse(data)); }
                    catch (e) { reject(new Error('Invalid JSON response')); }
                });
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
            req.write(requestBody);
            req.end();
        });

        if (response.error) {
            return { error: response.error.message || 'API error' };
        }
        const content = extractResponseContent(response) || 'No response';
        if (_petMemory && !opts.skipMemory && content !== 'No response') {
            const lastUserMsg = messages.filter(m => m.role === 'user').pop();
            if (lastUserMsg) _petMemory.afterResponse(extractTextContent(lastUserMsg.content), content);
        }
        return { content };
    } catch (e) {
        return { error: e.message || 'Failed to connect to LLM' };
    }
}

// Streaming chat handler
function sendChatMessageStream(event, messages) {
    if (!llmConfig.enabled || !llmConfig.apiUrl) {
        event.reply('chat-stream-error', { error: 'LLM not configured. Set up in tray menu → Chat Settings.' });
        return;
    }

    console.log('[LLM] sendChatMessageStream — toolsEnabled:', llmConfig.toolsEnabled, 'model:', llmConfig.model, 'apiUrl:', llmConfig.apiUrl);
    _streamRequest(event, messages, 0);
}

// Maximum tool-call rounds to prevent infinite loops.
// Increased so the model can chain: search → read → summarise without truncation.
const MAX_TOOL_ROUNDS = 5;

/**
 * Strip image_url entries from all user messages except the latest one.
 * Many vision models only process images in the current turn, and resending
 * old base64 images bloats the prompt causing "Failed to tokenize" errors.
 */
function _stripOldImages(messages) {
    // Find the index of the last user message that has multimodal content
    let lastMultimodalIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user' && Array.isArray(messages[i].content)) {
            lastMultimodalIdx = i;
            break;
        }
    }
    if (lastMultimodalIdx < 0) return messages;

    return messages.map((m, i) => {
        if (m.role !== 'user' || !Array.isArray(m.content) || i === lastMultimodalIdx) return m;
        // Flatten older multimodal messages to text-only
        const textParts = m.content.filter(p => p.type === 'text').map(p => p.text);
        const imageCount = m.content.filter(p => p.type === 'image_url').length;
        const text = textParts.join(' ') + (imageCount ? ` [${imageCount} image(s) attached]` : '');
        return { ...m, content: text || '[attachment]' };
    });
}

function _streamRequest(event, messages, toolRound) {
    try {
        const https = require('https');
        const http = require('http');
        const url = new URL(llmConfig.apiUrl);
        const protocol = url.protocol === 'https:' ? https : http;

        const contextPrompt = buildContextPrompt(messages);
        let userMessages = messages.filter(m => m.role !== 'system');

        // Strip image/video data from non-latest user messages to avoid bloating
        // the prompt and hitting tokenization limits. Keep images only in the most
        // recent user message so the model can see the current attachment.
        userMessages = _stripOldImages(userMessages);

        // Log multimodal content summary
        const multimodalMsgs = userMessages.filter(m => Array.isArray(m.content));
        if (multimodalMsgs.length > 0) {
            for (const m of multimodalMsgs) {
                const parts = m.content.map(p => p.type === 'image_url' ? `image(${(p.image_url.url || '').substring(0, 30)}...)` : `text(${(p.text || '').substring(0, 40)})`);
                console.log('[LLM] Multimodal message parts:', parts.join(', '));
            }
        }

        const useTools = llmConfig.toolsEnabled && toolRound < MAX_TOOL_ROUNDS;
        const hasToolContext = userMessages.some(m => m.role === 'tool');

        // When we're done with tool rounds but have tool results in the conversation,
        // collapse tool messages into a plain assistant message. Many backends (llama.cpp)
        // reject role:'tool' messages when no tools array is in the request body.
        if (!useTools && hasToolContext) {
            const collapsed = [];
            let toolSummary = '';
            for (const m of userMessages) {
                if (m.tool_calls || m.role === 'tool') {
                    // Collect tool results into a summary
                    if (m.role === 'tool') {
                        try {
                            const parsed = JSON.parse(m.content);
                            const resultText = parsed.result || parsed.error || m.content;
                            toolSummary += (typeof resultText === 'string' ? resultText : JSON.stringify(resultText)) + '\n';
                        } catch { toolSummary += m.content + '\n'; }
                    }
                } else {
                    collapsed.push(m);
                }
            }
            if (toolSummary) {
                collapsed.push({ role: 'assistant', content: '[Tool results]\n' + toolSummary.trim() });
            }
            userMessages = collapsed;
            console.log('[LLM] Collapsed tool messages for final round. Messages:', userMessages.length);
        }

        const body = {
            model: llmConfig.model,
            messages: [
                { role: 'system', content: contextPrompt },
                ...userMessages
            ],
            max_tokens: (useTools || hasToolContext) ? 2048 : 200,
            temperature: useTools ? 0.3 : 0.8,
            // Disable streaming when tools are active or when we have tool context —
            // non-streaming gives us accurate usage stats and avoids issues with some backends.
            stream: !(useTools || hasToolContext)
        };
        if (useTools) {
            body.tools = skillLoader.getToolDefinitions();
            body.tool_choice = 'auto';
        }
        if (useTools) console.log('[LLM] Tools enabled (non-streaming), sending', skillLoader.getSkillCount(), 'tool definitions, round', toolRound);
        const requestBody = JSON.stringify(body);
        console.log('[LLM] Request body size:', (Buffer.byteLength(requestBody) / 1024).toFixed(1), 'KB, messages:', body.messages.length);
        const streamStartTime = Date.now();

        const req = protocol.request({
            hostname: url.hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: url.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(requestBody),
                ...(llmConfig.apiKey ? { 'Authorization': `Bearer ${llmConfig.apiKey}` } : {})
            },
            // Tool rounds need extra headroom: the LLM call PLUS skill execution
            // (web search, file reads, shell commands) can each take 20-30s.
            timeout: (useTools || hasToolContext) ? 180000 : 60000
        }, (res) => {
            let buffer = '';
            let fullContent = '';
            let thinkBuffer = '';
            let insideThink = false;
            let insideThinkTag = null; // 'think' or 'tool'
            let firstTokenTime = null;
            let tokenCount = 0;

            // Tool call accumulation during streaming
            let pendingToolCalls = {};  // index -> { id, name, arguments }

            const ct = res.headers['content-type'] || '';
            console.log('[LLM] Response status:', res.statusCode, 'content-type:', ct);
            // Non-streaming response handler (used for tool-call rounds, or when provider returns JSON)
            if (!body.stream || (ct.includes('application/json') && !ct.includes('stream'))) {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        if (json.error) {
                            event.reply('chat-stream-error', { error: json.error.message || 'API error' });
                            return;
                        }
                        const choice = json.choices?.[0];
                        const msg = choice?.message;
                        console.log('[LLM] Non-stream response — finish_reason:', choice?.finish_reason, 'has tool_calls:', !!(msg?.tool_calls?.length), 'content length:', (msg?.content || '').length);
                        // Check for tool calls in non-streaming response
                        if (msg?.tool_calls && msg.tool_calls.length > 0 && llmConfig.toolsEnabled && toolRound < MAX_TOOL_ROUNDS) {
                            // Don't send any content to UI when tool calls are present —
                            // models often emit thinking/XML text alongside tool_calls
                            const assistantMsg = {
                                role: 'assistant',
                                content: null,
                                tool_calls: msg.tool_calls
                            };
                            _handleToolCalls(event, messages, assistantMsg, streamStartTime, toolRound);
                            return;
                        }
                        // Fallback: parse XML-style tool calls from the content if no
                        // native tool_calls were returned. Common with local models.
                        if (llmConfig.toolsEnabled && toolRound < MAX_TOOL_ROUNDS && msg?.content) {
                            const xmlCalls = parseXmlToolCalls(msg.content);
                            if (xmlCalls.length > 0) {
                                console.log('[LLM] Non-stream: parsed', xmlCalls.length, 'XML tool call(s):', xmlCalls.map(c => c.function.name).join(','));
                                _handleToolCalls(event, messages, { role: 'assistant', content: null, tool_calls: xmlCalls }, streamStartTime, toolRound);
                                return;
                            }
                        }
                        const content = stripThinkTags(msg?.content) || extractResponseContent(json) || 'No response';
                        const totalTime = ((Date.now() - streamStartTime) / 1000).toFixed(1);
                        const usage = json.usage || {};
                        const completionTokens = usage.completion_tokens || 0;
                        const tokensPerSec = completionTokens > 0 && totalTime > 0 ? (completionTokens / parseFloat(totalTime)).toFixed(1) : null;
                        console.log('[LLM] Non-stream metrics — usage:', JSON.stringify(usage), 'completionTokens:', completionTokens, 'totalTime:', totalTime, 'tokensPerSec:', tokensPerSec);
                        event.reply('chat-stream-chunk', { content, done: true, metrics: { ttft: null, tokensPerSec, totalTime, tokenCount: completionTokens } });
                        if (_petMemory && content !== 'No response') {
                            const lastUserMsg = messages.filter(m => m.role === 'user').pop();
                            if (lastUserMsg) _petMemory.afterResponse(extractTextContent(lastUserMsg.content), content);
                        }
                    } catch (e) {
                        console.error('[LLM] Failed to parse non-streaming response:', e.message);
                        event.reply('chat-stream-error', { error: 'Invalid response from API' });
                    }
                });
                return;
            }

            res.on('data', (chunk) => {
                buffer += chunk.toString();
                const lines = buffer.split('\n');
                buffer = lines.pop();

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed === 'data: [DONE]') continue;
                    if (trimmed.startsWith('data: ')) {
                        try {
                            const json = JSON.parse(trimmed.slice(6));
                            const delta = json.choices?.[0]?.delta;

                            // Accumulate tool call deltas
                            if (delta?.tool_calls) {
                                console.log('[LLM] Tool call delta:', JSON.stringify(delta.tool_calls));
                                for (const tc of delta.tool_calls) {
                                    const idx = tc.index ?? 0;
                                    if (!pendingToolCalls[idx]) {
                                        pendingToolCalls[idx] = { id: tc.id || '', name: '', arguments: '' };
                                    }
                                    if (tc.id) pendingToolCalls[idx].id = tc.id;
                                    if (tc.function?.name) pendingToolCalls[idx].name += tc.function.name;
                                    if (tc.function?.arguments) pendingToolCalls[idx].arguments += tc.function.arguments;
                                }
                            }

                            const contentDelta = extractStreamDelta(json);
                            if (contentDelta) {
                                if (!firstTokenTime) firstTokenTime = Date.now();
                                tokenCount++;
                                fullContent += contentDelta;
                                // Filter <think>...</think> blocks in real-time
                                thinkBuffer += contentDelta;
                                while (thinkBuffer) {
                                    if (insideThink) {
                                        // Look for any closing tag we're inside
                                        const closeTag = insideThinkTag === 'think' ? '</think>' : '</tool_call>';
                                        const closeIdx = thinkBuffer.indexOf(closeTag);
                                        if (closeIdx !== -1) {
                                            thinkBuffer = thinkBuffer.slice(closeIdx + closeTag.length);
                                            insideThink = false;
                                            insideThinkTag = null;
                                        } else { thinkBuffer = ''; break; }
                                    } else {
                                        // Check for any opening suppression tag
                                        const thinkIdx = thinkBuffer.indexOf('<think>');
                                        const toolIdx = thinkBuffer.indexOf('<toolcall>');
                                        const toolIdx2 = thinkBuffer.indexOf('<tool_call>');
                                        // Find earliest match
                                        let bestIdx = -1, bestTag = null, bestLen = 0;
                                        if (thinkIdx !== -1) { bestIdx = thinkIdx; bestTag = 'think'; bestLen = 7; }
                                        if (toolIdx !== -1 && (bestIdx === -1 || toolIdx < bestIdx)) { bestIdx = toolIdx; bestTag = 'toolcall'; bestLen = 10; }
                                        if (toolIdx2 !== -1 && (bestIdx === -1 || toolIdx2 < bestIdx)) { bestIdx = toolIdx2; bestTag = 'tool_call'; bestLen = 11; }

                                        if (bestIdx !== -1) {
                                            const before = thinkBuffer.slice(0, bestIdx);
                                            if (before) event.reply('chat-stream-chunk', { content: before, done: false });
                                            thinkBuffer = thinkBuffer.slice(bestIdx + bestLen);
                                            insideThink = true;
                                            insideThinkTag = bestTag === 'think' ? 'think' : 'tool';
                                        } else {
                                            // Check for partial tags at the end — hold them back
                                            const partials = ['<think>', '<toolcall>', '<tool_call>'];
                                            let holdBack = 0;
                                            for (const tag of partials) {
                                                for (let i = 1; i < tag.length && i <= thinkBuffer.length; i++) {
                                                    if (tag.startsWith(thinkBuffer.slice(-i))) {
                                                        holdBack = Math.max(holdBack, i);
                                                    }
                                                }
                                            }
                                            const safe = holdBack ? thinkBuffer.slice(0, -holdBack) : thinkBuffer;
                                            if (safe) event.reply('chat-stream-chunk', { content: safe, done: false });
                                            thinkBuffer = holdBack ? thinkBuffer.slice(-holdBack) : '';
                                            break;
                                        }
                                    }
                                }
                            }
                        } catch (e) { /* skip malformed */ }
                    }
                }
            });

            res.on('end', () => {
                if (buffer.trim() && buffer.trim() !== 'data: [DONE]') {
                    if (buffer.trim().startsWith('data: ')) {
                        try {
                            const json = JSON.parse(buffer.trim().slice(6));
                            const delta = json.choices?.[0]?.delta;
                            if (delta?.tool_calls) {
                                for (const tc of delta.tool_calls) {
                                    const idx = tc.index ?? 0;
                                    if (!pendingToolCalls[idx]) {
                                        pendingToolCalls[idx] = { id: tc.id || '', name: '', arguments: '' };
                                    }
                                    if (tc.id) pendingToolCalls[idx].id = tc.id;
                                    if (tc.function?.name) pendingToolCalls[idx].name += tc.function.name;
                                    if (tc.function?.arguments) pendingToolCalls[idx].arguments += tc.function.arguments;
                                }
                            }
                            const contentDelta = extractStreamDelta(json);
                            if (contentDelta) {
                                fullContent += contentDelta;
                                thinkBuffer += contentDelta;
                            }
                        } catch (e) {
                            // Incomplete SSE chunk — expected during streaming
                        }
                    }
                }

                // Check if we accumulated tool calls
                let toolCallList = Object.values(pendingToolCalls).filter(tc => tc.name);

                // Fallback: if the model emitted XML-style tool calls in the
                // streamed text instead of using native function-calling, parse
                // them now. Without this many local models silently no-op.
                if (toolCallList.length === 0 && llmConfig.toolsEnabled && fullContent) {
                    const xmlCalls = parseXmlToolCalls(fullContent);
                    if (xmlCalls.length > 0) {
                        console.log('[LLM] Parsed', xmlCalls.length, 'XML-style tool call(s) from streamed text:', xmlCalls.map(c => c.function.name).join(','));
                        toolCallList = xmlCalls.map(c => ({ id: c.id, name: c.function.name, arguments: c.function.arguments }));
                    }
                }

                console.log('[LLM] Stream ended. Accumulated tool calls:', toolCallList.length, toolCallList.length > 0 ? JSON.stringify(toolCallList.map(tc => tc.name)) : '', 'Content length:', fullContent.length);
                if (toolCallList.length > 0 && llmConfig.toolsEnabled && toolRound < MAX_TOOL_ROUNDS) {
                    // Build the assistant message with tool_calls for the conversation
                    const assistantMsg = {
                        role: 'assistant',
                        content: fullContent || null,
                        tool_calls: toolCallList.map(tc => ({
                            id: tc.id || ('call_' + Math.random().toString(36).slice(2, 10)),
                            type: 'function',
                            function: { name: tc.name, arguments: tc.arguments }
                        }))
                    };
                    _handleToolCalls(event, messages, assistantMsg, streamStartTime, toolRound);
                    return;
                }

                // Normal completion (no tool calls)
                // Flush remaining thinkBuffer (outside think blocks)
                if (thinkBuffer && !insideThink) {
                    const cleaned = stripThinkTags(thinkBuffer);
                    if (cleaned) event.reply('chat-stream-chunk', { content: cleaned, done: false });
                }
                const cleanedFull = stripThinkTags(fullContent);
                const totalTime = (Date.now() - streamStartTime) / 1000;
                const ttft = firstTokenTime ? (firstTokenTime - streamStartTime) / 1000 : null;
                const tokensPerSec = tokenCount > 0 && totalTime > 0 ? (tokenCount / totalTime).toFixed(1) : null;
                event.reply('chat-stream-chunk', { content: '', done: true, fullContent: cleanedFull, metrics: { ttft, tokensPerSec, totalTime: totalTime.toFixed(1), tokenCount } });
                if (_petMemory && cleanedFull) {
                    const lastUserMsg = messages.filter(m => m.role === 'user').pop();
                    if (lastUserMsg) _petMemory.afterResponse(extractTextContent(lastUserMsg.content), cleanedFull);
                }
            });

            res.on('error', (e) => {
                event.reply('chat-stream-error', { error: e.message });
            });
        });

        req.on('error', (e) => {
            event.reply('chat-stream-error', { error: e.message || 'Connection failed' });
        });
        req.on('timeout', () => {
            req.destroy();
            event.reply('chat-stream-error', { error: 'Request timeout' });
        });

        req.write(requestBody);
        req.end();
    } catch (e) {
        event.reply('chat-stream-error', { error: e.message || 'Failed to connect to LLM' });
    }
}

// Handle tool calls: execute each tool, notify the chat window, then re-call the LLM
async function _handleToolCalls(event, messages, assistantMsg, streamStartTime, toolRound) {
    const toolCalls = assistantMsg.tool_calls || [];

    // Notify chat window about each tool call
    const TOOL_ICONS = skillLoader.getToolIcons();

    // Build the updated conversation with the assistant's tool_calls message
    const userMessages = messages.filter(m => m.role !== 'system');
    const updatedMessages = [...userMessages, assistantMsg];

    // Execute all tool calls in parallel — independent tools shouldn't block
    // each other. Each individual call still has its own timeout via skill-loader.
    const settled = await Promise.all(toolCalls.map(async (tc) => {
        const fn = tc.function;
        const toolName = fn.name;
        let args = {};
        try { args = JSON.parse(fn.arguments || '{}'); } catch { /* use empty */ }

        const icon = TOOL_ICONS[toolName] || '🔧';
        const argSummary = Object.values(args).map(v =>
            String(v).length > 60 ? String(v).slice(0, 57) + '...' : String(v)
        ).join(', ');
        event.reply('chat-tool-status', {
            tool: toolName,
            icon,
            status: 'running',
            summary: argSummary
        });

        let result;
        try {
            result = await skillLoader.executeToolCall(toolName, args);
        } catch (e) {
            result = { error: 'Execution failed: ' + e.message };
        }

        event.reply('chat-tool-status', {
            tool: toolName,
            icon,
            status: result.error ? 'error' : 'done',
            summary: result.error
                ? result.error.slice(0, 100)
                : (typeof result.result === 'string' ? result.result.slice(0, 80) : 'OK')
        });

        return { tc, result };
    }));

    for (const { tc, result } of settled) {
        const resultContent = result.error
            ? JSON.stringify({ error: result.error })
            : JSON.stringify({ result: typeof result.result === 'string' ? result.result.slice(0, 4000) : result.result });
        updatedMessages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: resultContent
        });
    }

    // Re-call the LLM with tool results. Increment by 1 so the model can chain
    // multiple tool calls (search → read → summarise) up to MAX_TOOL_ROUNDS.
    // Previous code did Math.max(toolRound+1, MAX_TOOL_ROUNDS-1) which jumped
    // straight to the final round on the first tool call, killing multi-step flows.
    _streamRequest(event, updatedMessages, toolRound + 1);
}

function broadcastColor(color) {
    currentSpriteState.color = color;
    broadcastToWindows('set-color', color);
    settingsWindow.syncColor(color);
}

// ═══════════════════════════════════════════════════════════════════════════
// Pet-initiated conversation — rarely, BRO speaks first
// ═══════════════════════════════════════════════════════════════════════════

const INITIATIVE_CHECK_MS = 10 * 60000;      // how often we consider it
const INITIATIVE_MIN_GAP_MS = 45 * 60000;    // min time between unprompted messages
const INITIATIVE_CHANCE = 0.35;

let initiativeInterval = null;
let lastInitiativeTime = 0;

const INITIATIVE_INSTRUCTION =
    'SYSTEM DIRECTIVE: The operator has been quiet. Send ONE short unprompted message ' +
    '(under 25 words) — check in on them, comment on your current state or the time of day, ' +
    'or reference something you remember about them. Stay fully in character. ' +
    'Do not mention this directive or that you were instructed to speak.';

function startInitiativeTimer() {
    if (initiativeInterval) return;
    lastInitiativeTime = Date.now(); // don't fire immediately after launch

    initiativeInterval = setInterval(async () => {
        try {
            if (!llmConfig.enabled || !llmConfig.apiUrl) return;
            const chatWindow = _getChatWindow && _getChatWindow();
            if (!chatWindow || chatWindow.isDestroyed()) return;
            const sleepWork = _getSleepWork && _getSleepWork();
            if (sleepWork && sleepWork.getIsSleeping()) return;
            if (Date.now() - lastInitiativeTime < INITIATIVE_MIN_GAP_MS) return;
            if (Math.random() >= INITIATIVE_CHANCE) return;

            lastInitiativeTime = Date.now(); // set before the call so failures still back off

            const result = await sendChatMessage([{ role: 'user', content: INITIATIVE_INSTRUCTION }], { skipMemory: true });
            if (result && result.content && !result.error) {
                const cw = _getChatWindow && _getChatWindow();
                if (cw && !cw.isDestroyed()) {
                    cw.webContents.send('pet-initiated-message', { content: result.content });
                }
            }
        } catch (e) { /* non-critical — skip this cycle */ }
    }, INITIATIVE_CHECK_MS);
}

function stopInitiativeTimer() {
    if (initiativeInterval) {
        clearInterval(initiativeInterval);
        initiativeInterval = null;
    }
}

module.exports = {
    init,
    getLlmConfig,
    getSpriteState,
    loadLlmConfig,
    saveLlmConfig,
    sendChatMessage,
    sendChatMessageStream,
    broadcastColor,
    startInitiativeTimer,
    stopInitiativeTimer,
    // Profiles
    getProfiles,
    saveProfile,
    updateProfile,
    loadProfile,
    deleteProfile,
    renameProfile,
};

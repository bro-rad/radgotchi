'use strict';

// COMMS CONFIG — LLM settings page. Runs both in the Electron settings window
// and at /settings in web mode (where the server marks <body data-web-mode>).
const isWebMode = document.body.dataset.webMode === 'true';

function closeSettings() {
    if (isWebMode) window.location.href = '/';
    else window.close();
}

// Desktop: right-click closes the window. Not in web mode, where long-press
// on a phone fires contextmenu.
if (!isWebMode) {
    document.addEventListener('contextmenu', (e) => { e.preventDefault(); closeSettings(); });
}

let operatorPfpImageUrl = '';

function showPfpPreview(imageUrl) {
    operatorPfpImageUrl = imageUrl;
    const previewEl = document.getElementById('operatorPfpPreview');
    previewEl.innerHTML = '';
    const pfpImg = document.createElement('img');
    pfpImg.src = imageUrl;
    pfpImg.alt = 'PFP';
    previewEl.appendChild(pfpImg);
}

async function uploadPfp() {
    if (isWebMode) {
        // No native file dialog in the browser; read the file as a data URL
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.onchange = () => {
            const file = input.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => showPfpPreview(reader.result);
            reader.readAsDataURL(file);
        };
        input.click();
        return;
    }
    const result = await window.electronAPI.uploadPfp();
    if (result && result.imageUrl) showPfpPreview(result.imageUrl);
}
function clearPfp() {
    operatorPfpImageUrl = '';
    document.getElementById('operatorPfpPreview').innerHTML = '<span class="pfp-preview-placeholder">?</span>';
}
async function loadSettings() {
    const config = await window.electronAPI.getLlmConfig();
    document.getElementById('enabled').checked = config.enabled;
    document.getElementById('apiUrl').value = config.apiUrl || '';
    document.getElementById('apiKey').value = config.apiKey || '';
    document.getElementById('model').value = config.model || '';
    document.getElementById('systemPrompt').value = config.systemPrompt || '';
    document.getElementById('operatorName').value = config.operatorName || 'OPERATOR';
    document.getElementById('memoryEnabled').checked = config.memoryEnabled !== false;
    document.getElementById('memoryCount').textContent = config.memoryCount || 0;
    document.getElementById('toolsEnabled').checked = config.toolsEnabled === true;
    if (config.operatorPfp && config.operatorPfp.imageUrl) {
        showPfpPreview(config.operatorPfp.imageUrl);
    }
}
async function saveSettings() {
    const config = {
        enabled: document.getElementById('enabled').checked,
        apiUrl: document.getElementById('apiUrl').value.trim(),
        apiKey: document.getElementById('apiKey').value,
        model: document.getElementById('model').value.trim(),
        systemPrompt: document.getElementById('systemPrompt').value,
        operatorName: document.getElementById('operatorName').value.trim() || 'OPERATOR',
        memoryEnabled: document.getElementById('memoryEnabled').checked,
        toolsEnabled: document.getElementById('toolsEnabled').checked,
        operatorPfp: { imageUrl: operatorPfpImageUrl }
    };
    await window.electronAPI.saveLlmConfig(config);
    closeSettings();
}
async function clearMemory() {
    if (confirm('Wipe all stored memories? This cannot be undone.')) {
        await window.electronAPI.clearPetMemory();
        document.getElementById('memoryCount').textContent = '0';
        closeMemoryModal();
    }
}
async function reloadSkills() {
    const btn = document.getElementById('reloadSkillsBtn');
    const status = document.getElementById('skillsStatus');
    btn.disabled = true;
    const prevLabel = btn.textContent;
    btn.textContent = 'RELOADING...';
    status.textContent = '';
    try {
        const result = await window.electronAPI.reloadSkills();
        if (result && result.success) {
            status.style.color = 'var(--term-green)';
            status.textContent = '\u2713 ' + result.count + ' skill(s): ' + result.names.join(', ');
        } else {
            status.style.color = 'var(--term-red)';
            status.textContent = '\u2717 ' + ((result && result.error) || 'Failed');
        }
    } catch (e) {
        status.style.color = 'var(--term-red)';
        status.textContent = '\u2717 ' + e.message;
    } finally {
        btn.textContent = prevLabel;
        btn.disabled = false;
    }
}

async function viewMemory() {
    const facts = await window.electronAPI.getPetMemoryFacts();
    const listEl = document.getElementById('memoryList');
    listEl.innerHTML = '';
    if (!facts || facts.length === 0) {
        listEl.innerHTML = '<div style="text-align:center;color:var(--term-dim);font-size:9px;padding:20px;">NO MEMORIES STORED</div>';
    } else {
        facts.forEach((f, i) => {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;align-items:flex-start;gap:8px;padding:6px 8px;border-bottom:1px solid var(--term-border);transition:background 0.15s;';
            row.onmouseenter = () => row.style.background = 'rgba(0,212,255,0.05)';
            row.onmouseleave = () => row.style.background = 'transparent';
            const text = document.createElement('span');
            text.style.cssText = 'flex:1;font-size:10px;color:var(--term-green);line-height:1.4;word-break:break-word;';
            text.textContent = f.fact;
            const date = document.createElement('span');
            date.style.cssText = 'flex:none;font-size:7px;color:var(--term-dim);white-space:nowrap;padding-top:2px;';
            date.textContent = f.timestamp ? new Date(f.timestamp).toLocaleDateString() : '';
            const del = document.createElement('button');
            del.style.cssText = 'flex:none;width:18px;min-width:18px;max-width:18px;height:18px;padding:0;font-size:10px;border:1px solid var(--term-dim);color:var(--term-dim);background:transparent;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all 0.15s;';
            del.textContent = '×';
            del.title = 'Remove this memory';
            del.onmouseenter = () => { del.style.borderColor = 'var(--term-red)'; del.style.color = 'var(--term-red)'; };
            del.onmouseleave = () => { del.style.borderColor = 'var(--term-dim)'; del.style.color = 'var(--term-dim)'; };
            del.onclick = async () => {
                row.style.opacity = '0.3';
                const result = await window.electronAPI.removePetMemoryFact(i);
                if (result.success) {
                    row.style.transition = 'opacity 0.2s, max-height 0.2s';
                    row.style.opacity = '0';
                    row.style.maxHeight = '0';
                    row.style.overflow = 'hidden';
                    setTimeout(() => row.remove(), 200);
                    document.getElementById('memoryCount').textContent = result.facts.length;
                    // Re-render to keep indices in sync
                    setTimeout(() => viewMemory(), 250);
                }
            };
            row.appendChild(text);
            row.appendChild(date);
            row.appendChild(del);
            listEl.appendChild(row);
        });
    }
    document.getElementById('memoryModal').style.display = 'block';
}

function closeMemoryModal() {
    document.getElementById('memoryModal').style.display = 'none';
}

// Close modal on Escape key
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.getElementById('memoryModal').style.display === 'block') closeMemoryModal();
});

// ── Profile Management ──
const profileSelect = document.getElementById('profileSelect');
let profilesData = [];
let currentActiveId = null;

async function loadProfileList() {
    const { profiles, activeProfileId } = await window.electronAPI.getLlmProfiles();
    profilesData = profiles || [];
    currentActiveId = activeProfileId || null;
    renderProfileDropdown();
}

function renderProfileDropdown() {
    profileSelect.innerHTML = '<option value="">&mdash; none &mdash;</option>';
    profilesData.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.name;
        profileSelect.appendChild(opt);
    });
    profileSelect.value = currentActiveId || '';
}

profileSelect.addEventListener('change', async () => {
    const id = profileSelect.value;
    if (!id) return;
    const config = await window.electronAPI.loadLlmProfile(id);
    if (config) {
        document.getElementById('apiUrl').value = config.apiUrl || '';
        document.getElementById('apiKey').value = config.apiKey || '';
        document.getElementById('model').value = config.model || '';
        document.getElementById('systemPrompt').value = config.systemPrompt || '';
    }
    currentActiveId = id;
});

async function newProfile() {
    document.getElementById('profileNamePrompt').style.display = 'flex';
    const inp = document.getElementById('profileNameInput');
    inp.value = '';
    inp.focus();
}

async function confirmNewProfile() {
    const name = document.getElementById('profileNameInput').value.trim();
    if (!name) return;
    document.getElementById('profileNamePrompt').style.display = 'none';
    await saveFieldsToConfig();
    const result = await window.electronAPI.saveLlmProfile(name);
    profilesData = result.profiles;
    currentActiveId = result.activeProfileId;
    renderProfileDropdown();
}

function cancelNewProfile() {
    document.getElementById('profileNamePrompt').style.display = 'none';
}

document.getElementById('profileNameInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') confirmNewProfile();
    if (e.key === 'Escape') cancelNewProfile();
});

async function overwriteProfile() {
    const id = profileSelect.value;
    if (!id) { newProfile(); return; }
    const profile = profilesData.find(p => p.id === id);
    if (!confirm('Overwrite "' + (profile ? profile.name : 'profile') + '" with current settings?')) return;
    await saveFieldsToConfig();
    const result = await window.electronAPI.updateLlmProfile(id);
    profilesData = result.profiles;
    currentActiveId = result.activeProfileId;
    renderProfileDropdown();
}

async function deleteCurrentProfile() {
    const id = profileSelect.value;
    if (!id) return;
    const profile = profilesData.find(p => p.id === id);
    if (!confirm('Delete profile "' + (profile ? profile.name : '') + '"?')) return;
    const result = await window.electronAPI.deleteLlmProfile(id);
    profilesData = result.profiles;
    currentActiveId = result.activeProfileId;
    renderProfileDropdown();
}

async function saveFieldsToConfig() {
    const config = {
        apiUrl: document.getElementById('apiUrl').value.trim(),
        apiKey: document.getElementById('apiKey').value,
        model: document.getElementById('model').value.trim(),
        systemPrompt: document.getElementById('systemPrompt').value,
    };
    await window.electronAPI.saveLlmConfig(config);
}

loadSettings();
loadProfileList();

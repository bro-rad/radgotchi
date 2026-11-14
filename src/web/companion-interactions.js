/* Local companion presentation, inspired by upstream Radgotchi (MIT).
 * Observation code exclusively owns the image, expression and status text.
 * Explicit lifecycle: RadgotchiInteractions.init(document, storage).destroy(). */
(function () {
  'use strict';
  const instances = new WeakMap();
  function init(document, storage) {
    if (instances.has(document)) return instances.get(document);
    const host = document.getElementById('web-sprite-container');
    const sprite = document.getElementById('web-sprite');
    if (!host || !sprite || sprite.parentNode !== host) return {destroy() {}};
    function element(tag, name, text) {
      const node = document.createElement(tag);
      node.id = 'rg-interactions-' + name;
      node.className = 'rg-interactions-' + name;
      if (text) node.textContent = text;
      return node;
    }
    const pet = element('button', 'pet');
    pet.type = 'button';
    pet.setAttribute('aria-label', 'Greet companion (visual only)');
    pet.title = 'Greet companion · expression follows observations';
    const motion = element('span', 'motion');
    const controls = element('div', 'controls');
    controls.setAttribute('role', 'group');
    controls.setAttribute('aria-label', 'Local companion appearance');
    const key = 'radgotchi-companion-appearance-v1';
    const colors = ['original', 'red', 'cyan', 'green', 'purple', 'amber'];
    const zooms = [75, 100, 125];
    let color = 'original', zoom = 100;
    try {
      const raw = storage?.getItem(key);
      const saved = typeof raw === 'string' && raw.length <= 256 ? JSON.parse(raw) : null;
      if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
        if (colors.includes(saved.color)) color = saved.color;
        if (zooms.includes(saved.zoom)) zoom = saved.zoom;
      }
    } catch (_) { /* Disabled or malformed storage: session-only defaults. */ }
    function select(name, label, values) {
      const input = element('select', name);
      input.setAttribute('aria-label', label);
      input.title = label + ' · this browser only';
      for (const value of values) {
        const option = document.createElement('option');
        option.value = String(value);
        option.textContent = name === 'zoom' ? value + '%' : value.toUpperCase();
        input.append(option);
      }
      controls.append(input);
      return input;
    }
    const colorInput = select('color', 'Companion color', colors);
    const zoomInput = select('zoom', 'Companion zoom', zooms);
    function apply() {
      colorInput.value = color;
      zoomInput.value = String(zoom);
      pet.setAttribute('data-color', color);
      pet.setAttribute('data-zoom', String(zoom));
    }
    function save() {
      try { storage?.setItem(key, JSON.stringify({color, zoom})); } catch (_) { /* Keep session controls usable. */ }
    }
    function changeColor() {
      if (colors.includes(colorInput.value)) { color = colorInput.value; save(); }
      apply();
    }
    function changeZoom() {
      if (zooms.map(String).includes(zoomInput.value)) { zoom = Number(zoomInput.value); save(); }
      apply();
    }
    colorInput.addEventListener('change', changeColor);
    zoomInput.addEventListener('change', changeZoom);
    const pause = element('button', 'pause', 'Ⅱ');
    pause.type = 'button';
    pause.setAttribute('aria-label', 'Pause companion motion');
    pause.setAttribute('aria-pressed', 'false');
    pause.title = 'Pause companion motion';
    controls.append(pause);
    let paused = false;
    function greet() {
      // One bounded greeting at a time; no animation queue or timer allocation.
      if (!paused) motion.setAttribute('data-greeting', 'true');
    }
    function endGreeting(event) {
      if (event.target === motion && event.animationName === 'rg-interactions-greet') motion.removeAttribute('data-greeting');
    }
    function togglePause() {
      paused = !paused;
      motion.setAttribute('data-paused', String(paused));
      motion.removeAttribute('data-greeting');
      pause.setAttribute('aria-pressed', String(paused));
    }
    pet.addEventListener('click', greet);
    motion.addEventListener('animationend', endGreeting);
    pause.addEventListener('click', togglePause);
    apply();
    host.insertBefore(pet, sprite);
    motion.append(sprite);
    pet.append(motion);
    host.append(controls);
    host.classList.add('rg-interactions-host');
    let destroyed = false;
    const instance = {destroy() {
      if (destroyed) return;
      destroyed = true;
      colorInput.removeEventListener('change', changeColor);
      zoomInput.removeEventListener('change', changeZoom);
      pet.removeEventListener('click', greet);
      motion.removeEventListener('animationend', endGreeting);
      pause.removeEventListener('click', togglePause);
      // Never resurrect a sprite removed or moved by another owner.
      if (sprite.parentNode === motion && pet.parentNode === host) host.insertBefore(sprite, pet);
      pet.remove(); controls.remove();
      host.classList.remove('rg-interactions-host');
      instances.delete(document);
    }};
    instances.set(document, instance);
    return instance;
  }
  globalThis.RadgotchiInteractions = {init};
}());

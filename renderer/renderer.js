const { ipcRenderer } = require('electron');

// ── State ──────────────────────────────────────────────────────────────────
const tabs = new Map(); // tabId → { term, fitAddon, pane, tabEl, shellLabel, pixelsPerRow }
let activeTabId = null;
let availableShells = [];

// ── DOM refs ───────────────────────────────────────────────────────────────
const tabsEl      = document.getElementById('tabs');
const containerEl = document.getElementById('terminal-container');
const shellSelect = document.getElementById('shell-select');
const btnNewTab   = document.getElementById('btn-new-tab');
const btnMinimize = document.getElementById('btn-minimize');
const btnHide     = document.getElementById('btn-hide');
const btnClose    = document.getElementById('btn-close');

// ── Xterm theme ────────────────────────────────────────────────────────────
const TERM_THEME = {
  background:    'transparent',
  foreground:    '#e8e8e8',
  cursor:        '#e8e8e8',
  cursorAccent:  '#000',
  black:         '#000000',
  red:           '#cc5555',
  green:         '#55cc55',
  yellow:        '#cccc55',
  blue:          '#5599cc',
  magenta:       '#cc55cc',
  cyan:          '#55cccc',
  white:         '#e8e8e8',
  brightBlack:   '#555555',
  brightRed:     '#ff7777',
  brightGreen:   '#77ff77',
  brightYellow:  '#ffff77',
  brightBlue:    '#77aaff',
  brightMagenta: '#ff77ff',
  brightCyan:    '#77ffff',
  brightWhite:   '#ffffff',
};

// ── Window height — grows upward from bottom as content fills ─────────────
function resizeWindowToContent(tabId) {
  if (tabId !== activeTabId) return;
  const tab = tabs.get(tabId);
  if (!tab) return;
  const contentRows = tab.term.buffer.active.cursorY + 1;
  const contentPx   = Math.round(contentRows * tab.pixelsPerRow);
  ipcRenderer.send('window:resizeToContent', contentPx);
}

// ── Tab management ─────────────────────────────────────────────────────────
async function createTab(shellId) {
  const shell = availableShells.find(s => s.id === shellId) || availableShells[0];
  if (!shell) return;

  const term = new Terminal({
    allowTransparency: true,
    theme: TERM_THEME,
    fontFamily: "'Cascadia Code', 'Fira Code', Consolas, 'Courier New', monospace",
    fontSize: 13,
    lineHeight: 1.2,
    cursorBlink: true,
    scrollback: 5000,
    convertEol: true,
  });

  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);

  // DOM pane
  const pane = document.createElement('div');
  pane.className = 'terminal-pane';
  containerEl.appendChild(pane);
  term.open(pane);

  // Tab element
  const tabEl = document.createElement('div');
  tabEl.className = 'tab';
  tabEl.innerHTML = `
    <span class="tab-label">${shell.label}</span>
    <button class="tab-close" title="Close tab">✕</button>
  `;
  tabEl.querySelector('.tab-close').addEventListener('click', e => {
    e.stopPropagation();
    closeTab(tabId);
  });
  tabEl.addEventListener('click', () => activateTab(tabId));
  tabsEl.appendChild(tabEl);

  // Fit to the current window size to get cols/rows and pixels-per-row
  fitAddon.fit();
  const { cols, rows } = term;
  const pixelsPerRow = containerEl.clientHeight / rows;

  const tabId = await ipcRenderer.invoke('pty:create', { shellId: shell.id, cols, rows });

  tabs.set(tabId, { term, fitAddon, pane, tabEl, shellLabel: shell.label, pixelsPerRow });

  // Wire input
  term.onData(data => ipcRenderer.send('pty:input', { tabId, data }));

  // Only refit when the pane WIDTH changes — height is controlled by us.
  // Refitting on height changes would cause a feedback loop.
  let prevWidth = pane.clientWidth;
  const ro = new ResizeObserver(() => {
    if (activeTabId !== tabId) return;
    const w = pane.clientWidth;
    if (w !== prevWidth) {
      prevWidth = w;
      fitAddon.fit();
      ipcRenderer.send('pty:resize', { tabId, cols: term.cols, rows: term.rows });
    }
  });
  ro.observe(pane);

  activateTab(tabId);
  // Set initial window height to just the first row
  resizeWindowToContent(tabId);
  return tabId;
}

function activateTab(tabId) {
  if (!tabs.has(tabId)) return;

  if (activeTabId !== null && tabs.has(activeTabId)) {
    const prev = tabs.get(activeTabId);
    prev.pane.classList.remove('active');
    prev.tabEl.classList.remove('active');
  }

  activeTabId = tabId;
  const { term, fitAddon, pane, tabEl } = tabs.get(tabId);
  pane.classList.add('active');
  tabEl.classList.add('active');

  requestAnimationFrame(() => {
    fitAddon.fit();
    ipcRenderer.send('pty:resize', { tabId, cols: term.cols, rows: term.rows });
    term.focus();
    resizeWindowToContent(tabId);
  });
}

function closeTab(tabId) {
  if (!tabs.has(tabId)) return;
  const { term, pane, tabEl } = tabs.get(tabId);

  ipcRenderer.send('pty:kill', { tabId });
  term.dispose();
  pane.remove();
  tabEl.remove();
  tabs.delete(tabId);

  if (activeTabId === tabId) {
    activeTabId = null;
    const remaining = [...tabs.keys()];
    if (remaining.length > 0) {
      activateTab(remaining[remaining.length - 1]);
    }
  }

  if (tabs.size === 0) {
    createTab(shellSelect.value);
  }
}

// ── PTY output ────────────────────────────────────────────────────────────
ipcRenderer.on('pty:output', (event, { tabId, data }) => {
  const tab = tabs.get(tabId);
  if (!tab) return;
  // Use write callback so we read cursorY AFTER xterm has parsed the data
  tab.term.write(data, () => resizeWindowToContent(tabId));
});

ipcRenderer.on('pty:exit', (event, { tabId }) => {
  closeTab(tabId);
});

// ── Window controls ───────────────────────────────────────────────────────
btnMinimize.addEventListener('click', () => ipcRenderer.send('window:minimize'));
btnHide.addEventListener('click',     () => ipcRenderer.send('window:hide'));
btnClose.addEventListener('click',    () => ipcRenderer.send('window:close'));

btnNewTab.addEventListener('click', () => createTab(shellSelect.value));

// ── Keyboard shortcuts ────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.ctrlKey && e.key === 't') {
    e.preventDefault();
    createTab(shellSelect.value);
    return;
  }
  if (e.ctrlKey && e.key === 'w') {
    e.preventDefault();
    if (activeTabId !== null) closeTab(activeTabId);
    return;
  }
  if (e.ctrlKey && e.key === 'Tab') {
    e.preventDefault();
    const ids = [...tabs.keys()];
    if (ids.length < 2) return;
    const idx = ids.indexOf(activeTabId);
    const next = e.shiftKey
      ? ids[(idx - 1 + ids.length) % ids.length]
      : ids[(idx + 1) % ids.length];
    activateTab(next);
    return;
  }
  if (e.ctrlKey && e.key >= '1' && e.key <= '9') {
    const ids = [...tabs.keys()];
    const idx = parseInt(e.key, 10) - 1;
    if (idx < ids.length) { e.preventDefault(); activateTab(ids[idx]); }
  }
});

// ── Init ──────────────────────────────────────────────────────────────────
async function init() {
  availableShells = await ipcRenderer.invoke('pty:shells');

  availableShells.forEach(shell => {
    const opt = document.createElement('option');
    opt.value = shell.id;
    opt.textContent = shell.label;
    shellSelect.appendChild(opt);
  });

  await createTab(availableShells[0].id);
}

init().catch(console.error);

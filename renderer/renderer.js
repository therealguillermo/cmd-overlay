const { ipcRenderer } = require('electron');

// ── State ──────────────────────────────────────────────────────────────────
const tabs = new Map(); // tabId → { term, fitAddon, pane, tabEl, shellLabel }
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

// ── Tab management ─────────────────────────────────────────────────────────
async function createTab(shellId) {
  const shell = availableShells.find(s => s.id === shellId) || availableShells[0];
  if (!shell) return;

  // Build xterm instance
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

  // Fit, then position cursor at the last row so content grows upward
  fitAddon.fit();
  const { cols, rows } = term;
  term.write(`\x1b[${rows};1H`);

  const tabId = await ipcRenderer.invoke('pty:create', { shellId: shell.id, cols, rows });

  tabs.set(tabId, { term, fitAddon, pane, tabEl, shellLabel: shell.label });

  // Wire input
  term.onData(data => ipcRenderer.send('pty:input', { tabId, data }));

  // Resize observer
  const ro = new ResizeObserver(() => {
    if (activeTabId !== tabId) return;
    fitAddon.fit();
    ipcRenderer.send('pty:resize', { tabId, cols: term.cols, rows: term.rows });
  });
  ro.observe(pane);

  activateTab(tabId);
  return tabId;
}

function activateTab(tabId) {
  if (!tabs.has(tabId)) return;

  // Deactivate previous
  if (activeTabId !== null && tabs.has(activeTabId)) {
    const prev = tabs.get(activeTabId);
    prev.pane.classList.remove('active');
    prev.tabEl.classList.remove('active');
  }

  activeTabId = tabId;
  const { term, fitAddon, pane, tabEl } = tabs.get(tabId);
  pane.classList.add('active');
  tabEl.classList.add('active');

  // Fit and focus after paint
  requestAnimationFrame(() => {
    fitAddon.fit();
    ipcRenderer.send('pty:resize', { tabId, cols: term.cols, rows: term.rows });
    term.focus();
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

  // If no tabs left, open a new default one
  if (tabs.size === 0) {
    createTab(shellSelect.value);
  }
}

// ── PTY output ────────────────────────────────────────────────────────────

// Intercept clear-screen sequences and redirect the cursor to the last row
// instead of row 1, so content always anchors to the bottom.
function anchorToBottom(data, rows) {
  // Match: optional cursor-home, one or more clears (ESC[2J / ESC[3J), optional cursor-home
  return data.replace(
    /(\x1b\[\d*;?\d*H)?(\x1b\[[23]J)+(\x1b\[\d*;?\d*H)?/g,
    (_match, _pre, lastClear) => `${lastClear}\x1b[${rows};1H`
  );
}

ipcRenderer.on('pty:output', (event, { tabId, data }) => {
  const tab = tabs.get(tabId);
  if (!tab) return;
  tab.term.write(anchorToBottom(data, tab.term.rows));
});

ipcRenderer.on('pty:exit', (event, { tabId }) => {
  closeTab(tabId);
});

// ── Window controls ───────────────────────────────────────────────────────
btnMinimize.addEventListener('click', () => ipcRenderer.send('window:minimize'));
btnHide.addEventListener('click',     () => ipcRenderer.send('window:hide'));
btnClose.addEventListener('click',    () => ipcRenderer.send('window:close'));

// New tab
btnNewTab.addEventListener('click', () => createTab(shellSelect.value));

// ── Keyboard shortcuts ────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  // Ctrl+T → new tab
  if (e.ctrlKey && e.key === 't') {
    e.preventDefault();
    createTab(shellSelect.value);
    return;
  }
  // Ctrl+W → close active tab
  if (e.ctrlKey && e.key === 'w') {
    e.preventDefault();
    if (activeTabId !== null) closeTab(activeTabId);
    return;
  }
  // Ctrl+Tab / Ctrl+Shift+Tab → cycle tabs
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
  // Ctrl+1..9 → jump to tab
  if (e.ctrlKey && e.key >= '1' && e.key <= '9') {
    const ids = [...tabs.keys()];
    const idx = parseInt(e.key, 10) - 1;
    if (idx < ids.length) { e.preventDefault(); activateTab(ids[idx]); }
  }
});

// ── Init ──────────────────────────────────────────────────────────────────
async function init() {
  availableShells = await ipcRenderer.invoke('pty:shells');

  // Populate shell selector
  availableShells.forEach(shell => {
    const opt = document.createElement('option');
    opt.value = shell.id;
    opt.textContent = shell.label;
    shellSelect.appendChild(opt);
  });

  // Open one tab on start
  await createTab(availableShells[0].id);
}

init().catch(console.error);

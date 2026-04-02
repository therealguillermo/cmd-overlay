const { ipcRenderer } = require('electron');

const CLEAR_COMMANDS = new Set(['clear', 'cls']);

// ── State ──────────────────────────────────────────────────────────────────
const tabs = new Map(); // tabId → { term, fitAddon, pane, tabEl, shellLabel, lastSize }
let activeTabId = null;
let availableShells = [];
let reflowFrame = null;

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

// ── Window height ──────────────────────────────────────────────────────────
// Read xterm's actual rendered cell height so the measurement never goes stale.
function getCellHeight(term) {
  try {
    return term._core._renderService.dimensions.actualCellHeight;
  } catch (_) {
    return Math.ceil(term.options.fontSize * (term.options.lineHeight || 1));
  }
}

function getAbsoluteCursorRow(term) {
  const buffer = term.buffer.active;
  return buffer.baseY + buffer.cursorY;
}

function getBufferRowCount(tab) {
  return Math.max(1, getAbsoluteCursorRow(tab.term) - (tab.contentStartRow || 0) + 1);
}

function outputClearsTerminal(data) {
  return data.includes('\x1bc') || data.includes('\x1b[2J') || data.includes('\x1b[3J');
}

function resizeWindowToContent(tabId) {
  if (tabId !== activeTabId) return;
  const tab = tabs.get(tabId);
  if (!tab) return;
  const rows      = getBufferRowCount(tab);
  const contentPx = Math.round(rows * getCellHeight(tab.term));
  ipcRenderer.send('window:resizeToContent', contentPx);
}

function reflowActiveTerminal() {
  reflowFrame = null;
  if (activeTabId === null) return;

  const tab = tabs.get(activeTabId);
  if (!tab) return;

  const { term, fitAddon, pane, lastSize } = tab;
  if (!pane.classList.contains('active')) return;
  if (pane.clientWidth === 0 || pane.clientHeight === 0) return;

  fitAddon.fit();

  if (term.cols < 2 || term.rows < 1) return;

  if (!lastSize || lastSize.cols !== term.cols || lastSize.rows !== term.rows) {
    tab.lastSize = { cols: term.cols, rows: term.rows };
    ipcRenderer.send('pty:resize', { tabId: activeTabId, cols: term.cols, rows: term.rows });
  }

  resizeWindowToContent(activeTabId);
}

function scheduleReflow() {
  if (reflowFrame !== null) cancelAnimationFrame(reflowFrame);
  reflowFrame = requestAnimationFrame(reflowActiveTerminal);
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

  fitAddon.fit();
  const { cols, rows } = term;

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

  const tabId = await ipcRenderer.invoke('pty:create', { shellId: shell.id, cols, rows });

  tabs.set(tabId, {
    term,
    fitAddon,
    pane,
    tabEl,
    shellLabel: shell.label,
    lastSize: { cols, rows },
    contentStartRow: 0,
    shellInputBuffer: '',
    pendingClearCommand: false,
    agentMode: false,
    agentPending: 0,
    agentBuffer: '',
  });

  term.onData(data => handleTermInput(tabId, data));

  activateTab(tabId);
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
  const { term, pane, tabEl } = tabs.get(tabId);
  pane.classList.add('active');
  tabEl.classList.add('active');

  requestAnimationFrame(() => {
    term.focus();
    scheduleReflow();
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

// ── ?? Agent input interception ───────────────────────────────────────────
function handleTermInput(tabId, data) {
  const tab = tabs.get(tabId);
  if (!tab) return;

  if (tab.agentMode) {
    if (data === '\r') {
      const prompt = tab.agentBuffer.trim();
      tab.term.write('\r\n');
      tab.agentMode = false;
      tab.agentBuffer = '';
      if (prompt) ipcRenderer.send('agent:run', { tabId, prompt });
    } else if (data === '\x7f' || data === '\b') {
      if (tab.agentBuffer.length > 0) {
        tab.agentBuffer = tab.agentBuffer.slice(0, -1);
        tab.term.write('\b \b');
      }
    } else if (data === '\x03') {
      tab.term.write('^C\r\n');
      tab.agentMode = false;
      tab.agentBuffer = '';
      tab.agentPending = 0;
    } else {
      tab.agentBuffer += data;
      tab.term.write(data);
    }
    return;
  }

  if (data === '?') {
    if (tab.agentPending === 1) {
      // Second ? — enter agent mode
      tab.agentMode = true;
      tab.agentPending = 0;
      tab.agentBuffer = '';
      tab.term.write('\x1b[32m??\x1b[0m ');
    } else {
      tab.agentPending = 1;
    }
    return;
  }

  // Not a ? — flush any held ? to PTY and proceed normally
  if (tab.agentPending > 0) {
    ipcRenderer.send('pty:input', { tabId, data: '?' });
    tab.shellInputBuffer += '?';
    tab.agentPending = 0;
  }

  if (data === '\r') {
    const command = tab.shellInputBuffer.trim().toLowerCase();
    tab.pendingClearCommand = CLEAR_COMMANDS.has(command);
    tab.shellInputBuffer = '';
  } else if (data === '\x7f' || data === '\b') {
    tab.shellInputBuffer = tab.shellInputBuffer.slice(0, -1);
  } else if (data === '\x03') {
    tab.shellInputBuffer = '';
    tab.pendingClearCommand = false;
  } else if (data >= ' ') {
    tab.shellInputBuffer += data;
  }

  ipcRenderer.send('pty:input', { tabId, data });
}

// ── PTY output ────────────────────────────────────────────────────────────
ipcRenderer.on('pty:output', (event, { tabId, data }) => {
  const tab = tabs.get(tabId);
  if (!tab) return;
  const clearsTerminal = tab.pendingClearCommand || outputClearsTerminal(data);
  // Callback fires after xterm has fully parsed + rendered the data,
  // so cursorY is accurate when we read it.
  tab.term.write(data, () => {
    if (clearsTerminal) {
      tab.contentStartRow = getAbsoluteCursorRow(tab.term);
      tab.pendingClearCommand = false;
    }
    resizeWindowToContent(tabId);
  });
});

ipcRenderer.on('pty:exit', (event, { tabId }) => {
  closeTab(tabId);
});

// ── Agent output ──────────────────────────────────────────────────────────
ipcRenderer.on('agent:output', (event, { tabId, output }) => {
  const tab = tabs.get(tabId);
  if (tab) tab.term.write(output, () => resizeWindowToContent(tabId));
});

ipcRenderer.on('agent:done', (event, { tabId }) => {
  const tab = tabs.get(tabId);
  if (tab) tab.term.write('\r\n', () => resizeWindowToContent(tabId));
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

const resizeObserver = new ResizeObserver(() => {
  scheduleReflow();
});

resizeObserver.observe(containerEl);
window.addEventListener('resize', scheduleReflow);

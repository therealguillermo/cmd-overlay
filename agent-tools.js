const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { shell } = require('electron');

function isHttpUrl(s) {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

/** Reject obvious path tricks before opening or spawning. */
function assertAllowedPath(p) {
  const resolved = path.resolve(p);
  const home = path.resolve(os.homedir());
  if (!resolved.startsWith(home)) {
    throw new Error(`Path must be under user home: ${home}`);
  }
  return resolved;
}

/**
 * Each tool: description, risk, run(args) -> result (serializable).
 * risk: 'safe' | 'network' | 'destructive'
 */
const tools = {
  openUrl: {
    description: 'Open an http(s) URL in the default browser',
    risk: 'network',
    async run({ url }) {
      if (typeof url !== 'string' || !isHttpUrl(url)) {
        throw new Error('url must be a valid http(s) URL');
      }
      await shell.openExternal(url);
      return { opened: url };
    },
  },

  openPath: {
    description: 'Open a file or folder with the default application (path must be under your user home)',
    risk: 'safe',
    async run({ targetPath }) {
      if (typeof targetPath !== 'string') throw new Error('targetPath is required');
      const resolved = assertAllowedPath(targetPath);
      if (!fs.existsSync(resolved)) throw new Error(`Path does not exist: ${resolved}`);
      const err = await shell.openPath(resolved);
      if (err) throw new Error(err);
      return { opened: resolved };
    },
  },

  showItemInFolder: {
    description: 'Open File Explorer and select a file (path must be under your user home)',
    risk: 'safe',
    async run({ targetPath }) {
      if (typeof targetPath !== 'string') throw new Error('targetPath is required');
      const resolved = assertAllowedPath(targetPath);
      if (!fs.existsSync(resolved)) throw new Error(`Path does not exist: ${resolved}`);
      shell.showItemInFolder(resolved);
      return { revealed: resolved };
    },
  },

  spawnProcess: {
    description: 'Run an executable with arguments (no shell). Executable must exist.',
    risk: 'destructive',
    async run({ file, args = [], cwd, timeoutMs = 120000 }) {
      if (typeof file !== 'string' || !file.trim()) throw new Error('file is required');
      if (!Array.isArray(args)) throw new Error('args must be an array of strings');
      if (args.some(a => typeof a !== 'string')) throw new Error('args must be strings');
      const exe = path.resolve(file);
      if (!fs.existsSync(exe)) throw new Error(`Executable not found: ${exe}`);

      let cwdResolved;
      if (cwd != null) {
        if (typeof cwd !== 'string') throw new Error('cwd must be a string');
        cwdResolved = assertAllowedPath(cwd);
      }

      return await new Promise((resolve, reject) => {
        const child = spawn(exe, args, {
          cwd: cwdResolved,
          windowsHide: true,
        });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
          try {
            child.kill('SIGTERM');
          } catch (_) {}
          reject(new Error(`spawnProcess timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        child.stdout?.on('data', chunk => {
          stdout += chunk.toString();
        });
        child.stderr?.on('data', chunk => {
          stderr += chunk.toString();
        });
        child.on('error', err => {
          clearTimeout(timer);
          reject(err);
        });
        child.on('close', (code, signal) => {
          clearTimeout(timer);
          resolve({
            exitCode: code,
            signal: signal || null,
            stdout: stdout.slice(0, 200_000),
            stderr: stderr.slice(0, 200_000),
          });
        });
      });
    },
  },
};

function listTools() {
  return Object.entries(tools).map(([name, t]) => ({
    name,
    description: t.description,
    risk: t.risk,
  }));
}

function getTool(name) {
  return tools[name] || null;
}

module.exports = { listTools, getTool };

const Anthropic = require('@anthropic-ai/sdk');
const { exec } = require('child_process');
const { shell } = require('electron');
const { promisify } = require('util');

const execAsync = promisify(exec);

const SYSTEM_PROMPT = `You are an OS control agent running on Windows 10. You help users control their computer using natural language.
You have tools to run shell commands (PowerShell), open URLs in the browser, and launch applications.
Be concise. When you run a command, show the relevant output. Don't narrate every step — just do it and report the result.`;

const TOOLS = [
  {
    name: 'run_command',
    description: 'Execute a PowerShell command and return its output. Use for file operations, system info, process management, and anything shell-related.',
    input_schema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'PowerShell command to run',
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'open_url',
    description: 'Open a URL in the default web browser.',
    input_schema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Full URL to open (include https://)',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'launch_app',
    description: 'Launch an application on Windows by name or executable path.',
    input_schema: {
      type: 'object',
      properties: {
        app: {
          type: 'string',
          description: 'App name or exe path, e.g. "notepad", "calc", "chrome", "C:\\\\path\\\\to\\\\app.exe"',
        },
      },
      required: ['app'],
    },
  },
];

async function executeTool(name, input) {
  switch (name) {
    case 'run_command': {
      try {
        const { stdout, stderr } = await execAsync(input.command, {
          shell: 'powershell.exe',
          timeout: 30000,
        });
        const out = (stdout || '').trim();
        const err = (stderr || '').trim();
        if (out && err) return `${out}\n[stderr]: ${err}`;
        return out || err || '(no output)';
      } catch (e) {
        return `Error (exit ${e.code}): ${e.message}`;
      }
    }
    case 'open_url': {
      await shell.openExternal(input.url);
      return `Opened ${input.url}`;
    }
    case 'launch_app': {
      try {
        await execAsync(`Start-Process "${input.app}"`, {
          shell: 'powershell.exe',
          timeout: 10000,
        });
        return `Launched ${input.app}`;
      } catch (e) {
        return `Error: ${e.message}`;
      }
    }
    default:
      return `Unknown tool: ${name}`;
  }
}

async function runAgent(prompt, onOutput) {
  const client = new Anthropic();
  const messages = [{ role: 'user', content: prompt }];

  while (true) {
    const stream = client.messages.stream({
      model: 'claude-opus-4-6',
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    });

    stream.on('text', (delta) => {
      onOutput(delta);
    });

    const message = await stream.finalMessage();

    if (message.stop_reason === 'end_turn') break;

    const toolCalls = message.content.filter((b) => b.type === 'tool_use');
    if (toolCalls.length === 0) break;

    messages.push({ role: 'assistant', content: message.content });

    const toolResults = [];
    for (const tool of toolCalls) {
      onOutput(`\r\n\x1b[33m[${tool.name}]\x1b[0m ${JSON.stringify(tool.input)}\r\n`);
      const result = await executeTool(tool.name, tool.input);
      onOutput(`\x1b[90m${result}\x1b[0m\r\n`);
      toolResults.push({
        type: 'tool_result',
        tool_use_id: tool.id,
        content: result,
      });
    }

    messages.push({ role: 'user', content: toolResults });
  }
}

module.exports = { runAgent };

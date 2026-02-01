# OpenCode Supervisor Plugin for OpenClaw

Autonomous task execution via OpenCode HTTP API with automatic error handling and retry logic.

## Installation

```bash
openclaw plugins install openclaw-opencode-supervisor
```

Or install from GitHub:

```bash
openclaw plugins install github:zvenoai/openclaw-opencode-supervisor
```

## Configuration

After installation, configure the plugin in your OpenClaw config:

```bash
openclaw config set plugins.opencode-supervisor.enabled true
openclaw config set plugins.opencode-supervisor.config.password "your-opencode-password"
```

Or edit `~/.openclaw/config.json`:

```json
{
  "plugins": {
    "opencode-supervisor": {
      "enabled": true,
      "config": {
        "apiUrl": "http://127.0.0.1:4096",
        "username": "opencode",
        "password": "openclaw2026",
        "sandboxDir": "/root/clawd/sandbox",
        "credentialsDir": "/root/clawd/credentials",
        "maxIterations": 5,
        "timeoutMs": 120000
      }
    }
  }
}
```

Restart the gateway after configuration:

```bash
openclaw gateway restart
```

## Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| apiUrl | string | `http://127.0.0.1:4096` | OpenCode HTTP API URL |
| username | string | `opencode` | Basic auth username |
| password | string | - | Basic auth password |
| sandboxDir | string | `/root/clawd/sandbox` | Sandbox directory for code |
| credentialsDir | string | `/root/clawd/credentials` | Credentials directory (read-only) |
| maxIterations | integer | `5` | Max retry iterations |
| timeoutMs | integer | `120000` | Timeout per API call (ms) |

## Usage

The plugin registers an `opencode_task` tool that the agent uses automatically when appropriate.

### Example Prompts

```
"Create a Node.js project that connects to BCMS API"

"Write a Python script to fetch data from Google Sheets"

"Build a web scraper for product prices"
```

### Direct Tool Usage

The agent can call the tool directly:

```json
{
  "tool": "opencode_task",
  "params": {
    "task": "Create a Node.js project that reads from Google Sheets API",
    "projectName": "sheets-reader",
    "continueOnError": true
  }
}
```

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| task | string | yes | Detailed task description |
| projectName | string | no | Project folder name in sandbox |
| continueOnError | boolean | no | Auto-retry on errors (default: true) |

## How It Works

1. **Session Creation**: Creates a new OpenCode session via HTTP API
2. **Task Execution**: Sends the task with sandbox context
3. **Error Detection**: Monitors response for common error patterns
4. **Auto-Retry**: On error, sends follow-up request to fix
5. **Verification**: Confirms task completion before returning
6. **Result**: Returns detailed output with execution logs

## Error Detection

The plugin automatically detects and handles:

- JavaScript/TypeScript errors (TypeError, SyntaxError, ReferenceError)
- File system errors (ENOENT, EACCES, permission denied)
- HTTP errors (401, 403, 404, 500)
- Module resolution errors (Cannot find module)
- Runtime errors (is not defined, is not a function)

## Requirements

- OpenClaw gateway running
- OpenCode server running (`opencode serve --port 4096`)
- Network access between OpenClaw and OpenCode

## Verify Installation

```bash
# List installed plugins
openclaw plugins list

# Check plugin status
openclaw plugins info opencode-supervisor
```

## License

MIT

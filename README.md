# OpenCode Supervisor Plugin for OpenClaw

Autonomous task execution via OpenCode HTTP API with **reliable verification** through actual file changes.

## What's New in v1.1.3

- **Reliable error detection**: Uses exit codes instead of text pattern matching
- **Change verification**: Confirms task completion via `/session/:id/diff` API
- **No false positives**: Doesn't mistake code containing "Error" for actual errors
- **Progress tracking**: Detects when model isn't making changes and prompts accordingly

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
openclaw config set plugins.openclaw-opencode-supervisor.enabled true
openclaw config set plugins.openclaw-opencode-supervisor.config.password "your-opencode-password"
```

Or edit `~/.openclaw/config.json`:

```json
{
  "plugins": {
    "openclaw-opencode-supervisor": {
      "enabled": true,
      "config": {
        "apiUrl": "http://127.0.0.1:4096",
        "username": "opencode",
        "password": "openclaw2026",
        "sandboxDir": "/root/clawd/sandbox",
        "credentialsDir": "/root/clawd/credentials",
        "maxIterations": 50,
        "timeoutMs": 180000
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
| maxIterations | integer | `50` | Max iterations before stopping |
| timeoutMs | integer | `180000` | Timeout per API call (3 min) |

## Usage

The plugin registers an `opencode_task` tool that the agent uses automatically when appropriate.

### Example Prompts

```
"Create a Node.js project that connects to BCMS API"

"Refactor the Python scripts to use python-dotenv"

"Build a web scraper for product prices"
```

### Direct Tool Usage

The agent can call the tool directly:

```json
{
  "tool": "opencode_task",
  "params": {
    "task": "Refactor knowledge_factory.py to use .env and add type hints",
    "projectName": "knowledge-factory",
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

```
1. Create Session     POST /session
         ↓
2. Send Task          POST /session/:id/message
         ↓
3. Check Response
   ├── Tool exit code ≠ 0? → Send fix prompt
   └── finish = "stop"?
         ↓
4. Verify Changes     GET /session/:id (summary.files > 0?)
   ├── files > 0 → ✅ Success
   └── files = 0 → Prompt to make changes
         ↓
5. Get Diff           GET /session/:id/diff
         ↓
6. Return Result with file changes summary
```

## Reliable Indicators

The plugin uses **only reliable indicators**:

| Indicator | Source | Use |
|-----------|--------|-----|
| Exit code | `tool.state.metadata.exit` | Error detection (≠ 0 = error) |
| File count | `session.summary.files` | Task completion verification |
| Diff | `/session/:id/diff` | Actual changes made |

**Not used** (unreliable):
- Text pattern matching (e.g., `/Error:/i`)
- "TASK_COMPLETE" marker in model output

## Task Status

| Status | Meaning |
|--------|---------|
| ✅ `completed` | Files changed, task done |
| ⚠️ `completed_no_changes` | Model finished but no files changed |
| ❌ `failed` | Tool errors (non-zero exit codes) |
| ⏱️ `max_iterations` | Stopped after max attempts |

## Requirements

- OpenClaw gateway running
- OpenCode server running (`opencode serve --port 4096`)
- Network access between OpenClaw and OpenCode

## Verify Installation

```bash
# List installed plugins
openclaw plugins list

# Check plugin status
openclaw plugins info openclaw-opencode-supervisor
```

## License

MIT

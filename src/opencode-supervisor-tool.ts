/**
 * OpenCode Supervisor Tool v2
 *
 * Autonomous task execution via OpenCode HTTP API with:
 * - Reliable error detection via exit codes (not text patterns)
 * - Task completion verification via real file changes (diff API)
 * - Session-based progress tracking
 */

import { Type, type Static } from "@sinclair/typebox";

// =============================================================================
// Types
// =============================================================================

type PluginConfig = {
  apiUrl?: string;
  username?: string;
  password?: string;
  sandboxDir?: string;
  credentialsDir?: string;
  maxIterations?: number;
  timeoutMs?: number;
};

type ToolState = {
  status?: string;
  tool?: string;
  input?: {
    command?: string;
    description?: string;
    path?: string;
    file_path?: string;
    content?: string;
  };
  output?: string;
  metadata?: {
    output?: string;
    exit?: number;
    description?: string;
    truncated?: boolean;
  };
  time?: {
    start?: number;
    end?: number;
  };
};

type OpenCodePart = {
  id?: string;
  type: string;
  text?: string;
  tool?: string;
  callID?: string;
  state?: ToolState;
  reason?: string;
};

type MessageInfo = {
  id?: string;
  sessionID?: string;
  role?: string;
  finish?: string;
  error?: string;
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
  };
};

type OpenCodeResponse = {
  info?: MessageInfo;
  parts?: OpenCodePart[];
};

type SessionSummary = {
  additions: number;
  deletions: number;
  files: number;
};

type Session = {
  id: string;
  title?: string;
  directory?: string;
  summary?: SessionSummary;
  time?: {
    created?: number;
    updated?: number;
  };
};

type FileDiff = {
  path: string;
  additions: number;
  deletions: number;
  status: string;
};

type ToolAction = {
  tool: string;
  description?: string;
  command?: string;
  path?: string;
  output?: string;
  status?: string;
  exitCode?: number;
  hasError: boolean;
};

// =============================================================================
// HTTP Client
// =============================================================================

async function makeRequest<T>(params: {
  url: string;
  method: "GET" | "POST" | "DELETE";
  auth: string;
  body?: unknown;
  timeoutMs: number;
}): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), params.timeoutMs);

  try {
    const response = await fetch(params.url, {
      method: params.method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${params.auth}`,
      },
      body: params.body ? JSON.stringify(params.body) : undefined,
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return (await response.json()) as T;
  } finally {
    clearTimeout(timeoutId);
  }
}

// =============================================================================
// Response Analysis (Reliable indicators only)
// =============================================================================

/**
 * Extract text parts from response
 */
function extractText(response: OpenCodeResponse): string {
  if (!response.parts) return "";
  return response.parts
    .filter((p) => p.type === "text" && p.text)
    .map((p) => p.text!)
    .join("\n");
}

/**
 * Extract tool actions with reliable error detection via exit codes
 */
function extractToolActions(response: OpenCodeResponse): ToolAction[] {
  if (!response.parts) return [];

  return response.parts
    .filter((p) => p.type === "tool" && p.state)
    .map((p) => {
      const state = p.state!;
      const tool = p.tool || state.tool || "unknown";
      const exitCode = state.metadata?.exit;

      // Reliable error: non-zero exit code
      const hasError = typeof exitCode === "number" && exitCode !== 0;

      const action: ToolAction = {
        tool,
        status: state.status,
        exitCode,
        hasError,
      };

      if (state.input?.command) {
        action.command = state.input.command;
        action.description = state.input.description;
      }
      if (state.input?.path || state.input?.file_path) {
        action.path = state.input.path || state.input.file_path;
      }
      if (state.output) {
        action.output = state.output.slice(0, 500);
      } else if (state.metadata?.output) {
        action.output = state.metadata.output.slice(0, 500);
      }

      return action;
    });
}

/**
 * Check if any tool had a non-zero exit code
 */
function hasToolError(actions: ToolAction[]): ToolAction | null {
  return actions.find((a) => a.hasError) || null;
}

/**
 * Check if there were any write/edit actions
 */
function hasWriteActions(actions: ToolAction[]): boolean {
  return actions.some((a) => a.tool === "write" || a.tool === "edit");
}

/**
 * Format tool actions for output
 */
function formatToolActions(actions: ToolAction[]): string {
  if (actions.length === 0) return "";

  const lines: string[] = ["### Actions Performed"];
  for (const action of actions) {
    const errorMark = action.hasError ? " ❌" : "";

    if (action.tool === "bash" && action.command) {
      lines.push(`- **bash**: \`${action.command}\`${errorMark}`);
      if (action.hasError && action.output) {
        lines.push(`  Error (exit ${action.exitCode}): ${action.output.slice(0, 200)}`);
      }
    } else if (action.tool === "write" || action.tool === "edit") {
      lines.push(`- **${action.tool}**: \`${action.path}\`${errorMark}`);
    } else if (action.tool === "read") {
      lines.push(`- **read**: \`${action.path}\``);
    } else {
      lines.push(`- **${action.tool}**${action.path ? `: \`${action.path}\`` : ""}${errorMark}`);
    }
  }
  return lines.join("\n");
}

// =============================================================================
// OpenCode API Client
// =============================================================================

class OpenCodeClient {
  constructor(
    private apiUrl: string,
    private auth: string,
    private timeoutMs: number
  ) {}

  async createSession(): Promise<Session> {
    return makeRequest<Session>({
      url: `${this.apiUrl}/session`,
      method: "POST",
      auth: this.auth,
      body: {},
      timeoutMs: this.timeoutMs,
    });
  }

  async getSession(sessionId: string): Promise<Session> {
    return makeRequest<Session>({
      url: `${this.apiUrl}/session/${sessionId}`,
      method: "GET",
      auth: this.auth,
      timeoutMs: this.timeoutMs,
    });
  }

  async getSessionDiff(sessionId: string): Promise<FileDiff[]> {
    return makeRequest<FileDiff[]>({
      url: `${this.apiUrl}/session/${sessionId}/diff`,
      method: "GET",
      auth: this.auth,
      timeoutMs: this.timeoutMs,
    });
  }

  async sendMessage(sessionId: string, text: string): Promise<OpenCodeResponse> {
    return makeRequest<OpenCodeResponse>({
      url: `${this.apiUrl}/session/${sessionId}/message`,
      method: "POST",
      auth: this.auth,
      body: {
        parts: [{ type: "text", text }],
      },
      timeoutMs: this.timeoutMs,
    });
  }

  async abortSession(sessionId: string): Promise<boolean> {
    try {
      await makeRequest<{ success: boolean }>({
        url: `${this.apiUrl}/session/${sessionId}/abort`,
        method: "POST",
        auth: this.auth,
        body: {},
        timeoutMs: this.timeoutMs,
      });
      return true;
    } catch {
      return false;
    }
  }
}

// =============================================================================
// Task Execution Logic
// =============================================================================

type TaskResult = {
  status: "completed" | "completed_no_changes" | "failed" | "max_iterations";
  sessionId: string;
  iterations: number;
  filesChanged: number;
  additions: number;
  deletions: number;
  diffs: FileDiff[];
  actions: ToolAction[];
  logs: string[];
  finalOutput: string;
  error?: string;
};

async function executeTask(
  client: OpenCodeClient,
  task: string,
  projectPath: string,
  credentialsDir: string,
  maxIterations: number,
  continueOnError: boolean
): Promise<TaskResult> {
  const logs: string[] = [];
  const allActions: ToolAction[] = [];

  // Create session
  let session: Session;
  try {
    session = await client.createSession();
    logs.push(`Session created: ${session.id}`);
  } catch (err) {
    throw new Error(`Failed to create session: ${err}`);
  }

  const sessionId = session.id;

  // Build initial prompt with clear instructions
  const initialPrompt = [
    task,
    "",
    "## CONTEXT",
    `- Work directory: ${projectPath}`,
    `- Credentials: ${credentialsDir} (read-only)`,
    "",
    "## REQUIREMENTS",
    "1. Make actual changes to files (write/edit tools)",
    "2. Run and test your changes",
    "3. Fix any errors before finishing",
    "",
    "Begin by exploring the project structure, then implement the changes.",
  ].join("\n");

  let currentPrompt = initialPrompt;
  let iteration = 0;
  let lastResponse: OpenCodeResponse | null = null;
  let consecutiveNoProgress = 0;

  while (iteration < maxIterations) {
    iteration++;
    logs.push(`\n--- Iteration ${iteration}/${maxIterations} ---`);

    try {
      const response = await client.sendMessage(sessionId, currentPrompt);
      lastResponse = response;

      const finishReason = response.info?.finish;
      const responseText = extractText(response);
      const actions = extractToolActions(response);
      allActions.push(...actions);

      logs.push(`Finish: ${finishReason || "unknown"}`);
      logs.push(`Actions: ${actions.length > 0 ? actions.map((a) => a.tool).join(", ") : "none"}`);

      // Check for tool errors (reliable: exit code !== 0)
      const errorAction = hasToolError(actions);
      if (errorAction && continueOnError) {
        logs.push(`Tool error: ${errorAction.tool} exited with code ${errorAction.exitCode}`);
        currentPrompt = [
          `The command failed with exit code ${errorAction.exitCode}:`,
          "```",
          errorAction.output || "(no output)",
          "```",
          "",
          "Please fix this error and continue.",
        ].join("\n");
        consecutiveNoProgress = 0;
        continue;
      }

      // Check for real changes via API
      const sessionState = await client.getSession(sessionId);
      const filesChanged = sessionState.summary?.files || 0;
      const hasChanges = filesChanged > 0;

      logs.push(`Files changed: ${filesChanged}`);

      // Decide next action based on state
      if (finishReason === "stop") {
        if (hasChanges) {
          // Model stopped and we have real changes - success!
          logs.push("Task completed with file changes");
          break;
        } else {
          // Model stopped but no changes yet
          consecutiveNoProgress++;

          if (consecutiveNoProgress >= 3) {
            logs.push("No progress after 3 attempts - stopping");
            break;
          }

          // Check if there were any write attempts
          const hasWrites = hasWriteActions(allActions);

          if (hasWrites) {
            currentPrompt = [
              "You made write attempts but no files were changed.",
              "Please verify your changes and try again.",
            ].join("\n");
          } else {
            currentPrompt = [
              "You haven't made any file changes yet.",
              "Please use the write or edit tool to modify files.",
              "Don't just read files - actually implement the changes.",
            ].join("\n");
          }
          continue;
        }
      }

      // Non-stop finish reason
      if (finishReason !== "stop") {
        logs.push(`Unexpected finish: ${finishReason}`);
        if (continueOnError) {
          currentPrompt = `The previous step ended with "${finishReason}". Please continue.`;
          continue;
        }
      }

    } catch (err) {
      logs.push(`Request error: ${err}`);
      if (continueOnError && iteration < maxIterations) {
        await new Promise((r) => setTimeout(r, 2000));
        currentPrompt = "There was an error. Please continue with the task.";
        continue;
      }
      throw err;
    }
  }

  // Get final session state and diff
  let diffs: FileDiff[] = [];
  let finalSession: Session;

  try {
    finalSession = await client.getSession(sessionId);
    diffs = await client.getSessionDiff(sessionId);
  } catch (err) {
    logs.push(`Failed to get final state: ${err}`);
    finalSession = { id: sessionId, summary: { additions: 0, deletions: 0, files: 0 } };
  }

  const filesChanged = finalSession.summary?.files || 0;
  const additions = finalSession.summary?.additions || 0;
  const deletions = finalSession.summary?.deletions || 0;

  // Determine final status
  let status: TaskResult["status"];
  if (filesChanged > 0) {
    status = "completed";
  } else if (iteration >= maxIterations) {
    status = "max_iterations";
  } else if (hasToolError(allActions)) {
    status = "failed";
  } else {
    status = "completed_no_changes";
  }

  return {
    status,
    sessionId,
    iterations: iteration,
    filesChanged,
    additions,
    deletions,
    diffs,
    actions: allActions,
    logs,
    finalOutput: lastResponse ? extractText(lastResponse) : "",
  };
}

// =============================================================================
// Tool Definition
// =============================================================================

const ToolParameters = Type.Object({
  task: Type.String({
    description: "Detailed task description. Be specific about files to create/modify.",
  }),
  projectName: Type.Optional(
    Type.String({
      description: "Project subdirectory in sandbox. Created if missing.",
    })
  ),
  continueOnError: Type.Optional(
    Type.Boolean({
      description: "Retry on errors (default: true)",
    })
  ),
});

export function createOpenCodeSupervisorTool(api: any) {
  const pluginConfig = (api.pluginConfig ?? {}) as PluginConfig;

  const apiUrl = pluginConfig.apiUrl ?? "http://127.0.0.1:4096";
  const username = pluginConfig.username ?? "opencode";
  const password = pluginConfig.password ?? "openclaw2026";
  const sandboxDir = pluginConfig.sandboxDir ?? "/root/clawd/sandbox";
  const credentialsDir = pluginConfig.credentialsDir ?? "/root/clawd/credentials";
  const maxIterations = pluginConfig.maxIterations ?? 50;
  const timeoutMs = pluginConfig.timeoutMs ?? 180000; // 3 min per request

  const auth = Buffer.from(`${username}:${password}`).toString("base64");
  const client = new OpenCodeClient(apiUrl, auth, timeoutMs);

  return {
    name: "opencode_task",
    description: `Execute a coding task using OpenCode agent.
Runs in sandbox (${sandboxDir}) with access to credentials (${credentialsDir}).
Verifies task completion through actual file changes, not just model output.
Use for: code generation, refactoring, API integrations, file operations.`,

    parameters: ToolParameters,

    async execute(_id: string, params: Record<string, unknown>) {
      const task = params.task as string;
      if (!task?.trim()) {
        throw new Error("task is required");
      }

      const projectName = params.projectName as string | undefined;
      const continueOnError = params.continueOnError !== false;

      const projectPath = projectName ? `${sandboxDir}/${projectName}` : sandboxDir;

      const result = await executeTask(
        client,
        task,
        projectPath,
        credentialsDir,
        maxIterations,
        continueOnError
      );

      // Format diff summary
      const diffSummary =
        result.diffs.length > 0
          ? result.diffs
              .map((d) => `- ${d.path}: +${d.additions}/-${d.deletions}`)
              .join("\n")
          : "(no file changes)";

      // Format status message
      const statusMessages: Record<TaskResult["status"], string> = {
        completed: "✅ Task completed successfully",
        completed_no_changes: "⚠️ Task finished but no files were changed",
        failed: "❌ Task failed due to errors",
        max_iterations: "⏱️ Task stopped after max iterations",
      };

      return {
        content: [
          {
            type: "text",
            text: [
              `## OpenCode Task Result`,
              "",
              `**Status:** ${statusMessages[result.status]}`,
              `**Session:** ${result.sessionId}`,
              `**Iterations:** ${result.iterations}`,
              `**Files Changed:** ${result.filesChanged} (+${result.additions}/-${result.deletions})`,
              "",
              "### File Changes",
              diffSummary,
              "",
              formatToolActions(result.actions),
              "",
              "### Final Output",
              result.finalOutput || "(no output)",
              "",
              "<details>",
              "<summary>Execution Log</summary>",
              "",
              "```",
              result.logs.join("\n"),
              "```",
              "</details>",
            ].join("\n"),
          },
        ],
        details: {
          ...result,
          projectPath,
        },
      };
    },
  };
}

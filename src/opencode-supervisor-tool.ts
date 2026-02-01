/**
 * OpenCode Supervisor Tool
 *
 * Autonomous task execution via OpenCode HTTP API with:
 * - Automatic session management
 * - Error detection and retry logic
 * - Task completion verification
 */

// TypeBox for OpenClaw-compatible parameter schema
import { Type, type Static } from "@sinclair/typebox";

type PluginConfig = {
  apiUrl?: string;
  username?: string;
  password?: string;
  sandboxDir?: string;
  credentialsDir?: string;
  maxIterations?: number;
  timeoutMs?: number;
};

type OpenCodeResponse = {
  info?: {
    finish?: string;
    error?: string;
  };
  parts?: Array<{
    type: string;
    text?: string;
    state?: string;
  }>;
};

type SessionResponse = {
  id: string;
};

const ERROR_PATTERNS = [
  /Error:/i,
  /TypeError:/i,
  /ReferenceError:/i,
  /SyntaxError:/i,
  /ENOENT/i,
  /EACCES/i,
  /401 Unauthorized/i,
  /403 Forbidden/i,
  /404 Not Found/i,
  /500 Internal Server Error/i,
  /Cannot find module/i,
  /is not defined/i,
  /is not a function/i,
  /Unexpected token/i,
  /failed to/i,
  /permission denied/i,
];

function detectError(text: string): string | null {
  for (const pattern of ERROR_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      const idx = text.indexOf(match[0]);
      const start = Math.max(0, idx - 50);
      const end = Math.min(text.length, idx + 150);
      return text.slice(start, end).trim();
    }
  }
  return null;
}

function extractTextFromResponse(response: OpenCodeResponse): string {
  if (!response.parts) return "";
  return response.parts
    .filter((p) => p.type === "text" && p.text)
    .map((p) => p.text!)
    .join("\n");
}

function extractToolResults(response: OpenCodeResponse): string[] {
  if (!response.parts) return [];
  return response.parts
    .filter((p) => p.type === "tool" && p.state)
    .map((p) => p.state!);
}

async function makeRequest<T>(params: {
  url: string;
  method: "GET" | "POST";
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

// Parameter schema using TypeBox (OpenClaw standard)
const ToolParameters = Type.Object({
  task: Type.String({
    description: "Detailed task description. Be specific about what needs to be done."
  }),
  projectName: Type.Optional(
    Type.String({
      description: "Optional project name. Will be created in sandbox directory."
    })
  ),
  continueOnError: Type.Optional(
    Type.Boolean({
      description: "Continue trying to fix errors automatically (default: true)"
    })
  ),
});

type ToolParams = Static<typeof ToolParameters>;

export function createOpenCodeSupervisorTool(api: any) {
  const pluginConfig = (api.pluginConfig ?? {}) as PluginConfig;

  const apiUrl = pluginConfig.apiUrl ?? "http://127.0.0.1:4096";
  const username = pluginConfig.username ?? "opencode";
  const password = pluginConfig.password ?? "openclaw2026";
  const sandboxDir = pluginConfig.sandboxDir ?? "/root/clawd/sandbox";
  const credentialsDir = pluginConfig.credentialsDir ?? "/root/clawd/credentials";
  const maxIterations = pluginConfig.maxIterations ?? 5;
  const timeoutMs = pluginConfig.timeoutMs ?? 120000;

  const auth = Buffer.from(`${username}:${password}`).toString("base64");

  return {
    name: "opencode_task",
    description: `Execute a coding task autonomously using OpenCode CLI agent.
The task runs in sandbox (${sandboxDir}) with access to credentials (${credentialsDir}).
Automatically handles errors and retries until task completion or max iterations.
Use this for: creating projects, API integrations, code generation, browser automation.`,

    parameters: ToolParameters,

    async execute(_id: string, params: Record<string, unknown>) {
      const task = params.task as string;
      if (!task?.trim()) {
        throw new Error("task is required");
      }

      const projectName = params.projectName as string | undefined;
      const continueOnError = params.continueOnError !== false;

      const projectPath = projectName
        ? `${sandboxDir}/${projectName}`
        : sandboxDir;

      const initialPrompt = [
        task,
        "",
        "CONTEXT:",
        `- Work directory: ${projectPath}`,
        `- Credentials available at: ${credentialsDir} (read-only)`,
        "- Create all files in the work directory",
        "- Run and verify your code works before finishing",
      ].join("\n");

      let sessionId: string;
      try {
        const sessionResp = await makeRequest<SessionResponse>({
          url: `${apiUrl}/session`,
          method: "POST",
          auth,
          body: {},
          timeoutMs,
        });
        sessionId = sessionResp.id;
      } catch (err) {
        throw new Error(`Failed to create OpenCode session: ${err}`);
      }

      const logs: string[] = [];
      logs.push(`Session: ${sessionId}`);
      logs.push(`Task: ${task}`);
      logs.push("");

      let currentPrompt = initialPrompt;
      let iteration = 0;
      let lastResponse: OpenCodeResponse | null = null;
      let taskCompleted = false;

      while (iteration < maxIterations) {
        iteration++;
        logs.push(`--- Iteration ${iteration}/${maxIterations} ---`);

        try {
          const response = await makeRequest<OpenCodeResponse>({
            url: `${apiUrl}/session/${sessionId}/message`,
            method: "POST",
            auth,
            body: {
              parts: [{ type: "text", text: currentPrompt }],
            },
            timeoutMs,
          });

          lastResponse = response;
          const finishReason = response.info?.finish;
          const responseText = extractTextFromResponse(response);
          const toolResults = extractToolResults(response);

          logs.push(`Finish: ${finishReason ?? "unknown"}`);
          if (responseText) {
            logs.push(`Response: ${responseText.slice(0, 500)}${responseText.length > 500 ? "..." : ""}`);
          }

          const allText = [responseText, ...toolResults].join("\n");
          const detectedError = detectError(allText);

          if (detectedError && continueOnError && iteration < maxIterations) {
            logs.push(`Error detected: ${detectedError}`);
            currentPrompt = [
              `The previous step had an error:`,
              detectedError,
              "",
              "Please fix this error and continue with the task.",
              "Make sure to verify the fix works before finishing.",
            ].join("\n");
            continue;
          }

          if (finishReason === "stop" && !detectedError) {
            const successIndicators = [
              /successfully/i,
              /completed/i,
              /created/i,
              /works/i,
              /running/i,
              /output:/i,
            ];

            const hasSuccessIndicator = successIndicators.some((p) => p.test(allText));

            if (hasSuccessIndicator || iteration === maxIterations) {
              taskCompleted = true;
              logs.push("Task completed successfully");
              break;
            }

            currentPrompt = [
              "Please verify that the task is complete:",
              "1. Check that all files were created",
              "2. Run the code and show the output",
              "3. Confirm everything works as expected",
            ].join("\n");
            continue;
          }

          if (finishReason !== "stop") {
            if (continueOnError && iteration < maxIterations) {
              currentPrompt = `The previous request ended with status "${finishReason}". Please continue with the task.`;
              continue;
            }
          }

        } catch (err) {
          logs.push(`Request error: ${err}`);
          if (continueOnError && iteration < maxIterations) {
            await new Promise((r) => setTimeout(r, 2000));
            currentPrompt = `There was a connection error. Please continue with the task: ${task}`;
            continue;
          }
          throw new Error(`OpenCode request failed: ${err}`);
        }
      }

      const finalText = lastResponse ? extractTextFromResponse(lastResponse) : "";
      const status = taskCompleted ? "completed" : `stopped after ${iteration} iterations`;

      return {
        content: [
          {
            type: "text",
            text: [
              `## OpenCode Task Result`,
              "",
              `**Status:** ${status}`,
              `**Iterations:** ${iteration}`,
              `**Session:** ${sessionId}`,
              "",
              "### Output",
              finalText || "(no text output)",
              "",
              "### Execution Log",
              "```",
              logs.join("\n"),
              "```",
            ].join("\n"),
          },
        ],
        details: {
          sessionId,
          status,
          iterations: iteration,
          completed: taskCompleted,
          logs,
        },
      };
    },
  };
}

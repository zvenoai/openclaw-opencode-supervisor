import { createOpenCodeSupervisorTool } from "./src/opencode-supervisor-tool.js";

export default function register(api: any) {
  api.registerTool(createOpenCodeSupervisorTool(api), { optional: false });
}

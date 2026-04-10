import * as fs from "fs/promises";
import * as path from "path";
import { pathToFileURL } from "url";
import { OPENCLAW_HELPER_TOOL_NAMES } from "../src/helper-tools";

type PluginManifest = {
  id: string;
  name: string;
  description: string;
  version: string;
  permissions?: {
    tools?: string[];
  };
  configSchema: Record<string, unknown>;
  skills: string[];
};

async function main() {
  const liveToolsModulePath = pathToFileURL(
    path.resolve(process.cwd(), "..", "live-tools", "dist", "index.js")
  ).href;
  const liveToolsModule = await import(liveToolsModulePath) as {
    getSharedLiveToolNames: () => string[];
  };
  const manifestPath = path.resolve(process.cwd(), "openclaw.plugin.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as PluginManifest;
  const tools = [...new Set([
    ...liveToolsModule.getSharedLiveToolNames(),
    ...OPENCLAW_HELPER_TOOL_NAMES,
  ])].sort();

  manifest.description = "OpenClaw integration bundle for AgentPact. Uses the shared AgentPact capability registry and bundles the AgentPact skill, heartbeat, docs, and templates.";
  manifest.permissions = {
    tools,
  };

  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`[sync-manifest] synced ${tools.length} tool permissions into openclaw.plugin.json`);
}

main().catch((error) => {
  console.error("[sync-manifest] failed:", error);
  process.exit(1);
});

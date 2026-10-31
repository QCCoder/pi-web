import { NextResponse } from "next/server";
import { homedir } from "os";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// `home` is the real home dir — a display-shortening anchor only (SessionSidebar
// displayCwd). `agentDir` is the global settings anchor: Agents/Skills/Plugins
// use it as their settingsCwd fallback when no workspace/session is active. It
// must never be homedir — homedir is a parent of every allowed file root, so
// the allowlist check would 403 every config API call.
export async function GET() {
  return NextResponse.json({ home: homedir(), agentDir: getAgentDir() });
}

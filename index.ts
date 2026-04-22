/**
 * pi-agent-switch - OpenCode-style primary agent switching for pi
 * 
 * Allows switching the current session to use a specific agent's system prompt.
 * Similar to OpenCode's Tab key agent switching, but via /agent command.
 * 
 * Usage:
 *   /agent          - Open agent selector
 *   /agent <name>   - Switch directly to agent by name
 *   /agent-off      - Disable agent switching, restore default behavior
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

interface AgentInfo {
  name: string;
  description: string;
  systemPrompt: string;
  systemPromptMode: "append" | "replace";
  filePath: string;
}

// State for the active agent
let activeAgent: AgentInfo | null = null;
let currentCtx: ExtensionContext | undefined;

// Agent discovery - simplified version
function discoverAgents(cwd: string): AgentInfo[] {
  const agents: AgentInfo[] = [];
  
  const userDirOld = path.join(os.homedir(), ".pi", "agent", "agents");
  const userDirNew = path.join(os.homedir(), ".agents");
  
  const dirsToScan = [userDirOld, userDirNew];
  
  // Also scan pi-subagents agents if available
  const subagentsPath = path.join(os.homedir(), ".pi", "agent", "git", "github.com", "nicobailon", "pi-subagents", "agents");
  if (fs.existsSync(subagentsPath)) {
    dirsToScan.push(subagentsPath);
  }
  
  for (const dir of dirsToScan) {
    if (!fs.existsSync(dir)) continue;
    
    try {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        if (!file.endsWith(".md")) continue;
        
        const filePath = path.join(dir, file);
        try {
          const content = fs.readFileSync(filePath, "utf-8");
          const agent = parseAgentFile(content, filePath);
          if (agent && !agents.find(a => a.name === agent.name)) {
            agents.push(agent);
          }
        } catch (e) {
          // Skip invalid files
        }
      }
    } catch (e) {
      // Skip inaccessible directories
    }
  }
  
  // Sort by name
  agents.sort((a, b) => a.name.localeCompare(b.name));
  
  return agents;
}

function parseAgentFile(content: string, filePath: string): AgentInfo | null {
  // Parse frontmatter
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n/);
  if (!frontmatterMatch) return null;
  
  const frontmatter: Record<string, string> = {};
  for (const line of frontmatterMatch[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();
    // Remove quotes
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }
    frontmatter[key] = value;
  }
  
  const name = frontmatter.name || path.basename(filePath, ".md");
  const description = frontmatter.description || "";
  const systemPromptMode = (frontmatter.systemPromptMode as "append" | "replace") || "replace";
  
  // Get the system prompt content (everything after frontmatter)
  const systemPrompt = content.slice(frontmatterMatch[0].length).trim();
  
  return {
    name,
    description,
    systemPrompt,
    systemPromptMode,
    filePath,
  };
}

function formatAgentList(agents: AgentInfo[]): string {
  const lines: string[] = [];
  lines.push("Available agents:");
  lines.push("");
  
  for (const agent of agents) {
    const desc = agent.description.split("\n")[0].slice(0, 60);
    lines.push(`  ${agent.name.padEnd(25)} - ${desc}`);
  }
  
  lines.push("");
  lines.push("Usage: /agent <name> or /agent to see this list");
  
  return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
  // Handle before_agent_start - inject active agent's system prompt
  pi.on("before_agent_start", async (event, ctx) => {
    currentCtx = ctx;
    
    if (!activeAgent) return;
    
    if (activeAgent.systemPromptMode === "replace") {
      // Replace the system prompt entirely with the agent's prompt
      event.systemPrompt = activeAgent.systemPrompt;
    } else {
      // Append the agent's prompt to the existing system prompt
      event.systemPrompt = `${event.systemPrompt}\n\n---\n\n${activeAgent.systemPrompt}`;
    }
  });
  
  // Session start - reconstruct state if needed
  pi.on("session_start", async (event, ctx) => {
    currentCtx = ctx;
  });
  
  // Register /agent command
  pi.registerCommand("agent", {
    description: "Switch the current session to use a specific agent (/agent [name])",
    handler: async (args, ctx) => {
      currentCtx = ctx;
      
      const agents = discoverAgents(ctx.cwd);
      
      if (!args || !args.trim()) {
        // No args - show interactive selector
        const names = agents.map(a => a.name);
        const selected = await ctx.ui.select("Select agent:", names);
        
        if (!selected) {
          ctx.ui.notify("No agent selected.", "info");
          return;
        }
        
        const agent = agents.find(a => a.name === selected);
        if (!agent) {
          ctx.ui.notify(`Agent '${selected}' not found.`, "error");
          return;
        }
        
        activeAgent = agent;
        ctx.ui.notify(`Switched to agent: ${agent.name}`, "info");
        return;
      }
      
      // Args provided - try to find agent by name
      const agentName = args.trim();
      const agent = agents.find(a => a.name.toLowerCase() === agentName.toLowerCase());
      
      if (!agent) {
        ctx.ui.notify(`Agent '${agentName}' not found. Use /agents to see available agents.`, "error");
        return;
      }
      
      activeAgent = agent;
      ctx.ui.notify(`Switched to agent: ${agent.name}`, "info");
    },
  });
  
  // Register /agent-off command
  pi.registerCommand("agent-off", {
    description: "Disable agent switching and restore default behavior",
    handler: async (_args, ctx) => {
      if (activeAgent) {
        ctx.ui.notify(`Agent switching disabled (was: ${activeAgent.name}).`, "info");
      } else {
        ctx.ui.notify("Agent switching already disabled.", "info");
      }
      activeAgent = null;
    },
  });
  
  // Register /agents-list command to show available agents
  pi.registerCommand("agents-list", {
    description: "List all available agents",
    handler: async (_args, ctx) => {
      const agents = discoverAgents(ctx.cwd);
      const list = formatAgentList(agents);
      ctx.ui.notify(list, "info");
    },
  });
  
  // Register shortcut Ctrl+Shift+A for agent switching
  pi.registerShortcut("ctrl+shift+a", {
    handler: async (ctx) => {
      currentCtx = ctx;
      
      const agents = discoverAgents(ctx.cwd);
      const names = agents.map(a => a.name);
      const selected = await ctx.ui.select("Select agent (Ctrl+Shift+A):", names);
      
      if (!selected) return;
      
      const agent = agents.find(a => a.name === selected);
      if (!agent) return;
      
      activeAgent = agent;
      ctx.ui.notify(`Switched to agent: ${agent.name}`, "info");
    },
  });
}

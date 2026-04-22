/**
 * pi-agent-switch - OpenCode-style primary agent switching for pi
 * 
 * Allows switching the current session to use a specific agent's system prompt.
 * Similar to OpenCode's Tab key agent switching, but via /agent command.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

interface AgentInfo {
  name: string;
  description: string;
  systemPrompt: string;
  systemPromptMode: "append" | "replace";
  inheritProjectContext: boolean;
  inheritSkills: boolean;
  filePath: string;
}

// State for the active agent
let activeAgent: AgentInfo | null = null;
let currentCtx: ExtensionContext | undefined;

/**
 * Parse YAML frontmatter handling multiline strings (>-, |-, >, |)
 */
function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const frontmatter: Record<string, unknown> = {};
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  
  if (!normalized.startsWith("---")) {
    return { frontmatter, body: normalized };
  }
  
  const endIndex = normalized.indexOf("\n---", 3);
  if (endIndex === -1) {
    return { frontmatter, body: normalized };
  }
  
  const frontmatterBlock = normalized.slice(4, endIndex);
  const body = normalized.slice(endIndex + 4).trim();
  
  // Parse line by line, handling multiline strings
  const lines = frontmatterBlock.split("\n");
  let i = 0;
  
  while (i < lines.length) {
    const line = lines[i];
    const match = line.match(/^([\w-]+):\s*(.*)$/);
    
    if (match) {
      const key = match[1];
      let value = match[2];
      
      // Check for multiline indicator
      if (/^[>|\-?]\s*$/.test(value)) {
        // Multiline string follows
        const indicator = value.trim(); // >, |, >-, |-, etc.
        const fold = indicator.includes("-") ? false : (indicator === "|" ? false : true); // > folds, | preserves
        const consumeIndent = indicator.includes("-") || indicator === ">" || indicator === "|";
        
        let multilineValue = "";
        i++;
        
        while (i < lines.length) {
          const contentLine = lines[i];
          
          // Check if we've hit a non-indented line (end of this field)
          if (contentLine.trim() === "") {
            multilineValue += "\n";
            i++;
            continue;
          }
          
          // Check for indented content (continuation) or unindented new key
          const isIndented = contentLine.startsWith(" ") || contentLine.startsWith("\t");
          const isNewKey = !isIndented && contentLine.match(/^[\w-]+:/);
          
          if (isNewKey && !multilineValue.endsWith("\n")) {
            // New key found, end of multiline
            break;
          }
          
          if (isIndented || (!isNewKey && contentLine.trim())) {
            // Continuation line
            const text = contentLine.replace(/^\s+/, ""); // Remove leading whitespace
            multilineValue += (fold && multilineValue ? " " : "") + text + "\n";
            i++;
          } else {
            break;
          }
        }
        
        // Remove trailing newline and apply folding for >
        if (fold) {
          value = multilineValue.replace(/\n$/, "").replace(/\n/g, " ");
        } else {
          value = multilineValue.replace(/\n$/, "");
        }
      } else {
        // Single line value
        // Remove quotes
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        i++;
      }
      
      frontmatter[key] = value;
    } else {
      i++;
    }
  }
  
  return { frontmatter, body };
}

// Agent discovery
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
          console.error(`Error parsing agent file ${filePath}:`, e);
        }
      }
    } catch (e) {
      console.error(`Error reading agent directory ${dir}:`, e);
    }
  }
  
  // Sort by name
  agents.sort((a, b) => a.name.localeCompare(b.name));
  
  return agents;
}

function parseAgentFile(content: string, filePath: string): AgentInfo | null {
  const { frontmatter, body } = parseFrontmatter(content);
  
  if (Object.keys(frontmatter).length === 0) {
    // No frontmatter found
    return null;
  }
  
  const name = (frontmatter.name as string) || path.basename(filePath, ".md");
  const description = (frontmatter.description as string) || "";
  const systemPromptMode = (frontmatter.systemPromptMode as "append" | "replace") || "replace";
  const inheritProjectContext = (frontmatter.inheritProjectContext as boolean) ?? true;
  const inheritSkills = (frontmatter.inheritSkills as boolean) ?? false;
  
  return {
    name,
    description,
    systemPrompt: body,
    systemPromptMode,
    inheritProjectContext,
    inheritSkills,
    filePath,
  };
}

function formatAgentList(agents: AgentInfo[]): string {
  const lines: string[] = [];
  lines.push("Available agents:");
  lines.push("");
  
  for (const agent of agents) {
    const desc = (agent.description || "No description").split("\n")[0].slice(0, 60);
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
      event.systemPrompt = activeAgent.systemPrompt;
    } else {
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
        const names = agents.map(a => a.name);
        
        if (names.length === 0) {
          ctx.ui.notify("No agents found. Check ~/.pi/agent/agents/", "error");
          return;
        }
        
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
      
      const agentName = args.trim();
      const agent = agents.find(a => a.name.toLowerCase() === agentName.toLowerCase());
      
      if (!agent) {
        ctx.ui.notify(`Agent '${agentName}' not found. Use /agents-list for available agents.`, "error");
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
  
  // Register shortcut Ctrl+Alt+A for agent switching
  pi.registerShortcut("ctrl+alt+a", {
    handler: async (ctx) => {
      currentCtx = ctx;
      
      const agents = discoverAgents(ctx.cwd);
      const names = agents.map(a => a.name);
      
      if (names.length === 0) {
        ctx.ui.notify("No agents found.", "error");
        return;
      }
      
      const selected = await ctx.ui.select("Select agent:", names);
      
      if (!selected) return;
      
      const agent = agents.find(a => a.name === selected);
      if (!agent) return;
      
      activeAgent = agent;
      ctx.ui.notify(`Switched to agent: ${agent.name}`, "info");
    },
  });
}

/**
 * Agent discovery and configuration for agent-switcher extension.
 * Loads agent definitions from .md files with YAML frontmatter.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@mariozechner/pi-coding-agent";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, ".pi", "agents");
		if (isDirectory(candidate)) return candidate;
		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
	const agents: AgentConfig[] = [];
	if (!fs.existsSync(dir)) return agents;

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		let frontmatter: Record<string, string>;
		let body: string;
		try {
			const parsed = parseFrontmatter<Record<string, string>>(content);
			frontmatter = parsed.frontmatter;
			body = parsed.body;
		} catch {
			// Skip files with invalid YAML
			continue;
		}

		if (!frontmatter.name || !frontmatter.description) continue;

		// Handle tools as comma-separated string or YAML array
			let tools: string[] | undefined;
			if (frontmatter.tools) {
				const toolsValue = frontmatter.tools;
				// Normalize to string if it is an array (YAML parsed as sequence)
				const toolsStr = Array.isArray(toolsValue) ? toolsValue.join(",") : String(toolsValue);
				if (toolsStr.includes(",")) {
					tools = toolsStr.split(",").map((t) => t.trim()).filter(Boolean);
				} else {
					// Single tool name
					tools = [toolsStr.trim()];
				}
			}
		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: tools && tools.length > 0 ? tools : undefined,
			model: frontmatter.model,
			systemPrompt: body.trim(),
			source,
			filePath,
		});
	}

	return agents;
}

/** Discover all agents from user and project directories.
 *
 * Searches two locations:
 * - ~/.pi/agent/agents/   — compatible with subagent extension
 * - ~/.pi/agent/profiles/ — dedicated agent-switcher profiles
 */
export function discoverAgents(cwd: string): AgentConfig[] {
	const agentDir = getAgentDir();
	const userAgentsDir = path.join(agentDir, "agents");
	const userProfilesDir = path.join(agentDir, "profiles");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	const userAgents = loadAgentsFromDir(userAgentsDir, "user");
	const userProfiles = loadAgentsFromDir(userProfilesDir, "user");
	const projectAgents = projectAgentsDir ? loadAgentsFromDir(projectAgentsDir, "project") : [];

	const agentMap = new Map<string, AgentConfig>();
	// agents/ has priority over profiles/ (backward compat with subagent)
	for (const agent of userProfiles) agentMap.set(agent.name, agent);
	for (const agent of userAgents) agentMap.set(agent.name, agent);
	// project-level overrides everything
	for (const agent of projectAgents) agentMap.set(agent.name, agent);

	return Array.from(agentMap.values());
}

/** Find a specific agent by name. */
export function findAgent(cwd: string, name: string): AgentConfig | undefined {
	const agents = discoverAgents(cwd);
	return agents.find((a) => a.name === name);
}

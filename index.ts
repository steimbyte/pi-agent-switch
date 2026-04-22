/**
 * agent-switcher extension
 *
 * Registers `/agent` command to switch between predefined agent profiles
 * mid-session. Agents are defined as .md files in:
 * - ~/.pi/agent/profiles/
 * - ~/.pi/agent/agents/   (compatible with subagent extension)
 *
 * Each agent defines:
 * - name, description, tools, model (optional), systemPrompt
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text, Input, matchesKey, Key } from "@mariozechner/pi-tui";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { discoverAgents, findAgent } from "./agents";

const MAX_AGENTS_SHOWN = 15;

// Module-level state — survives across commands in the same session
let activeAgentName: string | null = null;
let activeAgentConfig: ReturnType<typeof findAgent> | null = null;

export default function (pi: ExtensionAPI) {
	// ── Helper: build agent picker UI with search ───────────────────────────

	async function showPicker(
		ctx: Parameters<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>[0],
	): Promise<void> {
		const allAgents = discoverAgents(ctx.cwd);
		if (allAgents.length === 0) {
			ctx.ui.notify("No profiles found in ~/.pi/agent/profiles/", "warning");
			return;
		}

		// Build items for SelectList
		const buildItems = (): SelectItem[] =>
			allAgents.map((a) => {
				const isActive = a.name === activeAgentName;
				const activeBadge = isActive ? " ✓" : "";
				// Show folder path in label if agent is in subfolder
				const displayName = a.relativePath
					? `${a.relativePath}/${a.name}`
					: a.name;
				return {
					value: a.name,
					label: displayName + activeBadge,
					description: `${a.source === "project" ? "📁" : "🏠"} ${a.description}${isActive ? " ◀ active" : ""}`,
				};
			});

		const items = buildItems();

		await ctx.ui.custom<void>((tui, theme, _kb, done) => {
			const container = new Container();

			// Top border
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

			// Title with active agent
			const activeDisplay = activeAgentName ? ` → ${activeAgentName}` : "";
			container.addChild(
				new Text(theme.fg("accent", theme.bold(`  Switch Agent${activeDisplay}  `)), 1, 0),
			);

			// Search input
			const searchInput = new Input();
			searchInput.placeholder = "Search agents...";
			container.addChild(searchInput);

			// Divider
			container.addChild(new Text(theme.fg("dim", "  ─────────────────────────  "), 1, 0));

			// Agent list with built-in filtering
			const selectList = new SelectList(items, MAX_AGENTS_SHOWN, {
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => theme.fg("accent", t),
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			});

			// Handle selection
			selectList.onSelect = (item) => {
				done(undefined);
				activate(pi, ctx, item.value as string);
			};
			selectList.onCancel = () => done(undefined);

			container.addChild(selectList);

			// No results message
			const noResults = new Text(
				theme.fg("warning", "  No matching agents"),
				1,
				0,
			);
			// Show when filter is active but no matches
			noResults.visible = () => searchInput.value.length > 0 && selectList.getSelectedItem() === null;
			container.addChild(noResults);

			// Bottom
			container.addChild(new Text(theme.fg("dim", "  ↑↓ navigate · type to filter · enter select · esc cancel  "), 1, 0));
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

			return {
				render: (w: number) => container.render(w),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => {
					// Escape → cancel (check first)
					if (matchesKey(data, Key.escape)) {
						done(undefined);
						return;
					}

					// Forward printable chars and backspace to both Input and SelectList
					if (data.length === 1 && data.charCodeAt(0) >= 32) {
						searchInput.handleInput(data);
						selectList.setFilter(searchInput.value);
						tui.requestRender();
						return;
					}
					if (matchesKey(data, Key.backspace)) {
						searchInput.handleInput(data);
						selectList.setFilter(searchInput.value);
						tui.requestRender();
						return;
					}

					// Forward navigation/selection keys to SelectList
					if (
						matchesKey(data, Key.up) ||
						matchesKey(data, Key.down) ||
						matchesKey(data, Key.enter) ||
						matchesKey(data, Key.tab) ||
						matchesKey(data, Key.shift("tab")) ||
						matchesKey(data, Key.home) ||
						matchesKey(data, Key.end)
					) {
						selectList.handleInput(data);
						tui.requestRender();
						return;
					}
				},
			};
		});
	}

	// ── Activate an agent by name ──────────────────────────────────────────

	async function activate(
		pi: ExtensionAPI,
		ctx: Parameters<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>[0],
		agentName: string,
	): Promise<void> {
		const agent = findAgent(ctx.cwd, agentName);
		if (!agent) {
			ctx.ui.notify(`Profile "${agentName}" not found.`, "error");
			return;
		}

		activeAgentName = agentName;
		activeAgentConfig = agent;

		// Display agent with folder path in status bar
		const displayName = agent.relativePath 
			? `${agent.relativePath}/${agentName}` 
			: agentName;
		ctx.ui.setStatus("agent-switcher", `AGENT: ${displayName}`);

		if (agent.tools && agent.tools.length > 0) {
			pi.setActiveTools(agent.tools);
			ctx.ui.notify(`Switched to "${agentName}" (tools: ${agent.tools.join(", ")})`, "info");
		} else {
			ctx.ui.notify(`Switched to "${agentName}"`, "info");
		}
	}

	// ── /agent command ─────────────────────────────────────────────────────

	pi.registerCommand("agent", {
		description: "Switch to a different agent profile",
		handler: async (args, ctx) => {
			if (!args) {
				await showPicker(ctx);
				return;
			}

			const agent = findAgent(ctx.cwd, args);
			if (!agent) {
				const available = discoverAgents(ctx.cwd);
				const suggestions = available.slice(0, 5).map((a) => a.name).join(", ");
				ctx.ui.notify(
					`Profile "${args}" not found.${suggestions ? ` Try: ${suggestions}` : ""}`,
					"error",
				);
				return;
			}

			await activate(pi, ctx, args);
		},
	});

	// ── /agents command ─────────────────────────────────────────────────────

	pi.registerCommand("agents", {
		description: "List all available agent profiles",
		handler: async (_args, ctx) => {
			const agents = discoverAgents(ctx.cwd);
			if (agents.length === 0) {
				ctx.ui.notify("No profiles found.", "warning");
				return;
			}
			const lines = agents.map((a) => {
				const badge = a.source === "project" ? "📁" : "🏠";
				const marker = a.name === activeAgentName ? " ◀ active" : "";
				return `${badge} ${a.name}: ${a.description}${marker}`;
			});
			ctx.ui.setWidget("agents-list", lines);
			ctx.ui.notify(`${agents.length} profile(s) available.`, "info");
		},
	});

	// ── Inject agent system prompt prefix on each turn ─────────────────────

	pi.on("before_agent_start", async (event, ctx) => {
		if (!activeAgentConfig || !activeAgentConfig.systemPrompt) return;

		const prefix = `\n[AGENT MODE: ${activeAgentName}]\n${activeAgentConfig.systemPrompt}\n`;
		return { systemPrompt: event.systemPrompt + prefix };
	});

	// ── Restore active agent from session ──────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && (entry as any).customType === "agent-switcher:active") {
				const name = (entry as any).data?.name as string | undefined;
				if (name) {
					const agent = findAgent(ctx.cwd, name);
					if (agent) {
						activeAgentName = name;
						activeAgentConfig = agent;
						if (agent.tools && agent.tools.length > 0) {
							pi.setActiveTools(agent.tools);
						}
						// Restore with folder path in status bar
						const displayName = agent.relativePath 
							? `${agent.relativePath}/${name}` 
							: name;
						ctx.ui.setStatus("agent-switcher", `AGENT: ${displayName}`);
					}
				}
				break;
			}
		}
	});

	// ── Persist active agent on turn end ──────────────────────────────────

	pi.on("agent_end", async (_event, ctx) => {
		if (!activeAgentName) return;
		pi.appendEntry("agent-switcher:active", { name: activeAgentName });
	});
}

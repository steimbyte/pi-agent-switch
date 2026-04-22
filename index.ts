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
import { Container, type SelectItem, SelectList, Text, Input } from "@mariozechner/pi-tui";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { discoverAgents, findAgent } from "./agents";

const MAX_AGENTS_SHOWN = 15;

// Module-level state — survives across commands in the same session
let activeAgentName: string | null = null;
let activeAgentConfig: ReturnType<typeof findAgent> | null = null;

export default function (pi: ExtensionAPI) {
	// ── Fuzzy filter ────────────────────────────────────────────────────────

	function fuzzyMatch(query: string, text: string): boolean {
		if (!query) return true;
		const q = query.toLowerCase();
		const t = text.toLowerCase();
		// Simple substring + character-by-character fuzzy
		if (t.includes(q)) return true;
		let qi = 0;
		for (let i = 0; i < t.length && qi < q.length; i++) {
			if (t[i] === q[qi]) qi++;
		}
		return qi === q.length;
	}

	function filterAgents(agents: ReturnType<typeof discoverAgents>, query: string): typeof agents {
		if (!query) return agents;
		return agents.filter(
			(a) =>
				fuzzyMatch(query, a.name) ||
				fuzzyMatch(query, a.description),
		);
	}

	// ── Helper: build agent picker UI with search ───────────────────────────

	async function showPicker(
		ctx: Parameters<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>[0],
	): Promise<void> {
		const allAgents = discoverAgents(ctx.cwd);
		if (allAgents.length === 0) {
			ctx.ui.notify("No profiles found in ~/.pi/agent/profiles/", "warning");
			return;
		}

		let searchQuery = "";
		let filtered = allAgents;
		let selectedIndex = 0;

		const rebuildItems = (): SelectItem[] =>
			filtered.map((a) => ({
				value: a.name,
				label: a.name,
				description: `${a.source === "project" ? "📁" : "🏠"} ${a.description}`,
			}));

		await ctx.ui.custom<void>((tui, theme, _kb, done) => {
			const container = new Container();

			// Top border
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

			// Title
			container.addChild(
				new Text(theme.fg("accent", theme.bold("  Switch Agent  ")), 1, 0),
			);

			// Search input
			const searchInput = new Input();
			searchInput.placeholder = "Search agents...";
			const originalHandleInput = searchInput.handleInput.bind(searchInput);
			searchInput.handleInput = (data: string) => {
				const result = originalHandleInput(data);
				// Trigger filter on any character change (not on submit/escape)
				if (data !== "enter" && data !== "escape") {
					searchQuery = searchInput.value;
					filtered = filterAgents(allAgents, searchQuery);
					selectedIndex = Math.min(selectedIndex, Math.max(0, filtered.length - 1));
					tui.requestRender();
				}
				return result;
			};
			container.addChild(searchInput);

			// Divider
			container.addChild(new Text(theme.fg("dim", "  ─────────────────────────  "), 1, 0));

			// Agent list
			const selectList = new SelectList(rebuildItems(), Math.min(filtered.length, MAX_AGENTS_SHOWN), {
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => theme.fg("accent", t),
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			});

			// Select agent via onSelect callback (Enter key triggers this via SelectList)
			selectList.onSelect = (item) => {
				const name = item.value as string;
				if (name) {
					done(undefined);
					// Activate after picker closes
					activate(pi, ctx, name);
				}
			};

			container.addChild(selectList);

			// No results message
			const noResults = new Text(
				theme.fg("warning", "  No matching agents"),
				1,
				0,
			);
			noResults.visible = () => filtered.length === 0;
			container.addChild(noResults);

			// Bottom
			container.addChild(new Text(theme.fg("dim", "  ↑↓ navigate · type to filter · enter select · esc cancel  "), 1, 0));
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

			// Focus search input on start
			searchInput.focused = true;

			return {
				render: (w: number) => container.render(w),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => {
					// Tab or printable char → pass to search input when focused
					if (
						data === "tab" ||
						(data.length === 1 && data.charCodeAt(0) >= 32)
					) {
						if (searchInput.handleInput(data)) {
							tui.requestRender();
							return;
						}
					}
					// Arrow up → move select list up
					if (data === "up" || data === "shift+tab") {
						selectedIndex = Math.max(0, selectedIndex - 1);
						selectList.selectedIndex = selectedIndex;
						tui.requestRender();
						return;
					}
					// Arrow down → move select list down
					if (data === "down" || data === "tab") {
						selectedIndex = Math.min(filtered.length - 1, selectedIndex + 1);
						selectList.selectedIndex = selectedIndex;
						tui.requestRender();
						return;
					}
					// Escape → cancel
					if (data === "escape") {
						done(undefined);
						return;
					}
					// Backspace → search input
					if (data === "backspace") {
						if (searchInput.handleInput(data)) {
							tui.requestRender();
						}
						return;
					}
					// Pass remaining to select list
					selectList.handleInput(data);
					tui.requestRender();
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

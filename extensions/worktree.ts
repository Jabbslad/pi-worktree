/**
 * Worktree Isolation Extension
 *
 * Provides git worktree lifecycle management:
 * - /worktree command for interactive worktree creation, listing, and removal
 * - worktree_create tool for LLM-driven worktree creation
 * - worktree_finish tool for LLM-driven worktree cleanup
 * - Auto-detection when running inside a worktree
 * - Safety checks before removal (uncommitted files, unpushed commits)
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";

// ============================================================================
// Types
// ============================================================================

interface WorktreeState {
	phase: "created" | "active" | "kept" | "removed";
	worktreePath: string;
	branch: string;
	originalCwd: string;
	name: string;
	timestamp: number;
}

interface WorktreeDetection {
	name: string;
	branch: string;
	originalCwd: string;
}

interface SafetyCheckResult {
	uncommitted: number;
	unpushed: number;
}

// ============================================================================
// Constants
// ============================================================================

const ADJECTIVES = [
	"bold", "calm", "cool", "dark", "deep", "fair", "fast", "fine",
	"glad", "good", "keen", "kind", "loud", "mild", "neat", "pale",
	"pure", "rare", "safe", "slim", "soft", "tall", "thin", "warm",
	"wide", "wild", "wise",
];

const NOUNS = [
	"arch", "bear", "bell", "bird", "cave", "claw", "crow", "dawn",
	"deer", "dove", "dusk", "elm", "fern", "fish", "frog", "gale",
	"gull", "hare", "hawk", "iris", "jade", "lark", "lynx", "moss",
	"newt", "oak", "owl", "peak", "pine", "reed", "rose", "sage",
	"swan", "tide", "vale", "vine", "wren", "yew",
];

const WORKTREE_DIR = ".pi/worktrees";
const CUSTOM_TYPE = "worktree-state";

// ============================================================================
// Helpers
// ============================================================================

function generateName(): string {
	const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
	const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
	const suffix = Math.random().toString(36).slice(2, 6);
	return `${adj}-${noun}-${suffix}`;
}

function detectWorktree(cwd: string): WorktreeDetection | null {
	const gitPath = join(cwd, ".git");
	try {
		const stat = statSync(gitPath);
		if (!stat.isFile()) return null;

		const content = readFileSync(gitPath, "utf8").trim();
		if (!content.startsWith("gitdir: ")) return null;

		const gitdir = content.slice(8).trim();

		// Check if cwd is under a .pi/worktrees/ directory
		const marker = `/${WORKTREE_DIR}/`;
		const markerIndex = cwd.indexOf(marker);
		if (markerIndex === -1) return null;

		const originalCwd = cwd.slice(0, markerIndex);
		const afterMarker = cwd.slice(markerIndex + marker.length);
		const name = afterMarker.split("/")[0];
		if (!name) return null;

		// Read branch from HEAD in gitdir
		let branch: string;
		try {
			const headContent = readFileSync(join(gitdir, "HEAD"), "utf8").trim();
			branch = headContent.startsWith("ref: refs/heads/")
				? headContent.slice(16)
				: headContent.slice(0, 8); // detached HEAD: short hash
		} catch {
			branch = "unknown";
		}

		return { name, branch, originalCwd };
	} catch {
		return null;
	}
}

function getLastWorktreeState(ctx: ExtensionContext): WorktreeState | null {
	const entries = ctx.sessionManager.getBranch();
	let last: WorktreeState | null = null;
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === CUSTOM_TYPE) {
			last = entry.data as WorktreeState;
		}
	}
	return last;
}

async function safetyCheck(
	pi: ExtensionAPI,
	cwd: string,
	branch: string,
	originalCwd: string,
): Promise<SafetyCheckResult> {
	const statusResult = await pi.exec("git", ["status", "--porcelain"], { cwd });
	const uncommitted = statusResult.code === 0
		? statusResult.stdout.trim().split("\n").filter(Boolean).length
		: -1; // -1 signals git failure

	const logResult = await pi.exec(
		"git",
		["log", "--oneline", branch, "--not", "--remotes"],
		{ cwd: originalCwd },
	);
	const unpushed = logResult.code === 0
		? logResult.stdout.trim().split("\n").filter(Boolean).length
		: 0;

	return { uncommitted, unpushed };
}

async function syncSettings(gitRoot: string, worktreePath: string, pi: ExtensionAPI): Promise<void> {
	const piDir = join(gitRoot, ".pi");
	const destDir = join(worktreePath, ".pi");

	// Ensure .pi directory exists in worktree
	await pi.exec("mkdir", ["-p", destDir]);

	// Copy each config directory/file if it exists
	for (const item of ["extensions", "prompts", "skills", "settings.json"]) {
		const src = join(piDir, item);
		// Check source exists before copying
		const check = await pi.exec("test", ["-e", src]);
		if (check.code !== 0) continue;
		const result = await pi.exec("cp", ["-r", src, join(destDir, item)]);
		if (result.code !== 0) {
			// Non-fatal: log but continue
			await pi.exec("echo", [`Warning: failed to copy ${item}: ${result.stderr}`]);
		}
	}
}

async function createWorktree(
	pi: ExtensionAPI,
	cwd: string,
	name: string | undefined,
	branchFrom: string | undefined,
): Promise<{ ok: true; worktreePath: string; branch: string; name: string } | { ok: false; error: string }> {
	// Verify git repo
	const gitCheck = await pi.exec("git", ["rev-parse", "--git-dir"], { cwd });
	if (gitCheck.code !== 0) {
		return { ok: false, error: "Not in a git repository." };
	}

	// Get git root
	const rootResult = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd });
	if (rootResult.code !== 0) {
		return { ok: false, error: "Failed to determine git root." };
	}
	const gitRoot = rootResult.stdout.trim();

	// Refuse to nest worktrees
	if (detectWorktree(cwd)) {
		return { ok: false, error: "Already inside a worktree. Nesting is not supported." };
	}

	const worktreeName = name || generateName();
	const branch = `worktree/${worktreeName}`;
	const worktreePath = join(gitRoot, WORKTREE_DIR, worktreeName);
	const ref = branchFrom || "HEAD";

	// Create worktree
	let addResult = await pi.exec(
		"git",
		["worktree", "add", worktreePath, "-b", branch, ref],
		{ cwd },
	);

	// Retry with different name on branch collision
	if (addResult.code !== 0 && addResult.stderr.includes("already exists")) {
		const retryName = generateName();
		const retryBranch = `worktree/${retryName}`;
		const retryPath = join(gitRoot, WORKTREE_DIR, retryName);
		addResult = await pi.exec(
			"git",
			["worktree", "add", retryPath, "-b", retryBranch, ref],
			{ cwd },
		);
		if (addResult.code !== 0) {
			return { ok: false, error: `Failed to create worktree: ${addResult.stderr}` };
		}
		await syncSettings(gitRoot, retryPath, pi);
		return { ok: true, worktreePath: retryPath, branch: retryBranch, name: retryName };
	}

	if (addResult.code !== 0) {
		return { ok: false, error: `Failed to create worktree: ${addResult.stderr}` };
	}

	await syncSettings(gitRoot, worktreePath, pi);
	return { ok: true, worktreePath, branch, name: worktreeName };
}

// ============================================================================
// Extension entry point
// ============================================================================

export default function (pi: ExtensionAPI) {
	// ========================================================================
	// LLM-callable tools
	// ========================================================================

	pi.registerTool({
		name: "worktree_create",
		label: "Create Worktree",
		description:
			"Create an isolated git worktree for task work. " +
			"Creates a new branch and worktree directory under .pi/worktrees/. " +
			"After creation, the user should launch a new pi session from the worktree directory.",
		promptSnippet: "Create an isolated git worktree for a task",
		promptGuidelines: [
			"Only use worktree_create when the user explicitly asks to work in isolation or mentions 'worktree'.",
			"After creating a worktree, tell the user to cd into the worktree path and start a new pi session.",
		],
		parameters: Type.Object({
			name: Type.Optional(
				Type.String({ description: "Worktree name (e.g. 'fix-auth'). Random if omitted." }),
			),
			branch_from: Type.Optional(
				Type.String({ description: "Git ref to branch from. Defaults to HEAD." }),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = await createWorktree(pi, ctx.cwd, params.name, params.branch_from);
			if (!result.ok) {
				return {
					content: [{ type: "text" as const, text: `Error: ${result.error}` }],
					details: {},
				};
			}

			pi.appendEntry<WorktreeState>(CUSTOM_TYPE, {
				phase: "created",
				worktreePath: result.worktreePath,
				branch: result.branch,
				originalCwd: ctx.cwd,
				name: result.name,
				timestamp: Date.now(),
			});

			return {
				content: [{
					type: "text" as const,
					text:
						`Worktree created:\n` +
						`  Name: ${result.name}\n` +
						`  Path: ${result.worktreePath}\n` +
						`  Branch: ${result.branch}\n\n` +
						`Tell the user to run:\n  cd ${result.worktreePath} && pi`,
				}],
				details: { worktreePath: result.worktreePath, branch: result.branch, name: result.name },
			};
		},
	});

	pi.registerTool({
		name: "worktree_finish",
		label: "Finish Worktree",
		description:
			"Exit the current worktree session. " +
			"Action 'keep' preserves the worktree on disk. " +
			"Action 'remove' deletes the worktree and its branch after safety checks.",
		promptGuidelines: [
			"Only use worktree_finish when inside an active worktree session.",
			"Prefer action 'keep' unless the user explicitly asks to remove the worktree.",
			"If remove fails due to uncommitted changes, ask the user before setting discard_changes.",
		],
		parameters: Type.Object({
			action: Type.Union([Type.Literal("keep"), Type.Literal("remove")], {
				description: "'keep' preserves the worktree; 'remove' deletes it and its branch.",
			}),
			discard_changes: Type.Optional(
				Type.Boolean({
					description: "Force removal even with uncommitted changes or unpushed commits.",
				}),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const state = getLastWorktreeState(ctx);
			if (!state || state.phase !== "active") {
				return {
					content: [{ type: "text" as const, text: "Not in an active worktree session." }],
					details: {},
				};
			}

			// Verify session cwd matches recorded worktree
			if (ctx.cwd !== state.worktreePath) {
				return {
					content: [{
						type: "text" as const,
						text: `Session cwd (${ctx.cwd}) does not match worktree (${state.worktreePath}). Cannot proceed.`,
					}],
					details: {},
				};
			}

			if (params.action === "keep") {
				pi.appendEntry<WorktreeState>(CUSTOM_TYPE, {
					...state,
					phase: "kept",
					timestamp: Date.now(),
				});
				return {
					content: [{
						type: "text" as const,
						text: `Worktree kept at ${state.worktreePath}\nBranch: ${state.branch}`,
					}],
					details: {},
				};
			}

			// action === "remove"
			const checks = await safetyCheck(pi, ctx.cwd, state.branch, state.originalCwd);

			// Fail-closed: if git status itself failed, refuse removal
			if (checks.uncommitted < 0) {
				return {
					content: [{
						type: "text" as const,
						text: "Cannot determine worktree status (git failed). Refusing removal for safety.",
					}],
					details: {},
				};
			}

			if ((checks.uncommitted > 0 || checks.unpushed > 0) && !params.discard_changes) {
				return {
					content: [{
						type: "text" as const,
						text:
							`Cannot remove worktree with unsaved work:\n` +
							`  Uncommitted files: ${checks.uncommitted}\n` +
							`  Unpushed commits: ${checks.unpushed}\n\n` +
							`Set discard_changes=true to force removal, or use action="keep".`,
					}],
					details: { uncommitted: checks.uncommitted, unpushed: checks.unpushed },
				};
			}

			// Remove worktree (must run from outside the worktree)
			const removeResult = await pi.exec(
				"git",
				["worktree", "remove", state.worktreePath, "--force"],
				{ cwd: state.originalCwd },
			);
			if (removeResult.code !== 0) {
				return {
					content: [{
						type: "text" as const,
						text: `Failed to remove worktree: ${removeResult.stderr}`,
					}],
					details: {},
				};
			}

			// Delete the branch
			await pi.exec("git", ["branch", "-D", state.branch], { cwd: state.originalCwd });

			pi.appendEntry<WorktreeState>(CUSTOM_TYPE, {
				...state,
				phase: "removed",
				timestamp: Date.now(),
			});

			return {
				content: [{
					type: "text" as const,
					text: `Worktree "${state.name}" removed.\nReturned to: ${state.originalCwd}`,
				}],
				details: {},
			};
		},
	});

	// ========================================================================
	// /worktree command
	// ========================================================================

	pi.registerCommand("worktree", {
		description: "Manage git worktrees (create, list, remove)",
		getArgumentCompletions(prefix) {
			const subs = ["create", "list", "remove"];
			return subs
				.filter((s) => s.startsWith(prefix))
				.map((s) => ({ value: s, label: s }));
		},
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/);
			const subcommand = parts[0] || "";

			if (!subcommand) {
				if (!ctx.hasUI) {
					ctx.ui.notify("Usage: /worktree <create|list|remove>", "info");
					return;
				}
				const choice = await ctx.ui.select("Worktree", [
					"create - Create a new worktree",
					"list - List existing worktrees",
					"remove - Remove a worktree",
				]);
				if (!choice) return;
				const selected = choice.split(" - ")[0];
				return handleSubcommand(selected, parts.slice(1), ctx);
			}

			return handleSubcommand(subcommand, parts.slice(1), ctx);
		},
	});

	async function handleSubcommand(sub: string, args: string[], ctx: ExtensionCommandContext) {
		switch (sub) {
			case "create": {
				const name = args[0] || undefined;
				const result = await createWorktree(pi, ctx.cwd, name, undefined);
				if (!result.ok) {
					ctx.ui.notify(result.error, "error");
					return;
				}
				pi.appendEntry<WorktreeState>(CUSTOM_TYPE, {
					phase: "created",
					worktreePath: result.worktreePath,
					branch: result.branch,
					originalCwd: ctx.cwd,
					name: result.name,
					timestamp: Date.now(),
				});

				ctx.ui.notify(
					`Worktree created: ${result.name}\n` +
					`Path: ${result.worktreePath}\n` +
					`Branch: ${result.branch}\n\n` +
					`Run: cd ${result.worktreePath} && pi`,
					"info",
				);
				return;
			}

			case "list": {
				const listResult = await pi.exec("git", ["worktree", "list"], { cwd: ctx.cwd });
				if (listResult.code !== 0) {
					ctx.ui.notify(`git worktree list failed: ${listResult.stderr}`, "error");
					return;
				}

				const lines = listResult.stdout.trim().split("\n");
				const piWorktrees = lines.filter((l) => l.includes(`/${WORKTREE_DIR}/`));

				if (piWorktrees.length === 0) {
					ctx.ui.notify("No pi worktrees found.", "info");
					return;
				}

				ctx.ui.notify(
					`Pi worktrees (${piWorktrees.length}):\n${piWorktrees.join("\n")}`,
					"info",
				);
				return;
			}

			case "remove": {
				const targetName = args[0];
				if (!targetName) {
					const listResult = await pi.exec("git", ["worktree", "list", "--porcelain"], { cwd: ctx.cwd });
					if (listResult.code !== 0) {
						ctx.ui.notify(`git worktree list failed: ${listResult.stderr}`, "error");
						return;
					}

					const worktrees = parseWorktreeList(listResult.stdout);
					if (worktrees.length === 0) {
						ctx.ui.notify("No pi worktrees to remove.", "info");
						return;
					}

					if (!ctx.hasUI) {
						ctx.ui.notify("Usage: /worktree remove <name>", "info");
						return;
					}

					const choice = await ctx.ui.select(
						"Select worktree to remove",
						worktrees.map((w) => `${w.name} (${w.branch})`),
					);
					if (!choice) return;

					const selectedName = choice.split(" (")[0];
					return removeWorktreeInteractive(selectedName, ctx);
				}

				return removeWorktreeInteractive(targetName, ctx);
			}

			default:
				ctx.ui.notify(`Unknown subcommand: ${sub}. Use create, list, or remove.`, "error");
		}
	}

	function parseWorktreeList(porcelainOutput: string): Array<{ name: string; path: string; branch: string }> {
		const blocks = porcelainOutput.trim().split("\n\n");
		const results: Array<{ name: string; path: string; branch: string }> = [];

		for (const block of blocks) {
			const lines = block.split("\n");
			const pathLine = lines.find((l) => l.startsWith("worktree "));
			const branchLine = lines.find((l) => l.startsWith("branch "));

			if (!pathLine) continue;
			const path = pathLine.slice(9);

			const marker = `/${WORKTREE_DIR}/`;
			const idx = path.indexOf(marker);
			if (idx === -1) continue;

			const name = path.slice(idx + marker.length).split("/")[0];
			if (!name) continue;
			const branch = branchLine ? branchLine.slice(7) : "unknown";

			results.push({ name, path, branch });
		}

		return results;
	}

	async function removeWorktreeInteractive(name: string, ctx: ExtensionContext) {
		const rootResult = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd: ctx.cwd });
		if (rootResult.code !== 0) {
			ctx.ui.notify("Failed to determine git root.", "error");
			return;
		}
		const gitRoot = rootResult.stdout.trim();
		const worktreePath = join(gitRoot, WORKTREE_DIR, name);

		const branch = `worktree/${name}`;
		const checks = await safetyCheck(pi, worktreePath, branch, gitRoot);

		if (checks.uncommitted < 0) {
			ctx.ui.notify("Cannot determine worktree status. Is it a valid worktree?", "error");
			return;
		}

		if (checks.uncommitted > 0 || checks.unpushed > 0) {
			if (!ctx.hasUI) {
				ctx.ui.notify(
					`Worktree "${name}" has ${checks.uncommitted} uncommitted files and ${checks.unpushed} unpushed commits. Cannot remove in non-interactive mode.`,
					"error",
				);
				return;
			}
			const confirmed = await ctx.ui.confirm(
				"Discard changes?",
				`Worktree "${name}" has ${checks.uncommitted} uncommitted file(s) and ${checks.unpushed} unpushed commit(s). Remove anyway?`,
			);
			if (!confirmed) {
				ctx.ui.notify("Removal cancelled.", "info");
				return;
			}
		}

		const removeResult = await pi.exec(
			"git",
			["worktree", "remove", worktreePath, "--force"],
			{ cwd: gitRoot },
		);
		if (removeResult.code !== 0) {
			ctx.ui.notify(`Failed to remove worktree: ${removeResult.stderr}`, "error");
			return;
		}

		await pi.exec("git", ["branch", "-D", branch], { cwd: gitRoot });

		pi.appendEntry<WorktreeState>(CUSTOM_TYPE, {
			phase: "removed",
			worktreePath,
			branch,
			originalCwd: gitRoot,
			name,
			timestamp: Date.now(),
		});

		ctx.ui.notify(`Worktree "${name}" removed.`, "info");
	}

	// ========================================================================
	// Event handlers
	// ========================================================================

	pi.on("session_start", async (_event, ctx) => {
		const detection = detectWorktree(ctx.cwd);
		if (!detection) return;

		pi.appendEntry<WorktreeState>(CUSTOM_TYPE, {
			phase: "active",
			worktreePath: ctx.cwd,
			branch: detection.branch,
			originalCwd: detection.originalCwd,
			name: detection.name,
			timestamp: Date.now(),
		});

		ctx.ui.setStatus("worktree", `worktree: ${detection.name} (${detection.branch})`);
		ctx.ui.notify(`Working in worktree: ${detection.name}`, "info");
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const state = getLastWorktreeState(ctx);
		if (!state || state.phase !== "active") return;

		const checks = await safetyCheck(pi, ctx.cwd, state.branch, state.originalCwd);

		// If dirty, has unpushed commits, or git failed: always keep
		if (checks.uncommitted !== 0 || checks.unpushed > 0) {
			const reasons: string[] = [];
			if (checks.uncommitted < 0) reasons.push("git status failed");
			if (checks.uncommitted > 0) reasons.push(`${checks.uncommitted} uncommitted file(s)`);
			if (checks.unpushed > 0) reasons.push(`${checks.unpushed} unpushed commit(s)`);
			ctx.ui.notify(
				`Worktree "${state.name}" kept (${reasons.join(", ")}).\nPath: ${state.worktreePath}`,
				"info",
			);
			pi.appendEntry<WorktreeState>(CUSTOM_TYPE, { ...state, phase: "kept", timestamp: Date.now() });
			return;
		}

		// Clean worktree: prompt if UI available
		if (ctx.hasUI) {
			const remove = await ctx.ui.confirm(
				"Remove worktree?",
				`Worktree "${state.name}" has no uncommitted changes or unpushed commits. Remove it?`,
			);
			if (remove) {
				await pi.exec(
					"git",
					["worktree", "remove", state.worktreePath, "--force"],
					{ cwd: state.originalCwd },
				);
				await pi.exec("git", ["branch", "-D", state.branch], { cwd: state.originalCwd });
				pi.appendEntry<WorktreeState>(CUSTOM_TYPE, { ...state, phase: "removed", timestamp: Date.now() });
				ctx.ui.notify(`Worktree "${state.name}" removed.`, "info");
				return;
			}
		}

		// Default: keep
		pi.appendEntry<WorktreeState>(CUSTOM_TYPE, { ...state, phase: "kept", timestamp: Date.now() });
	});
}

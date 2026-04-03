/**
 * Team Agents Extension (SDK-based prototype)
 *
 * Replaces RPC subprocess spawning with in-process AgentSessionRuntime,
 * enabling cwd switching without restarting agents.
 *
 * Key changes from the original:
 * - Agents run as in-process AgentSession instances via createAgentSessionRuntime()
 * - agent_switch_cwd tool: switches an agent's working directory to any path
 * - The runtime factory pattern allows rebuilding cwd-bound services on the fly
 *
 * Architecture:
 * - Each agent gets its own AgentSessionRuntime with a factory that can be
 *   re-invoked for a different cwd
 * - The factory closes over fixed inputs (auth, model) and recreates
 *   cwd-bound services (resource loader, settings, tools, extensions)
 * - When switching cwd, we dispose the old runtime and create a new one
 *   at the target path using the same factory
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Type } from "@mariozechner/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	AuthStorage,
	ModelRegistry,
	SessionManager,
	SettingsManager,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	getAgentDir,
	parseFrontmatter,
} from "@mariozechner/pi-coding-agent";

// ============================================================================
// Constants
// ============================================================================

const TEAM_LEAD_NAME = "team-lead";
const TEAMS_DIR = "teams";
const TASKS_DIR = "tasks";
const AGENTS_DIR = "agents";
const INBOX_POLL_INTERVAL_MS = 2000;
const HIGH_WATER_MARK_FILE = ".highwatermark";

// ============================================================================
// Types
// ============================================================================

interface TeamFile {
	name: string;
	description?: string;
	createdAt: number;
	leadAgentId: string;
	members: TeamMember[];
}

interface TeamMember {
	agentId: string;
	name: string;
	agentType?: string;
	model?: string;
	prompt?: string;
	joinedAt: number;
	cwd: string;
	isActive?: boolean;
}

interface Task {
	id: string;
	subject: string;
	description: string;
	activeForm?: string;
	owner?: string;
	status: "pending" | "in_progress" | "completed";
	blocks: string[];
	blockedBy: string[];
	metadata?: Record<string, unknown>;
}

interface TeammateMessage {
	from: string;
	text: string;
	timestamp: string;
	read: boolean;
	summary?: string;
}

interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	maxTurns?: number;
	initialPrompt?: string;
	source: "user" | "project";
	filePath: string;
}

/**
 * In-process agent handle. Replaces the old LiteRpcClient.
 * Holds the AgentSessionRuntime and the factory used to create it,
 * enabling cwd switching via dispose + recreate.
 */
interface InProcessAgent {
	runtime: AgentSessionRuntime;
	createRuntime: CreateAgentSessionRuntimeFactory;
	unsubscribe: () => void;
	agentDef: AgentConfig;
	currentCwd: string;
	isRunning: boolean;
	/** Track if the agent is currently processing */
	isBusy: boolean;
}

// ============================================================================
// Path Helpers (unchanged from original)
// ============================================================================

function sanitizeName(name: string): string {
	return name.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase();
}

function formatAgentId(name: string, teamName: string): string {
	return `${sanitizeName(name)}@${sanitizeName(teamName)}`;
}

function getPiDir(cwd: string): string {
	return join(cwd, ".pi");
}

function getTeamDir(cwd: string, teamName: string): string {
	return join(getPiDir(cwd), TEAMS_DIR, sanitizeName(teamName));
}

function getTeamFilePath(cwd: string, teamName: string): string {
	return join(getTeamDir(cwd, teamName), "config.json");
}

function getInboxDir(cwd: string, teamName: string): string {
	return join(getTeamDir(cwd, teamName), "inboxes");
}

function getInboxPath(cwd: string, agentName: string, teamName: string): string {
	return join(getInboxDir(cwd, teamName), `${sanitizeName(agentName)}.json`);
}

function getTasksDir(cwd: string, teamName: string): string {
	return join(getPiDir(cwd), TASKS_DIR, sanitizeName(teamName));
}

function getTaskPath(cwd: string, teamName: string, taskId: string): string {
	return join(getTasksDir(cwd, teamName), `${taskId}.json`);
}

function getTaskListLockPath(cwd: string, teamName: string): string {
	return join(getTasksDir(cwd, teamName), ".lock");
}

function getHighWaterMarkPath(cwd: string, teamName: string): string {
	return join(getTasksDir(cwd, teamName), HIGH_WATER_MARK_FILE);
}

// ============================================================================
// File Locking (mkdir-based, POSIX atomic)
// ============================================================================

async function acquireLock(
	lockPath: string,
	retries = 30,
	minTimeout = 5,
	maxTimeout = 100,
): Promise<() => Promise<void>> {
	for (let i = 0; i < retries; i++) {
		try {
			await mkdir(lockPath, { recursive: false });
			return async () => {
				try {
					await rm(lockPath, { recursive: true });
				} catch {
					// Ignore cleanup errors
				}
			};
		} catch (err: unknown) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== "EEXIST") throw err;
			const delay = Math.min(minTimeout * 2 ** i, maxTimeout);
			await new Promise((r) => setTimeout(r, delay));
		}
	}
	throw new Error(`Failed to acquire lock: ${lockPath}`);
}

// ============================================================================
// Team Config I/O (unchanged)
// ============================================================================

function readTeamFile(cwd: string, teamName: string): TeamFile | null {
	try {
		const content = readFileSync(getTeamFilePath(cwd, teamName), "utf-8");
		return JSON.parse(content) as TeamFile;
	} catch {
		return null;
	}
}

async function readTeamFileAsync(cwd: string, teamName: string): Promise<TeamFile | null> {
	try {
		const content = await readFile(getTeamFilePath(cwd, teamName), "utf-8");
		return JSON.parse(content) as TeamFile;
	} catch {
		return null;
	}
}

async function writeTeamFile(cwd: string, teamName: string, teamFile: TeamFile): Promise<void> {
	const dir = getTeamDir(cwd, teamName);
	await mkdir(dir, { recursive: true });
	await writeFile(getTeamFilePath(cwd, teamName), JSON.stringify(teamFile, null, 2));
}

async function addMemberToTeamFile(cwd: string, teamName: string, member: TeamMember): Promise<void> {
	const teamFile = await readTeamFileAsync(cwd, teamName);
	if (!teamFile) throw new Error(`Team "${teamName}" not found`);
	teamFile.members.push(member);
	await writeTeamFile(cwd, teamName, teamFile);
}

async function updateMemberCwd(cwd: string, teamName: string, memberName: string, newCwd: string): Promise<void> {
	const teamFile = await readTeamFileAsync(cwd, teamName);
	if (!teamFile) return;
	const member = teamFile.members.find((m) => m.name === memberName);
	if (!member) return;
	member.cwd = newCwd;
	await writeTeamFile(cwd, teamName, teamFile);
}

async function setMemberActive(cwd: string, teamName: string, memberName: string, isActive: boolean): Promise<void> {
	const teamFile = await readTeamFileAsync(cwd, teamName);
	if (!teamFile) return;
	const member = teamFile.members.find((m) => m.name === memberName);
	if (!member) return;
	member.isActive = isActive;
	await writeTeamFile(cwd, teamName, teamFile);
}

// ============================================================================
// Mailbox I/O (unchanged)
// ============================================================================

async function readMailbox(cwd: string, agentName: string, teamName: string): Promise<TeammateMessage[]> {
	try {
		const content = await readFile(getInboxPath(cwd, agentName, teamName), "utf-8");
		return JSON.parse(content) as TeammateMessage[];
	} catch {
		return [];
	}
}

async function readUnreadMessages(cwd: string, agentName: string, teamName: string): Promise<TeammateMessage[]> {
	const messages = await readMailbox(cwd, agentName, teamName);
	return messages.filter((m) => !m.read);
}

async function writeToMailbox(
	cwd: string,
	recipientName: string,
	message: Omit<TeammateMessage, "read">,
	teamName: string,
): Promise<void> {
	const inboxDir = getInboxDir(cwd, teamName);
	await mkdir(inboxDir, { recursive: true });

	const inboxPath = getInboxPath(cwd, recipientName, teamName);
	const lockPath = `${inboxPath}.lockdir`;

	try {
		await writeFile(inboxPath, "[]", { flag: "wx" });
	} catch {
		// File already exists
	}

	const release = await acquireLock(lockPath, 10, 5, 100);
	try {
		const messages = await readMailbox(cwd, recipientName, teamName);
		messages.push({ ...message, read: false });
		await writeFile(inboxPath, JSON.stringify(messages, null, 2));
	} finally {
		await release();
	}
}

async function markMessagesAsRead(cwd: string, agentName: string, teamName: string): Promise<void> {
	const inboxPath = getInboxPath(cwd, agentName, teamName);
	const lockPath = `${inboxPath}.lockdir`;

	let release: (() => Promise<void>) | undefined;
	try {
		release = await acquireLock(lockPath, 10, 5, 100);
		const messages = await readMailbox(cwd, agentName, teamName);
		if (messages.length === 0) return;
		for (const m of messages) m.read = true;
		await writeFile(inboxPath, JSON.stringify(messages, null, 2));
	} catch {
		// Ignore
	} finally {
		await release?.();
	}
}

// ============================================================================
// Task I/O (unchanged)
// ============================================================================

async function readHighWaterMark(cwd: string, teamName: string): Promise<number> {
	try {
		const content = (await readFile(getHighWaterMarkPath(cwd, teamName), "utf-8")).trim();
		const value = parseInt(content, 10);
		return Number.isNaN(value) ? 0 : value;
	} catch {
		return 0;
	}
}

async function writeHighWaterMark(cwd: string, teamName: string, value: number): Promise<void> {
	await writeFile(getHighWaterMarkPath(cwd, teamName), String(value));
}

async function findHighestTaskIdFromFiles(cwd: string, teamName: string): Promise<number> {
	const dir = getTasksDir(cwd, teamName);
	let files: string[];
	try {
		files = await readdir(dir);
	} catch {
		return 0;
	}
	let max = 0;
	for (const f of files) {
		if (!f.endsWith(".json")) continue;
		const id = parseInt(f.replace(".json", ""), 10);
		if (!Number.isNaN(id) && id > max) max = id;
	}
	return max;
}

async function getNextTaskId(cwd: string, teamName: string): Promise<string> {
	const lockPath = getTaskListLockPath(cwd, teamName);
	await mkdir(getTasksDir(cwd, teamName), { recursive: true });
	const release = await acquireLock(lockPath, 30, 5, 100);
	try {
		const [fromFiles, fromMark] = await Promise.all([
			findHighestTaskIdFromFiles(cwd, teamName),
			readHighWaterMark(cwd, teamName),
		]);
		const next = Math.max(fromFiles, fromMark) + 1;
		await writeHighWaterMark(cwd, teamName, next);
		return String(next);
	} finally {
		await release();
	}
}

async function createTask(cwd: string, teamName: string, taskData: Omit<Task, "id">): Promise<string> {
	const id = await getNextTaskId(cwd, teamName);
	const task: Task = { id, ...taskData };
	await writeFile(getTaskPath(cwd, teamName, id), JSON.stringify(task, null, 2));
	return id;
}

async function getTask(cwd: string, teamName: string, taskId: string): Promise<Task | null> {
	try {
		const content = await readFile(getTaskPath(cwd, teamName, taskId), "utf-8");
		return JSON.parse(content) as Task;
	} catch {
		return null;
	}
}

async function updateTask(
	cwd: string,
	teamName: string,
	taskId: string,
	updates: Partial<Omit<Task, "id">>,
): Promise<Task | null> {
	const taskPath = getTaskPath(cwd, teamName, taskId);
	const lockPath = `${taskPath}.lockdir`;
	const release = await acquireLock(lockPath, 30, 5, 100);
	try {
		const existing = await getTask(cwd, teamName, taskId);
		if (!existing) return null;
		const updated: Task = { ...existing, ...updates, id: taskId };
		await writeFile(taskPath, JSON.stringify(updated, null, 2));
		return updated;
	} finally {
		await release();
	}
}

async function listTasks(cwd: string, teamName: string): Promise<Task[]> {
	const dir = getTasksDir(cwd, teamName);
	let files: string[];
	try {
		files = await readdir(dir);
	} catch {
		return [];
	}
	const taskIds = files.filter((f) => f.endsWith(".json")).map((f) => f.replace(".json", ""));
	const results = await Promise.all(taskIds.map((id) => getTask(cwd, teamName, id)));
	return results.filter((t): t is Task => t !== null);
}

async function deleteTask(cwd: string, teamName: string, taskId: string): Promise<boolean> {
	const path = getTaskPath(cwd, teamName, taskId);
	try {
		const numericId = parseInt(taskId, 10);
		if (!Number.isNaN(numericId)) {
			const currentMark = await readHighWaterMark(cwd, teamName);
			if (numericId > currentMark) {
				await writeHighWaterMark(cwd, teamName, numericId);
			}
		}
		await rm(path);
		return true;
	} catch {
		return false;
	}
}

// ============================================================================
// Built-in Agent Definitions (unchanged)
// ============================================================================

const BUILT_IN_AGENTS: AgentConfig[] = [
	{
		name: "general-purpose",
		description: "General-purpose agent for research, code search, and multi-step tasks",
		systemPrompt: `You are a general-purpose agent. Given the user's message, use the tools available to complete the task fully.

Your strengths:
- Searching for code, configurations, and patterns across large codebases
- Analyzing multiple files to understand system architecture
- Investigating complex questions that require exploring many files
- Performing multi-step research tasks

Guidelines:
- Search broadly when you don't know where something lives
- Start broad and narrow down. Use multiple search strategies if the first doesn't yield results
- Be thorough: check multiple locations, consider different naming conventions
- Never create files unless absolutely necessary
- When complete, respond with a concise report of what was done and key findings`,
		source: "user",
		filePath: "built-in",
	},
	{
		name: "researcher",
		description: "Fast codebase exploration specialist (read-only)",
		tools: ["read", "grep", "find", "ls", "bash"],
		systemPrompt: `You are a research specialist. You excel at thoroughly navigating and exploring codebases.

CRITICAL: READ-ONLY MODE. You must NOT create, modify, or delete any files.

Your strengths:
- Rapidly finding files using glob patterns
- Searching code with powerful regex patterns
- Reading and analyzing file contents

Guidelines:
- Use grep and find for broad searches
- Use read when you know the specific file path
- Use bash ONLY for read-only operations (ls, git status, git log, git diff, find, grep)
- Make efficient use of tools — spawn multiple parallel tool calls where possible
- Report findings clearly and concisely`,
		source: "user",
		filePath: "built-in",
	},
	{
		name: "coder",
		description: "Implementation agent with full read/write capabilities",
		systemPrompt: `You are an implementation specialist. You write clean, correct code that follows existing project conventions.

Guidelines:
- Read existing code before making changes — understand patterns and style
- Make minimal, focused changes — don't refactor code you weren't asked to change
- Test your changes when possible
- Never introduce security vulnerabilities
- When complete, clearly state what files were changed and why`,
		source: "user",
		filePath: "built-in",
	},
	{
		name: "reviewer",
		description: "Code review agent that examines diffs for bugs, style, and security issues",
		tools: ["read", "grep", "find", "ls", "bash"],
		systemPrompt: `You are a code review specialist. You examine code changes for correctness, style, and security.

CRITICAL: READ-ONLY MODE. You must NOT create, modify, or delete any files.

Review checklist:
- Correctness: Does the code do what it claims? Edge cases? Off-by-one errors?
- Security: Injection vulnerabilities? Improper input validation? Exposed secrets?
- Style: Consistent with existing codebase conventions?
- Performance: Any obvious inefficiencies?

Guidelines:
- Use bash to run git diff and git log to understand what changed
- Read the surrounding code to understand context
- Report issues categorized by severity (critical, warning, suggestion)
- Be specific — include file paths and line numbers`,
		source: "user",
		filePath: "built-in",
	},
	{
		name: "planner",
		description: "Architecture agent that creates implementation plans (read-only)",
		tools: ["read", "grep", "find", "ls", "bash"],
		systemPrompt: `You are a software architect. You analyze codebases and create detailed implementation plans.

CRITICAL: READ-ONLY MODE. You must NOT create, modify, or delete any files.

Guidelines:
- Explore the codebase to understand existing architecture and patterns
- Identify files that need to be created or modified
- Consider edge cases and potential issues
- Produce a clear, step-by-step implementation plan
- Include specific file paths and function names
- Note any dependencies between steps`,
		source: "user",
		filePath: "built-in",
	},
];

// ============================================================================
// Agent Discovery (unchanged)
// ============================================================================

function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
	const agents: AgentConfig[] = [];
	if (!existsSync(dir)) return agents;

	let entries: ReturnType<typeof readdirSync>;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = join(dir, entry.name);
		let content: string;
		try {
			content = readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
		if (!frontmatter.name || !frontmatter.description) continue;

		const tools = frontmatter.tools
			?.split(",")
			.map((t: string) => t.trim())
			.filter(Boolean);

		const maxTurnsRaw = frontmatter.maxTurns;
		const maxTurns = maxTurnsRaw ? parseInt(maxTurnsRaw, 10) : undefined;

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: tools && tools.length > 0 ? tools : undefined,
			model: frontmatter.model,
			systemPrompt: body,
			maxTurns: maxTurns && !Number.isNaN(maxTurns) ? maxTurns : undefined,
			initialPrompt: frontmatter.initialPrompt,
			source,
			filePath,
		});
	}

	return agents;
}

function discoverAgents(cwd: string): AgentConfig[] {
	const userDir = join(getAgentDir(), "agents");
	const projectDir = join(cwd, ".pi", AGENTS_DIR);

	const userAgents = loadAgentsFromDir(userDir, "user");
	const projectAgents = loadAgentsFromDir(projectDir, "project");

	const agentMap = new Map<string, AgentConfig>();
	for (const agent of BUILT_IN_AGENTS) agentMap.set(agent.name, agent);
	for (const agent of userAgents) agentMap.set(agent.name, agent);
	for (const agent of projectAgents) agentMap.set(agent.name, agent);
	return Array.from(agentMap.values());
}

// ============================================================================
// In-Process Agent Factory
// ============================================================================

/**
 * Create a runtime factory for an agent.
 * The factory closes over the agent's system prompt and configuration,
 * and recreates cwd-bound services for each effective cwd.
 */
function createAgentRuntimeFactory(
	agentDef: AgentConfig,
	teamName: string,
	agentName: string,
	modelOverride?: string,
): CreateAgentSessionRuntimeFactory {
	// Build the full system prompt once (it doesn't change with cwd)
	const teammateAddendum = `
# Agent Teammate Communication

IMPORTANT: You are running as agent "${agentName}" in team "${teamName}".
The team lead coordinates your work through messages.

When you complete a task, clearly state:
- What was accomplished
- Files changed (if any)
- Any blockers or questions for other agents

Messages from other teammates will arrive prefixed with their name.
Your responses go back to the team lead who will route them as needed.
`;

	const fullSystemPrompt = [agentDef.systemPrompt, teammateAddendum].join("\n\n");

	return async ({ cwd, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd,
			resourceLoaderOptions: {
				systemPromptOverride: () => fullSystemPrompt,
			},
		});

		return {
			...(await createAgentSessionFromServices({
				services,
				sessionManager,
				sessionStartEvent,
			})),
			services,
			diagnostics: services.diagnostics,
		};
	};
}

/**
 * Spawn an in-process agent using the SDK's AgentSessionRuntime.
 * Returns an InProcessAgent handle that supports cwd switching.
 */
async function spawnInProcessAgent(
	agentDef: AgentConfig,
	teamName: string,
	agentName: string,
	cwd: string,
	modelOverride?: string,
): Promise<InProcessAgent> {
	const factory = createAgentRuntimeFactory(agentDef, teamName, agentName, modelOverride);

	const runtime = await createAgentSessionRuntime(factory, {
		cwd,
		agentDir: getAgentDir(),
		sessionManager: SessionManager.inMemory(),
	});

	// Subscribe to events for monitoring
	let isBusy = false;
	const unsubscribe = runtime.session.subscribe((event) => {
		if (event.type === "agent_start") {
			isBusy = true;
		} else if (event.type === "agent_end") {
			isBusy = false;
		}
	});

	return {
		runtime,
		createRuntime: factory,
		unsubscribe,
		agentDef,
		currentCwd: cwd,
		isRunning: true,
		get isBusy() {
			return isBusy;
		},
	};
}

/**
 * Switch an agent's working directory by creating a new runtime at the target cwd.
 * Disposes the old runtime and creates a fresh one using the same factory.
 * Conversation history is NOT preserved (fresh session at new cwd).
 */
async function switchAgentCwd(agent: InProcessAgent, newCwd: string): Promise<void> {
	// Dispose old runtime
	agent.unsubscribe();
	await agent.runtime.dispose();

	// Create new runtime at the new cwd using the same factory
	const newRuntime = await createAgentSessionRuntime(agent.createRuntime, {
		cwd: newCwd,
		agentDir: getAgentDir(),
		sessionManager: SessionManager.inMemory(),
	});

	// Re-subscribe
	let isBusy = false;
	const newUnsubscribe = newRuntime.session.subscribe((event) => {
		if (event.type === "agent_start") {
			isBusy = true;
		} else if (event.type === "agent_end") {
			isBusy = false;
		}
	});

	// Update agent handle in place
	agent.runtime = newRuntime;
	agent.unsubscribe = newUnsubscribe;
	agent.currentCwd = newCwd;
	Object.defineProperty(agent, "isBusy", {
		get: () => isBusy,
		configurable: true,
	});
}

/**
 * Send a prompt to an in-process agent and wait for completion.
 */
async function promptAgent(agent: InProcessAgent, message: string, timeout = 120000): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error("Timeout waiting for agent response"));
		}, timeout);

		const parts: string[] = [];
		const unsub = agent.runtime.session.subscribe((event) => {
			if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
				parts.push(event.assistantMessageEvent.delta);
			}
			if (event.type === "agent_end") {
				clearTimeout(timer);
				unsub();
				resolve(parts.join(""));
			}
		});

		agent.runtime.session.prompt(message).catch((err) => {
			clearTimeout(timer);
			unsub();
			reject(err);
		});
	});
}

// ============================================================================
// Inbox Polling (adapted for in-process agents)
// ============================================================================

function startInboxPolling(
	cwd: string,
	teamName: string,
	agents: Map<string, InProcessAgent>,
): NodeJS.Timeout {
	return setInterval(async () => {
		for (const [name, agent] of agents) {
			if (!agent.isRunning || agent.isBusy) continue;
			try {
				const unread = await readUnreadMessages(cwd, name, teamName);
				if (unread.length === 0) continue;

				const formatted = unread
					.map(
						(m) =>
							`<teammate-message from="${m.from}" summary="${m.summary || ""}">\n${m.text}\n</teammate-message>`,
					)
					.join("\n\n");

				// Use followUp to avoid interrupting current work
				await agent.runtime.session.followUp(formatted);
				await markMessagesAsRead(cwd, name, teamName);
			} catch {
				// Ignore polling errors for individual agents
			}
		}
	}, INBOX_POLL_INTERVAL_MS);
}

// ============================================================================
// Extension Entry Point
// ============================================================================

export default function (pi: ExtensionAPI) {
	const activeAgents = new Map<string, InProcessAgent>();
	let currentTeam: string | null = null;
	let pollingInterval: NodeJS.Timeout | null = null;

	function requireTeam(): string {
		if (!currentTeam) throw new Error("No active team. Use team_create first.");
		return currentTeam;
	}

	// ========================================================================
	// Tool: team_create
	// ========================================================================

	pi.registerTool({
		name: "team_create",
		label: "Create Team",
		description:
			"Create a new team for multi-agent coordination. " +
			"Sets up team config, inbox directory, and shared task board. " +
			"The current session becomes the team lead.",
		promptSnippet: "Create a team for multi-agent coordination",
		parameters: Type.Object({
			team_name: Type.String({ description: "Unique name for the team" }),
			description: Type.Optional(Type.String({ description: "Team purpose/description" })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (currentTeam) {
				return {
					content: [{ type: "text" as const, text: `Already leading team "${currentTeam}". Delete it first.` }],
					details: {},
				};
			}

			const teamName = params.team_name;
			const leadAgentId = formatAgentId(TEAM_LEAD_NAME, teamName);

			const teamFile: TeamFile = {
				name: teamName,
				description: params.description,
				createdAt: Date.now(),
				leadAgentId,
				members: [
					{
						agentId: leadAgentId,
						name: TEAM_LEAD_NAME,
						joinedAt: Date.now(),
						cwd: ctx.cwd,
						isActive: true,
					},
				],
			};

			await writeTeamFile(ctx.cwd, teamName, teamFile);
			await mkdir(getTasksDir(ctx.cwd, teamName), { recursive: true });

			currentTeam = teamName;
			ctx.ui.setStatus("team", `team: ${teamName}`);

			return {
				content: [
					{
						type: "text" as const,
						text:
							`Team "${teamName}" created.\n` +
							`You are the team lead (${leadAgentId}).\n` +
							`Use team_spawn to add agents.`,
					},
				],
				details: { teamName, leadAgentId },
			};
		},
	});

	// ========================================================================
	// Tool: team_delete
	// ========================================================================

	pi.registerTool({
		name: "team_delete",
		label: "Delete Team",
		description:
			"Delete the current team. Stops all active agents and cleans up team and task directories. " +
			"Fails if there are active members — use send_message to shut them down first.",
		parameters: Type.Object({}),

		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const teamName = requireTeam();
			const teamFile = await readTeamFileAsync(ctx.cwd, teamName);

			if (teamFile) {
				const activeMembers = teamFile.members.filter(
					(m) => m.name !== TEAM_LEAD_NAME && m.isActive !== false,
				);
				if (activeMembers.length > 0) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Cannot delete team with ${activeMembers.length} active member(s): ${activeMembers.map((m) => m.name).join(", ")}. Stop them first.`,
							},
						],
						details: {},
					};
				}
			}

			// Dispose all in-process agents
			for (const [_name, agent] of activeAgents) {
				agent.unsubscribe();
				await agent.runtime.dispose();
			}
			activeAgents.clear();

			if (pollingInterval) {
				clearInterval(pollingInterval);
				pollingInterval = null;
			}

			// Cleanup directories
			const teamDir = getTeamDir(ctx.cwd, teamName);
			const tasksDir = getTasksDir(ctx.cwd, teamName);
			try {
				const { rmSync } = await import("node:fs");
				rmSync(teamDir, { recursive: true, force: true });
			} catch { /* Ignore */ }
			try {
				const { rmSync } = await import("node:fs");
				rmSync(tasksDir, { recursive: true, force: true });
			} catch { /* Ignore */ }

			currentTeam = null;
			ctx.ui.setStatus("team", undefined);

			return {
				content: [{ type: "text" as const, text: `Team "${teamName}" deleted.` }],
				details: {},
			};
		},
	});

	// ========================================================================
	// Tool: team_spawn
	// ========================================================================

	pi.registerTool({
		name: "team_spawn",
		label: "Spawn Teammate",
		description:
			"Spawn a named agent as a teammate in the current team. " +
			"The agent runs as an in-process AgentSession with its own context window. " +
			"Discovers agent definitions from .pi/agents/ and ~/.pi/agent/agents/.",
		promptSnippet: "Spawn a named agent into the current team",
		promptGuidelines: [
			"Use team_spawn after team_create to add agents to your team.",
			"The 'agent' parameter must match a .md file name in .pi/agents/ or ~/.pi/agent/agents/.",
			"Send initial instructions via the 'prompt' parameter.",
		],
		parameters: Type.Object({
			name: Type.String({ description: "Unique name for this teammate (e.g., 'researcher', 'implementer')" }),
			agent: Type.String({ description: "Agent definition name (from .md files in .pi/agents/)" }),
			prompt: Type.String({ description: "Initial task/instructions for this agent" }),
			model: Type.Optional(Type.String({ description: "Model override for this agent" })),
			cwd: Type.Optional(Type.String({ description: "Working directory (defaults to project root)" })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const teamName = requireTeam();

			if (activeAgents.has(params.name)) {
				return {
					content: [{ type: "text" as const, text: `Agent "${params.name}" already exists in this team.` }],
					details: {},
				};
			}

			// Discover agent definition
			const agents = discoverAgents(ctx.cwd);
			const agentDef = agents.find((a) => a.name === params.agent);
			if (!agentDef) {
				const available = agents.map((a) => `${a.name} (${a.source}): ${a.description}`).join("\n  ");
				return {
					content: [
						{
							type: "text" as const,
							text: `Agent definition "${params.agent}" not found.\nAvailable agents:\n  ${available || "none"}`,
						},
					],
					details: {},
				};
			}

			const agentCwd = params.cwd || ctx.cwd;
			const model = params.model || agentDef.model;

			try {
				const agent = await spawnInProcessAgent(agentDef, teamName, params.name, agentCwd, model);
				activeAgents.set(params.name, agent);
			} catch (err: unknown) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Failed to spawn agent "${params.name}": ${err instanceof Error ? err.message : String(err)}`,
						},
					],
					details: {},
				};
			}

			// Register in team config
			await addMemberToTeamFile(ctx.cwd, teamName, {
				agentId: formatAgentId(params.name, teamName),
				name: params.name,
				agentType: agentDef.description,
				model,
				prompt: params.prompt,
				joinedAt: Date.now(),
				cwd: agentCwd,
				isActive: true,
			});

			// Send initial prompt via mailbox
			await writeToMailbox(
				ctx.cwd,
				params.name,
				{
					from: TEAM_LEAD_NAME,
					text: params.prompt,
					timestamp: new Date().toISOString(),
					summary: `Initial instructions from ${TEAM_LEAD_NAME}`,
				},
				teamName,
			);

			// Start inbox polling if not already running
			if (!pollingInterval) {
				pollingInterval = startInboxPolling(ctx.cwd, teamName, activeAgents);
			}

			// Kick off the agent with initial prompt directly
			const agent = activeAgents.get(params.name)!;
			agent.runtime.session.prompt("Check your inbox for instructions from the team lead.").catch(() => {
				// Non-fatal: agent will pick up inbox on next poll
			});

			ctx.ui.setStatus("team", `team: ${teamName} (${activeAgents.size} agents)`);

			return {
				content: [
					{
						type: "text" as const,
						text:
							`Spawned teammate "${params.name}" (agent: ${agentDef.name}, model: ${model || "default"}).\n` +
							`Working in: ${agentCwd}\n` +
							`Initial instructions sent via mailbox.`,
					},
				],
				details: {
					name: params.name,
					agentId: formatAgentId(params.name, teamName),
					agent: agentDef.name,
					model,
					cwd: agentCwd,
				},
			};
		},
	});

	// ========================================================================
	// Tool: agent_switch_cwd — switch an agent's working directory
	// ========================================================================

	pi.registerTool({
		name: "agent_switch_cwd",
		label: "Switch Agent Working Directory",
		description:
			"Switch a teammate's working directory to a different path. " +
			"The agent's session is recreated at the new cwd with fresh context. " +
			"Use this after creating a worktree to move an agent into it, or to point an agent at a subdirectory.",
		promptSnippet: "Switch an agent's working directory to a different path",
		promptGuidelines: [
			"Use agent_switch_cwd after worktree_create to move an agent into the new worktree.",
			"The agent gets a fresh session with all cwd-bound services rebuilt for the new path.",
			"After switching, send the agent new instructions via send_message.",
		],
		parameters: Type.Object({
			agent_name: Type.String({ description: "Name of the teammate to switch" }),
			cwd: Type.String({ description: "New working directory path (absolute)" }),
			initial_prompt: Type.Optional(Type.String({ description: "Instructions to send after switching" })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const teamName = requireTeam();

			const agent = activeAgents.get(params.agent_name);
			if (!agent) {
				return {
					content: [{ type: "text" as const, text: `Agent "${params.agent_name}" not found or not active.` }],
					details: {},
				};
			}

			const targetCwd = resolve(params.cwd);

			// Verify target exists
			if (!existsSync(targetCwd)) {
				return {
					content: [{ type: "text" as const, text: `Directory does not exist: ${targetCwd}` }],
					details: {},
				};
			}

			// Wait for agent to finish current work
			if (agent.isBusy) {
				try {
					await agent.runtime.session.agent.waitForIdle();
				} catch {
					// Continue anyway
				}
			}

			const oldCwd = agent.currentCwd;
			try {
				await switchAgentCwd(agent, targetCwd);
			} catch (err: unknown) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Failed to switch agent cwd: ${err instanceof Error ? err.message : String(err)}`,
						},
					],
					details: {},
				};
			}

			// Update team config with new cwd
			await updateMemberCwd(ctx.cwd, teamName, params.agent_name, targetCwd);

			// Send initial instructions if provided
			if (params.initial_prompt) {
				await writeToMailbox(
					ctx.cwd,
					params.agent_name,
					{
						from: TEAM_LEAD_NAME,
						text: params.initial_prompt,
						timestamp: new Date().toISOString(),
						summary: "Instructions after cwd switch",
					},
					teamName,
				);

				agent.runtime.session.prompt(params.initial_prompt).catch(() => {
					// Will be picked up via inbox polling
				});
			}

			return {
				content: [
					{
						type: "text" as const,
						text:
							`Agent "${params.agent_name}" switched to: ${targetCwd}\n` +
							`  Previous cwd: ${oldCwd}\n\n` +
							`Agent now has fresh context bound to the new directory.\n` +
							`Tools, extensions, and settings are all resolved from the new cwd.`,
					},
				],
				details: {
					agentName: params.agent_name,
					newCwd: targetCwd,
					oldCwd,
				},
			};
		},
	});

	// ========================================================================
	// Tool: team_list
	// ========================================================================

	pi.registerTool({
		name: "team_list",
		label: "List Team",
		description: "List all team members with their status and current task assignments.",
		parameters: Type.Object({}),

		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const teamName = requireTeam();
			const teamFile = await readTeamFileAsync(ctx.cwd, teamName);
			if (!teamFile) {
				return { content: [{ type: "text" as const, text: "Team not found." }], details: {} };
			}

			const tasks = await listTasks(ctx.cwd, teamName);
			const lines: string[] = [`Team: ${teamFile.name}`, `Members (${teamFile.members.length}):`];

			for (const member of teamFile.members) {
				const isLead = member.name === TEAM_LEAD_NAME;
				const agent = activeAgents.get(member.name);
				const status = isLead
					? "lead"
					: member.isActive === false
						? "stopped"
						: agent?.isRunning
							? (agent.isBusy ? "busy" : "idle")
							: "unknown";

				const ownedTasks = tasks.filter(
					(t) => t.owner === member.name && t.status !== "completed",
				);
				const taskInfo = ownedTasks.length > 0
					? ` [tasks: ${ownedTasks.map((t) => `#${t.id}`).join(", ")}]`
					: "";

				const cwdInfo = member.cwd !== ctx.cwd ? ` cwd:${member.cwd}` : "";

				lines.push(`  ${member.name} (${status})${taskInfo}${member.model ? ` model:${member.model}` : ""}${cwdInfo}`);
			}

			return {
				content: [{ type: "text" as const, text: lines.join("\n") }],
				details: { team: teamFile, taskCount: tasks.length },
			};
		},
	});

	// ========================================================================
	// Tool: send_message
	// ========================================================================

	pi.registerTool({
		name: "send_message",
		label: "Send Message",
		description:
			"Send a message to a teammate via the file-based mailbox system. " +
			'Use to: "*" to broadcast to all teammates.',
		promptSnippet: "Send a message to a teammate",
		promptGuidelines: [
			"Messages are delivered asynchronously — the recipient reads them on their next turn.",
			'Use to: "*" to broadcast to all non-lead members.',
		],
		parameters: Type.Object({
			to: Type.String({ description: 'Recipient name, or "*" for broadcast' }),
			message: Type.String({ description: "Message content" }),
			summary: Type.Optional(Type.String({ description: "5-10 word preview" })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const teamName = requireTeam();
			const teamFile = await readTeamFileAsync(ctx.cwd, teamName);
			if (!teamFile) {
				return { content: [{ type: "text" as const, text: "Team not found." }], details: {} };
			}

			const msg: Omit<TeammateMessage, "read"> = {
				from: TEAM_LEAD_NAME,
				text: params.message,
				timestamp: new Date().toISOString(),
				summary: params.summary,
			};

			if (params.to === "*") {
				const recipients = teamFile.members.filter((m) => m.name !== TEAM_LEAD_NAME);
				for (const recipient of recipients) {
					await writeToMailbox(ctx.cwd, recipient.name, msg, teamName);
				}
				return {
					content: [
						{
							type: "text" as const,
							text: `Broadcast sent to ${recipients.length} teammate(s): ${recipients.map((r) => r.name).join(", ")}`,
						},
					],
					details: { recipients: recipients.map((r) => r.name) },
				};
			}

			const recipient = teamFile.members.find((m) => m.name === params.to);
			if (!recipient) {
				const available = teamFile.members
					.filter((m) => m.name !== TEAM_LEAD_NAME)
					.map((m) => m.name)
					.join(", ");
				return {
					content: [
						{
							type: "text" as const,
							text: `Teammate "${params.to}" not found. Available: ${available || "none"}`,
						},
					],
					details: {},
				};
			}

			await writeToMailbox(ctx.cwd, params.to, msg, teamName);

			return {
				content: [{ type: "text" as const, text: `Message sent to ${params.to}.` }],
				details: { to: params.to },
			};
		},
	});

	// ========================================================================
	// Tool: task_create
	// ========================================================================

	pi.registerTool({
		name: "task_create",
		label: "Create Task",
		description: "Create a task on the shared team task board. Optionally assign to a teammate.",
		promptSnippet: "Create a task on the team task board",
		parameters: Type.Object({
			subject: Type.String({ description: "Brief task title" }),
			description: Type.Optional(Type.String({ description: "Detailed requirements" })),
			assignee: Type.Optional(Type.String({ description: "Teammate name to assign to" })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const teamName = requireTeam();

			const taskData: Omit<Task, "id"> = {
				subject: params.subject,
				description: params.description || "",
				owner: params.assignee,
				status: params.assignee ? "in_progress" : "pending",
				blocks: [],
				blockedBy: [],
			};

			const id = await createTask(ctx.cwd, teamName, taskData);

			if (params.assignee) {
				await writeToMailbox(
					ctx.cwd,
					params.assignee,
					{
						from: TEAM_LEAD_NAME,
						text: `Task #${id} assigned to you: ${params.subject}${params.description ? `\n${params.description}` : ""}`,
						timestamp: new Date().toISOString(),
						summary: `Task #${id}: ${params.subject}`,
					},
					teamName,
				);
			}

			return {
				content: [
					{
						type: "text" as const,
						text: `Task #${id} created: ${params.subject}${params.assignee ? ` (assigned to ${params.assignee})` : ""}`,
					},
				],
				details: { id, task: { id, ...taskData } },
			};
		},
	});

	// ========================================================================
	// Tool: task_update
	// ========================================================================

	pi.registerTool({
		name: "task_update",
		label: "Update Task",
		description:
			"Update a task's status, owner, or dependencies. " +
			'Set status to "deleted" to remove a task.',
		parameters: Type.Object({
			id: Type.String({ description: "Task ID" }),
			status: Type.Optional(
				Type.Union(
					[
						Type.Literal("pending"),
						Type.Literal("in_progress"),
						Type.Literal("completed"),
						Type.Literal("deleted"),
					],
					{ description: "New status" },
				),
			),
			owner: Type.Optional(Type.String({ description: "New owner (teammate name)" })),
			subject: Type.Optional(Type.String({ description: "Updated title" })),
			description: Type.Optional(Type.String({ description: "Updated description" })),
			addBlocks: Type.Optional(Type.Array(Type.String(), { description: "Task IDs this task blocks" })),
			addBlockedBy: Type.Optional(Type.Array(Type.String(), { description: "Task IDs blocking this task" })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const teamName = requireTeam();

			if (params.status === "deleted") {
				const deleted = await deleteTask(ctx.cwd, teamName, params.id);
				return {
					content: [
						{
							type: "text" as const,
							text: deleted ? `Task #${params.id} deleted.` : `Task #${params.id} not found.`,
						},
					],
					details: {},
				};
			}

			const existing = await getTask(ctx.cwd, teamName, params.id);
			if (!existing) {
				return { content: [{ type: "text" as const, text: `Task #${params.id} not found.` }], details: {} };
			}

			const updates: Partial<Omit<Task, "id">> = {};
			if (params.status) updates.status = params.status;
			if (params.owner !== undefined) updates.owner = params.owner;
			if (params.subject) updates.subject = params.subject;
			if (params.description) updates.description = params.description;

			if (params.status === "in_progress" && !existing.owner && !params.owner) {
				updates.owner = TEAM_LEAD_NAME;
			}

			if (params.addBlocks) {
				updates.blocks = [...new Set([...existing.blocks, ...params.addBlocks])];
			}
			if (params.addBlockedBy) {
				updates.blockedBy = [...new Set([...existing.blockedBy, ...params.addBlockedBy])];
			}

			const updated = await updateTask(ctx.cwd, teamName, params.id, updates);
			if (!updated) {
				return { content: [{ type: "text" as const, text: `Failed to update task #${params.id}.` }], details: {} };
			}

			if (params.owner && params.owner !== existing.owner && params.owner !== TEAM_LEAD_NAME) {
				await writeToMailbox(
					ctx.cwd,
					params.owner,
					{
						from: TEAM_LEAD_NAME,
						text: `Task #${params.id} assigned to you: ${updated.subject}`,
						timestamp: new Date().toISOString(),
						summary: `Task #${params.id} assigned`,
					},
					teamName,
				);
			}

			return {
				content: [{ type: "text" as const, text: `Task #${params.id} updated.` }],
				details: { task: updated },
			};
		},
	});

	// ========================================================================
	// Tool: task_list
	// ========================================================================

	pi.registerTool({
		name: "task_list",
		label: "List Tasks",
		description: "List all tasks on the team task board, optionally filtered.",
		parameters: Type.Object({
			status: Type.Optional(Type.String({ description: "Filter by status" })),
			owner: Type.Optional(Type.String({ description: "Filter by owner" })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const teamName = requireTeam();
			let tasks = await listTasks(ctx.cwd, teamName);

			if (params.status) tasks = tasks.filter((t) => t.status === params.status);
			if (params.owner) tasks = tasks.filter((t) => t.owner === params.owner);

			if (tasks.length === 0) {
				return { content: [{ type: "text" as const, text: "No tasks found." }], details: {} };
			}

			const lines = tasks.map((t) => {
				const owner = t.owner ? ` @${t.owner}` : "";
				const deps = t.blockedBy.length > 0 ? ` blocked-by:[${t.blockedBy.join(",")}]` : "";
				return `#${t.id} [${t.status}]${owner} ${t.subject}${deps}`;
			});

			return {
				content: [{ type: "text" as const, text: lines.join("\n") }],
				details: { tasks, count: tasks.length },
			};
		},
	});

	// ========================================================================
	// Tool: task_get
	// ========================================================================

	pi.registerTool({
		name: "task_get",
		label: "Get Task",
		description: "Get full details of a specific task.",
		parameters: Type.Object({
			id: Type.String({ description: "Task ID" }),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const teamName = requireTeam();
			const task = await getTask(ctx.cwd, teamName, params.id);
			if (!task) {
				return { content: [{ type: "text" as const, text: `Task #${params.id} not found.` }], details: {} };
			}

			const lines = [
				`Task #${task.id}: ${task.subject}`,
				`Status: ${task.status}`,
				`Owner: ${task.owner || "unassigned"}`,
				task.description ? `Description: ${task.description}` : null,
				task.blocks.length > 0 ? `Blocks: ${task.blocks.join(", ")}` : null,
				task.blockedBy.length > 0 ? `Blocked by: ${task.blockedBy.join(", ")}` : null,
			].filter(Boolean);

			return {
				content: [{ type: "text" as const, text: lines.join("\n") }],
				details: { task },
			};
		},
	});

	// ========================================================================
	// Commands
	// ========================================================================

	pi.registerCommand("team", {
		description: "Show team status",
		handler: async (_args, ctx) => {
			if (!currentTeam) {
				ctx.ui.notify("No active team.", "info");
				return;
			}
			const teamFile = readTeamFile(ctx.cwd, currentTeam);
			if (!teamFile) {
				ctx.ui.notify("Team config not found.", "error");
				return;
			}

			const lines = [`Team: ${teamFile.name} (${teamFile.members.length} members)`];
			for (const member of teamFile.members) {
				const isLead = member.name === TEAM_LEAD_NAME;
				const agent = activeAgents.get(member.name);
				const status = isLead
					? "lead"
					: agent?.isRunning
						? (agent.isBusy ? "busy" : "idle")
						: "stopped";
				lines.push(`  ${member.name}: ${status}${member.agentType ? ` (${member.agentType})` : ""}${member.cwd !== ctx.cwd ? ` [cwd: ${member.cwd}]` : ""}`);
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("tasks", {
		description: "Show team task board",
		handler: async (_args, ctx) => {
			if (!currentTeam) {
				ctx.ui.notify("No active team.", "info");
				return;
			}
			const tasks = await listTasks(ctx.cwd, currentTeam);
			if (tasks.length === 0) {
				ctx.ui.notify("No tasks.", "info");
				return;
			}

			const lines = [`Task Board (${tasks.length} tasks):`];
			for (const t of tasks) {
				const owner = t.owner ? ` @${t.owner}` : "";
				lines.push(`  #${t.id} [${t.status}]${owner} ${t.subject}`);
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	// ========================================================================
	// Lifecycle
	// ========================================================================

	pi.on("session_shutdown", async () => {
		if (pollingInterval) {
			clearInterval(pollingInterval);
			pollingInterval = null;
		}

		for (const [name, agent] of activeAgents) {
			if (currentTeam) {
				try {
					await setMemberActive(process.cwd(), currentTeam, name, false);
				} catch {
					// Best effort
				}
			}
			agent.unsubscribe();
			await agent.runtime.dispose();
		}
		activeAgents.clear();
	});
}

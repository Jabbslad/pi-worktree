# pi-worktree

Git worktree isolation and team agent coordination extensions for [pi](https://github.com/badlogic/pi).

## Extensions

### `worktree.ts` — Worktree Isolation

Provides git worktree lifecycle management:
- `/worktree` command for interactive worktree creation, listing, and removal
- `worktree_create` tool for LLM-driven worktree creation
- `worktree_finish` tool for LLM-driven worktree cleanup
- Auto-detection when running inside a worktree
- Safety checks before removal (uncommitted files, unpushed commits)

### `team-agents.ts` — Team Agent Coordination (SDK-based prototype)

Multi-agent coordination with **in-process cwd switching**, enabling agents to change working directories at runtime.

## Team Agents: SDK-based Architecture

This prototype replaces the original RPC subprocess approach with in-process `AgentSessionRuntime` instances from the pi SDK.

### Why?

The original team-agents extension spawned each agent as an RPC subprocess with a fixed `cwd`. The RPC protocol has no command to change working directory, so once spawned, an agent could never switch directories.

The new `createAgentSessionRuntime()` API in pi uses a factory pattern that separates fixed inputs (what the agent IS) from cwd-bound inputs (where the agent WORKS). This enables clean rebuilds at a different cwd.

### Architecture Comparison

| Aspect | Original (RPC) | Prototype (SDK) |
|--------|----------------|-----------------|
| Agent process | Separate subprocess per agent | In-process `AgentSession` |
| cwd switching | ❌ Impossible (fixed at spawn) | ✅ Via `switchAgentCwd()` |
| Communication | stdin/stdout JSON-RPC | Direct `session.prompt()` / `subscribe()` |
| Process isolation | ✅ Full isolation | ❌ Shared process |
| Memory | Each agent has own heap | Shared heap |

### How cwd Switching Works

```
CreateAgentSessionRuntimeFactory
  │
  │  Closes over: system prompt, agent config (fixed)
  │  Recreates:   services, tools, extensions, settings (cwd-bound)
  │
  ├── Initial: createAgentSessionRuntime(factory, { cwd: "/project" })
  │     → AgentSessionRuntime at /project
  │
  └── Switch:  dispose() old runtime
               createAgentSessionRuntime(factory, { cwd: "/new/path" })
               → AgentSessionRuntime at new path
```

### Tool: `agent_switch_cwd`

Switches an agent's working directory to any path. The agent's session is recreated with all cwd-bound services rebuilt.

```
Parameters:
  agent_name     - Name of the teammate to switch
  cwd            - New working directory path (absolute)
  initial_prompt - Instructions to send after switching
```

**Example workflow with worktrees:**
```
1. team_create({ team_name: "feature-work" })
2. team_spawn({ name: "impl", agent: "coder", prompt: "..." })
3. worktree_create({ name: "new-feature" })              ← worktree extension
4. agent_switch_cwd({ agent_name: "impl",                ← team-agents extension
                      cwd: "/project/.pi/worktrees/new-feature",
                      initial_prompt: "Implement X in this isolated branch" })
5. send_message({ to: "impl", message: "Also add tests" })
```

### Trade-offs

**Gained:**
- cwd switching — agents can move to any directory at runtime
- Simpler IPC — no JSON-RPC parsing, direct method calls
- Richer integration — full access to `AgentSession` events, state, and tools

**Lost:**
- Process isolation — a misbehaving agent could affect the host process
- Memory separation — all agents share the Node.js heap

### Open Questions

- Should conversation history be preserved across cwd switches? (Currently starts fresh)
- Memory pressure with many concurrent agents in one process?
- Extension loading in agent sessions — should they load the same extensions as the lead?

## Installation

```bash
pi install git:github.com/Jabbslad/pi-worktree
```

Or add to `settings.json`:
```json
{
  "packages": ["git:github.com/Jabbslad/pi-worktree"]
}
```

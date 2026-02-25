/**
 * Skill tools are handled entirely by the AgentLoop built-in implementations
 * because they need access to AgentContext (loadedSkills for dedup, meetName for progress).
 * This file is intentionally empty - the exports are kept for the index.ts import.
 */

export const skillToolExecutors: Record<string, (args: Record<string, unknown>) => Promise<string>> = {};

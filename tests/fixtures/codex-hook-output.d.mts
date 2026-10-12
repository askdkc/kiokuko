export function acceptCodexToolHook(stdout: string, event: 'PreToolUse' | 'PostToolUse'): {
  systemMessage?: string;
  hookSpecificOutput?: { hookEventName: string; permissionDecision?: 'deny'; permissionDecisionReason?: string; additionalContext?: string };
};
export function runCodexNestedTool<T>(hook: (event: object) => { status: number | null; stdout: string; stderr: string }, call: object, execute: () => Promise<T>): Promise<T>;

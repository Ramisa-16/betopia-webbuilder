export interface QueuedPromptPayload {
  text: string
  agentPrompt?: string | null
}

export function getQueuedPromptExecutionArgs(
  queuedPrompt: QueuedPromptPayload | null,
  queuedAttachments: unknown[],
): { text: string; attachments?: unknown[]; options?: { agentPrompt?: string } } | null {
  if (!queuedPrompt) return null

  return {
    text: queuedPrompt.text,
    attachments: queuedAttachments.length > 0 ? queuedAttachments : undefined,
    options: queuedPrompt.agentPrompt ? { agentPrompt: queuedPrompt.agentPrompt } : undefined,
  }
}

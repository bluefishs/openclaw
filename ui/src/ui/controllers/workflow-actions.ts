/**
 * Workflow Actions — HTTP API calls for workflow management
 */

export type WorkflowStepInput = {
  agentId: string;
  triggerOn: "completed" | "failed";
  contextFrom: "previous_result" | "original_input" | "both";
  maxRetries?: number;
  requireApproval?: boolean;
};

export type WorkflowDefinitionInput = {
  id: string;
  name: string;
  steps: WorkflowStepInput[];
  maxDepth?: number;
};

/** Safely parse JSON response; returns null on parse failure. */
async function safeJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Extract error message from API response or fall back to HTTP status. */
function extractError(data: Record<string, unknown> | null, res: Response): string {
  const errObj = data?.error as Record<string, unknown> | undefined;
  return (errObj?.message as string) ?? `HTTP ${res.status}`;
}

export async function resumeWorkflow(
  baseUrl: string,
  serviceToken: string,
  workflowId: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await fetch(`${baseUrl}/workflows/${encodeURIComponent(workflowId)}/resume`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Service-Token": serviceToken,
      },
      body: "{}",
    });
    if (!res.ok) {
      return { success: false, error: extractError(await safeJson(res), res) };
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function cancelWorkflow(
  baseUrl: string,
  serviceToken: string,
  workflowId: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await fetch(`${baseUrl}/workflows/${encodeURIComponent(workflowId)}`, {
      method: "DELETE",
      headers: {
        "X-Service-Token": serviceToken,
      },
    });
    if (!res.ok) {
      return { success: false, error: extractError(await safeJson(res), res) };
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function createWorkflowDefinition(
  baseUrl: string,
  serviceToken: string,
  definition: WorkflowDefinitionInput,
): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await fetch(`${baseUrl}/workflows/definitions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Service-Token": serviceToken,
      },
      body: JSON.stringify(definition),
    });
    if (!res.ok) {
      return { success: false, error: extractError(await safeJson(res), res) };
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function deleteWorkflowDefinition(
  baseUrl: string,
  serviceToken: string,
  definitionId: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await fetch(
      `${baseUrl}/workflows/definitions/${encodeURIComponent(definitionId)}`,
      {
        method: "DELETE",
        headers: {
          "X-Service-Token": serviceToken,
        },
      },
    );
    if (!res.ok) {
      return { success: false, error: extractError(await safeJson(res), res) };
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

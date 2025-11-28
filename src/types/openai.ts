import type { MCPServerStdio, MCPServerStreamableHttp } from "@openai/agents";
import type { Session } from "@stackone/openai-agents-js-sessions";
import { z } from "zod";

export const TextPartSchema = z.object({
  kind: z.literal("text"),
  text: z.string(),
});

export const DataPartSchema = z.object({
  kind: z.literal("data"),
  data: z.string().describe("Stringified JSON object."),
});

export const ArtifactSchema = z.object({
  name: z.string().describe("3-5 words describing the task output."),
  description: z.string().describe("1 sentence describing the task output."),
  part: z
    .union([TextPartSchema, DataPartSchema])
    .describe(
      "Task output. This can be a string, a markdown string, or a stringified JSON object.",
    ),
});

export type StructuredResponseArtifact = z.infer<typeof ArtifactSchema>;

// The `TaskState`s are:
//
// submitted = 'submitted'
// working = 'working'
// input_required = 'input-required'
// completed = 'completed'
// canceled = 'canceled'
// failed = 'failed'
// rejected = 'rejected'
// auth_required = 'auth-required'
// unknown = 'unknown'
//
// `submitted`, `working`, `canceled`, and `unknown` are not decidable by the agent (they are handled in the `AgentExecutor`)

export const TaskStateSchema = z.enum([
  "input-required",
  "completed",
  "failed",
  "rejected",
  "auth-required",
]);

// StructuredResponse schema with validation
export const StructuredResponseSchema = z.object({
  task_state: TaskStateSchema.describe(
    "The state of the task:\n" +
      "- 'input-required': The task requires additional input from the user.\n" +
      "- 'completed': The task has been completed.\n" +
      "- 'failed': The task has failed.\n" +
      "- 'rejected': The task has been rejected.\n" +
      "- 'auth-required': The task requires authentication from the user.\n",
  ),
  artifacts: z
    .array(ArtifactSchema)
    .optional()
    .nullable()
    .describe(
      "Required if `task_state` is 'completed'. If `task_state` is not 'completed', `artifacts` should not be provided.",
    ),
});

export type StructuredResponse = z.infer<typeof StructuredResponseSchema>;

export const StructuredResponseWithArtifactsValidationSchema = StructuredResponseSchema.superRefine(
  (data, ctx) => {
    // Validate that artifacts are not provided when task_state is not 'completed'
    if (data.task_state !== "completed" && data.artifacts && data.artifacts.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "`task_state` is not 'completed', `artifacts` should not be provided.",
        path: ["artifacts"],
      });
    }

    // Validate that artifacts are provided when task_state is 'completed'
    if (data.task_state === "completed" && (!data.artifacts || data.artifacts.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "`task_state` is 'completed', `artifacts` must contain at least one item.",
        path: ["artifacts"],
      });
    }
  },
);

/**
 * Options for configuring the OpenAIAgentExecutor.
 */
export interface OpenAIAgentExecutorOptions {
  /**
   * Session provider for conversation history.
   */
  sessionProvider?: (sessionId: string) => Session | Promise<Session>;

  /**
   * MCP servers to be managed by the executor.
   */
  mcpServers?: (MCPServerStdio | MCPServerStreamableHttp)[];
}

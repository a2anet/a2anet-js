import type {
  Message,
  Part,
  Task,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
  TextPart,
} from "@a2a-js/sdk";
import type { AgentExecutor, ExecutionEventBus, RequestContext } from "@a2a-js/sdk/server";
import {
  Agent,
  type AgentInputItem,
  type RunMessageOutputItem,
  type RunToolCallItem,
  type RunToolCallOutputItem,
  type UserMessageItem,
  run,
  user,
} from "@openai/agents";
import type { Session } from "@stackone/openai-agents-js-sessions";
import { v4 as uuidv4 } from "uuid";

import type { StructuredResponse } from "../types/openai.js";
import { StructuredResponseSchema } from "../types/openai.js";

export type ActionMetaItemInput = {
  name: string;
  type: string;
  required: boolean;
  description: string;
  in: string;
};

export class OpenAIAgentExecutor implements AgentExecutor {
  private readonly agent: Agent;
  private readonly taskAgent: Agent<unknown, typeof StructuredResponseSchema>;
  private readonly sessions: Map<string, Session> = new Map();
  private readonly sessionProvider?: (sessionId: string) => Session;

  constructor(
    agent: Agent,
    taskAgent: Agent<unknown, typeof StructuredResponseSchema>,
    sessionProvider?: (sessionId: string) => Session,
  ) {
    this.agent = agent;
    this.taskAgent = taskAgent;
    this.sessionProvider = sessionProvider;
  }

  /**
   * Get or create a session for the given context ID.
   */
  private getSession(contextId: string): Session | undefined {
    if (!this.sessionProvider) {
      return undefined;
    }

    let session = this.sessions.get(contextId);
    if (!session) {
      session = this.sessionProvider(contextId);
      this.sessions.set(contextId, session);
    }

    return session;
  }

  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const { contextId, taskId, userMessage, task } = requestContext as {
      contextId: string;
      taskId: string;
      userMessage: Message;
      task?: Task;
    };

    // biome-ignore lint/suspicious/noConsole: We want to log the event.
    console.log("Message", JSON.stringify(userMessage, null, 4));

    if (!task) {
      const taskSubmitted: Task = {
        kind: "task",
        id: taskId,
        contextId,
        status: { state: "submitted", timestamp: new Date().toISOString() },
        history: [userMessage],
      };
      // biome-ignore lint/suspicious/noConsole: We want to log the event.
      console.log("Task", JSON.stringify(taskSubmitted, null, 4));
      eventBus.publish(taskSubmitted);
    }

    const taskStatusUpdateEvent: TaskStatusUpdateEvent = {
      kind: "status-update",
      taskId,
      contextId,
      status: { state: "working", timestamp: new Date().toISOString() },
      final: false,
    };
    // biome-ignore lint/suspicious/noConsole: We want to log the event.
    console.log("TaskStatusUpdateEvent", JSON.stringify(taskStatusUpdateEvent, null, 4));
    eventBus.publish(taskStatusUpdateEvent);

    // Get session for this context (if session provider is configured)
    const session = this.getSession(contextId);

    // Build input from session history
    let input: AgentInputItem[];

    const userMessages: UserMessageItem[] = userMessage.parts
      .map((p) => (p.kind === "text" ? user(p.text) : null))
      .filter((p) => p !== null);

    if (session) {
      // Load existing history from session and add current user message
      const sessionHistory = await session.getItems();
      input = [...sessionHistory, ...userMessages];
    } else {
      // No session - just the user message
      input = userMessages;
    }

    // Run the agent with conversation history
    const result = await run(this.agent, input, {
      stream: true,
    });

    for await (const event of result) {
      if (event.type === "run_item_stream_event") {
        if (event.item.type === "message_output_item") {
          this.handleMessageOutputItem(event.item, taskId, contextId, eventBus);
        } else if (event.item.type === "tool_call_item") {
          this.handleToolCallItem(event.item, taskId, contextId, eventBus);
        } else if (event.item.type === "tool_call_output_item") {
          this.handleToolCallOutputItem(event.item, taskId, contextId, eventBus);
        }
      }
    }

    // Wait for agent to complete
    await result.completed;

    // Save new items to session if provided
    if (session) {
      // Get new items generated during this run
      // result.history contains all items including what we passed in
      // New items are everything after the initial input
      const newItems = result.history.slice(input.length);

      if (newItems.length > 0) {
        // Add the user message we just sent (not included in newItems)
        await session.addItems([...userMessages, ...newItems]);
      } else {
        // Even if no new items from agent, still save the user message
        await session.addItems(userMessages);
      }
    }

    // Extract structured A2A response by analyzing the conversation
    await this.handleStructuredResponse(result.history, taskId, contextId, eventBus);

    eventBus.finished();
  }

  /**
   * Handle `message_output_item` events from OpenAI SDK
   * These are text responses from the agent
   */
  private handleMessageOutputItem(
    item: RunMessageOutputItem,
    taskId: string,
    contextId: string,
    eventBus: ExecutionEventBus,
  ): void {
    // biome-ignore lint/suspicious/noConsole: We want to log the event.
    console.log("message_output_item", JSON.stringify(item, null, 4));

    const messageId = item.rawItem.id || uuidv4();

    // Extract text content from message
    const parts: TextPart[] = item.rawItem.content
      .map((contentItem) => {
        if (contentItem.type === "output_text") {
          return {
            kind: "text",
            text: contentItem.text,
          } as TextPart;
        }
        return null;
      })
      .filter((part): part is TextPart => part !== null);

    if (parts.length === 0) {
      return;
    }

    const messageOutputEvent: TaskStatusUpdateEvent = {
      kind: "status-update",
      taskId,
      contextId,
      status: {
        message: {
          kind: "message",
          messageId,
          taskId,
          contextId,
          role: "agent",
          parts,
          metadata: {
            timestamp: new Date().toISOString(),
          },
        },
        state: "working",
        timestamp: new Date().toISOString(),
      },
      final: false,
    };

    // biome-ignore lint/suspicious/noConsole: We want to log the event.
    console.log("TaskStatusUpdateEvent", JSON.stringify(messageOutputEvent, null, 4));
    eventBus.publish(messageOutputEvent);
  }

  /**
   * Handle `tool_call_item` events from OpenAI SDK
   * These are tool invocations by the agent
   */
  private handleToolCallItem(
    item: RunToolCallItem,
    taskId: string,
    contextId: string,
    eventBus: ExecutionEventBus,
  ): void {
    // biome-ignore lint/suspicious/noConsole: We want to log the event.
    console.log("tool_call_item", JSON.stringify(item, null, 4));

    const rawItem = item.rawItem;
    const parts: Part[] = [];
    let toolCallId: string;
    let toolCallName: string;

    // Extract properties based on tool call type
    if (rawItem.type === "function_call") {
      toolCallId = rawItem.callId;
      toolCallName = rawItem.name;
      if (rawItem.arguments) {
        try {
          parts.push({
            kind: "data",
            data: JSON.parse(rawItem.arguments) as { [k: string]: unknown },
          });
        } catch {
          parts.push({
            kind: "text",
            text: rawItem.arguments,
          });
        }
      }
    } else if (rawItem.type === "hosted_tool_call") {
      toolCallId = rawItem.id || uuidv4();
      toolCallName = rawItem.name;
      if (rawItem.arguments) {
        try {
          parts.push({
            kind: "data",
            data: JSON.parse(rawItem.arguments) as { [k: string]: unknown },
          });
        } catch {
          parts.push({
            kind: "text",
            text: rawItem.arguments,
          });
        }
      }
    } else if (rawItem.type === "computer_call") {
      throw new Error("tool_call_item type `computer_call` is not supported.");
    } else {
      return;
    }

    const messageId = `${rawItem.id}_${toolCallId}`;

    const toolCallItemEvent: TaskStatusUpdateEvent = {
      kind: "status-update",
      taskId,
      contextId,
      status: {
        message: {
          kind: "message",
          messageId,
          taskId,
          contextId,
          role: "agent",
          parts,
          metadata: {
            type: "tool-call",
            toolCallId,
            toolCallName,
            timestamp: new Date().toISOString(),
          },
        },
        state: "working",
        timestamp: new Date().toISOString(),
      },
      final: false,
    };

    // biome-ignore lint/suspicious/noConsole: We want to log the event.
    console.log("TaskStatusUpdateEvent", JSON.stringify(toolCallItemEvent, null, 4));
    eventBus.publish(toolCallItemEvent);
  }

  /**
   * Handle `tool_call_output_item` events from OpenAI SDK
   * These are the results from tool executions
   */
  private handleToolCallOutputItem(
    item: RunToolCallOutputItem,
    taskId: string,
    contextId: string,
    eventBus: ExecutionEventBus,
  ): void {
    // biome-ignore lint/suspicious/noConsole: We want to log the event.
    console.log("tool_call_output_item", JSON.stringify(item, null, 4));

    const messageId = item.rawItem.id || uuidv4();
    const rawItem = item.rawItem;
    const parts: Part[] = [];
    let toolCallId: string;
    let toolCallName: string;

    if (rawItem.type === "function_call_result") {
      toolCallId = rawItem.callId;
      toolCallName = rawItem.name;

      const output = rawItem.output;
      if (output.type === "text") {
        try {
          parts.push({
            kind: "data",
            data: JSON.parse(output.text) as { [k: string]: unknown },
          });
        } catch {
          parts.push({
            kind: "text",
            text: output.text,
          });
        }
      } else if (output.type === "image") {
        parts.push({
          kind: "file",
          file: {
            bytes: output.data,
            mimeType: output.mediaType,
          },
        });
      }
    } else if (rawItem.type === "computer_call_result") {
      throw new Error("tool_call_output_item type `computer_call_result` is not supported.");
    } else {
      return;
    }

    const toolCallOutputItemEvent: TaskStatusUpdateEvent = {
      kind: "status-update",
      taskId,
      contextId,
      status: {
        message: {
          kind: "message",
          messageId,
          taskId,
          contextId,
          role: "agent",
          parts,
          metadata: {
            type: "tool-call-result",
            toolCallId,
            toolCallName,
            timestamp: new Date().toISOString(),
          },
        },
        state: "working",
        timestamp: new Date().toISOString(),
      },
      final: false,
    };

    // biome-ignore lint/suspicious/noConsole: We want to log the event.
    console.log("TaskStatusUpdateEvent", JSON.stringify(toolCallOutputItemEvent, null, 4));
    eventBus.publish(toolCallOutputItemEvent);
  }

  /**
   * Determine the state of the task and get artifact(s) if the task is complete with the task agent.
   */
  private async handleStructuredResponse(
    history: AgentInputItem[],
    taskId: string,
    contextId: string,
    eventBus: ExecutionEventBus,
  ): Promise<void> {
    const result = await run(this.taskAgent, history);

    const structuredResponse = result.finalOutput;

    if (!structuredResponse) {
      const structuredResponseUnknownEvent: TaskStatusUpdateEvent = {
        kind: "status-update",
        taskId,
        contextId,
        status: {
          state: "unknown",
          timestamp: new Date().toISOString(),
        },
        final: true,
      };

      // biome-ignore lint/suspicious/noConsole: We want to log the event.
      console.log("TaskStatusUpdateEvent", JSON.stringify(structuredResponseUnknownEvent, null, 4));

      eventBus.publish(structuredResponseUnknownEvent);

      return;
    }

    // Handle artifact(s) if task is completed
    if (structuredResponse.task_state === "completed" && structuredResponse.artifacts) {
      this.handleStructuredResponseArtifacts(
        structuredResponse.artifacts,
        taskId,
        contextId,
        eventBus,
      );
    }

    // Publish final task status
    const structuredResponseFinalEvent: TaskStatusUpdateEvent = {
      kind: "status-update",
      taskId,
      contextId,
      status: {
        state: structuredResponse.task_state,
        timestamp: new Date().toISOString(),
      },
      final: true,
    };

    // biome-ignore lint/suspicious/noConsole: We want to log the event.
    console.log("TaskStatusUpdateEvent", JSON.stringify(structuredResponseFinalEvent, null, 4));
    eventBus.publish(structuredResponseFinalEvent);
  }

  /**
   * Helper function to handle artifact(s).
   */
  private handleStructuredResponseArtifacts(
    artifacts: StructuredResponse["artifacts"],
    taskId: string,
    contextId: string,
    eventBus: ExecutionEventBus,
  ): void {
    if (!artifacts) {
      return;
    }

    for (const artifact of artifacts) {
      let parts: Part[];

      if (artifact.part.kind === "text") {
        parts = [
          {
            kind: "text",
            text: artifact.part.text,
          },
        ];
      } else if (artifact.part.kind === "data") {
        try {
          parts = [
            {
              kind: "data",
              data: JSON.parse(artifact.part.data) as { [k: string]: unknown },
            },
          ];
        } catch {
          parts = [
            {
              kind: "text",
              text: artifact.part.data,
            },
          ];
        }
      } else {
        throw new Error("`artifact.part.kind` must be either `text` or `data`.");
      }

      const taskArtifactUpdateEvent: TaskArtifactUpdateEvent = {
        kind: "artifact-update",
        taskId,
        contextId,
        artifact: {
          artifactId: uuidv4(),
          name: artifact.name,
          description: artifact.description,
          parts: parts,
          metadata: {
            timestamp: new Date().toISOString(),
          },
        },
      };

      // biome-ignore lint/suspicious/noConsole: We want to log the event.
      console.log("TaskArtifactUpdateEvent", JSON.stringify(taskArtifactUpdateEvent, null, 4));
      eventBus.publish(taskArtifactUpdateEvent);
    }
  }

  async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    // TODO: Implement task cancellation logic
    console.log("cancelTask", taskId);
    eventBus.finished();
    await Promise.resolve();
  }
}

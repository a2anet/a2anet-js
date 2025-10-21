# A2ANet JavaScript SDK

A JavaScript/TypeScript package that bridges the [OpenAI Agents SDK](https://openai.github.io/openai-agents-js/) with the [A2A (Agent-to-Agent) protocol](https://www.a2a.app/), making it easy to build interoperable AI agents.

## Overview

The A2A protocol enables agents to communicate with each other in a standardized way. This SDK provides an `AgentExecutor` implementation that allows you to use the powerful OpenAI Agents SDK within the A2A framework, giving you:

- ✨ **OpenAI Agents SDK Integration** - Use agents, tools, handoffs, and guardrails from the OpenAI Agents SDK
- 🔄 **Conversation History** - Persistent sessions using [`@stackone/openai-agents-js-sessions`](https://github.com/StackOneHQ/openai-agents-js-sessions) (based on the [OpenAI Agents Python SDK Sessions](https://openai.github.io/openai-agents-python/sessions/))
- 📡 **Streaming Support** - Real-time event streaming for agent responses, tool calls, and task updates
- 🎯 **Task State Management** - Automatic task state detection and artifact extraction
- 🛠️ **Tool Integration** - Full support for OpenAI Agents SDK tools and function calling

## Installation

```bash
npm install a2anet @openai/agents @a2a-js/sdk zod@3
```

Or with your preferred package manager:

```bash
yarn add a2anet @openai/agents @a2a-js/sdk zod@3
pnpm add a2anet @openai/agents @a2a-js/sdk zod@3
```

## Quick Start

```typescript
import { Agent } from "@openai/agents";
import { OpenAIAgentExecutor } from "a2anet";

// 1. Create your main agent using OpenAI Agents SDK
const agent = new Agent({
  name: "Customer Support Agent",
  instructions:
    "You are a helpful customer support agent. Answer questions and help users solve problems.",
  model: "gpt-4o",
});

// 2. Create a task agent to determine task state and extract artifacts
const taskAgent = new Agent({
  name: "Task Analyzer",
  instructions: `Analyze the conversation and determine:
    - The current state of the task (completed, input-required, failed, etc.)
    - Extract any artifacts (results) if the task is completed
    
    When the user's request has been fully addressed, mark the task as completed.`,
  outputType: StructuredResponseSchema,
});

// 3. Create the A2A executor
const executor = new OpenAIAgentExecutor(agent, taskAgent);

// 4. Use the executor in your A2A server
// (See A2A SDK documentation for full server setup)
```

## Core Concepts

### Agent Executor

The `OpenAIAgentExecutor` is the bridge between OpenAI Agents and the A2A protocol. It implements the A2A `AgentExecutor` interface and handles:

- **Request Processing** - Receives A2A protocol requests and converts them to OpenAI Agent inputs
- **Event Streaming** - Streams agent responses, tool calls, and task updates back to the client
- **Session Management** - Maintains conversation history across multiple turns
- **Task State Detection** - Uses a specialized "task agent" to determine task completion and extract results

### Two-Agent Architecture

The executor uses two agents:

1. **Main Agent** - Your actual AI agent that handles user requests, uses tools, and generates responses
2. **Task Agent** - A specialized agent that analyzes the conversation to determine:
   - Is the task complete, or does it need more input?
   - What are the final artifacts/results?
   - What is the task state (completed, failed, input-required, etc.)?

This separation allows your main agent to focus on the conversation while the task agent handles A2A protocol requirements.

### Task States

The task agent can return these states:

- `completed` - Task successfully finished (must include artifacts)
- `input-required` - Agent needs more information from the user
- `failed` - Task failed to complete
- `rejected` - Task was rejected (e.g., violates policy)
- `auth-required` - Task requires authentication

Other states like `submitted`, `working`, `canceled`, and `unknown` are handled automatically by the executor.

### Artifacts

When a task is `completed`, the task agent must provide artifacts - the final outputs of the task. Artifacts can be:

- **Text** - Plain text or markdown
- **Data** - Structured JSON objects

```typescript
// Example structured response from task agent
{
  task_state: 'completed',
  artifacts: [
    {
      name: 'Weather Report',
      description: 'Current weather conditions for the requested location',
      part: {
        kind: 'data',
        data: JSON.stringify({
          temperature: 72,
          conditions: 'sunny',
          humidity: 45
        })
      }
    }
  ]
}
```

## Session Management

The executor supports conversation history through session providers. This uses [`@stackone/openai-agents-js-sessions`](https://github.com/StackOneHQ/openai-agents-js-sessions), which is based on the [OpenAI Agents Python SDK Sessions](https://openai.github.io/openai-agents-python/sessions/).

### Using Sessions

```typescript
import { InMemorySession } from "@stackone/openai-agents-js-sessions";
import { OpenAIAgentExecutor } from "a2anet";

// Create a session provider function
const sessionProvider = (sessionId: string) => {
  return new InMemorySession();
};

// Pass it to the executor
const executor = new OpenAIAgentExecutor(agent, taskAgent, sessionProvider);
```

### Available Session Backends

The `@stackone/openai-agents-js-sessions` package provides multiple storage backends:

- **InMemorySession** - For testing and development
- **SQLiteSession** - For persistent local storage
- **SequelizeSession** - For production databases (PostgreSQL, MySQL, etc.)

```typescript
import { SQLiteSession } from "@stackone/openai-agents-js-sessions";

const sessionProvider = (sessionId: string) => {
  return new SQLiteSession({
    database: "./sessions.db",
    sessionId,
  });
};
```

## Complete Example

Here's a full example with tools, sessions, and proper task detection:

```typescript
import { Agent, tool } from "@openai/agents";
import { z } from "zod";
import { OpenAIAgentExecutor, StructuredResponseSchema } from "a2anet";
import { InMemorySession } from "@stackone/openai-agents-js-sessions";

// Define a tool
const getWeather = tool({
  name: "get_weather",
  description: "Get the current weather for a city",
  parameters: z.object({
    city: z.string(),
  }),
  async execute({ city }) {
    // In a real app, call a weather API
    return `The weather in ${city} is sunny and 72°F`;
  },
});

// Main agent with tools
const weatherAgent = new Agent({
  name: "Weather Assistant",
  instructions: `You are a helpful weather assistant. 
    When users ask about weather, use the get_weather tool.
    Provide clear and friendly responses.`,
  tools: [getWeather],
  model: "gpt-4o",
});

// Task agent for A2A protocol
const taskAgent = new Agent({
  name: "Task Analyzer",
  instructions: `Review the conversation and determine the task state.
    
    Mark as 'completed' when:
    - The user's weather question has been answered with specific information
    - Extract the weather information as an artifact
    
    Mark as 'input-required' when:
    - The user hasn't specified which city they want weather for
    - More clarification is needed
    
    Mark as 'failed' if the weather lookup failed or returned an error.`,
  outputType: StructuredResponseSchema,
  model: "gpt-4o",
});

// Session provider
const sessionProvider = (sessionId: string) => new InMemorySession();

// Create executor
const executor = new OpenAIAgentExecutor(weatherAgent, taskAgent, sessionProvider);

// Use in your A2A server
export default executor;
```

## Advanced Features

### Tool Calls and Streaming

The executor automatically handles tool calls and streams all events:

- **Message Output Events** - Agent text responses
- **Tool Call Events** - When the agent invokes a tool
- **Tool Call Output Events** - Results from tool execution
- **Task Status Updates** - Task state changes
- **Task Artifact Updates** - Final results when task completes

### Multiple Agents with Handoffs

You can use the full power of OpenAI Agents SDK, including handoffs between agents:

```typescript
const bookingAgent = new Agent({
  name: "Booking Agent",
  instructions: "Help users with booking requests.",
});

const refundAgent = new Agent({
  name: "Refund Agent",
  instructions: "Process refund requests.",
});

const triageAgent = new Agent({
  name: "Triage Agent",
  instructions: `Route users to the right agent.
    For booking questions, hand off to Booking Agent.
    For refund questions, hand off to Refund Agent.`,
  handoffs: [bookingAgent, refundAgent],
});

// Use triageAgent as your main agent in the executor
const executor = new OpenAIAgentExecutor(triageAgent, taskAgent);
```

### Custom Task Agent Instructions

The task agent is crucial for A2A protocol compliance. Customize its instructions based on your use case:

```typescript
const taskAgent = new Agent({
  name: "Task Analyzer",
  instructions: `Analyze the conversation and determine task state:

    COMPLETED: When the booking is confirmed and the user has received:
    - Confirmation number
    - Date and time
    - Location details
    Extract these as artifacts in JSON format.

    INPUT_REQUIRED: When we still need:
    - Preferred date/time
    - Number of people
    - Special requests

    FAILED: When:
    - Requested time slot is unavailable
    - System error occurred
    - User's request cannot be fulfilled

    REJECTED: When:
    - User is trying to book in the past
    - Request violates our policies`,
  outputType: StructuredResponseSchema,
});
```

## API Reference

### `OpenAIAgentExecutor`

The main class that implements the A2A `AgentExecutor` interface.

#### Constructor

```typescript
constructor(
  agent: Agent,
  taskAgent: Agent<unknown, typeof StructuredResponseSchema>,
  sessionProvider?: (sessionId: string) => Session
)
```

**Parameters:**

- `agent` - The main OpenAI Agent that handles user interactions
- `taskAgent` - An agent configured with `StructuredResponseSchema` as output type to analyze task state
- `sessionProvider` (optional) - Function that returns a Session instance for a given session ID

#### Methods

- `execute(context: RequestContext, eventBus: ExecutionEventBus): Promise<void>`
  - Executes the agent for an incoming A2A request
  - Handles streaming, tool calls, and session management automatically

- `cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void>`
  - Handles task cancellation requests (implementation pending)

### Type Exports

```typescript
import {
  StructuredResponseSchema,
  StructuredResponse,
  StructuredResponseArtifact,
  TaskStateSchema,
} from "a2anet";
```

## Requirements

- Node.js >= 18.0.0
- OpenAI API key (set `OPENAI_API_KEY` environment variable)

## Related Projects

- [OpenAI Agents SDK](https://openai.github.io/openai-agents-js/) - The underlying agent framework
- [@a2a-js/sdk](https://github.com/a2aproject/a2a-js) - The A2A protocol implementation for JavaScript
- [@stackone/openai-agents-js-sessions](https://github.com/StackOneHQ/openai-agents-js-sessions) - Session management (based on [OpenAI Agents Python SDK Sessions](https://openai.github.io/openai-agents-python/sessions/))

## License

Apache-2.0

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Support

For issues and questions:

- [GitHub Issues](https://github.com/a2anet/a2anet-js/issues)
- [A2A Protocol Documentation](https://www.a2a.app/)
- [OpenAI Agents SDK Documentation](https://openai.github.io/openai-agents-js/)

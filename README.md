# A2A Net JavaScript SDK

A JavaScript/TypeScript package with a pre-built [Agent2Agent (A2A) Protocol](https://a2a-protocol.org/latest/) Agent Executor for the [OpenAI Agents JS SDK](https://openai.github.io/openai-agents-js/).

The package should allow you to create an A2A agent with the OpenAI SDK in 5 minutes, and is fully customisable.
By default, the Agent Executor converts OpenAI SDK messages and tool calls into A2A compatible messages.
The Agent Executor also accepts a "Task Agent" that reviews the conversation history, determines the [`TaskState`](https://a2a-protocol.org/latest/specification/#63-taskstate-enum) (e.g. `input-required`, `completed`, `failed`, etc.), and extracts `Artifact`s.
Because the OpenAI SDK doesn't support sessions out-of-the-box, the library uses [@stackone/openai-agents-js-sessions](https://www.npmjs.com/package/@stackone/openai-agents-js-sessions) which is based on [OpenAI Agents Python SDK Sessions](https://openai.github.io/openai-agents-python/sessions/).

Test your agent with the [Agent2Agent (A2A) UI](https://github.com/a2anet/a2a-ui), and add your deployed agent to [A2A Net](https://a2anet.com/).

## 📋 Overview

### A2A Support

- [x] Agent Executor
  - [x] `execute()` method
  - [ ] `cancelTask()` method
- [x] Task State type
- [x] Artifact type
  - [x] `TextPart` Artifact
  - [x] `DataPart` Artifact
  - [ ] `FilePart` Artifact
- [x] Streaming
- [ ] Push notifications

### Frameworks

- [x] [OpenAI Agents JS SDK](https://openai.github.io/openai-agents-js/)
- [ ] [AI SDK](https://ai-sdk.dev/)

#### OpenAI Agents JS SDK

##### `run_item_stream_event`

- [x] `message_output_item`
  - [x] `output_text`
  - [ ] `audio`
  - [ ] `refusal`
  - [ ] `image`
- [x] `tool_call_item`
  - [x] `function_call`
  - [x] `hosted_tool_call`
  - [ ] `computer_call`
- [x] `tool_call_output_item`
  - [x] `function_call_result`
  - [ ] `computer_call_result`

##### Other

- [x] MCP (Model Context Protocol) servers
  - [x] Hosted MCP tools
  - [x] Streamable HTTP MCP servers
  - [x] Stdio MCP servers
- [x] Sessions with [@stackone/openai-agents-js-sessions](https://www.npmjs.com/package/@stackone/openai-agents-js-sessions)

## 📦 Installation

```bash
npm install a2anet @openai/agents @a2a-js/sdk zod@3
```

Or with your preferred package manager:

```bash
yarn add a2anet @openai/agents @a2a-js/sdk zod@3
pnpm add a2anet @openai/agents @a2a-js/sdk zod@3
```

## ⚡ Quick Start

```typescript
import express from "express";
import { Agent, tool } from "@openai/agents";
import { z } from "zod";
import { OpenAIAgentExecutor, StructuredResponseSchema } from "a2anet";
import type { AgentCard } from "@a2a-js/sdk";
import { DefaultRequestHandler, InMemoryTaskStore } from "@a2a-js/sdk/server";
import { A2AExpressApp } from "@a2a-js/sdk/server/express";

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

// 1. Create your main agent using OpenAI Agents SDK
const weatherAgent = new Agent({
  name: "Weather Assistant",
  instructions: `You are a helpful weather assistant.
    When users ask about weather, use the get_weather tool.
    Provide clear and friendly responses.`,
  tools: [getWeather],
  model: "gpt-4.1",
});

// 2. Create a task agent to determine task state and extract artifacts
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
  model: "gpt-4.1",
});

// 3. Define your agent's identity card
const agentCard: AgentCard = {
  name: "Weather Assistant",
  description: "A helpful weather assistant that provides weather information for cities.",
  protocolVersion: "0.3.0",
  version: "0.1.0",
  url: "http://localhost:4000/",
  skills: [
    {
      id: "weather",
      name: "Weather Information",
      description: "Get current weather for a city",
      tags: ["weather", "information"],
    },
  ],
};

// 4. Create the A2A executor
const executor = new OpenAIAgentExecutor(weatherAgent, taskAgent, agentCard);

// 5. Set up and run the A2A server
const requestHandler = new DefaultRequestHandler(agentCard, new InMemoryTaskStore(), executor);

const appBuilder = new A2AExpressApp(requestHandler);
const expressApp = appBuilder.setupRoutes(express());

expressApp.listen(4000, () => {
  console.log("🚀 Server started on http://localhost:4000");
});
```

## 🧩 Core Concepts

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

## 🤖 OpenAI Agents JS SDK

### Session Management

The executor supports conversation history through session providers. This uses [`@stackone/openai-agents-js-sessions`](https://github.com/StackOneHQ/openai-agents-js-sessions), which is based on the [OpenAI Agents Python SDK Sessions](https://openai.github.io/openai-agents-python/sessions/).

#### Using Sessions

```typescript
import { InMemorySession } from "@stackone/openai-agents-js-sessions";
import { OpenAIAgentExecutor } from "a2anet";

// Create a session provider function
const sessionProvider = (sessionId: string) => {
  return new InMemorySession(sessionId);
};

// Pass it to the executor
const executor = new OpenAIAgentExecutor(agent, taskAgent, agentCard, {
  sessionProvider,
});
```

#### Available Session Backends

The `@stackone/openai-agents-js-sessions` package provides multiple storage backends:

##### InMemorySession

In-memory storage (data lost when process ends). Ideal for development and testing.

```typescript
import { InMemorySession } from "@stackone/openai-agents-js-sessions";

const sessionProvider = (sessionId: string) => {
  return new InMemorySession(sessionId);
};
```

##### SQLiteSession

SQLite-backed storage for persistent conversation history.

```typescript
import { SQLiteSession } from "@stackone/openai-agents-js-sessions";

const sessionProvider = (sessionId: string) => {
  return new SQLiteSession(sessionId, "conversations.db");
};
```

##### SequelizeSession

Sequelize-powered storage supporting PostgreSQL, MySQL, SQLite, and more.

```typescript
import { SequelizeSession } from "@stackone/openai-agents-js-sessions";
import { Sequelize } from "sequelize";

// From URL (PostgreSQL)
const sessionProvider = async (sessionId: string) => {
  return await SequelizeSession.fromUrl(sessionId, "postgres://user:pass@localhost:5432/mydb", {
    createTables: true,
  });
};
```

### MCP Server Support

The executor supports [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) servers, allowing your agents to access external tools and data sources. Three types of MCP servers are supported:

#### Hosted MCP Tools

Hosted MCP tools are remote servers that the OpenAI Responses API invokes directly. Configure them on your Agent's `tools` array - no lifecycle management needed:

```typescript
import { Agent, hostedMcpTool } from "@openai/agents";
import { OpenAIAgentExecutor } from "a2anet";

const agent = new Agent({
  name: "Documentation Assistant",
  instructions: "Use the MCP tools to answer questions about the repository.",
  tools: [
    hostedMcpTool({
      serverLabel: "gitmcp",
      serverUrl: "https://gitmcp.io/openai/codex",
    }),
  ],
});

const executor = new OpenAIAgentExecutor(agent, taskAgent, agentCard);
```

#### Streamable HTTP MCP Servers

For Streamable HTTP MCP servers (local or remote), pass them to the executor's `mcpServers` option. The executor automatically handles `connect()` and `close()`:

```typescript
import { Agent, MCPServerStreamableHttp } from "@openai/agents";
import { OpenAIAgentExecutor } from "a2anet";

const mcpServer = new MCPServerStreamableHttp({
  url: "https://example.com/mcp",
  name: "My MCP Server",
});

const agent = new Agent({
  name: "MCP Assistant",
  instructions: "Use the tools to respond to user requests.",
  mcpServers: [mcpServer],
});

const executor = new OpenAIAgentExecutor(agent, taskAgent, agentCard, {
  mcpServers: [mcpServer],
});
```

#### Stdio MCP Servers

For local MCP servers that use standard I/O, use `MCPServerStdio`:

```typescript
import { Agent, MCPServerStdio } from "@openai/agents";
import { OpenAIAgentExecutor } from "a2anet";

const mcpServer = new MCPServerStdio({
  name: "Filesystem MCP Server",
  fullCommand: "npx -y @modelcontextprotocol/server-filesystem /path/to/files",
});

const agent = new Agent({
  name: "File Assistant",
  instructions: "Use the tools to read files and answer questions.",
  mcpServers: [mcpServer],
});

const executor = new OpenAIAgentExecutor(agent, taskAgent, agentCard, {
  mcpServers: [mcpServer],
});
```

For more details on MCP, see the [OpenAI Agents MCP documentation](https://openai.github.io/openai-agents-js/mcp/).

### Tracing

The executor wraps all agent runs in an OpenAI Agents SDK trace context, which is required when using MCP servers. This enables tracing and debugging through the [OpenAI Agents Tracing](https://openai.github.io/openai-agents-js/guides/tracing/) features.

## 📄 License

`a2anet` is distributed under the terms of the [Apache-2.0](https://spdx.org/licenses/Apache-2.0.html) license.

## 🤝 Join the A2A Net Community

A2A Net is a site to find and share AI agents and open-source community. Join to share your A2A agents, ask questions, stay up-to-date with the latest A2A news, be the first to hear about open-source releases, tutorials, and more!

- 🌍 Site: https://a2anet.com/
- 🤖 Discord: https://discord.gg/674NGXpAjU

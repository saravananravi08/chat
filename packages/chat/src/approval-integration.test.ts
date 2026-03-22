/**
 * Integration tests for the approval system.
 *
 * These tests exercise the full flow across thread.requestApproval(),
 * thread.runAgent(), and chat.handleApprovalAction().
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AgentLike,
  type AgentResultLike,
  ApprovalRegistry,
  type ApprovalResponseHandler,
  consumePendingApproval,
} from "./approval";
import { Chat } from "./chat";
import { clearChatSingleton, setChatSingleton } from "./chat-singleton";
import { createMockAdapter, createMockState, mockLogger } from "./mock-adapter";
import { ThreadImpl } from "./thread";
import type { ActionEvent, Adapter } from "./types";

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeActionEvent(
  actionId: string,
  adapter: Adapter,
  overrides?: Partial<Omit<ActionEvent, "thread" | "openModal">>
): Omit<ActionEvent, "thread" | "openModal"> {
  return {
    actionId,
    value: "",
    user: {
      userId: "U999",
      userName: "reviewer",
      fullName: "The Reviewer",
      isBot: false,
      isMe: false,
    },
    messageId: "msg-1",
    threadId: "slack:C123:1234.5678",
    adapter,
    raw: {},
    ...overrides,
  };
}

/** Create a mock agent that returns the given results in sequence. */
function createMockAgent(
  results: AgentResultLike[]
): AgentLike & { generateCalls: unknown[][] } {
  let callIndex = 0;
  const generateCalls: unknown[][] = [];

  return {
    generateCalls,
    generate: vi.fn().mockImplementation(async (options: unknown) => {
      generateCalls.push([options]);
      const result = results[callIndex];
      callIndex++;
      return result;
    }),
  };
}

function noApprovalResult(): AgentResultLike {
  return {
    content: [{ type: "text", text: "Done" }],
    response: { messages: [{ role: "assistant", content: "Done" }] },
    text: "Done",
  };
}

function approvalRequestResult(
  toolCalls: Array<{
    approvalId: string;
    toolName: string;
    toolCallId: string;
    input: Record<string, unknown>;
  }>
): AgentResultLike {
  return {
    content: toolCalls.map((tc) => ({
      type: "tool-approval-request",
      approvalId: tc.approvalId,
      toolCall: {
        toolName: tc.toolName,
        toolCallId: tc.toolCallId,
        input: tc.input,
      },
    })),
    response: {
      messages: [{ role: "assistant", content: "needs approval" }],
    },
  };
}

// ============================================================================
// thread.requestApproval()
// ============================================================================

describe("thread.requestApproval()", () => {
  let mockAdapter: Adapter;
  let mockState: ReturnType<typeof createMockState>;
  let registry: ApprovalRegistry;
  let thread: ThreadImpl;

  beforeEach(() => {
    mockAdapter = createMockAdapter();
    mockState = createMockState();
    registry = new ApprovalRegistry();

    setChatSingleton({
      _approvalRegistry: registry,
      getAdapter: () => mockAdapter,
      getState: () => mockState,
    });

    thread = new ThreadImpl({
      id: "slack:C123:1234.5678",
      adapter: mockAdapter,
      channelId: "C123",
      stateAdapter: mockState,
    });
  });

  afterEach(() => {
    clearChatSingleton();
  });

  /** Wait for the registry entry to appear, then resolve it. */
  async function resolveWhenReady(
    id: string,
    approved: boolean,
    extra?: { reason?: string }
  ) {
    while (!registry.has(id)) {
      await new Promise((r) => setTimeout(r, 1));
    }
    registry.resolve(id, {
      id,
      approved,
      ...extra,
      user: {
        userId: "U1",
        userName: "alice",
        fullName: "Alice",
        isBot: false,
        isMe: false,
      },
    });
  }

  it("should post a card and resolve when approved", async () => {
    const [result] = await Promise.all([
      thread.requestApproval({ id: "txn-1", title: "Transfer $500" }),
      resolveWhenReady("txn-1", true),
    ]);

    expect(result.approved).toBe(true);
    expect(result.id).toBe("txn-1");
    expect(result.user.userName).toBe("alice");
    expect(mockAdapter.postMessage).toHaveBeenCalledTimes(1);
  });

  it("should post a card and resolve when denied", async () => {
    const [result] = await Promise.all([
      thread.requestApproval({ id: "txn-2", title: "Delete Account" }),
      resolveWhenReady("txn-2", false),
    ]);

    expect(result.approved).toBe(false);
  });

  it("should persist the approval in the state adapter", async () => {
    const [result] = await Promise.all([
      thread.requestApproval({
        id: "persist-1",
        title: "Persist Test",
        fields: { key: "value" },
        metadata: { context: "test" },
      }),
      (async () => {
        // Wait for state to be persisted
        while (!mockState.cache.has("pending-approval:persist-1")) {
          await new Promise((r) => setTimeout(r, 1));
        }
        const stored = mockState.cache.get("pending-approval:persist-1") as any;
        expect(stored.id).toBe("persist-1");
        expect(stored.title).toBe("Persist Test");
        expect(stored.fields).toEqual({ key: "value" });
        expect(stored.metadata).toEqual({ context: "test" });
        expect(stored.adapterName).toBe("slack");

        // Now resolve so the promise completes
        await resolveWhenReady("persist-1", true);
      })(),
    ]);

    expect(result.approved).toBe(true);
  });

  it("should update the card after approval when updateCard is true", async () => {
    await Promise.all([
      thread.requestApproval({
        id: "update-1",
        title: "Update Test",
        updateCard: true,
      }),
      resolveWhenReady("update-1", true),
    ]);

    expect(mockAdapter.editMessage).toHaveBeenCalledTimes(1);
  });

  it("should not update the card when updateCard is false", async () => {
    await Promise.all([
      thread.requestApproval({
        id: "no-update-1",
        title: "No Update Test",
        updateCard: false,
      }),
      resolveWhenReady("no-update-1", true),
    ]);

    expect(mockAdapter.editMessage).not.toHaveBeenCalled();
  });

  it("should time out if no response within TTL", async () => {
    vi.useFakeTimers();

    const promise = thread.requestApproval({
      id: "timeout-1",
      title: "Timeout Test",
      ttlMs: 5000,
    });

    // Flush the async work (post card, persist state, register)
    await vi.advanceTimersByTimeAsync(1);

    // Now advance past the TTL
    vi.advanceTimersByTime(5001);

    await expect(promise).rejects.toThrow("timed out");

    vi.useRealTimers();
  });

  it("should register the approval in the in-memory registry", async () => {
    const promise = thread.requestApproval({
      id: "reg-1",
      title: "Registry Test",
    });

    // Wait for the async work to complete
    while (!registry.has("reg-1")) {
      await new Promise((r) => setTimeout(r, 1));
    }

    expect(registry.has("reg-1")).toBe(true);

    // Clean up
    registry.resolve("reg-1", {
      id: "reg-1",
      approved: true,
      user: {
        userId: "U1",
        userName: "alice",
        fullName: "Alice",
        isBot: false,
        isMe: false,
      },
    });
    await promise;
  });

  it("should survive card edit failure gracefully", async () => {
    (mockAdapter.editMessage as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Platform error")
    );

    const [result] = await Promise.all([
      thread.requestApproval({
        id: "edit-fail",
        title: "Edit Fail",
        updateCard: true,
      }),
      resolveWhenReady("edit-fail", true),
    ]);

    // Should not throw — edit failure is caught
    expect(result.approved).toBe(true);
  });

  it("should include reason in the result when provided", async () => {
    const [result] = await Promise.all([
      thread.requestApproval({ id: "reason-1", title: "Reason Test" }),
      resolveWhenReady("reason-1", false, { reason: "Too risky" }),
    ]);

    expect(result.reason).toBe("Too risky");
  });

  it("should register resolver and persist state before posting the card", async () => {
    // Intercept postMessage to check state at the moment the card is posted,
    // and resolve the approval inside the mock so it doesn't race.
    let registryHadEntry = false;
    let stateHadEntry = false;
    (mockAdapter.postMessage as ReturnType<typeof vi.fn>).mockImplementation(
      async () => {
        registryHadEntry = registry.has("race-1");
        stateHadEntry = mockState.cache.has("pending-approval:race-1");
        // Resolve inside postMessage so it doesn't race with the poll
        registry.resolve("race-1", {
          id: "race-1",
          approved: true,
          user: {
            userId: "U1",
            userName: "alice",
            fullName: "Alice",
            isBot: false,
            isMe: false,
          },
        });
        return { id: "msg-1", threadId: undefined, raw: {} };
      }
    );

    const result = await thread.requestApproval({
      id: "race-1",
      title: "Race Test",
    });

    expect(result.approved).toBe(true);
    expect(registryHadEntry).toBe(true);
    expect(stateHadEntry).toBe(true);
  });

  it("should throw before any side effects if singleton is missing", async () => {
    clearChatSingleton();

    await expect(
      thread.requestApproval({ id: "no-singleton", title: "Fail" })
    ).rejects.toThrow("No Chat singleton registered");

    // No card should have been posted
    expect(mockAdapter.postMessage).not.toHaveBeenCalled();
    // No state should have been persisted
    expect(mockState.cache.has("pending-approval:no-singleton")).toBe(false);
  });

  it("should clean up registry and persisted state if posting fails", async () => {
    (mockAdapter.postMessage as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Slack API error")
    );

    await expect(
      thread.requestApproval({ id: "post-fail", title: "Post Fail" })
    ).rejects.toThrow("Slack API error");

    // Registry entry should be cleaned up
    expect(registry.has("post-fail")).toBe(false);
    // Persisted state should be cleaned up
    expect(mockState.cache.has("pending-approval:post-fail")).toBe(false);
  });
});

// ============================================================================
// thread.runAgent()
// ============================================================================

describe("thread.runAgent()", () => {
  let mockAdapter: Adapter;
  let mockState: ReturnType<typeof createMockState>;
  let registry: ApprovalRegistry;
  let thread: ThreadImpl;

  beforeEach(() => {
    mockAdapter = createMockAdapter();
    mockState = createMockState();
    registry = new ApprovalRegistry();

    setChatSingleton({
      _approvalRegistry: registry,
      getAdapter: () => mockAdapter,
      getState: () => mockState,
    });

    thread = new ThreadImpl({
      id: "slack:C123:1234.5678",
      adapter: mockAdapter,
      channelId: "C123",
      stateAdapter: mockState,
    });
  });

  afterEach(() => {
    clearChatSingleton();
  });

  it("should return immediately when agent needs no approvals", async () => {
    const agent = createMockAgent([noApprovalResult()]);

    const result = await thread.runAgent(agent, { prompt: "hello" });

    expect(agent.generate).toHaveBeenCalledTimes(1);
    expect(result.text).toBe("Done");
  });

  it("should handle a single tool approval request", async () => {
    const agent = createMockAgent([
      approvalRequestResult([
        {
          approvalId: "ap-1",
          toolName: "deleteFile",
          toolCallId: "tc-1",
          input: { path: "/tmp/file.txt" },
        },
      ]),
      noApprovalResult(),
    ]);

    // Approve asynchronously when the registry entry appears
    const approveWhenReady = async () => {
      while (!registry.has("ap-1")) {
        await new Promise((r) => setTimeout(r, 1));
      }
      registry.resolve("ap-1", {
        id: "ap-1",
        approved: true,
        user: {
          userId: "U1",
          userName: "alice",
          fullName: "Alice",
          isBot: false,
          isMe: false,
        },
      });
    };

    const [result] = await Promise.all([
      thread.runAgent(agent, { prompt: "delete the file" }),
      approveWhenReady(),
    ]);

    expect(agent.generate).toHaveBeenCalledTimes(2);
    expect(result.text).toBe("Done");

    // Second call should include a tool-role message with approval responses
    const secondCallArgs = (agent.generate as ReturnType<typeof vi.fn>).mock
      .calls[1][0];
    const messages = secondCallArgs.messages;
    const toolMessage = messages.find(
      (m: { role?: string }) => m.role === "tool"
    );
    expect(toolMessage).toBeDefined();
    expect(toolMessage.content).toEqual([
      {
        type: "tool-approval-response",
        approvalId: "ap-1",
        approved: true,
      },
    ]);
  });

  it("should handle multiple parallel approval requests", async () => {
    const agent = createMockAgent([
      approvalRequestResult([
        {
          approvalId: "ap-a",
          toolName: "sendEmail",
          toolCallId: "tc-a",
          input: { to: "a@test.com" },
        },
        {
          approvalId: "ap-b",
          toolName: "transfer",
          toolCallId: "tc-b",
          input: { amount: 500 },
        },
      ]),
      noApprovalResult(),
    ]);

    const approveAll = async () => {
      while (!(registry.has("ap-a") && registry.has("ap-b"))) {
        await new Promise((r) => setTimeout(r, 1));
      }
      registry.resolve("ap-a", {
        id: "ap-a",
        approved: true,
        user: {
          userId: "U1",
          userName: "alice",
          fullName: "Alice",
          isBot: false,
          isMe: false,
        },
      });
      registry.resolve("ap-b", {
        id: "ap-b",
        approved: false,
        user: {
          userId: "U2",
          userName: "bob",
          fullName: "Bob",
          isBot: false,
          isMe: false,
        },
      });
    };

    const [result] = await Promise.all([
      thread.runAgent(agent, { prompt: "do both" }),
      approveAll(),
    ]);

    expect(result.text).toBe("Done");

    // Check that both responses are wrapped in a single tool message
    const secondCallArgs = (agent.generate as ReturnType<typeof vi.fn>).mock
      .calls[1][0];
    const toolMessage = secondCallArgs.messages.find(
      (m: { role?: string }) => m.role === "tool"
    );
    expect(toolMessage.content).toHaveLength(2);
    expect(toolMessage.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ approvalId: "ap-a", approved: true }),
        expect.objectContaining({ approvalId: "ap-b", approved: false }),
      ])
    );
  });

  it("should handle multi-round approval loops", async () => {
    const agent = createMockAgent([
      // Round 1: one approval
      approvalRequestResult([
        {
          approvalId: "r1",
          toolName: "step1",
          toolCallId: "tc-1",
          input: {},
        },
      ]),
      // Round 2: another approval
      approvalRequestResult([
        {
          approvalId: "r2",
          toolName: "step2",
          toolCallId: "tc-2",
          input: {},
        },
      ]),
      // Round 3: done
      noApprovalResult(),
    ]);

    const approveSequentially = async () => {
      // Approve round 1
      while (!registry.has("r1")) {
        await new Promise((r) => setTimeout(r, 1));
      }
      registry.resolve("r1", {
        id: "r1",
        approved: true,
        user: {
          userId: "U1",
          userName: "alice",
          fullName: "Alice",
          isBot: false,
          isMe: false,
        },
      });
      // Approve round 2
      while (!registry.has("r2")) {
        await new Promise((r) => setTimeout(r, 1));
      }
      registry.resolve("r2", {
        id: "r2",
        approved: true,
        user: {
          userId: "U1",
          userName: "alice",
          fullName: "Alice",
          isBot: false,
          isMe: false,
        },
      });
    };

    const [result] = await Promise.all([
      thread.runAgent(agent, { prompt: "multi-step" }),
      approveSequentially(),
    ]);

    expect(agent.generate).toHaveBeenCalledTimes(3);
    expect(result.text).toBe("Done");
  });

  it("should use custom approvalCard callback", async () => {
    const agent = createMockAgent([
      approvalRequestResult([
        {
          approvalId: "custom-1",
          toolName: "dangerousAction",
          toolCallId: "tc-1",
          input: { level: "high" },
        },
      ]),
      noApprovalResult(),
    ]);

    const customCard = vi.fn().mockReturnValue({
      title: "Custom Title",
      description: "Custom description",
      fields: { Level: "high" },
    });

    const approveWhenReady = async () => {
      while (!registry.has("custom-1")) {
        await new Promise((r) => setTimeout(r, 1));
      }
      registry.resolve("custom-1", {
        id: "custom-1",
        approved: true,
        user: {
          userId: "U1",
          userName: "alice",
          fullName: "Alice",
          isBot: false,
          isMe: false,
        },
      });
    };

    await Promise.all([
      thread.runAgent(agent, {
        prompt: "do it",
        approvalCard: customCard,
      }),
      approveWhenReady(),
    ]);

    expect(customCard).toHaveBeenCalledWith({
      toolName: "dangerousAction",
      toolCallId: "tc-1",
      input: { level: "high" },
    });
  });

  it("should use default approvalCard when none is provided", async () => {
    const agent = createMockAgent([
      approvalRequestResult([
        {
          approvalId: "default-1",
          toolName: "myTool",
          toolCallId: "tc-1",
          input: { foo: "bar" },
        },
      ]),
      noApprovalResult(),
    ]);

    const approveWhenReady = async () => {
      while (!registry.has("default-1")) {
        await new Promise((r) => setTimeout(r, 1));
      }
      registry.resolve("default-1", {
        id: "default-1",
        approved: true,
        user: {
          userId: "U1",
          userName: "alice",
          fullName: "Alice",
          isBot: false,
          isMe: false,
        },
      });
    };

    await Promise.all([
      thread.runAgent(agent, { prompt: "go" }),
      approveWhenReady(),
    ]);

    // The posted card should have the default title format
    const postedCard = (mockAdapter.postMessage as ReturnType<typeof vi.fn>)
      .mock.calls[0][1];
    expect(postedCard.title).toContain("myTool");
  });

  it("should forward reason in tool-approval-response when provided", async () => {
    const agent = createMockAgent([
      approvalRequestResult([
        {
          approvalId: "reason-1",
          toolName: "riskyOp",
          toolCallId: "tc-1",
          input: {},
        },
      ]),
      noApprovalResult(),
    ]);

    const denyWithReason = async () => {
      while (!registry.has("reason-1")) {
        await new Promise((r) => setTimeout(r, 1));
      }
      registry.resolve("reason-1", {
        id: "reason-1",
        approved: false,
        reason: "Not authorized",
        user: {
          userId: "U1",
          userName: "alice",
          fullName: "Alice",
          isBot: false,
          isMe: false,
        },
      });
    };

    await Promise.all([
      thread.runAgent(agent, { prompt: "try it" }),
      denyWithReason(),
    ]);

    const secondCallArgs = (agent.generate as ReturnType<typeof vi.fn>).mock
      .calls[1][0];
    const toolMessage = secondCallArgs.messages.find(
      (m: { role?: string }) => m.role === "tool"
    );
    expect(toolMessage.content[0]).toEqual({
      type: "tool-approval-response",
      approvalId: "reason-1",
      approved: false,
      reason: "Not authorized",
    });
  });

  it("should not include reason field when it is undefined", async () => {
    const agent = createMockAgent([
      approvalRequestResult([
        {
          approvalId: "no-reason",
          toolName: "tool",
          toolCallId: "tc-1",
          input: {},
        },
      ]),
      noApprovalResult(),
    ]);

    const approve = async () => {
      while (!registry.has("no-reason")) {
        await new Promise((r) => setTimeout(r, 1));
      }
      registry.resolve("no-reason", {
        id: "no-reason",
        approved: true,
        user: {
          userId: "U1",
          userName: "alice",
          fullName: "Alice",
          isBot: false,
          isMe: false,
        },
      });
    };

    await Promise.all([thread.runAgent(agent, { prompt: "go" }), approve()]);

    const secondCallArgs = (agent.generate as ReturnType<typeof vi.fn>).mock
      .calls[1][0];
    const toolMessage = secondCallArgs.messages.find(
      (m: { role?: string }) => m.role === "tool"
    );
    // reason should not be present as a key
    expect(toolMessage.content[0]).toEqual({
      type: "tool-approval-response",
      approvalId: "no-reason",
      approved: true,
    });
    expect("reason" in toolMessage.content[0]).toBe(false);
  });

  it("should pass through extra agent options", async () => {
    const agent = createMockAgent([noApprovalResult()]);

    await thread.runAgent(agent, {
      prompt: "hello",
      temperature: 0.5,
      maxTokens: 100,
    });

    const callArgs = (agent.generate as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(callArgs.temperature).toBe(0.5);
    expect(callArgs.maxTokens).toBe(100);
  });

  it("should include assistant response messages when resuming", async () => {
    const assistantMessages = [
      { role: "assistant", content: "I need to call deleteFile" },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "tc-1" }],
      },
    ];

    const agent = createMockAgent([
      {
        content: [
          {
            type: "tool-approval-request",
            approvalId: "msg-test",
            toolCall: {
              toolName: "deleteFile",
              toolCallId: "tc-1",
              input: {},
            },
          },
        ],
        response: { messages: assistantMessages },
      },
      noApprovalResult(),
    ]);

    const approve = async () => {
      while (!registry.has("msg-test")) {
        await new Promise((r) => setTimeout(r, 1));
      }
      registry.resolve("msg-test", {
        id: "msg-test",
        approved: true,
        user: {
          userId: "U1",
          userName: "alice",
          fullName: "Alice",
          isBot: false,
          isMe: false,
        },
      });
    };

    await Promise.all([
      thread.runAgent(agent, { prompt: "delete it" }),
      approve(),
    ]);

    const secondCallArgs = (agent.generate as ReturnType<typeof vi.fn>).mock
      .calls[1][0];

    // Messages should contain: assistant messages + tool-role approval response
    expect(secondCallArgs.messages).toHaveLength(3);
    expect(secondCallArgs.messages[0]).toBe(assistantMessages[0]);
    expect(secondCallArgs.messages[1]).toBe(assistantMessages[1]);
    expect(secondCallArgs.messages[2].role).toBe("tool");
  });
});

// ============================================================================
// chat.handleApprovalAction() (via processAction)
// ============================================================================

describe("chat.handleApprovalAction()", () => {
  let chat: Chat<{ slack: Adapter }>;
  let mockAdapter: Adapter;
  let mockState: ReturnType<typeof createMockState>;

  beforeEach(async () => {
    mockAdapter = createMockAdapter("slack");
    mockState = createMockState();

    chat = new Chat({
      userName: "testbot",
      adapters: { slack: mockAdapter },
      state: mockState,
      logger: mockLogger,
    });

    // Initialize via webhook
    await chat.webhooks.slack(
      new Request("http://test.com", { method: "POST" })
    );
  });

  it("should resolve in-memory promise on approval action", async () => {
    // Register an in-memory approval
    const promise = chat._approvalRegistry.register("mem-1", 60000);

    // Simulate button click
    chat.processAction(
      makeActionEvent("__approval:mem-1:approve", mockAdapter)
    );
    await new Promise((r) => setTimeout(r, 10));

    const result = await promise;
    expect(result.approved).toBe(true);
    expect(result.id).toBe("mem-1");
    expect(result.user.userName).toBe("reviewer");
  });

  it("should resolve in-memory promise on deny action", async () => {
    const promise = chat._approvalRegistry.register("mem-2", 60000);

    chat.processAction(makeActionEvent("__approval:mem-2:deny", mockAdapter));
    await new Promise((r) => setTimeout(r, 10));

    const result = await promise;
    expect(result.approved).toBe(false);
  });

  it("should not propagate approval actions to user onAction handlers", async () => {
    const userHandler = vi.fn();
    chat.onAction(userHandler);

    chat._approvalRegistry.register("intercept-1", 60000);

    chat.processAction(
      makeActionEvent("__approval:intercept-1:approve", mockAdapter)
    );
    await new Promise((r) => setTimeout(r, 10));

    // User handler should NOT be called — approval actions are intercepted
    expect(userHandler).not.toHaveBeenCalled();
  });

  it("should call onApprovalResponse handler on restart recovery path", async () => {
    const handler: ApprovalResponseHandler = vi.fn();
    chat.onApprovalResponse(handler);

    // Simulate persisted approval (as if server restarted — no in-memory promise)
    mockState.cache.set("pending-approval:restart-1", {
      id: "restart-1",
      title: "Restart Test",
      metadata: { context: "recovery" },
      adapterName: "slack",
      createdAt: new Date().toISOString(),
      thread: {
        _type: "chat:Thread",
        id: "slack:C123:1234.5678",
        channelId: "C123",
        isDM: false,
        adapterName: "slack",
      },
      updateCard: false,
      sentMessage: undefined,
    });

    chat.processAction(
      makeActionEvent("__approval:restart-1:approve", mockAdapter)
    );
    await new Promise((r) => setTimeout(r, 10));

    expect(handler).toHaveBeenCalledTimes(1);
    const event = (handler as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(event.id).toBe("restart-1");
    expect(event.approved).toBe(true);
    expect(event.metadata).toEqual({ context: "recovery" });
  });

  it("should consume stored approval on click (prevents double-processing)", async () => {
    mockState.cache.set("pending-approval:double-1", {
      id: "double-1",
      title: "Double Click Test",
      adapterName: "slack",
      createdAt: new Date().toISOString(),
      thread: {
        _type: "chat:Thread",
        id: "slack:C123:1234.5678",
        channelId: "C123",
        isDM: false,
        adapterName: "slack",
      },
      updateCard: false,
    });

    chat.processAction(
      makeActionEvent("__approval:double-1:approve", mockAdapter)
    );
    await new Promise((r) => setTimeout(r, 10));

    // Stored approval should be consumed (deleted)
    const remaining = await consumePendingApproval(mockState, "double-1");
    expect(remaining).toBeNull();
  });

  it("should post expiry message when approval is expired and no handler registered", async () => {
    // No stored approval, no in-memory promise — it's expired
    chat.processAction(
      makeActionEvent("__approval:expired-1:approve", mockAdapter)
    );
    await new Promise((r) => setTimeout(r, 10));

    // Should have posted an expiry message
    expect(mockAdapter.postMessage).toHaveBeenCalled();
    const postedText = (mockAdapter.postMessage as ReturnType<typeof vi.fn>)
      .mock.calls[0][1];
    expect(postedText).toContain("expired");
  });

  it("should attach metadata from stored approval to the in-memory result", async () => {
    // Persist approval with metadata
    mockState.cache.set("pending-approval:meta-1", {
      id: "meta-1",
      title: "Meta Test",
      metadata: { toolName: "transfer", amount: 500 },
      adapterName: "slack",
      createdAt: new Date().toISOString(),
      thread: {
        _type: "chat:Thread",
        id: "slack:C123:1234.5678",
        channelId: "C123",
        isDM: false,
        adapterName: "slack",
      },
      updateCard: false,
    });

    // Also register in-memory (happy path where stored metadata is attached)
    const promise = chat._approvalRegistry.register("meta-1", 60000);

    chat.processAction(
      makeActionEvent("__approval:meta-1:approve", mockAdapter)
    );
    await new Promise((r) => setTimeout(r, 10));

    const result = await promise;
    expect(result.metadata).toEqual({ toolName: "transfer", amount: 500 });
  });
});

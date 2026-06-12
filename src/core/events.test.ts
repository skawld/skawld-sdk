import { describe, expect, it } from "bun:test";
import {
  isAssistantEvent,
  isCompactionEvent,
  isErrorEvent,
  isHookErrorEvent,
  isPartialAssistantEvent,
  isPermissionRequestEvent,
  isResultEvent,
  isSystemEvent,
  isToolCallEndEvent,
  isToolCallStartEvent,
  isUsageEvent,
  isUserEvent,
  type Event,
} from "./events.js";

describe("event type guards", () => {
  it("each guard returns true for its kind and false for others", () => {
    const samples: Record<string, Event> = {
      system: {
        type: "system",
        subtype: "init",
        session_id: "s",
        run_id: "r",
        model: "m",
        tools: [],
        permission_mode: "default",
        cwd: "/",
      },
      assistant: {
        type: "assistant",
        message: { role: "assistant", content: [] },
        stop_reason: "end_turn",
      },
      user: { type: "user", message: { role: "user", content: [] } },
      partial_assistant: {
        type: "partial_assistant",
        delta: { kind: "text", text: "x" },
      },
      tool_call_start: {
        type: "tool_call_start",
        tool_use_id: "t",
        tool_name: "Read",
        input: {},
      },
      tool_call_end: {
        type: "tool_call_end",
        tool_use_id: "t",
        tool_name: "Read",
        is_error: false,
        duration_ms: 1,
      },
      permission_request: { type: "permission_request", requests: [] },
      usage: {
        type: "usage",
        usage: { input_tokens: 0, output_tokens: 0 },
        cumulative: { input_tokens: 0, output_tokens: 0 },
      },
      compaction: {
        type: "compaction",
        messages_before: 10,
        messages_after: 5,
        tokens_before: 100,
        tokens_after: 50,
        strategy: "default",
      },
      result: {
        type: "result",
        subtype: "success",
        stop_reason: "end_turn",
        total_usage: { input_tokens: 0, output_tokens: 0 },
        duration_ms: 1,
      },
      error: {
        type: "error",
        error: { name: "ProviderError", message: "boom", retryable: false },
      },
      hook_error: {
        type: "hook_error",
        hook_event: "PreToolUse",
        message: "Hook failed: boom",
        tool_use_id: "tu-1",
      },
    };

    const guards: Array<[(e: Event) => boolean, string]> = [
      [isSystemEvent, "system"],
      [isAssistantEvent, "assistant"],
      [isUserEvent, "user"],
      [isPartialAssistantEvent, "partial_assistant"],
      [isToolCallStartEvent, "tool_call_start"],
      [isToolCallEndEvent, "tool_call_end"],
      [isPermissionRequestEvent, "permission_request"],
      [isUsageEvent, "usage"],
      [isCompactionEvent, "compaction"],
      [isResultEvent, "result"],
      [isErrorEvent, "error"],
      [isHookErrorEvent, "hook_error"],
    ];

    for (const [guard, key] of guards) {
      const positive = samples[key];
      if (!positive) throw new Error(`missing sample for ${key}`);
      expect(guard(positive)).toBe(true);
      for (const [otherKey, ev] of Object.entries(samples)) {
        if (otherKey === key) continue;
        expect(guard(ev)).toBe(false);
      }
    }
  });
});

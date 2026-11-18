import { createHash } from "node:crypto";
import type { Message, ModelResponse, ModelToolExchange } from "../../types";
import { ModelResponseLimitError } from "./response-limits";

function fingerprint(messages: Message[], count: number, binding: string): string {
  const hash = createHash("sha256").update(binding);
  for (const m of messages.slice(0, count)) {
    hash.update(JSON.stringify([m.id, m.role, m.toolCallId, m.content]));
  }
  return hash.digest("hex");
}

/** Native reasoning belongs to one inference chain. Never serialize it into Auggy history. */
export function createToolReplay<Item>() {
  const saved = new WeakMap<
    ModelResponse,
    {
      count: number;
      prefix: string;
      items: Item[];
      ids: string[];
    }
  >();
  return {
    remember(
      response: ModelResponse,
      history: Message[],
      binding: string,
      items: Item[],
      ids: string[],
    ) {
      if (!response.toolCalls?.length) return;
      if (
        ids.length !== response.toolCalls.length ||
        ids.some((id) => typeof id !== "string" || !id) ||
        new Set(ids).size !== ids.length
      ) {
        throw new ModelResponseLimitError(
          "maxResponseBytes",
          "Provider returned invalid tool call identifiers.",
        );
      }
      saved.set(response, {
        count: history.length,
        prefix: fingerprint(history, history.length, binding),
        items,
        ids,
      });
    },
    messages(
      history: Message[],
      binding: string,
      exchange: ModelToolExchange | undefined,
      convert: (messages: Message[]) => Item[],
      results: (outputs: { id: string; content: string }[]) => Item[],
    ): Item[] {
      if (!exchange) return convert(history);
      const previous = saved.get(exchange.response);
      if (
        !previous ||
        previous.count > history.length ||
        previous.prefix !== fingerprint(history, previous.count, binding)
      ) {
        throw new Error(
          "Provider tool continuation requires the original prompt prefix. Check the agent's history budget.",
        );
      }
      let offset = previous.count;
      if (exchange.assistantMessageId) {
        const text = history[offset++];
        if (
          text?.role !== "assistant" ||
          text.id !== exchange.assistantMessageId ||
          text.content !== exchange.response.content
        ) {
          throw new Error("Provider tool continuation is missing its assistant message.");
        }
      }
      const outputs = previous.ids.map((id) => ({ id, content: [] as string[] }));
      for (const { index, toolCallId } of exchange.calls) {
        const use = history[offset++];
        const result = history[offset++];
        if (
          !outputs[index] ||
          use?.role !== "tool_use" ||
          result?.role !== "tool_result" ||
          use.toolCallId !== toolCallId ||
          result.toolCallId !== toolCallId
        ) {
          throw new Error("Provider tool continuation is missing its recorded tool result.");
        }
        outputs[index].content.push(result.content);
      }
      return [
        ...previous.items,
        ...results(
          outputs.map(({ id, content }) => ({
            id,
            content: content.length ? content.join("\n") : "Tool was not executed.",
          })),
        ),
        ...convert(history.slice(offset)),
      ];
    },
  };
}

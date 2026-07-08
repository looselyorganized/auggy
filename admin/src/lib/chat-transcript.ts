export type ChatTranscriptRole = "user" | "assistant";

export interface ChatTranscriptToolCall {
  name: string;
  args?: string;
  result?: string;
  status: "running" | "completed" | "error";
}

export interface ChatTranscriptMessage {
  role: ChatTranscriptRole;
  content: string;
  toolCalls?: ChatTranscriptToolCall[];
  error?: string;
}

export interface ChatTranscriptOptions {
  agentName: string;
  previewModeLabel: string;
  threadId: string;
  copiedAt: Date;
}

export function formatChatTranscript(
  messages: ChatTranscriptMessage[],
  options: ChatTranscriptOptions,
): string {
  const lines: string[] = [
    "# Auggy console chat transcript",
    "",
    `Agent: ${singleLine(options.agentName)}`,
    `Preview mode: ${singleLine(options.previewModeLabel)}`,
    `Thread ID: ${singleLine(options.threadId)}`,
    `Copied at: ${options.copiedAt.toISOString()}`,
    "",
    "## Conversation",
  ];

  if (messages.length === 0) {
    lines.push("", "_No messages._");
    return lines.join("\n");
  }

  messages.forEach((message, index) => {
    const speaker = message.role === "user" ? "User" : options.agentName;
    lines.push("", `### ${index + 1}. ${singleLine(speaker)}`, "");

    const hasContent = message.content.trim().length > 0;
    if (hasContent) {
      lines.push(message.content.trim());
    } else if (!message.toolCalls?.length && !message.error) {
      lines.push("_No message content._");
    }

    if (message.toolCalls?.length) {
      message.toolCalls.forEach((toolCall, toolIndex) => {
        lines.push(
          "",
          `#### Tool call ${toolIndex + 1}: ${singleLine(toolCall.name)} (${toolCall.status})`,
        );

        if (toolCall.args !== undefined) {
          lines.push("", "Args:", "", fencedBlock(toolCall.args || "(empty)", "text"));
        }

        if (toolCall.result !== undefined) {
          lines.push("", "Result:", "", fencedBlock(toolCall.result || "(empty)", "text"));
        }
      });
    }

    if (message.error) {
      lines.push("", "Error:", "", fencedBlock(message.error, "text"));
    }
  });

  return lines.join("\n");
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function fencedBlock(value: string, language: string): string {
  const maxRun = Math.max(0, ...Array.from(value.matchAll(/`+/g), (match) => match[0].length));
  const fence = "`".repeat(Math.max(3, maxRun + 1));
  return `${fence}${language}\n${value}\n${fence}`;
}

import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { createChatThread, type ChatThreadSummary } from "@/lib/chat-workspace";
import { ToastProvider } from "@/lib/toast";
import { ChatThreadNav } from "./ChatThreadNav";

function thread(
  id: string,
  title: string,
  patch: Partial<ChatThreadSummary> = {},
): ChatThreadSummary {
  const { messages: _messages, ...summary } = createChatThread({
    id,
    title,
    previewMode: "creator",
    now: "2026-07-20T10:00:00.000Z",
  });
  return { ...summary, ...patch };
}

describe("ChatThreadNav", () => {
  it("labels new, active, unread, streaming, and failed conversations", () => {
    const html = renderToStaticMarkup(
      <ChatThreadNav
        threads={[
          thread("active", "Current chat"),
          thread("unread", "Background result", { unread: true }),
          thread("streaming", "Long task", { runStatus: "streaming" }),
          thread("failed", "Broken task", { runStatus: "error" }),
        ]}
        activeId="active"
        onNew={() => {}}
        onSelect={() => {}}
      />,
    );

    expect(html).toContain(">New</span>");
    expect(html).toContain('aria-current="page"');
    expect(html).toContain("Background result, Unread");
    expect(html).toContain("Long task, Streaming response");
    expect(html).toContain("Broken task, Response failed");
  });

  it("shows a non-interactive loading affordance while chats hydrate", () => {
    const html = renderToStaticMarkup(
      <ChatThreadNav
        threads={[thread("draft", "Draft chat")]}
        activeId="draft"
        loading
        onNew={() => {}}
        onSelect={() => {}}
      />,
    );

    expect(html).toContain("Loading chats…");
    expect(html).not.toContain("Draft chat");
    expect(html).toContain('disabled=""');
  });

  it("hides durable rows and reports a hydration failure", () => {
    const html = renderToStaticMarkup(
      <ChatThreadNav
        threads={[thread("draft", "Draft chat")]}
        activeId="draft"
        error="database unavailable"
        onNew={() => {}}
        onSelect={() => {}}
      />,
    );

    expect(html).toContain("Chats unavailable");
    expect(html).toContain('role="alert"');
    expect(html).toContain('title="database unavailable"');
    expect(html).not.toContain("Draft chat");
  });

  it("leaves every chat unselected when another console section is active", () => {
    const html = renderToStaticMarkup(
      <ChatThreadNav
        threads={[thread("draft", "Draft chat")]}
        activeId=""
        onNew={() => {}}
        onSelect={() => {}}
      />,
    );

    expect(html).not.toContain('aria-current="page"');
  });

  it("renders a permanent chat icon and desktop mutation affordance", () => {
    const html = renderToStaticMarkup(
      <ToastProvider>
        <ChatThreadNav
          threads={[thread("active", "Current chat")]}
          activeId="active"
          onNew={() => {}}
          onSelect={() => {}}
          onRename={() => {}}
          onDelete={() => {}}
        />
      </ToastProvider>,
    );

    expect(html).toContain("lucide-message-square");
    expect(html).toContain('aria-label="Actions for Current chat"');
  });
});

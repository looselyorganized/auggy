/** Build a console-relative URL for a durable chat identifier. */
export function chatThreadPath(threadId: string): string {
  return `/chat/${encodeURIComponent(threadId)}`;
}

/** React Router's low-level matchPath helper leaves path parameters encoded. */
export function decodeChatThreadRouteParam(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function isChatThreadActuallyVisible(options: {
  chatRouteActive: boolean;
  documentVisible: boolean;
  routedThreadId: string | undefined;
  activeThreadId: string;
}): boolean {
  return (
    options.chatRouteActive &&
    options.documentVisible &&
    options.routedThreadId !== undefined &&
    options.routedThreadId === options.activeThreadId
  );
}

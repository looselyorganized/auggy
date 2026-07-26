/**
 * Resolve the durable replay scope for one Telegram bot.
 *
 * The default deliberately remains provider-derived rather than agent-derived:
 * existing replay claims must survive an Auggy identity upgrade so an update is
 * not delivered twice. Exclusive bot ownership is enforced separately by the
 * local runtime resource registry.
 */
export function resolveTelegramReplayNamespace(
  botToken: string,
  explicitNamespace?: string,
  testClientName?: string,
): string {
  if (explicitNamespace) return explicitNamespace;
  const botId = botToken.match(/^(\d+):/)?.[1];
  if (testClientName && !botId) return `${testClientName}:test-client`;
  if (!botId) {
    throw new Error(
      "[telegram-transport] replay.namespace is required when botToken has no numeric bot id",
    );
  }
  return `telegram:bot-${botId}`;
}

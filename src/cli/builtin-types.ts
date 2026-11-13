/** Supported declarable built-in types. Data only: safe for passive CLI readers. */
export const BUILTIN_TYPE_NAMES = [
  "fileMemory",
  "supabaseMemory",
  "layeredMemory",
  "filesystem",
  "webTransport",
  "webFetch",
  "knowledge",
  "skills",
  "bash",
  "budgets",
  "notify",
  "mcp",
  "agentMail",
  "telegramTransport",
  "turnControl",
  "visitorAuth",
  "link",
] as const;

export const BUILTIN_TYPES: ReadonlySet<string> = new Set(BUILTIN_TYPE_NAMES);

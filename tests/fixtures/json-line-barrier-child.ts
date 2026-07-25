const decoder = new TextDecoder();
const reader = Bun.stdin.stream().getReader();
let buffered = "";

async function nextMessage(): Promise<Record<string, unknown> | null> {
  while (true) {
    const newline = buffered.indexOf("\n");
    if (newline >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (line.length === 0) continue;
      return JSON.parse(line) as Record<string, unknown>;
    }
    const chunk = await reader.read();
    if (chunk.done) return null;
    buffered += decoder.decode(chunk.value, { stream: true });
  }
}

const worker = process.argv[2] ?? "child";
if (process.argv[3] === "noisy") console.error("x".repeat(128 * 1024));
console.log(JSON.stringify({ event: "READY", worker }));
const message = await nextMessage();
if (message?.event !== "GO") throw new Error("expected explicit GO barrier message");
console.log(JSON.stringify({ event: "RELEASED", worker }));

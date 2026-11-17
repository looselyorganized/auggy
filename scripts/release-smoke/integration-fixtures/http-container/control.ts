/** Static finite remote command. The enclosing runner owns remote timeout/termination proof. */
import { boundedFixtureBody } from "../application/model-fixture";
import { HOSTED_HTTP_LIMITS, HOSTED_HTTP_PORTS, parseHostedHttpControl } from "./startup";

export async function runHostedHttpControl(input: unknown): Promise<string> {
  const operation = parseHostedHttpControl(input);
  const token = process.env.AUGGY_FIXTURE_CONTROL_TOKEN;
  if (!token || !/^[a-f0-9]{64}$/.test(token))
    throw new Error("Missing private fixture control authority");
  const body = JSON.stringify(operation);
  if (Buffer.byteLength(body) > HOSTED_HTTP_LIMITS.controlBytes)
    throw new Error("Fixture control exceeded bound");
  const response = await fetch(`http://127.0.0.1:${HOSTED_HTTP_PORTS.control}/control`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-fixture-control": token },
    body,
    redirect: "manual",
    signal: AbortSignal.timeout(HOSTED_HTTP_LIMITS.drainMs + 2000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("Fixture control rejected");
  }
  return boundedFixtureBody(response, HOSTED_HTTP_LIMITS.snapshotBytes);
}

if (import.meta.main) {
  const deadline = setTimeout(() => process.exit(70), 15_000);
  try {
    const bytes = await boundedFixtureBody(
      new Response(Bun.stdin.stream()),
      HOSTED_HTTP_LIMITS.controlBytes,
    );
    const result = await runHostedHttpControl(JSON.parse(bytes));
    await Bun.write(Bun.stdout, result);
  } catch {
    console.error("Bounded HTTP fixture control failed");
    process.exitCode = 1;
  } finally {
    clearTimeout(deadline);
  }
}

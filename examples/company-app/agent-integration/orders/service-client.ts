import { z } from "zod";
import type { OrdersService } from "./contracts";

const grant = z
  .object({
    action: z.enum(["orders.read", "orders.refund.simulate"]),
    resource: z.string().min(1).max(128),
    constraints: z
      .object({ maxAmountCents: z.number().int().min(1).max(5000) })
      .strict()
      .optional(),
  })
  .strict();
const authorization = z
  .object({
    scopes: z.array(z.literal("orders.read")).max(1),
    grants: z.array(grant).max(64),
    authzVersion: z.string().min(1).max(128),
  })
  .strict();
export const orderSchema = z
  .object({
    id: z.string().min(1).max(128),
    status: z.enum(["processing", "shipped"]),
    item: z.string().max(256),
    totalCents: z.number().int().nonnegative(),
    privateNote: z.string().max(512),
  })
  .strict();
export const refundSchema = z
  .object({
    simulationId: z.string().min(1).max(128),
    orderId: z.string().min(1).max(128),
    amountCents: z.number().int().min(1).max(5000),
    simulated: z.literal(true),
  })
  .strict();

export class OrdersServiceError extends Error {
  constructor(readonly status: 403 | 409 | 503) {
    super("Order service request could not be completed");
  }
}

export function createOrdersServiceClient(options: {
  origin?: string;
  token?: string;
  fetch?: typeof fetch;
}): OrdersService {
  if (!options.origin || !options.token) throw new OrdersServiceError(503);
  const origin = new URL(options.origin);
  if (
    !/^https?:$/.test(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    /[\p{Cc}\s\\]/u.test(options.origin)
  ) {
    throw new OrdersServiceError(503);
  }
  const fetchImpl = options.fetch ?? fetch;
  async function request<T>(
    path: string,
    body: unknown,
    schema: z.ZodType<T>,
    parent?: AbortSignal,
  ): Promise<T> {
    const deadline = AbortSignal.timeout(10_000);
    const signal = parent ? AbortSignal.any([parent, deadline]) : deadline;
    let reader:
      | Pick<ReadableStreamDefaultReader<Uint8Array>, "read" | "cancel" | "releaseLock">
      | undefined;
    try {
      const response = await fetchImpl(new URL(path, origin), {
        method: "POST",
        redirect: "manual",
        signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${options.token}` },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new OrdersServiceError(
          response.status === 403 ? 403 : response.status === 409 ? 409 : 503,
        );
      }
      if (!response.body) throw new OrdersServiceError(503);
      const streamReader = response.body.getReader();
      reader = streamReader;
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      for (;;) {
        const next = await streamReader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > 64 * 1024) throw new OrdersServiceError(503);
        chunks.push(next.value);
      }
      const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
      return schema.parse(JSON.parse(text));
    } catch (error) {
      if (error instanceof OrdersServiceError) throw error;
      throw new OrdersServiceError(503);
    } finally {
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
    }
  }
  return {
    authorizationFor: (subject) => request("/authorization", subject, authorization),
    read: (principal, orderId, signal) =>
      request("/orders/read", { principal, orderId }, orderSchema, signal),
    simulateRefund: (principal, input, signal) =>
      request("/refunds/simulate", { principal, ...input }, refundSchema, signal),
  };
}

import type { ConfirmedAddressChange, DemoOrder, PreparedAddressChange } from "./schemas";

const DEMO_ORDER_ID = "A-1042";
const DEMO_STARTING_ADDRESS = "100 Main Street, San Francisco, CA 94105";

export interface AuthorizedActor {
  key: string;
  id: string;
  type: "creator" | "verified_visitor";
}

interface PendingAddressChange {
  changeId: string;
  actorKey: string;
  binding: string;
  orderId: string;
  proposedAddress: string;
  confirmationPhrase: string;
  expiresAt: number;
}

export class OrderSupportError extends Error {
  constructor(
    readonly code:
      | "verification_required"
      | "order_not_found"
      | "change_not_prepared"
      | "confirmation_expired"
      | "confirmation_mismatch"
      | "explicit_confirmation_required",
    message: string,
  ) {
    super(message);
  }
}

export interface OrderSupportServiceOptions {
  now?: () => Date;
  createId?: () => string;
  confirmationTtlMs?: number;
}

export class OrderSupportService {
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly confirmationTtlMs: number;
  private readonly ordersByActor = new Map<string, DemoOrder>();
  private readonly pendingById = new Map<string, PendingAddressChange>();
  private readonly pendingIdByActorBinding = new Map<string, string>();

  constructor(opts: OrderSupportServiceOptions = {}) {
    this.now = opts.now ?? (() => new Date());
    this.createId = opts.createId ?? (() => crypto.randomUUID());
    this.confirmationTtlMs = opts.confirmationTtlMs ?? 10 * 60 * 1000;
    if (!Number.isSafeInteger(this.confirmationTtlMs) || this.confirmationTtlMs <= 0) {
      throw new Error("order-support: confirmationTtlMs must be a positive integer");
    }
  }

  getOrder(actor: AuthorizedActor, orderId: string): DemoOrder {
    if (orderId !== DEMO_ORDER_ID) {
      throw new OrderSupportError("order_not_found", "That order was not found for this identity.");
    }
    let order = this.ordersByActor.get(actor.key);
    if (!order) {
      order = {
        orderId: DEMO_ORDER_ID,
        shippingAddress: DEMO_STARTING_ADDRESS,
        fulfillmentStatus: "processing",
      };
      this.ordersByActor.set(actor.key, order);
    }
    return { ...order };
  }

  prepareAddressChange(input: {
    actor: AuthorizedActor;
    binding: string;
    orderId: string;
    newAddress: string;
  }): PreparedAddressChange {
    const order = this.getOrder(input.actor, input.orderId);
    const changeId = `change_${this.createId()}`;
    const confirmationPhrase = `CONFIRM ADDR-${suffix(this.createId())}`;
    const expiresAt = this.now().getTime() + this.confirmationTtlMs;
    const key = actorBindingKey(input.actor, input.binding);
    const previousId = this.pendingIdByActorBinding.get(key);
    if (previousId) this.pendingById.delete(previousId);

    this.pendingById.set(changeId, {
      changeId,
      actorKey: input.actor.key,
      binding: input.binding,
      orderId: order.orderId,
      proposedAddress: input.newAddress,
      confirmationPhrase,
      expiresAt,
    });
    this.pendingIdByActorBinding.set(key, changeId);

    return {
      status: "confirmation_required",
      changeId,
      orderId: order.orderId,
      currentAddress: order.shippingAddress,
      proposedAddress: input.newAddress,
      confirmationPhrase,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  confirmAddressChange(input: {
    actor: AuthorizedActor;
    binding: string;
    changeId?: string;
    confirmationPhrase: string;
    humanInput: string;
  }): ConfirmedAddressChange {
    const key = actorBindingKey(input.actor, input.binding);
    const changeId = input.changeId ?? this.pendingIdByActorBinding.get(key);
    const pending = changeId ? this.pendingById.get(changeId) : undefined;
    if (!pending || pending.actorKey !== input.actor.key || pending.binding !== input.binding) {
      throw new OrderSupportError(
        "change_not_prepared",
        "No address change is awaiting confirmation for this identity and channel.",
      );
    }
    if (this.now().getTime() >= pending.expiresAt) {
      this.deletePending(pending);
      throw new OrderSupportError("confirmation_expired", "The confirmation expired. Prepare the change again.");
    }
    if (input.confirmationPhrase !== pending.confirmationPhrase) {
      throw new OrderSupportError("confirmation_mismatch", "The confirmation phrase does not match the pending change.");
    }
    if (input.humanInput !== pending.confirmationPhrase) {
      throw new OrderSupportError(
        "explicit_confirmation_required",
        "The authorized human must provide the exact confirmation phrase.",
      );
    }

    const order = this.getOrder(input.actor, pending.orderId);
    const previousAddress = order.shippingAddress;
    const changedAt = this.now().toISOString();
    const updatedOrder: DemoOrder = { ...order, shippingAddress: pending.proposedAddress };
    this.ordersByActor.set(input.actor.key, updatedOrder);
    this.deletePending(pending);

    return {
      status: "success",
      order: updatedOrder,
      audit: {
        auditId: `AUD-${suffix(this.createId())}`,
        action: "shipping_address.changed",
        actorType: input.actor.type,
        actorId: input.actor.id,
        orderId: updatedOrder.orderId,
        previousAddress,
        updatedAddress: updatedOrder.shippingAddress,
        changedAt,
      },
    };
  }

  private deletePending(pending: PendingAddressChange): void {
    this.pendingById.delete(pending.changeId);
    this.pendingIdByActorBinding.delete(
      `${pending.actorKey}:${pending.binding}`,
    );
  }
}

function actorBindingKey(actor: AuthorizedActor, binding: string): string {
  return `${actor.key}:${binding}`;
}

function suffix(value: string): string {
  const normalized = value.replace(/[^a-z0-9]/gi, "").toUpperCase();
  return (normalized || "CHANGE").slice(0, 32);
}

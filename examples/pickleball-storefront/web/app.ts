import { createAuggyClient } from "./auggy-client";

const api = createAuggyClient({
  baseUrl: "http://localhost:8088",
  visitorToken: () => localStorage.getItem("auggyVisitorToken") ?? undefined,
  onVisitorToken: (token) => localStorage.setItem("auggyVisitorToken", token),
});

type CatalogProduct = Awaited<
  ReturnType<typeof api.get<"/storefront/products">>
> extends { ok: true; data: { products: Array<infer T> } }
  ? T
  : never;

const selected = new Map<string, { product: CatalogProduct; quantity: number }>();
const products = element("products");
const status = element("status");
const styleFilter = element("style-filter") as HTMLSelectElement;
const checkoutButton = element("checkout-button") as HTMLButtonElement;
const checkoutDialog = element("checkout-dialog") as HTMLDialogElement;
const chatToggle = element("chat-toggle") as HTMLButtonElement;
const chatClose = element("chat-close") as HTMLButtonElement;
const chatPanel = element("chat-panel");
const chatForm = element("chat-form") as HTMLFormElement;
const chatInput = element("chat-input") as HTMLInputElement;
const chatMessages = element("chat-messages");

styleFilter.addEventListener("change", () => void loadProducts());
checkoutButton.addEventListener("click", () => void prepareCheckout());
chatToggle.addEventListener("click", () => setChatOpen(true));
chatClose.addEventListener("click", () => setChatOpen(false));
chatForm.addEventListener("submit", (event) => void sendChat(event));
void loadProducts();

async function loadProducts(): Promise<void> {
  status.textContent = "Loading catalog...";
  products.replaceChildren();
  const playStyle = styleFilter.value || undefined;
  const result = await api.get("/storefront/products", {
    query: { playStyle: playStyle as "control" | "balanced" | "power" | undefined },
  });
  if (!result.ok) {
    status.textContent = `Catalog unavailable (${result.status}).`;
    return;
  }
  status.textContent = `${result.data.products.length} products available`;
  for (const product of result.data.products) products.append(productCard(product));
}

function productCard(product: CatalogProduct): HTMLElement {
  const card = document.createElement("article");
  card.className = "product-card";

  const visual = document.createElement("div");
  visual.className = "product-visual";
  const shape = document.createElement("div");
  shape.className = "paddle-shape";
  shape.style.background = product.accent;
  visual.append(shape);

  const copy = document.createElement("div");
  copy.className = "product-copy";
  const meta = document.createElement("div");
  meta.className = "product-meta";
  meta.append(text("span", product.category), text("span", `$${product.priceUsd}`));
  const name = text("h3", product.name);
  const summary = text("p", product.summary);
  const button = text("button", "Add to draft cart") as HTMLButtonElement;
  button.type = "button";
  button.addEventListener("click", () => {
    const current = selected.get(product.id);
    selected.set(product.id, { product, quantity: (current?.quantity ?? 0) + 1 });
    updateCartSummary();
  });
  copy.append(meta, name, summary, button);
  card.append(visual, copy);
  return card;
}

function updateCartSummary(): void {
  const items = [...selected.values()];
  const count = items.reduce((sum, item) => sum + item.quantity, 0);
  const total = items.reduce((sum, item) => sum + item.product.priceUsd * item.quantity, 0);
  element("cart-count").textContent = `${count} ${count === 1 ? "item" : "items"}`;
  element("cart-total").textContent = `$${total}`;
  element("checkout-summary").textContent = `${count} items · $${total}`;
  checkoutButton.disabled = count === 0;
}

async function prepareCheckout(): Promise<void> {
  checkoutButton.disabled = true;
  checkoutButton.textContent = "Preparing...";
  const cartResult = await api.post("/storefront/carts", {
    body: {
      items: [...selected.values()].map(({ product, quantity }) => ({
        productId: product.id,
        quantity,
      })),
    },
  });
  if (!cartResult.ok) return showError(`Could not create cart (${cartResult.status}).`);

  const checkoutResult = await api.post("/storefront/checkout-sessions", {
    body: { cartId: cartResult.data.cart.id },
  });
  if (!checkoutResult.ok) return showError(`Could not prepare checkout (${checkoutResult.status}).`);

  element("checkout-message").textContent =
    `Checkout ${checkoutResult.data.checkout.id} is ready for ` +
    `$${checkoutResult.data.checkout.amountUsd}.`;
  checkoutDialog.showModal();
  checkoutButton.disabled = false;
  checkoutButton.textContent = "Prepare checkout";
}

function showError(message: string): void {
  status.textContent = message;
  checkoutButton.disabled = false;
  checkoutButton.textContent = "Prepare checkout";
}

function setChatOpen(open: boolean): void {
  chatPanel.hidden = !open;
  chatToggle.setAttribute("aria-expanded", String(open));
  if (open) chatInput.focus();
}

async function sendChat(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const message = chatInput.value.trim();
  if (!message) return;
  appendMessage(message, "visitor-message");
  chatInput.value = "";

  const submit = chatForm.querySelector("button") as HTMLButtonElement;
  submit.disabled = true;
  const responseNode = appendMessage("", "agent-message");
  try {
    const response = await fetch("http://localhost:8088/agent/run", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
        "x-visitor-token": localStorage.getItem("auggyVisitorToken") ?? "bootstrap",
      },
      body: JSON.stringify({
        threadId: persistentThreadId(),
        messages: [{ role: "user", content: message }],
      }),
    });
    const rotatedToken = response.headers.get("x-visitor-token");
    if (rotatedToken) localStorage.setItem("auggyVisitorToken", rotatedToken);
    if (!response.ok || !response.body) {
      responseNode.textContent = `The agent is unavailable (${response.status}).`;
      return;
    }
    await readAgentStream(response.body, responseNode);
  } catch {
    responseNode.textContent = "The agent connection failed. Check that Auggy is running.";
  } finally {
    submit.disabled = false;
    chatInput.focus();
  }
}

async function readAgentStream(
  stream: ReadableStream<Uint8Array>,
  output: HTMLElement,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const data = frame
        .split("\n")
        .find((line) => line.startsWith("data:"))
        ?.slice(5)
        .trim();
      if (!data) continue;
      const event = JSON.parse(data) as { type?: string; delta?: string; message?: string };
      if (event.type === "TEXT_MESSAGE_CONTENT" && event.delta) {
        output.textContent += event.delta;
      }
      if (event.type === "RUN_ERROR") {
        output.textContent = event.message ?? "The agent could not complete that request.";
      }
    }
    if (done) break;
  }
  if (!output.textContent) output.textContent = "The agent returned no text.";
}

function appendMessage(value: string, className: string): HTMLParagraphElement {
  const node = document.createElement("p");
  node.className = className;
  node.textContent = value;
  chatMessages.append(node);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return node;
}

function persistentThreadId(): string {
  const existing = localStorage.getItem("auggyStorefrontThreadId");
  if (existing) return existing;
  const created = `storefront-${crypto.randomUUID()}`;
  localStorage.setItem("auggyStorefrontThreadId", created);
  return created;
}

function element(id: string): HTMLElement {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing #${id}`);
  return value;
}

function text(tag: string, value: string): HTMLElement {
  const node = document.createElement(tag);
  node.textContent = value;
  return node;
}

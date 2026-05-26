import { findCsrfToken } from "@/lib/api";
import type { CsrfToken } from "@/lib/types";

async function memFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const base = new URL(window.location.href);
  base.username = "";
  base.password = "";
  const url = new URL(input, base).toString();
  return fetch(url, init);
}

export interface MemoryEntryView {
  augmentName: string;
  augmentType: string;
  scope: string;
  label: string;
  content: string;
  peerId: string | null;
  trustLevel: string | null;
  createdAtIso: string | null;
  origin: string | null;
  superseded: boolean;
}

export interface MemoryProviderSummary {
  augmentName: string;
  augmentType: string;
  kind: "namespace" | "static";
  scope: string;
  entryCount: number;
  listSupported: boolean;
  listError: string | null;
}

export interface MemoryDashboard {
  entries: MemoryEntryView[];
  providers: MemoryProviderSummary[];
  totals: { entries: number; peers: number; providers: number };
  peerForgetCapable: string[];
}

export async function fetchMemoryDashboard(): Promise<MemoryDashboard> {
  const res = await memFetch("/admin/api/memory");
  if (!res.ok) {
    const body = (await safeJson(res)) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as MemoryDashboard;
}

export interface ErasePeerResult {
  ok: boolean;
  message: string;
  erasedByAugment?: Record<string, number>;
}

export async function erasePeer(
  csrfTokens: CsrfToken[],
  peerId: string,
): Promise<ErasePeerResult> {
  const csrf = findCsrfToken(csrfTokens, "memory-erase-peer");
  if (!csrf) return { ok: false, message: "Missing CSRF token for memory-erase-peer" };
  const res = await memFetch("/admin/api/memory/peer/erase", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ csrf, peerId }),
  });
  if (res.status === 419) return { ok: false, message: "Session expired — reload the page." };
  const body = (await safeJson(res)) as { ok?: boolean; message?: string; error?: string; erasedByAugment?: Record<string, number> };
  if (!res.ok) return { ok: false, message: body.error ?? body.message ?? `HTTP ${res.status}` };
  return {
    ok: !!body.ok,
    message: body.message ?? body.error ?? "",
    erasedByAugment: body.erasedByAugment,
  };
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

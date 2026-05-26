import { useCallback, useEffect, useState } from "react";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useDashboardContext } from "@/components/admin/DashboardContext";
import { useToast } from "@/lib/toast";
import { readIdentity, writeIdentity, type IdentityRead } from "@/lib/identity-api";
import { diffLines, diffStats, type DiffOp } from "@/lib/diff";

interface LoadState {
  status: "idle" | "loading" | "loaded" | "error";
  source: IdentityRead | null;
  error: string | null;
}

export function IdentityTab() {
  const { data, refresh } = useDashboardContext();
  const { push } = useToast();

  const [load, setLoad] = useState<LoadState>({ status: "idle", source: null, error: null });
  const [draft, setDraft] = useState<string>("");
  const [previewing, setPreviewing] = useState(false);
  const [saving, setSaving] = useState(false);

  const fetchIdentity = useCallback(async () => {
    setLoad((s) => ({ ...s, status: "loading" }));
    try {
      const source = await readIdentity();
      setLoad({ status: "loaded", source, error: null });
      setDraft(source.content);
    } catch (err) {
      setLoad({ status: "error", source: null, error: (err as Error).message });
    }
  }, []);

  useEffect(() => {
    void fetchIdentity();
  }, [fetchIdentity]);

  const dirty = load.source ? draft !== load.source.content : false;

  const handleSave = useCallback(async () => {
    setSaving(true);
    const res = await writeIdentity(data?.csrfTokens ?? [], draft);
    push(res.ok ? "success" : "error", res.message);
    if (res.ok) {
      setPreviewing(false);
      await fetchIdentity();
      await refresh();
    }
    setSaving(false);
  }, [data, draft, push, refresh, fetchIdentity]);

  const handleRevert = useCallback(() => {
    if (load.source) setDraft(load.source.content);
  }, [load.source]);

  // Cmd/Ctrl+S → open diff preview when dirty.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        if (dirty && !saving) setPreviewing(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [dirty, saving]);

  if (load.status === "loading" && !load.source) {
    return <Skeleton title="Loading identity.md…" />;
  }
  if (load.status === "error") {
    return (
      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle className="text-destructive">identity.md load failed</CardTitle>
          <CardDescription className="font-mono text-xs">{load.error}</CardDescription>
        </CardHeader>
      </Card>
    );
  }
  if (!load.source) return null;

  const meta = data?.agentMeta;
  const chars = draft.length;
  const words = countWords(draft);
  const tokens = estimateTokens(draft);

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Identity preamble
        </h2>
        <p className="text-xs text-muted-foreground">
          The agent's preamble — pinned in context on every turn. Edit it here; the kernel
          reloads it at boot, so <strong>restart the agent</strong> after saving for the changes
          to apply.
        </p>
        <div className="flex flex-wrap gap-x-4 gap-y-1 pt-1 text-[11px] text-muted-foreground">
          <span className="font-mono">{load.source.path}</span>
          {load.source.modifiedIso && (
            <span>
              modified{" "}
              <time dateTime={load.source.modifiedIso} title={load.source.modifiedIso}>
                {formatRelative(load.source.modifiedIso)}
              </time>
            </span>
          )}
          {meta?.name && <span>agent: {meta.name}</span>}
        </div>
      </header>

      <Textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        className="min-h-[560px] font-mono text-xs leading-relaxed"
        spellCheck={false}
        placeholder="No identity.md on disk yet. Type here and save to create it."
      />

      <footer className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-4 text-xs text-muted-foreground">
          <span>{chars.toLocaleString()} chars</span>
          <span>{words.toLocaleString()} words</span>
          <span>~{tokens.toLocaleString()} tokens</span>
          <span>{(new Blob([draft]).size / 1024).toFixed(1)} KiB</span>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" disabled={!dirty || saving} onClick={handleRevert}>
            Revert
          </Button>
          <Button
            size="sm"
            disabled={!dirty || saving}
            onClick={() => setPreviewing(true)}
            title="Cmd/Ctrl+S"
          >
            Preview & save
          </Button>
        </div>
      </footer>

      <DiffDialog
        open={previewing}
        onOpenChange={(open) => !open && setPreviewing(false)}
        oldText={load.source.content}
        newText={draft}
        onConfirm={handleSave}
        saving={saving}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Diff preview dialog
// ---------------------------------------------------------------------------

function DiffDialog({
  open,
  onOpenChange,
  oldText,
  newText,
  onConfirm,
  saving,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  oldText: string;
  newText: string;
  onConfirm: () => void;
  saving: boolean;
}) {
  const ops = open ? diffLines(oldText, newText) : [];
  const stats = diffStats(ops);
  const nothingChanged = stats.added === 0 && stats.removed === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Preview identity.md changes</DialogTitle>
          <DialogDescription>
            {nothingChanged ? (
              <>No changes to save.</>
            ) : (
              <>
                <span className="text-emerald-500">+{stats.added}</span>{" "}
                <span className="text-destructive">−{stats.removed}</span> lines. Restart the
                agent after saving for the new identity to load into context.
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[480px] overflow-y-auto rounded-md border bg-muted/30 p-3 font-mono text-[11px] leading-snug">
          <DiffView ops={ops} />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            Keep editing
          </Button>
          <Button onClick={onConfirm} disabled={nothingChanged || saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DiffView({ ops }: { ops: DiffOp[] }) {
  return (
    <pre className="whitespace-pre-wrap break-words">
      {ops.map((op, i) => {
        if (op.kind === "context") {
          return (
            <div key={i} className="text-muted-foreground">
              {"  "}
              {op.text}
            </div>
          );
        }
        if (op.kind === "add") {
          return (
            <div key={i} className="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
              +&nbsp;{op.text}
            </div>
          );
        }
        return (
          <div key={i} className="bg-destructive/10 text-destructive">
            −&nbsp;{op.text}
          </div>
        );
      })}
    </pre>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function Skeleton({ title }: { title: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Identity</CardTitle>
        <CardDescription>{title}</CardDescription>
      </CardHeader>
    </Card>
  );
}

function countWords(s: string): number {
  const trimmed = s.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

/**
 * Rough character-based token estimate. Mirrors the agent runtime's
 * char-based tokenizer (`src/tokenizer.ts`) — ~4 chars per token. Good
 * enough for a UI hint; the real tokenizer ships with each model.
 */
function estimateTokens(s: string): number {
  return Math.round(s.length / 4);
}

function formatRelative(iso: string): string {
  const t = new Date(iso).getTime();
  const now = Date.now();
  const diffSec = Math.round((now - t) / 1000);
  if (diffSec < 5) return "just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.round(diffSec / 3600)}h ago`;
  return `${Math.round(diffSec / 86400)}d ago`;
}

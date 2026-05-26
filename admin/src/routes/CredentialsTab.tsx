import { useCallback, useEffect, useState } from "react";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Plus, Copy, Eye, EyeOff } from "lucide-react";
import { useDashboardContext } from "@/components/admin/DashboardContext";
import { useToast } from "@/lib/toast";
import { useConfirm } from "@/lib/confirm";
import {
  deleteCredential,
  listCredentials,
  revealCredential,
  setCredential,
  type CredentialsEntry,
  type CredentialsList,
} from "@/lib/credentials-api";

interface EditState {
  /** Original key, or null for "create new". */
  originalKey: string | null;
  key: string;
  value: string;
  /** When true, render value as masked text — flipped via the eye toggle. */
  hidden: boolean;
  saving: boolean;
}

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function CredentialsTab() {
  const { data } = useDashboardContext();
  const { push } = useToast();
  const confirm = useConfirm();
  const [list, setList] = useState<CredentialsList | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<EditState | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await listCredentials();
      setList(next);
      setLoadError(null);
    } catch (err) {
      setLoadError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleReveal = useCallback(
    async (key: string) => {
      if (revealed[key] !== undefined) {
        setRevealed((m) => {
          const { [key]: _, ...rest } = m;
          return rest;
        });
        return;
      }
      setBusyKey(key);
      const r = await revealCredential(data?.csrfTokens ?? [], key);
      if ("error" in r) {
        push("error", r.error);
      } else {
        setRevealed((m) => ({ ...m, [key]: r.value }));
      }
      setBusyKey(null);
    },
    [data, push, revealed],
  );

  const handleCopy = useCallback(
    async (key: string) => {
      let value = revealed[key];
      if (value === undefined) {
        const r = await revealCredential(data?.csrfTokens ?? [], key);
        if ("error" in r) {
          push("error", r.error);
          return;
        }
        value = r.value;
      }
      try {
        await navigator.clipboard.writeText(value);
        push("success", `Copied ${key} to clipboard`);
      } catch {
        push("error", "Clipboard not available — reveal and copy manually.");
      }
    },
    [data, push, revealed],
  );

  const openEdit = useCallback(
    async (key: string) => {
      const r = await revealCredential(data?.csrfTokens ?? [], key);
      if ("error" in r) {
        push("error", r.error);
        return;
      }
      setEditing({ originalKey: key, key, value: r.value, hidden: true, saving: false });
    },
    [data, push],
  );

  const openCreate = useCallback(() => {
    setEditing({ originalKey: null, key: "", value: "", hidden: false, saving: false });
  }, []);

  const handleSaveEdit = useCallback(async () => {
    if (!editing) return;
    const key = editing.key.trim();
    if (!KEY_RE.test(key)) {
      push("error", "Key must match [A-Za-z_][A-Za-z0-9_]* (letters, digits, underscore).");
      return;
    }
    setEditing({ ...editing, saving: true });
    // When renaming, delete the old key first then set the new one.
    if (editing.originalKey && editing.originalKey !== key) {
      const del = await deleteCredential(data?.csrfTokens ?? [], editing.originalKey);
      if (!del.ok) {
        push("error", del.message || "rename failed");
        setEditing((prev) => (prev ? { ...prev, saving: false } : null));
        return;
      }
    }
    const r = await setCredential(data?.csrfTokens ?? [], key, editing.value);
    push(r.ok ? "success" : "error", r.message || (r.ok ? "Saved" : "Failed"));
    if (r.ok) {
      setEditing(null);
      // Drop any stale reveal cache for keys we edited.
      setRevealed((m) => {
        const { [key]: _new, ...rest } = m;
        if (editing.originalKey && editing.originalKey !== key) {
          const { [editing.originalKey]: _old, ...rest2 } = rest;
          return rest2;
        }
        return rest;
      });
      await refresh();
    } else {
      setEditing((prev) => (prev ? { ...prev, saving: false } : null));
    }
  }, [editing, data, push, refresh]);

  const handleDelete = useCallback(
    async (key: string) => {
      const ok = await confirm({
        message: `Remove ${key} from .env? The runtime won't see it after the next agent restart.`,
        destructive: true,
        confirmLabel: "Remove",
      });
      if (!ok) return;
      setBusyKey(key);
      const r = await deleteCredential(data?.csrfTokens ?? [], key);
      push(r.ok ? "success" : "error", r.message);
      if (r.ok) {
        setRevealed((m) => {
          const { [key]: _, ...rest } = m;
          return rest;
        });
        await refresh();
      }
      setBusyKey(null);
    },
    [confirm, data, push, refresh],
  );

  if (loadError && !list) {
    return (
      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle className="text-destructive">.env load failed</CardTitle>
          <CardDescription className="font-mono text-xs">{loadError}</CardDescription>
        </CardHeader>
      </Card>
    );
  }
  if (!list) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Credentials</CardTitle>
          <CardDescription>Loading .env…</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <header className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            .env entries
          </h2>
          <p className="text-xs text-muted-foreground">
            Stored at <span className="font-mono">{list.path}</span>. Values are masked by
            default — click the eye to reveal. Changes take effect on next agent restart.
          </p>
        </div>
        <Button onClick={openCreate} size="sm">
          <Plus className="size-4" />
          Add key
        </Button>
      </header>

      {list.entries.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">No credentials yet</CardTitle>
            <CardDescription>
              {list.exists
                ? "The .env file exists but has no KEY=VALUE entries."
                : "No .env file at this path yet. Adding a key creates it."}
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <div className="overflow-hidden rounded-md border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/40">
                <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Key
                </th>
                <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Value
                </th>
                <th className="w-px px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {list.entries.map((entry) => (
                <CredentialRow
                  key={entry.key}
                  entry={entry}
                  revealedValue={revealed[entry.key]}
                  busy={busyKey === entry.key}
                  onToggleReveal={() => handleReveal(entry.key)}
                  onCopy={() => handleCopy(entry.key)}
                  onEdit={() => openEdit(entry.key)}
                  onDelete={() => handleDelete(entry.key)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <EditDialog
        editing={editing}
        onChange={(patch) => setEditing((prev) => (prev ? { ...prev, ...patch } : null))}
        onCancel={() => setEditing(null)}
        onSave={handleSaveEdit}
      />
    </div>
  );
}

function CredentialRow({
  entry,
  revealedValue,
  busy,
  onToggleReveal,
  onCopy,
  onEdit,
  onDelete,
}: {
  entry: CredentialsEntry;
  revealedValue: string | undefined;
  busy: boolean;
  onToggleReveal: () => void;
  onCopy: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const isRevealed = revealedValue !== undefined;
  const display = entry.empty
    ? "(empty)"
    : isRevealed
      ? revealedValue
      : "•".repeat(Math.min(Math.max(entry.length, 1), 24));
  return (
    <tr className="border-b last:border-0">
      <td className="px-3 py-2 align-middle font-mono text-xs">{entry.key}</td>
      <td className="px-3 py-2 align-middle">
        <span className={`font-mono text-xs ${isRevealed ? "" : "text-muted-foreground"}`}>
          {display}
        </span>
        {!entry.empty && (
          <span className="ml-2 text-[10px] text-muted-foreground">
            {entry.length} char{entry.length === 1 ? "" : "s"}
          </span>
        )}
      </td>
      <td className="px-3 py-2 align-middle">
        <div className="flex justify-end gap-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={onToggleReveal}
            disabled={busy || entry.empty}
            aria-label={isRevealed ? "Hide value" : "Reveal value"}
            title={isRevealed ? "Hide" : "Reveal"}
          >
            {isRevealed ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={onCopy}
            disabled={busy || entry.empty}
            aria-label="Copy value"
            title="Copy"
          >
            <Copy className="size-4" />
          </Button>
          <Button variant="outline" size="sm" onClick={onEdit} disabled={busy}>
            Edit
          </Button>
          <Button variant="destructive" size="sm" onClick={onDelete} disabled={busy}>
            Remove
          </Button>
        </div>
      </td>
    </tr>
  );
}

function EditDialog({
  editing,
  onChange,
  onCancel,
  onSave,
}: {
  editing: EditState | null;
  onChange: (patch: Partial<EditState>) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const isNew = editing?.originalKey === null;
  const key = editing?.key ?? "";
  const trimmed = key.trim();
  const keyInvalid =
    !editing
      ? false
      : trimmed.length === 0 || !KEY_RE.test(trimmed) || trimmed.length > 64;
  const keyHelper = editing
    ? trimmed.length === 0
      ? "Key is required."
      : !KEY_RE.test(trimmed)
        ? "Key must match [A-Za-z_][A-Za-z0-9_]* — no spaces, hyphens, or leading digits."
        : trimmed.length > 64
          ? "Max 64 characters."
          : isNew
            ? "Will be added to .env."
            : trimmed === editing.originalKey
              ? "Value will be updated in place."
              : "Existing entry will be deleted, new key added."
    : "";

  return (
    <Dialog open={!!editing} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        {editing && (
          <>
            <DialogHeader>
              <DialogTitle>{isNew ? "Add credential" : `Edit ${editing.originalKey}`}</DialogTitle>
              <DialogDescription>
                Writes to <span className="font-mono">.env</span>. The runtime reloads
                credentials at boot — restart the agent after saving.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div className="space-y-1">
                <Label htmlFor="cred-key">Key</Label>
                <Input
                  id="cred-key"
                  value={editing.key}
                  onChange={(e) => onChange({ key: e.target.value })}
                  placeholder="ANTHROPIC_API_KEY"
                  autoFocus={isNew}
                  disabled={editing.saving}
                />
                <p className={`text-xs ${keyInvalid ? "text-amber-500" : "text-muted-foreground"}`}>
                  {keyHelper}
                </p>
              </div>
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <Label htmlFor="cred-value">Value</Label>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => onChange({ hidden: !editing.hidden })}
                    aria-label={editing.hidden ? "Show value" : "Hide value"}
                    title={editing.hidden ? "Show" : "Hide"}
                  >
                    {editing.hidden ? <Eye className="size-4" /> : <EyeOff className="size-4" />}
                  </Button>
                </div>
                <Input
                  id="cred-value"
                  type={editing.hidden ? "password" : "text"}
                  value={editing.value}
                  onChange={(e) => onChange({ value: e.target.value })}
                  placeholder="(empty)"
                  disabled={editing.saving}
                />
                <p className="text-xs text-muted-foreground">
                  {editing.value.length} char{editing.value.length === 1 ? "" : "s"}
                </p>
              </div>
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={onCancel} disabled={editing.saving}>
                Cancel
              </Button>
              <Button onClick={onSave} disabled={keyInvalid || editing.saving}>
                {editing.saving ? "Saving…" : isNew ? "Add" : "Save"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

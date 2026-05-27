import { useCallback, useEffect, useMemo, useState } from "react";
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
import { useConfirm } from "@/lib/confirm";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Plus } from "lucide-react";
import {
  createSkill,
  editSkill,
  installSkill,
  readSkillContent,
  removeSkill,
  resetSkill,
} from "@/lib/skills-api";
import type { InstalledSkillInfo } from "@/lib/types";

export function SkillsTab() {
  const { data, error, loading, refresh } = useDashboardContext();
  const { push } = useToast();
  const confirm = useConfirm();
  const [busyFolder, setBusyFolder] = useState<string | null>(null);
  const [editing, setEditing] = useState<EditState | null>(null);
  const [creating, setCreating] = useState<CreateState | null>(null);

  const skills = data?.skills;

  const handleRemove = useCallback(
    async (folder: string) => {
      if (busyFolder) return;
      const ok = await confirm({
        message: `Remove the skill "${folder}"? This deletes the agent's copy; the bundled template remains untouched.`,
        destructive: true,
      });
      if (!ok) return;
      setBusyFolder(folder);
      const res = await removeSkill(data?.csrfTokens ?? [], folder);
      push(res.ok ? "success" : "error", res.message || (res.ok ? "Removed." : "Failed."));
      await refresh();
      setBusyFolder(null);
    },
    [busyFolder, confirm, data, push, refresh],
  );

  const handleReset = useCallback(
    async (folder: string) => {
      if (busyFolder) return;
      const ok = await confirm({
        message: `Reset "${folder}" to its bundled version? Any operator edits will be discarded.`,
        destructive: true,
      });
      if (!ok) return;
      setBusyFolder(folder);
      const res = await resetSkill(data?.csrfTokens ?? [], folder);
      push(res.ok ? "success" : "error", res.message || (res.ok ? "Reset." : "Failed."));
      await refresh();
      setBusyFolder(null);
    },
    [busyFolder, confirm, data, push, refresh],
  );

  const handleInstall = useCallback(
    async (folder: string) => {
      if (busyFolder) return;
      setBusyFolder(folder);
      const res = await installSkill(data?.csrfTokens ?? [], folder);
      push(res.ok ? "success" : "error", res.message || (res.ok ? "Installed." : "Failed."));
      await refresh();
      setBusyFolder(null);
    },
    [busyFolder, data, push, refresh],
  );

  const openEditor = useCallback(async (skill: InstalledSkillInfo) => {
    try {
      const content = await readSkillContent(skill.folder);
      setEditing({ folder: skill.folder, original: content, draft: content, saving: false });
    } catch (err) {
      push("error", `Failed to load ${skill.folder}/SKILL.md: ${(err as Error).message}`);
    }
  }, [push]);

  const openCreate = useCallback(() => {
    setCreating({ folder: "", saving: false });
  }, []);

  const handleSaveCreate = useCallback(async () => {
    if (!creating) return;
    const folder = creating.folder.trim();
    if (!folder) {
      push("error", "Folder name is required.");
      return;
    }
    setCreating({ ...creating, saving: true });
    const res = await createSkill(data?.csrfTokens ?? [], folder);
    push(res.ok ? "success" : "error", res.message || (res.ok ? "Created." : "Failed."));
    if (res.ok) {
      setCreating(null);
      await refresh();
      // Auto-open the editor on the just-created skill so the operator can
      // immediately customize the starter template.
      try {
        const content = await readSkillContent(folder);
        setEditing({ folder, original: content, draft: content, saving: false });
      } catch {
        /* refresh already brought it into view; editor is optional */
      }
    } else {
      setCreating((prev) => (prev ? { ...prev, saving: false } : null));
    }
  }, [creating, data, push, refresh]);

  const handleSaveEdit = useCallback(async () => {
    if (!editing) return;
    setEditing({ ...editing, saving: true });
    const res = await editSkill(data?.csrfTokens ?? [], editing.folder, editing.draft);
    push(res.ok ? "success" : "error", res.message || (res.ok ? "Saved." : "Failed."));
    if (res.ok) {
      setEditing(null);
      await refresh();
    } else {
      setEditing((prev) => (prev ? { ...prev, saving: false } : null));
    }
  }, [editing, data, push, refresh]);

  if (loading && !data) return <Loading />;
  if (error && !data) return <ErrorPanel message={error} />;
  if (!skills) return null;

  return (
    <div className="space-y-8">
      <header className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Installed
          </h2>
          <p className="text-xs text-muted-foreground">
            {skills.installed.length === 0
              ? "No skills installed yet."
              : skills.skillsDir
                ? `Located at ${skills.skillsDir}`
                : `${skills.installed.length} installed`}
          </p>
        </div>
        <Button onClick={openCreate} size="sm">
          <Plus className="size-4" />
          New skill
        </Button>
      </header>

      <InstalledList
        skills={skills.installed}
        busyFolder={busyFolder}
        onEdit={openEditor}
        onReset={handleReset}
        onRemove={handleRemove}
      />

      <header className="space-y-1 pt-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Missing skills
        </h2>
        <p className="text-xs text-muted-foreground">
          Your agent has these augments mounted but their bundled teaching isn't on disk.
          Reinstall to teach the model about their tools. Normally{" "}
          <code className="font-mono text-[11px]">auggy create</code> /{" "}
          <code className="font-mono text-[11px]">auggy add</code> copies these automatically.
        </p>
      </header>

      <AvailableList
        items={skills.available}
        busyFolder={busyFolder}
        onInstall={handleInstall}
      />

      <EditDialog
        editing={editing}
        onChange={(draft) => setEditing((prev) => (prev ? { ...prev, draft } : null))}
        onCancel={() => setEditing(null)}
        onSave={handleSaveEdit}
      />

      <CreateDialog
        creating={creating}
        onChange={(folder) => setCreating((prev) => (prev ? { ...prev, folder } : null))}
        onCancel={() => setCreating(null)}
        onSave={handleSaveCreate}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

interface EditState {
  folder: string;
  original: string;
  draft: string;
  saving: boolean;
}

interface CreateState {
  folder: string;
  saving: boolean;
}

const FOLDER_NAME_RE = /^[A-Za-z0-9._-]+$/;

function CreateDialog({
  creating,
  onChange,
  onCancel,
  onSave,
}: {
  creating: CreateState | null;
  onChange: (folder: string) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const folder = creating?.folder ?? "";
  const trimmed = folder.trim();
  const invalid = trimmed.length === 0 || trimmed.length > 64 || !FOLDER_NAME_RE.test(trimmed);
  const helper = invalid
    ? trimmed.length === 0
      ? "Enter a folder name."
      : trimmed.length > 64
        ? "Max 64 characters."
        : "Letters, digits, dot/dash/underscore only — no spaces or slashes."
    : `Will be created at skills/${trimmed}/SKILL.md`;

  return (
    <Dialog open={!!creating} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        {creating && (
          <>
            <DialogHeader>
              <DialogTitle>New skill</DialogTitle>
              <DialogDescription>
                Creates a starter <code className="font-mono text-[11px]">SKILL.md</code> with
                valid frontmatter. The editor opens after create so you can customize the body.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Label htmlFor="new-skill-folder">Folder name</Label>
              <Input
                id="new-skill-folder"
                value={creating.folder}
                onChange={(e) => onChange(e.target.value)}
                placeholder="my-skill"
                autoFocus
                disabled={creating.saving}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !invalid && !creating.saving) {
                    e.preventDefault();
                    onSave();
                  }
                }}
              />
              <p className={`text-xs ${invalid ? "text-amber-500" : "text-muted-foreground"}`}>
                {helper}
              </p>
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={onCancel} disabled={creating.saving}>
                Cancel
              </Button>
              <Button onClick={onSave} disabled={invalid || creating.saving}>
                {creating.saving ? "Creating…" : "Create"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function InstalledList({
  skills,
  busyFolder,
  onEdit,
  onReset,
  onRemove,
}: {
  skills: InstalledSkillInfo[];
  busyFolder: string | null;
  onEdit: (s: InstalledSkillInfo) => void;
  onReset: (folder: string) => void;
  onRemove: (folder: string) => void;
}) {
  if (skills.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Nothing installed</CardTitle>
          <CardDescription>Install a bundled skill below to teach the agent.</CardDescription>
        </CardHeader>
      </Card>
    );
  }
  return (
    <div className="space-y-2">
      {skills.map((s) => (
        <Card key={s.folder}>
          <CardHeader className="p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-3">
                  <CardTitle className="font-mono text-sm">{s.folder}</CardTitle>
                  <SourceTag source={s.source} />
                  {!s.frontmatterValid && (
                    <span className="text-xs text-amber-500">frontmatter invalid</span>
                  )}
                </div>
                {s.description && (
                  <p className="mt-1 truncate text-xs text-muted-foreground">{s.description}</p>
                )}
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {(s.contentBytes / 1024).toFixed(1)} KiB
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busyFolder === s.folder}
                  onClick={() => onEdit(s)}
                >
                  Edit
                </Button>
                {s.source !== "manual" && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busyFolder === s.folder || s.source === "bundled"}
                    onClick={() => onReset(s.folder)}
                    title={
                      s.source === "bundled"
                        ? "Already matches bundled — nothing to reset."
                        : "Restore bundled version"
                    }
                  >
                    Reset
                  </Button>
                )}
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={busyFolder === s.folder}
                  onClick={() => onRemove(s.folder)}
                >
                  Remove
                </Button>
              </div>
            </div>
          </CardHeader>
        </Card>
      ))}
    </div>
  );
}

function AvailableList({
  items,
  busyFolder,
  onInstall,
}: {
  items: { folder: string; name: string | null; description: string | null; fromAugmentType: string }[];
  busyFolder: string | null;
  onInstall: (folder: string) => void;
}) {
  if (items.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">No gaps</CardTitle>
          <CardDescription>
            Every mounted augment has its bundled skill installed.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }
  return (
    <div className="space-y-2">
      {items.map((s) => (
        <Card key={s.folder}>
          <CardHeader className="p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-3">
                  <CardTitle className="font-mono text-sm">{s.folder}</CardTitle>
                  <span className="text-xs text-muted-foreground">
                    from {s.fromAugmentType}
                  </span>
                </div>
                {s.description && (
                  <p className="mt-1 truncate text-xs text-muted-foreground">{s.description}</p>
                )}
              </div>
              <Button
                size="sm"
                disabled={busyFolder === s.folder}
                onClick={() => onInstall(s.folder)}
              >
                Install
              </Button>
            </div>
          </CardHeader>
        </Card>
      ))}
    </div>
  );
}

function SourceTag({ source }: { source: InstalledSkillInfo["source"] }) {
  const label = source === "bundled" ? "bundled" : source === "modified" ? "modified" : "manual";
  const cls =
    source === "bundled"
      ? "text-emerald-500"
      : source === "modified"
        ? "text-amber-500"
        : "text-muted-foreground";
  return <span className={`text-[10px] uppercase tracking-wide ${cls}`}>{label}</span>;
}

function EditDialog({
  editing,
  onChange,
  onCancel,
  onSave,
}: {
  editing: EditState | null;
  onChange: (draft: string) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const dirty = useMemo(
    () => (editing ? editing.draft !== editing.original : false),
    [editing],
  );

  // Esc closes; Cmd/Ctrl+S saves.
  useEffect(() => {
    if (!editing) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        if (dirty && !editing.saving) onSave();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [editing, dirty, onSave]);

  return (
    <Dialog open={!!editing} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-w-3xl">
        {editing && (
          <>
            <DialogHeader>
              <DialogTitle className="font-mono">{editing.folder}/SKILL.md</DialogTitle>
              <DialogDescription>
                Edits write to the agent's copy. The bundled template is untouched — use Reset to
                restore it.
              </DialogDescription>
            </DialogHeader>
            <Textarea
              value={editing.draft}
              onChange={(e) => onChange(e.target.value)}
              className="min-h-[420px] font-mono text-xs"
              spellCheck={false}
            />
            <DialogFooter>
              <span className="mr-auto self-center text-xs text-muted-foreground">
                {dirty ? "unsaved changes · Cmd/Ctrl+S to save" : "no changes"}
              </span>
              <Button variant="ghost" onClick={onCancel} disabled={editing.saving}>
                Cancel
              </Button>
              <Button onClick={onSave} disabled={!dirty || editing.saving}>
                {editing.saving ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Loading() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Skills</CardTitle>
        <CardDescription>Loading…</CardDescription>
      </CardHeader>
    </Card>
  );
}

function ErrorPanel({ message }: { message: string }) {
  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <CardTitle className="text-destructive">Skills load failed</CardTitle>
        <CardDescription className="font-mono text-xs">{message}</CardDescription>
      </CardHeader>
    </Card>
  );
}

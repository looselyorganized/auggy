import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useActionDispatcher } from "./useActionDispatcher";
import type { AdminAction } from "@/lib/types";

export function ActionForm({ action }: { action: AdminAction }) {
  const { dispatch, busy } = useActionDispatcher();
  const inputs = action.inputs ?? [];
  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const inp of inputs) {
      initial[inp.name] = inp.default ?? (inp.type === "boolean" ? "false" : "");
    }
    return initial;
  });

  const hasInputs = inputs.length > 0;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await dispatch({
      actionId: action.id,
      values,
      confirmRequired: action.confirmRequired,
      confirmMessage: `Run "${action.label}"?`,
    });
  };

  return (
    <form
      onSubmit={onSubmit}
      className={hasInputs ? "flex flex-col gap-3" : "inline-flex"}
      aria-label={action.label}
    >
      {inputs.map((inp) => {
        const id = `${action.id}-${inp.name}`;
        if (inp.type === "boolean") {
          return (
            <div key={inp.name} className="flex items-center gap-2">
              <input
                id={id}
                type="checkbox"
                checked={values[inp.name] === "true"}
                onChange={(e) =>
                  setValues((v) => ({ ...v, [inp.name]: e.target.checked ? "true" : "false" }))
                }
                className="size-4 rounded border-input"
              />
              <Label htmlFor={id}>{inp.label}</Label>
              {inp.helpText && (
                <span className="text-xs text-muted-foreground">{inp.helpText}</span>
              )}
            </div>
          );
        }
        return (
          <div key={inp.name} className="flex flex-col gap-1">
            <Label htmlFor={id}>{inp.label}</Label>
            <Input
              id={id}
              type={inp.type === "number" ? "number" : "text"}
              required={inp.required}
              value={values[inp.name] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [inp.name]: e.target.value }))}
            />
            {inp.helpText && (
              <span className="text-xs text-muted-foreground">{inp.helpText}</span>
            )}
          </div>
        );
      })}
      <div className={hasInputs ? "" : ""}>
        <Button type="submit" disabled={busy} size="sm">
          {action.label}
        </Button>
      </div>
    </form>
  );
}

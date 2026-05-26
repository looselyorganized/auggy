import type { ReactNode } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

function Placeholder({ title, description, children }: { title: string; description: string; children?: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">
        {children ?? <p>Coming up next in the build.</p>}
      </CardContent>
    </Card>
  );
}

export const ChatTab = () => (
  <Placeholder
    title="Chat"
    description="Direct line to this agent — operator-flavored chrome."
  />
);

export const BudgetsTab = () => (
  <Placeholder
    title="Budget"
    description="Current spend per trust tier · cap-edit affordances. Backed by the budgets augment."
  />
);

// TracesTab kept as a stub for the Security route's temporary placeholder —
// Security tab build replaces it in task #24.
export const TracesTab = () => (
  <Placeholder
    title="Security"
    description="Auth posture + visitor list. Coming up next in the build."
  />
);

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


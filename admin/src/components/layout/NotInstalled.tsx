import { Link } from "react-router-dom";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export interface NotInstalledProps {
  tabLabel: string;
  /** Which augment type(s) the operator needs to install. */
  requires: string[];
}

/**
 * Rendered when an operator deep-links to a tab whose backing augment
 * isn't mounted. Per the spec's "Tab visibility" section: don't show
 * an empty form — explain the dependency and point at the Augments tab.
 */
export function NotInstalled({ tabLabel, requires }: NotInstalledProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{tabLabel} — not installed</CardTitle>
        <CardDescription>
          This tab is hidden because the backing augment isn't mounted on this agent.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p>
          Requires:{" "}
          {requires.map((t, i) => (
            <span key={t}>
              <code className="font-mono text-xs">{t}</code>
              {i < requires.length - 1 ? " or " : ""}
            </span>
          ))}
        </p>
        <p className="text-muted-foreground">
          Install via <code className="font-mono text-xs">auggy add</code>, or open the Augments
          tab to manage composition.
        </p>
        <Button asChild size="sm">
          <Link to="/augments">Go to Augments</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

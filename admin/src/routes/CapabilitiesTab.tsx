import { useMemo, useState } from "react";
import { CapabilityNavigation, CapabilitySummaryBar } from "@/components/capabilities/CapabilityNavigation";
import { CapabilityDetail } from "@/components/capabilities/CapabilitySurfaces";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useDashboardContext } from "@/components/admin/DashboardContext";
import { buildCapabilityModel } from "@/lib/capability-model";

export {
  buildConversationSurfaceRows,
  formatMemorySurfaceCapabilities,
} from "@/components/capabilities/CapabilitySurfaces";

export function CapabilitiesTab() {
  const { data, loading, error } = useDashboardContext();
  const [selectedAugmentName, setSelectedAugmentName] = useState<string | null>(null);
  const model = useMemo(
    () => (data ? buildCapabilityModel(data, { selectedAugmentName }) : null),
    [data, selectedAugmentName],
  );

  if (loading && !data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Capabilities</CardTitle>
          <CardDescription>Loading...</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (error && !data) {
    return (
      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle className="text-destructive">Capabilities load failed</CardTitle>
          <CardDescription className="font-mono text-xs">{error}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (!data || !model) return null;

  const selectedNode = model.scope.selectedAugmentName
    ? model.augmentNodes.find((node) => node.augment.name === model.scope.selectedAugmentName)
    : undefined;

  return (
    <div className="h-full w-full overflow-y-auto">
      <div className="mx-auto grid w-full max-w-6xl gap-4 p-3 sm:p-4">
        <section className="grid gap-3">
          <div>
            <h2 className="text-xl font-semibold tracking-normal">Capabilities</h2>
            <p className="text-sm text-muted-foreground">
              Runtime map of mounted augments and the surfaces they expose.
            </p>
          </div>
          <CapabilitySummaryBar model={model} />
        </section>

        <div className="grid min-h-0 gap-4 lg:grid-cols-[minmax(20rem,0.95fr)_minmax(0,1.45fr)]">
          <Card>
            <CardHeader className="pb-4">
              <CardTitle>Mounted augments</CardTitle>
              <CardDescription>Select an owner to scope the runtime map.</CardDescription>
            </CardHeader>
            <CardContent>
              <CapabilityNavigation model={model} onSelect={setSelectedAugmentName} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-4">
              <CardTitle>{selectedNode ? "Selected augment" : "All runtime capabilities"}</CardTitle>
              <CardDescription>
                {selectedNode
                  ? `Surfaces owned by ${selectedNode.augment.name}.`
                  : "Conversation, app routes, tools, memory, and access posture."}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <CapabilityDetail data={data} model={model} />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

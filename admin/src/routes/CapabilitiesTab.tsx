import { useMemo, useState } from "react";
import {
  CAPABILITY_DETAIL_ID,
  CapabilityMobileSelector,
  CapabilityNavigation,
  CapabilitySummaryBar,
} from "@/components/capabilities/CapabilityNavigation";
import { CapabilityDetail } from "@/components/capabilities/CapabilitySurfaces";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
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
      <div className="h-full w-full overflow-y-auto p-3 sm:p-4">
        <Card className="mx-auto max-w-6xl" role="status" aria-live="polite">
          <CardHeader>
            <h2 className="font-semibold leading-none">Capabilities</h2>
            <CardDescription>Loading...</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="h-full w-full overflow-y-auto p-3 sm:p-4">
        <Card
          className="mx-auto max-w-6xl border-destructive/40"
          role="alert"
        >
          <CardHeader>
            <h2 className="font-semibold leading-none text-destructive">
              Capabilities load failed
            </h2>
            <CardDescription className="break-words font-mono text-xs">{error}</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  if (!data || !model) return null;

  const selectedNode = model.scope.selectedAugmentName
    ? model.augmentNodes.find((node) => node.augment.name === model.scope.selectedAugmentName)
    : undefined;
  const scopeLabel = selectedNode
    ? `${selectedNode.augment.type}, runtime ${selectedNode.augment.name}`
    : "all runtime capabilities";

  return (
    <div className="h-full w-full overflow-y-auto">
      <div className="mx-auto grid w-full max-w-6xl gap-4 p-3 sm:p-4">
        <section className="grid gap-3">
          <div>
            <h2 className="text-xl font-semibold tracking-normal">Capabilities</h2>
            <p className="text-sm text-muted-foreground">
              Observed map of mounted augments and the surfaces reported by the runtime.
            </p>
          </div>
          <CapabilitySummaryBar model={model} />
          <CapabilityMobileSelector model={model} onSelect={setSelectedAugmentName} />
          <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
            Showing {scopeLabel}.
          </p>
        </section>

        <div className="grid min-h-0 min-w-0 gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
          <Card className="hidden self-start lg:sticky lg:top-4 lg:block lg:max-h-[calc(100dvh-6rem)] lg:overflow-y-auto">
            <CardHeader className="pb-4">
              <h3 className="font-semibold leading-none">Mounted augments</h3>
              <CardDescription>Select an owner to scope the runtime map.</CardDescription>
            </CardHeader>
            <CardContent>
              <CapabilityNavigation model={model} onSelect={setSelectedAugmentName} />
            </CardContent>
          </Card>

          <Card id={CAPABILITY_DETAIL_ID} className="min-w-0 scroll-mt-4">
            <CardHeader className="pb-4">
              <h3 className="font-semibold leading-none">
                {selectedNode ? "Selected augment" : "All runtime capabilities"}
              </h3>
              <CardDescription>
                {selectedNode
                  ? `Surfaces owned by ${selectedNode.augment.name}.`
                  : "Conversation, app routes, tools, skills, memory, and access posture."}
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

import { resolve } from "node:path";
import type { InspectionReport } from "../authoring/contracts";
import type { InspectCommandOptions } from "../authoring-command-options";
import {
  buildInspectionReport,
  createInvalidInspectionReport,
  renderInspectionReport,
} from "../authoring/inspection";
import { selectInspectionDocument } from "../authoring/inspection-selection";

export function runInspect(name: string | undefined, options: InspectCommandOptions): number {
  let report: InspectionReport;
  try {
    report = buildInspectionReport(selectInspectionDocument(name, options.config));
  } catch (error) {
    report = createInvalidInspectionReport(
      options.config ? resolve(options.config) : resolve("agent.yaml"),
      error,
    );
  }
  console.log(options.json ? JSON.stringify(report) : renderInspectionReport(report));
  return report.status === "invalid" ? 1 : 0;
}

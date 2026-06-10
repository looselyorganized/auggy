import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { CreateLeadInput, ServiceSearchQuery } from "./schemas";

export interface ConciergeService {
  id: string;
  name: string;
  summary: string;
  tags: string[];
  startingAtUsd: number;
}

export interface LeadRecord extends CreateLeadInput {
  id: string;
  createdAt: string;
  highIntent: boolean;
}

const SERVICES: ConciergeService[] = [
  {
    id: "curated-gifting",
    name: "Curated Gifting",
    summary: "Personalized gift packages for birthdays, thank-yous, client gifts, and small events.",
    tags: ["gift", "birthday", "client", "thank-you", "package"],
    startingAtUsd: 150,
  },
  {
    id: "home-refresh",
    name: "Home Refresh",
    summary: "Small-space styling and sourcing help for shelves, entryways, offices, and guest rooms.",
    tags: ["home", "styling", "decor", "room", "sourcing"],
    startingAtUsd: 300,
  },
  {
    id: "event-touches",
    name: "Event Touches",
    summary: "Finishing details for intimate dinners, launches, showers, and hosted gatherings.",
    tags: ["event", "dinner", "launch", "party", "hosting"],
    startingAtUsd: 450,
  },
];

export function searchServices(query: ServiceSearchQuery = {}): ConciergeService[] {
  const terms = [query.need, query.tag].filter(Boolean).join(" ").toLowerCase();
  const maxBudgetUsd = query.maxBudgetUsd;

  return SERVICES.filter((service) => {
    if (maxBudgetUsd !== undefined && service.startingAtUsd > maxBudgetUsd) return false;
    if (!terms) return true;
    const haystack = [service.name, service.summary, ...service.tags].join(" ").toLowerCase();
    return terms
      .split(/\s+/)
      .filter(Boolean)
      .some((term) => haystack.includes(term));
  });
}

export function saveLead(input: CreateLeadInput, opts: { leadsPath: string }): LeadRecord {
  const record: LeadRecord = {
    ...input,
    id: `lead_${crypto.randomUUID()}`,
    createdAt: new Date().toISOString(),
    highIntent: isHighIntent(input),
  };

  mkdirSync(dirname(opts.leadsPath), { recursive: true });
  appendFileSync(opts.leadsPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  return record;
}

function isHighIntent(input: CreateLeadInput): boolean {
  const timeline = input.timeline?.toLowerCase() ?? "";
  const notes = input.notes?.toLowerCase() ?? "";
  return (
    (input.budgetUsd ?? 0) >= 500 ||
    timeline.includes("today") ||
    timeline.includes("tomorrow") ||
    timeline.includes("this week") ||
    notes.includes("quote") ||
    notes.includes("book")
  );
}

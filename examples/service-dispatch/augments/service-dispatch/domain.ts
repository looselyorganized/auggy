import type {
  Appointment,
  AppointmentHold,
  CreateIntakeInput,
  Intake,
  Service,
  Slot,
} from "./schemas";

export class DispatchError extends Error {
  constructor(
    readonly code:
      | "outside_service_area"
      | "intake_not_found"
      | "slot_not_found"
      | "hold_not_found"
      | "hold_forbidden"
      | "hold_expired",
    message: string,
  ) {
    super(message);
  }
}

export interface DispatchActor {
  key: string;
  id: string;
}

const SERVICES: readonly Service[] = [
  {
    id: "heating-repair",
    name: "Heating repair",
    summary: "Diagnosis and repair for furnaces, heat pumps, and thermostats.",
    startingAtUsd: 189,
    durationMinutes: 90,
  },
  {
    id: "plumbing-repair",
    name: "Plumbing repair",
    summary: "Leaks, blocked fixtures, failed valves, and common residential plumbing problems.",
    startingAtUsd: 169,
    durationMinutes: 90,
  },
  {
    id: "appliance-repair",
    name: "Appliance repair",
    summary: "Diagnosis for washers, dryers, dishwashers, and refrigerators.",
    startingAtUsd: 149,
    durationMinutes: 60,
  },
];

const SLOTS: readonly Slot[] = [
  { id: "slot-heat-1", serviceId: "heating-repair", startsAt: "2026-07-22T16:00:00.000Z", endsAt: "2026-07-22T17:30:00.000Z" },
  { id: "slot-heat-2", serviceId: "heating-repair", startsAt: "2026-07-23T18:00:00.000Z", endsAt: "2026-07-23T19:30:00.000Z" },
  { id: "slot-plumb-1", serviceId: "plumbing-repair", startsAt: "2026-07-22T19:00:00.000Z", endsAt: "2026-07-22T20:30:00.000Z" },
  { id: "slot-appliance-1", serviceId: "appliance-repair", startsAt: "2026-07-24T17:00:00.000Z", endsAt: "2026-07-24T18:00:00.000Z" },
];

export class ServiceDispatch {
  private readonly intakes = new Map<string, Intake>();
  private readonly holds = new Map<string, AppointmentHold & { actorKey: string }>();

  constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = () => crypto.randomUUID(),
    private readonly holdTtlMs = 15 * 60 * 1000,
  ) {
    if (!Number.isSafeInteger(holdTtlMs) || holdTtlMs <= 0) {
      throw new Error("service-dispatch: holdTtlMs must be a positive integer");
    }
  }

  listServices(): Service[] {
    return SERVICES.map((service) => ({ ...service }));
  }

  checkCoverage(postalCode: string): { covered: boolean; normalizedPostalCode: string; area?: string } {
    const normalizedPostalCode = postalCode.toUpperCase().replace(/\s+/g, "");
    const prefix = normalizedPostalCode.slice(0, 3);
    const areas: Record<string, string> = {
      V5K: "East Vancouver",
      V5M: "East Vancouver",
      V6B: "Downtown Vancouver",
      V6E: "West End",
      V7J: "North Vancouver",
      V7L: "North Vancouver",
      V7M: "North Vancouver",
    };
    const area = areas[prefix];
    return { covered: area !== undefined, normalizedPostalCode, ...(area ? { area } : {}) };
  }

  createIntake(input: CreateIntakeInput): Intake {
    const coverage = this.checkCoverage(input.postalCode);
    if (!coverage.covered) {
      throw new DispatchError("outside_service_area", "That postal code is outside the demo service area.");
    }
    const serviceId = classifyService(input.issue);
    const urgency = classifyUrgency(input.issue);
    const intake: Intake = {
      id: `intake_${this.createId()}`,
      ...input,
      postalCode: coverage.normalizedPostalCode,
      serviceId,
      urgency,
      status: "new",
      escalationRecommended: urgency !== "routine",
      createdAt: this.now().toISOString(),
    };
    this.intakes.set(intake.id, intake);
    return intake;
  }

  findSlots(serviceId: string): Slot[] {
    return SLOTS.filter((slot) => slot.serviceId === serviceId).map((slot) => ({ ...slot }));
  }

  holdAppointment(actor: DispatchActor, input: { intakeId: string; slotId: string }): AppointmentHold {
    const intake = this.intakes.get(input.intakeId);
    if (!intake) throw new DispatchError("intake_not_found", "Service intake not found.");
    const slot = SLOTS.find((candidate) => candidate.id === input.slotId);
    if (!slot || slot.serviceId !== intake.serviceId) {
      throw new DispatchError("slot_not_found", "That slot is not available for this service.");
    }
    const hold: AppointmentHold & { actorKey: string } = {
      id: `hold_${this.createId()}`,
      intakeId: intake.id,
      slot: { ...slot },
      status: "held",
      expiresAt: new Date(this.now().getTime() + this.holdTtlMs).toISOString(),
      actorKey: actor.key,
    };
    this.holds.set(hold.id, hold);
    const { actorKey: _actorKey, ...publicHold } = hold;
    return publicHold;
  }

  confirmAppointment(actor: DispatchActor, holdId: string): Appointment {
    const hold = this.holds.get(holdId);
    if (!hold) throw new DispatchError("hold_not_found", "Appointment hold not found.");
    if (hold.actorKey !== actor.key) {
      throw new DispatchError("hold_forbidden", "That appointment hold belongs to another visitor.");
    }
    if (this.now().getTime() >= Date.parse(hold.expiresAt)) {
      this.holds.delete(hold.id);
      throw new DispatchError("hold_expired", "The appointment hold expired.");
    }
    this.holds.delete(hold.id);
    return {
      id: `appointment_${this.createId()}`,
      intakeId: hold.intakeId,
      slot: hold.slot,
      status: "confirmed",
      confirmedAt: this.now().toISOString(),
    };
  }
}

function classifyService(issue: string): string {
  const normalized = issue.toLowerCase();
  if (/furnace|heat pump|thermostat|no heat|heating/.test(normalized)) return "heating-repair";
  if (/leak|pipe|drain|toilet|faucet|water/.test(normalized)) return "plumbing-repair";
  return "appliance-repair";
}

function classifyUrgency(issue: string): Intake["urgency"] {
  const normalized = issue.toLowerCase();
  if (/gas smell|smoke|fire|carbon monoxide|sparking|immediate danger/.test(normalized)) {
    return "emergency";
  }
  if (/no heat|active leak|flood|burst pipe|refrigerator.*warm/.test(normalized)) {
    return "urgent";
  }
  return "routine";
}

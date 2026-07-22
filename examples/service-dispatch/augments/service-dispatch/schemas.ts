import { z } from "zod";

export const ServiceSchema = z.object({
  id: z.string(),
  name: z.string(),
  summary: z.string(),
  startingAtUsd: z.number(),
  durationMinutes: z.number().int(),
});

export const ServicesResponseSchema = z.object({ services: z.array(ServiceSchema) });

export const CoverageQuerySchema = z.object({
  postalCode: z.string().trim().min(3).max(10),
});

export const CoverageResponseSchema = z.object({
  covered: z.boolean(),
  normalizedPostalCode: z.string(),
  area: z.string().optional(),
});

export const CreateIntakeSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().email().optional(),
  postalCode: z.string().trim().min(3).max(10),
  issue: z.string().trim().min(10).max(2_000),
  preferredWindow: z.string().trim().max(120).optional(),
});

export const IntakeSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().optional(),
  postalCode: z.string(),
  issue: z.string(),
  preferredWindow: z.string().optional(),
  serviceId: z.string(),
  urgency: z.enum(["routine", "urgent", "emergency"]),
  status: z.literal("new"),
  escalationRecommended: z.boolean(),
  createdAt: z.string(),
});

export const IntakeResponseSchema = z.object({ intake: IntakeSchema });

export const AvailabilityQuerySchema = z.object({
  serviceId: z.string().trim().min(1),
});

export const SlotSchema = z.object({
  id: z.string(),
  serviceId: z.string(),
  startsAt: z.string(),
  endsAt: z.string(),
});

export const AvailabilityResponseSchema = z.object({ slots: z.array(SlotSchema) });

export const HoldAppointmentSchema = z.object({
  intakeId: z.string().trim().min(1),
  slotId: z.string().trim().min(1),
});

export const AppointmentHoldSchema = z.object({
  id: z.string(),
  intakeId: z.string(),
  slot: SlotSchema,
  status: z.literal("held"),
  expiresAt: z.string(),
});

export const AppointmentHoldResponseSchema = z.object({ hold: AppointmentHoldSchema });
export const AppointmentParamsSchema = z.object({ id: z.string().trim().min(1) });

export const AppointmentSchema = z.object({
  id: z.string(),
  intakeId: z.string(),
  slot: SlotSchema,
  status: z.literal("confirmed"),
  confirmedAt: z.string(),
});

export const AppointmentResponseSchema = z.object({ appointment: AppointmentSchema });

export type CreateIntakeInput = z.infer<typeof CreateIntakeSchema>;
export type Intake = z.infer<typeof IntakeSchema>;
export type Service = z.infer<typeof ServiceSchema>;
export type Slot = z.infer<typeof SlotSchema>;
export type AppointmentHold = z.infer<typeof AppointmentHoldSchema>;
export type Appointment = z.infer<typeof AppointmentSchema>;

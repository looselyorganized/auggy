import { z } from "zod";

export const ServiceSearchQuerySchema = z.object({
  need: z.string().trim().min(1).optional(),
  tag: z.string().trim().min(1).optional(),
  maxBudgetUsd: z.coerce.number().positive().optional(),
});

export const CreateLeadSchema = z.object({
  name: z.string().trim().min(1),
  email: z.string().trim().email().optional(),
  phone: z.string().trim().min(7).optional(),
  need: z.string().trim().min(1),
  serviceId: z.string().trim().min(1).optional(),
  timeline: z.string().trim().min(1).optional(),
  budgetUsd: z.coerce.number().positive().optional(),
  notes: z.string().trim().max(1000).optional(),
});

export type ServiceSearchQuery = z.infer<typeof ServiceSearchQuerySchema>;
export type CreateLeadInput = z.infer<typeof CreateLeadSchema>;

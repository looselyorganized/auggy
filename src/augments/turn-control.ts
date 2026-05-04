import { z } from "zod";
import type { Augment, ToolResult } from "../types";
import { defineAugment, defineTool } from "../helpers";

/**
 * turnControl augment — turn-lifecycle directive tools.
 *
 * v1 ships one tool: `request_input(prompt)`. The model calls it when it
 * needs an answer to proceed; the kernel ends the turn with status
 * `input-required` and the prompt becomes the user-visible reply.
 *
 * Future tools (deferred): `defer(eta)`, `escalate(level)`. The augment
 * seam is reserved so adding them does not require kernel changes.
 */
export interface TurnControlOptions {
  /**
   * Override the request_input tool description if the operator wants to
   * constrain or expand when the model should call it. Default text tells
   * the model to ask only when blocked on missing user input, not as a
   * closing pleasantry.
   */
  requestInputDescription?: string;
}

const DEFAULT_REQUEST_INPUT_DESCRIPTION =
  "Pause this turn and ask the user for more information. " +
  "Use this when you need an answer to proceed and cannot reasonably guess. " +
  "The `prompt` argument is shown to the user as your reply; the conversation " +
  "resumes on their next message. The turn ends with status 'input-required'. " +
  "Do not use this as a closing pleasantry — only when you are actually blocked on missing input.";

export function turnControl(opts: TurnControlOptions = {}): Augment {
  const requestInput = defineTool({
    name: "request_input",
    description: opts.requestInputDescription ?? DEFAULT_REQUEST_INPUT_DESCRIPTION,
    category: "meta",
    input: z.object({
      prompt: z
        .string()
        .min(1)
        .describe(
          "The question or prompt shown to the user. Becomes the assistant's visible reply.",
        ),
      reason: z
        .string()
        .optional()
        .describe("Optional internal note for tracing. Not shown to the user."),
    }),
    execute: async ({ prompt }): Promise<ToolResult> => ({
      content: prompt,
      terminate: { status: "input-required", message: prompt },
    }),
  });

  return defineAugment({
    name: "turnControl",
    capabilities: ["tools"],
    tools: [requestInput],
  });
}

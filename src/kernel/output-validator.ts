export interface OutputValidationResult {
  flagged: boolean;
  reasons: string[];
}

export function validateOutput(
  response: string,
  sensitivePatterns: string[],
): OutputValidationResult {
  const reasons: string[] = [];

  for (const pattern of sensitivePatterns) {
    if (response.includes(pattern)) {
      reasons.push(`Response contains sensitive pattern: "${pattern.slice(0, 50)}..."`);
    }
  }

  // Check for common system prompt leak indicators
  const leakIndicators = [
    "[AUGMENT CONTEXT:",
    "You are an agent managed by the Auggy runtime",
    "PEER-DERIVED",
  ];

  for (const indicator of leakIndicators) {
    if (response.includes(indicator)) {
      reasons.push(`Response contains system context marker: "${indicator}"`);
    }
  }

  return {
    flagged: reasons.length > 0,
    reasons,
  };
}

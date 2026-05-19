import type { Grader } from "../types";

function normalize(s: string, caseSensitive?: boolean): string {
  return caseSensitive ? s : s.toLowerCase();
}

export const responseContains: Grader = (spec, input) => {
  if (spec.type !== "response_contains") {
    return { type: spec.type, passed: false, reason: "grader mismatch" };
  }
  const haystack = normalize(input.responseText, spec.caseSensitive);
  const needle = normalize(spec.text, spec.caseSensitive);
  const contains = haystack.includes(needle);
  return {
    type: "response_contains",
    passed: contains,
    reason: contains ? undefined : `response missing required text: ${JSON.stringify(spec.text)}`,
  };
};

export const responseDoesNotContain: Grader = (spec, input) => {
  if (spec.type !== "response_does_not_contain") {
    return { type: spec.type, passed: false, reason: "grader mismatch" };
  }
  const haystack = normalize(input.responseText, spec.caseSensitive);
  const needle = normalize(spec.text, spec.caseSensitive);
  const contains = haystack.includes(needle);
  return {
    type: "response_does_not_contain",
    passed: !contains,
    reason: contains ? `response contained forbidden text: ${JSON.stringify(spec.text)}` : undefined,
  };
};

export const responseContainsAny: Grader = (spec, input) => {
  if (spec.type !== "response_contains_any") {
    return { type: spec.type, passed: false, reason: "grader mismatch" };
  }
  const haystack = normalize(input.responseText, spec.caseSensitive);
  for (const text of spec.texts) {
    if (haystack.includes(normalize(text, spec.caseSensitive))) {
      return { type: "response_contains_any", passed: true, matched: text };
    }
  }
  return {
    type: "response_contains_any",
    passed: false,
    matched: null,
    reason: `response contained none of the expected texts`,
  };
};

export const responseDoesNotContainAny: Grader = (spec, input) => {
  if (spec.type !== "response_does_not_contain_any") {
    return { type: spec.type, passed: false, reason: "grader mismatch" };
  }
  const haystack = normalize(input.responseText, spec.caseSensitive);
  for (const text of spec.texts) {
    if (haystack.includes(normalize(text, spec.caseSensitive))) {
      return {
        type: "response_does_not_contain_any",
        passed: false,
        matched: text,
        reason: `response contained forbidden text: ${JSON.stringify(text)}`,
      };
    }
  }
  return { type: "response_does_not_contain_any", passed: true, matched: null };
};

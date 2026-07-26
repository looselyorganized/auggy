/**
 * A deliberately small cron dialect for durable schedules. It only accepts five
 * numeric UTC fields: minute, hour, day of month, month, and day of week.
 */
export const MAX_CRON_EXPRESSION_BYTES = 256;

const MAX_FIELD_BYTES = 96;
const MAX_FIELD_TERMS = 32;
const MAX_FIELD_EXPANSION = 128;
const MAX_SEARCH_YEARS = 8;
const MAX_SEARCH_STEPS = 20_000;

type FieldName = "minute" | "hour" | "dayOfMonth" | "month" | "dayOfWeek";

interface CronField {
  readonly values: readonly number[];
  readonly wildcard: boolean;
}

export interface UtcCron {
  readonly minute: CronField;
  readonly hour: CronField;
  readonly dayOfMonth: CronField;
  readonly month: CronField;
  readonly dayOfWeek: CronField;
}

interface FieldDefinition {
  readonly name: FieldName;
  readonly minimum: number;
  readonly maximum: number;
  readonly normalize?: (value: number) => number;
}

const FIELD_DEFINITIONS: readonly FieldDefinition[] = [
  { name: "minute", minimum: 0, maximum: 59 },
  { name: "hour", minimum: 0, maximum: 23 },
  { name: "dayOfMonth", minimum: 1, maximum: 31 },
  { name: "month", minimum: 1, maximum: 12 },
  {
    name: "dayOfWeek",
    minimum: 0,
    maximum: 7,
    normalize: (value) => (value === 7 ? 0 : value),
  },
];

/** Parse a bounded, numeric, five-field UTC cron expression. */
export function parseUtcCron(expression: string): UtcCron {
  if (byteLength(expression) > MAX_CRON_EXPRESSION_BYTES) {
    throw new Error(`Cron expression exceeds ${MAX_CRON_EXPRESSION_BYTES} bytes.`);
  }
  if (!/^[0-9*,/\- ]+$/.test(expression)) {
    throw new Error("Cron expressions may only contain numeric five-field syntax.");
  }

  const tokens = expression.split(" ");
  if (tokens.length !== FIELD_DEFINITIONS.length || tokens.some((token) => token.length === 0)) {
    throw new Error("A cron expression must contain exactly five space-separated fields.");
  }

  const fields = FIELD_DEFINITIONS.map((definition, index) =>
    parseField(tokens[index]!, definition),
  );

  return Object.freeze({
    minute: fields[0]!,
    hour: fields[1]!,
    dayOfMonth: fields[2]!,
    month: fields[3]!,
    dayOfWeek: fields[4]!,
  });
}

/**
 * Return the first matching UTC minute after the input minute. A result never
 * represents the minute containing `after`, even if that minute matches.
 */
export function nextUtcCron(cronOrExpression: UtcCron | string, after: Date): Date | null {
  if (!Number.isFinite(after.getTime())) {
    throw new Error("Cron calculation requires a valid clock value.");
  }

  const cron =
    typeof cronOrExpression === "string" ? parseUtcCron(cronOrExpression) : cronOrExpression;
  let candidate = firstMinuteAfter(after);
  const finalYear = candidate.getUTCFullYear() + MAX_SEARCH_YEARS;

  for (let step = 0; step < MAX_SEARCH_STEPS; step += 1) {
    if (!Number.isFinite(candidate.getTime()) || candidate.getUTCFullYear() > finalYear) {
      return null;
    }

    const month = candidate.getUTCMonth() + 1;
    if (!includes(cron.month, month)) {
      candidate = advanceMonth(candidate, cron.month);
      continue;
    }

    if (!matchesDay(cron, candidate)) {
      candidate = startNextDay(candidate);
      continue;
    }

    const nextHour = nextValue(cron.hour.values, candidate.getUTCHours());
    if (nextHour === null) {
      candidate = startNextDay(candidate);
      continue;
    }
    if (nextHour !== candidate.getUTCHours()) {
      candidate.setUTCHours(nextHour, 0, 0, 0);
      continue;
    }

    const nextMinute = nextValue(cron.minute.values, candidate.getUTCMinutes());
    if (nextMinute === null) {
      candidate = startNextHour(candidate);
      continue;
    }
    if (nextMinute !== candidate.getUTCMinutes()) {
      candidate.setUTCMinutes(nextMinute, 0, 0);
      continue;
    }

    return candidate;
  }

  return null;
}

function parseField(token: string, definition: FieldDefinition): CronField {
  if (byteLength(token) > MAX_FIELD_BYTES) {
    throw new Error(`${definition.name} field exceeds ${MAX_FIELD_BYTES} bytes.`);
  }

  const terms = token.split(",");
  if (terms.length > MAX_FIELD_TERMS || terms.some((term) => term.length === 0)) {
    throw new Error(`${definition.name} has too many or empty list terms.`);
  }

  const values = new Set<number>();
  let expansion = 0;
  for (const term of terms) {
    const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(term);
    if (!match) {
      throw new Error(`Invalid ${definition.name} field term: ${term}.`);
    }

    const base = match[1]!;
    const stepText = match[2];
    if (stepText !== undefined && base !== "*" && !base.includes("-")) {
      throw new Error(`${definition.name} steps require a wildcard or range base.`);
    }
    const step = stepText === undefined ? 1 : parsePositiveInteger(stepText, definition.name);
    const [start, end] = parseRange(base, definition);
    if (step > end - start + 1) {
      throw new Error(`${definition.name} step exceeds its range.`);
    }

    for (let value = start; value <= end; value += step) {
      expansion += 1;
      if (expansion > MAX_FIELD_EXPANSION) {
        throw new Error(`${definition.name} expands beyond ${MAX_FIELD_EXPANSION} values.`);
      }
      values.add(definition.normalize?.(value) ?? value);
    }
  }

  return Object.freeze({
    values: Object.freeze([...values].sort((left, right) => left - right)),
    wildcard: token === "*",
  });
}

function parseRange(base: string, definition: FieldDefinition): readonly [number, number] {
  if (base === "*") {
    return [definition.minimum, definition.maximum];
  }

  const range = base.split("-");
  const start = parseBoundedInteger(range[0]!, definition);
  const end = range.length === 1 ? start : parseBoundedInteger(range[1]!, definition);
  if (start > end) {
    throw new Error(`${definition.name} range must not be reversed.`);
  }
  return [start, end];
}

function parseBoundedInteger(value: string, definition: FieldDefinition): number {
  const number = parseInteger(value, definition.name);
  if (number < definition.minimum || number > definition.maximum) {
    throw new Error(
      `${definition.name} must be between ${definition.minimum} and ${definition.maximum}.`,
    );
  }
  return number;
}

function parsePositiveInteger(value: string, name: FieldName): number {
  const number = parseInteger(value, name);
  if (number < 1) {
    throw new Error(`${name} step must be positive.`);
  }
  return number;
}

function parseInteger(value: string, name: FieldName): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new Error(`${name} contains an unsafe integer.`);
  }
  return number;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function firstMinuteAfter(after: Date): Date {
  const result = new Date(after.getTime());
  result.setUTCSeconds(0, 0);
  result.setUTCMinutes(result.getUTCMinutes() + 1);
  return result;
}

function includes(field: CronField, value: number): boolean {
  return field.values.includes(value);
}

function matchesDay(cron: UtcCron, candidate: Date): boolean {
  const dayOfMonthMatches = includes(cron.dayOfMonth, candidate.getUTCDate());
  const dayOfWeekMatches = includes(cron.dayOfWeek, candidate.getUTCDay());

  if (cron.dayOfMonth.wildcard) {
    return cron.dayOfWeek.wildcard || dayOfWeekMatches;
  }
  if (cron.dayOfWeek.wildcard) {
    return dayOfMonthMatches;
  }
  return dayOfMonthMatches || dayOfWeekMatches;
}

function nextValue(values: readonly number[], current: number): number | null {
  for (const value of values) {
    if (value >= current) {
      return value;
    }
  }
  return null;
}

function advanceMonth(candidate: Date, month: CronField): Date {
  const currentMonth = candidate.getUTCMonth() + 1;
  const nextMonth = month.values.find((value) => value > currentMonth);
  if (nextMonth === undefined) {
    return startOfMonth(candidate, candidate.getUTCFullYear() + 1, month.values[0]! - 1);
  }
  return startOfMonth(candidate, candidate.getUTCFullYear(), nextMonth - 1);
}

function startOfMonth(candidate: Date, year: number, month: number): Date {
  const result = new Date(candidate.getTime());
  result.setUTCFullYear(year, month, 1);
  result.setUTCHours(0, 0, 0, 0);
  return result;
}

function startNextDay(candidate: Date): Date {
  const result = new Date(candidate.getTime());
  result.setUTCDate(result.getUTCDate() + 1);
  result.setUTCHours(0, 0, 0, 0);
  return result;
}

function startNextHour(candidate: Date): Date {
  const result = new Date(candidate.getTime());
  result.setUTCHours(result.getUTCHours() + 1, 0, 0, 0);
  return result;
}

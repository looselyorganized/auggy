/**
 * Minimal in-memory mock of the Supabase client interface that
 * supabaseMemory uses. Good enough for unit tests without touching a
 * real Supabase instance.
 */
export interface MockRow {
  label: string;
  content: string;
  metadata?: Record<string, unknown>;
  created_at: string;
  [key: string]: unknown;
}

export interface MockSupabaseClient {
  _rows: Map<string, MockRow[]>;
  from(table: string): MockQueryBuilder;
}

export interface MockQueryBuilder {
  insert(row: MockRow | MockRow[]): Promise<{ error: Error | null }>;
  select(columns?: string): MockQueryBuilder;
  delete(): MockQueryBuilder;
  update(patch: Record<string, unknown>): MockQueryBuilder;
  eq(column: string, value: unknown): MockQueryBuilder;
  is(column: string, value: null): MockQueryBuilder;
  gt(column: string, value: number): MockQueryBuilder;
  or(filterExpr: string): MockQueryBuilder;
  like(column: string, value: string): MockQueryBuilder;
  ilike(column: string, value: string): MockQueryBuilder;
  order(column: string, opts?: { ascending?: boolean }): MockQueryBuilder;
  limit(n: number): MockQueryBuilder;
  maybeSingle(): Promise<{ data: MockRow | null; error: Error | null }>;
  then<TResult1 = { data: unknown[]; error: Error | null }, TResult2 = never>(
    onfulfilled?:
      | ((value: { data: unknown[]; error: Error | null }) => TResult1 | PromiseLike<TResult1>)
      | null
      | undefined,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null | undefined,
  ): PromiseLike<TResult1 | TResult2>;
}

export function createMockSupabase(): MockSupabaseClient {
  const rows = new Map<string, MockRow[]>();

  const client: MockSupabaseClient = {
    _rows: rows,
    from(table: string): MockQueryBuilder {
      if (!rows.has(table)) rows.set(table, []);
      return makeBuilder(table);
    },
  };

  function makeBuilder(table: string): MockQueryBuilder {
    const filters: Array<(r: MockRow) => boolean> = [];
    let orderBy: { column: string; ascending: boolean } | null = null;
    let limitN: number | null = null;
    let mode: "select" | "delete" | "update" = "select";
    let updatePatch: Record<string, unknown> = {};
    let selectedColumns: string[] | null = null;

    function addLikeFilter(column: string, value: string, insensitive: boolean): void {
      let source = "^";
      for (let i = 0; i < value.length; i++) {
        const char = value[i]!;
        if (char === "\\" && i + 1 < value.length) {
          i++;
          source += value[i]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        } else if (char === "%") {
          source += ".*";
        } else if (char === "_") {
          source += ".";
        } else {
          source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        }
      }
      const pattern = new RegExp(`${source}$`, insensitive ? "i" : "");
      filters.push((row) => {
        const candidate = (row as Record<string, unknown>)[column];
        return typeof candidate === "string" && pattern.test(candidate);
      });
    }

    const builder: MockQueryBuilder = {
      async insert(row) {
        const arr = Array.isArray(row) ? row : [row];
        rows.get(table)!.push(...arr);
        return { error: null };
      },
      select(columns) {
        mode = "select";
        selectedColumns =
          columns
            ?.split(",")
            .map((column) => column.trim())
            .filter(Boolean) ?? null;
        return builder;
      },
      delete() {
        mode = "delete";
        return builder;
      },
      update(patch) {
        mode = "update";
        updatePatch = patch;
        return builder;
      },
      eq(column, value) {
        filters.push((r) => (r as Record<string, unknown>)[column] === value);
        return builder;
      },
      is(column, value) {
        filters.push((r) => (r as Record<string, unknown>)[column] === value);
        return builder;
      },
      gt(column, value) {
        filters.push((r) => {
          const v = (r as Record<string, unknown>)[column];
          return typeof v === "number" && v > value;
        });
        return builder;
      },
      or(filterExpr) {
        // Minimal PostgREST-or parser. Supports the shapes layeredMemory
        // sends: "col.is.null,col.gte.<number>". Splits on top-level
        // commas, parses each "col.op.value" clause, and matches if any
        // clause holds. Wider grammars are out of scope for this mock.
        const clauses = filterExpr.split(",").map((c) => c.trim());
        const predicates = clauses.map((clause) => {
          const parts = clause.split(".");
          const col = parts[0]!;
          const op = parts[1]!;
          const rest = parts.slice(2).join(".");
          return (r: MockRow): boolean => {
            const v = (r as Record<string, unknown>)[col];
            if (op === "is" && rest === "null") return v === null;
            if (op === "gte") {
              const n = Number(rest);
              return typeof v === "number" && v >= n;
            }
            if (op === "lt") {
              const n = Number(rest);
              return typeof v === "number" && v < n;
            }
            return false;
          };
        });
        filters.push((r) => predicates.some((p) => p(r)));
        return builder;
      },
      like(column, value) {
        addLikeFilter(column, value, false);
        return builder;
      },
      ilike(column, value) {
        addLikeFilter(column, value, true);
        return builder;
      },
      order(column, opts) {
        orderBy = { column, ascending: opts?.ascending ?? true };
        return builder;
      },
      limit(n) {
        limitN = n;
        return builder;
      },
      async maybeSingle() {
        const result = await builder.then((v) => v);
        const first = (result.data as MockRow[])[0] ?? null;
        return { data: first, error: result.error };
      },
      // biome-ignore lint/suspicious/noThenProperty: Supabase query builders are intentionally thenable; this mock matches that contract.
      then(onfulfilled) {
        const all = rows.get(table)!;
        const matched = all.filter((r) => filters.every((f) => f(r)));

        let results: MockRow[];

        if (mode === "delete") {
          // Remove matched rows from the underlying array, keep a copy as data.
          const remaining = all.filter((r) => !matched.includes(r));
          rows.set(table, remaining);
          results = matched;
        } else if (mode === "update") {
          // Mutate matched rows in place.
          for (const row of matched) {
            Object.assign(row, updatePatch);
          }
          results = matched;
        } else {
          results = matched;
          if (orderBy) {
            results = [...results].sort((a, b) => {
              const av = a[orderBy!.column];
              const bv = b[orderBy!.column];
              const cmp = (av as string | number) < (bv as string | number) ? -1 : 1;
              return orderBy!.ascending ? cmp : -cmp;
            });
          }
          if (limitN !== null) {
            results = results.slice(0, limitN);
          }
          if (selectedColumns) {
            results = results.map(
              (row) =>
                Object.fromEntries(
                  selectedColumns!.map((column) => [column, row[column]]),
                ) as MockRow,
            );
          }
        }

        const value: { data: unknown[]; error: Error | null } = {
          data: results,
          error: null,
        };
        return Promise.resolve(onfulfilled ? onfulfilled(value) : (value as never));
      },
    };
    return builder;
  }

  return client;
}

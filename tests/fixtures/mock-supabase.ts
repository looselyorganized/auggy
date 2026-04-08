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
  eq(column: string, value: unknown): MockQueryBuilder;
  ilike(column: string, value: string): MockQueryBuilder;
  order(
    column: string,
    opts?: { ascending?: boolean },
  ): MockQueryBuilder;
  limit(n: number): MockQueryBuilder;
  maybeSingle(): Promise<{ data: MockRow | null; error: Error | null }>;
  then<TResult1 = { data: unknown[]; error: Error | null }, TResult2 = never>(
    onfulfilled?:
      | ((value: {
          data: unknown[];
          error: Error | null;
        }) => TResult1 | PromiseLike<TResult1>)
      | null
      | undefined,
    onrejected?:
      | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
      | null
      | undefined,
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

    const builder: MockQueryBuilder = {
      async insert(row) {
        const arr = Array.isArray(row) ? row : [row];
        rows.get(table)!.push(...arr);
        return { error: null };
      },
      select() {
        return builder;
      },
      eq(column, value) {
        filters.push((r) => (r as Record<string, unknown>)[column] === value);
        return builder;
      },
      ilike(column, value) {
        const pattern = value.replace(/%/g, "").toLowerCase();
        filters.push((r) => {
          const v = (r as Record<string, unknown>)[column];
          return typeof v === "string" && v.toLowerCase().includes(pattern);
        });
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
      then(onfulfilled) {
        let results = rows.get(table)!.filter((r) =>
          filters.every((f) => f(r)),
        );
        if (orderBy) {
          results = [...results].sort((a, b) => {
            const av = a[orderBy!.column];
            const bv = b[orderBy!.column];
            const cmp =
              (av as string | number) < (bv as string | number) ? -1 : 1;
            return orderBy!.ascending ? cmp : -cmp;
          });
        }
        if (limitN !== null) {
          results = results.slice(0, limitN);
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

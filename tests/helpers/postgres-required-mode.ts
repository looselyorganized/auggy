/** Test-only gate. Ordinary local runs may skip; required CI must execute every case. */
export function createPostgresTestGate(env: Record<string, string | undefined>) {
  const requiredFlag = env.AUGGY_REQUIRE_POSTGRES_TESTS;
  if (requiredFlag !== undefined && requiredFlag !== "1") {
    throw new Error("AUGGY_REQUIRE_POSTGRES_TESTS must equal 1 when provided");
  }
  const required = requiredFlag === "1";
  const url = env.AUGGY_TEST_POSTGRES_URL?.trim() || undefined;
  if (required && !url) throw new Error("Required PostgreSQL tests need AUGGY_TEST_POSTGRES_URL");
  let registered = 0;
  let completed = 0;
  let serverVersion: number | null = null;
  return {
    url,
    required,
    track(body: () => Promise<void>): () => Promise<void> {
      registered += 1;
      let executed = false;
      return async () => {
        if (executed) throw new Error("PostgreSQL test executed more than once");
        executed = true;
        await body();
        completed += 1;
      };
    },
    verifyServerVersion(value: unknown): void {
      if (!Number.isInteger(value) || (value as number) < 170000 || (value as number) >= 180000) {
        throw new Error("Required PostgreSQL tests must execute against PostgreSQL 17");
      }
      serverVersion = value as number;
    },
    verifyComplete() {
      if (required && (serverVersion === null || registered === 0 || completed !== registered)) {
        throw new Error("Required PostgreSQL tests did not complete every registered case");
      }
      return { required, registered, completed, serverVersion };
    },
  };
}

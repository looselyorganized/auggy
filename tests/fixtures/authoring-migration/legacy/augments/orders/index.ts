import { fixtureValue } from "./helper";

// This source must remain byte-identical and must never execute during migration.
throw new Error(`MIGRATION_SOURCE_EXECUTED_${fixtureValue}`);

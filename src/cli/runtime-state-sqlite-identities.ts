import {
  AGENTMAIL_LEDGER_APPLICATION_ID,
  AGENTMAIL_LEDGER_SCHEMA_VERSION,
} from "../augments/agentMail/inbound-ledger";
import {
  NOTIFY_DELIVERY_APPLICATION_ID,
  NOTIFY_DELIVERY_SCHEMA_VERSION,
} from "../augments/notify/delivery-store";
import { BUDGETS_APPLICATION_ID, BUDGETS_SCHEMA_VERSION } from "../augments/budgets/budget-store";
import {
  LAYERED_MEMORY_APPLICATION_ID,
  LAYERED_MEMORY_SCHEMA_VERSION,
} from "../augments/layeredMemory/storage/sqlite-store";
import {
  TELEGRAM_REPLAY_APPLICATION_ID,
  TELEGRAM_REPLAY_SCHEMA_VERSION,
} from "../augments/telegramTransport/replay-store";
import {
  VISITOR_AUTH_APPLICATION_ID,
  VISITOR_AUTH_SCHEMA_VERSION,
} from "../augments/visitorAuth/storage/sqlite-store";
import {
  WEB_IDEMPOTENCY_APPLICATION_ID,
  WEB_IDEMPOTENCY_SCHEMA_VERSION,
} from "../transports/idempotency-store";
import {
  CONSOLE_CHAT_APPLICATION_ID,
  CONSOLE_CHAT_SCHEMA_VERSION,
} from "../transports/admin/console-chat-store";
import { DURABLE_JOBS_APPLICATION_ID, DURABLE_JOBS_SCHEMA_VERSION } from "../jobs/sqlite-store";

export interface RuntimeStateSqliteIdentity {
  applicationId: number;
  userVersion: number;
  /** Historical versions emitted under the same inventory schema label. */
  compatibleUserVersions?: readonly number[];
}

export const RUNTIME_STATE_SQLITE_IDENTITIES: Readonly<Record<string, RuntimeStateSqliteIdentity>> =
  Object.freeze({
    "LMEM/v1": {
      applicationId: LAYERED_MEMORY_APPLICATION_ID,
      userVersion: LAYERED_MEMORY_SCHEMA_VERSION,
    },
    "BUDG/v1": {
      applicationId: BUDGETS_APPLICATION_ID,
      userVersion: BUDGETS_SCHEMA_VERSION,
    },
    "VAUT/v1": {
      applicationId: VISITOR_AUTH_APPLICATION_ID,
      userVersion: VISITOR_AUTH_SCHEMA_VERSION,
    },
    "AUID/v2": {
      applicationId: WEB_IDEMPOTENCY_APPLICATION_ID,
      userVersion: WEB_IDEMPOTENCY_SCHEMA_VERSION,
    },
    "CCHT/v4": {
      applicationId: CONSOLE_CHAT_APPLICATION_ID,
      userVersion: CONSOLE_CHAT_SCHEMA_VERSION,
    },
    "TGRP/v2": {
      applicationId: TELEGRAM_REPLAY_APPLICATION_ID,
      userVersion: TELEGRAM_REPLAY_SCHEMA_VERSION,
    },
    "AMIL/v4": {
      applicationId: AGENTMAIL_LEDGER_APPLICATION_ID,
      userVersion: AGENTMAIL_LEDGER_SCHEMA_VERSION,
    },
    "AMIL/v3": {
      applicationId: AGENTMAIL_LEDGER_APPLICATION_ID,
      userVersion: 3,
    },
    "AMIL/v2": {
      applicationId: AGENTMAIL_LEDGER_APPLICATION_ID,
      userVersion: 2,
      compatibleUserVersions: [2, 3],
    },
    "NTFY/v2": {
      applicationId: NOTIFY_DELIVERY_APPLICATION_ID,
      userVersion: NOTIFY_DELIVERY_SCHEMA_VERSION,
    },
    "NTFY/v1": {
      applicationId: NOTIFY_DELIVERY_APPLICATION_ID,
      userVersion: 1,
    },
    "DJOB/v2": {
      applicationId: DURABLE_JOBS_APPLICATION_ID,
      userVersion: DURABLE_JOBS_SCHEMA_VERSION,
    },
  });

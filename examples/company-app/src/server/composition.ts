import "server-only";
import { createAssertionHandler } from "./assertion-handler";
import { createCompanyPolicy } from "./company-policy";
import { sessionAdapter } from "./session-adapter";
import { createOrdersServiceClient } from "../../agent-integration/orders/service-client";

/** Session verification and domain permission lookup are deliberately separate. */
export const issueAssertion = createAssertionHandler({
  configuration: () => ({
    appOrigin: process.env.APP_ORIGIN,
    audience: process.env.AUGGY_AUTH_AUDIENCE,
    keyId: process.env.AUGGY_AUTH_KEY_ID,
    secret: process.env.AUGGY_AUTH_SECRET,
  }),
  adapter: sessionAdapter,
  policy: createCompanyPolicy({
    authorizationFor: (session) =>
      createOrdersServiceClient({
        origin: process.env.ORDERS_SERVICE_URL,
        token: process.env.ORDERS_SERVICE_TOKEN,
      }).authorizationFor(session),
  }),
});

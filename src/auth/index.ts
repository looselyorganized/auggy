/** Pure assertion helpers for application backends; no agent runtime or Bun storage imports. */
export type {
  AuthorizationConstraintValue,
  AuthorizationConstraints,
  AuthorizationGrant,
  AuthorizationScope,
} from "../types";
export {
  createExternalAuthAssertion,
  verifyExternalAuthAssertion,
} from "./external-auth";
export type {
  CreateExternalAuthAssertionOptions,
  ExternalAuthAssertionSecret,
  ExternalAuthAssertionFailureReason,
  ExternalAuthAssertionVerification,
  ExternalAuthClaims,
  VerifyExternalAuthAssertionOptions,
} from "./external-auth";

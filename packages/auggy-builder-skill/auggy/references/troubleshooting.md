# Troubleshooting

Start with:

```bash
auggy doctor
```

Use `auggy doctor --cloud` for deploy readiness.

## Missing Provider API Key

Symptom: model calls fail or `doctor` reports a missing env var.

Fix:

1. Identify the env var name from `doctor`.
2. Ask the creator to set it in `.env` locally or the deploy provider in
   production.
3. Do not ask the creator to paste the secret into chat.
4. Restart the agent after changing env.

## `EADDRINUSE`

Symptom: local server cannot bind to the configured port.

Fix:

1. Check the configured `webTransport` port.
2. Identify the process using the port.
3. If it is an old Auggy/dev server and the creator agrees, stop it.
4. Otherwise change the configured port and rerun.

Do not randomly kill processes without confirming what owns the port.

## Route Collisions

Symptom: agent boot or `doctor` reports duplicate route paths/methods.

Fix:

1. Run `auggy routes` if the agent can boot.
2. Search custom augments for the duplicate method/path.
3. Rename one route or group routes under a capability prefix.
4. Keep public, visitor, creator, and agent routes explicit.

## Public Route Posture Warning

Symptom: `doctor` warns that a custom route is public.

Fix:

- Keep `auth: "none"` only for intentionally public reads/forms/webhook entry
  points.
- Use `visitor.required` for account data.
- Use `creator` or `bearer` for operator/admin actions.
- Use `agent.required` for admitted machine/agent callers.

## Invalid Custom Augment Module

Symptom: custom augment fails to import or does not expose expected routes/tools.

Fix:

1. Confirm `augments/<name>/augment.yaml` has `type: custom` and `source`.
2. Confirm the source exports a default function.
3. Confirm the function returns `defineAugment({...})`.
4. Run focused tests for the augment if present.
5. Run `auggy doctor` and `auggy routes`.

## Generated Client Target Mistakes

Symptom: browser code wants a bearer/creator route, or server code cannot call
visitor-token routes.

Fix:

- Browser target intentionally omits `bearer`, `creator`, `agent.required`, and
  webhook-policy routes.
- Server target intentionally omits visitor-token routes.
- Generate both clients and import the correct one for the caller environment.
- Do not put server credentials in browser code.

## Missing App Auth Assertion

Symptom: `visitor.required` route returns visitor auth required.

Fix:

1. Confirm the app backend verifies the normal app session.
2. Confirm it mints a short-lived Auggy auth assertion.
3. Confirm browser generated client sets `authAssertion`.
4. Confirm `webTransport.externalAuth` has matching secret, audience, provider,
   key id, and TTL expectations.
5. If replay protection is enabled, confirm assertions include unique `jti`.

## Railway Deploy Failure

Fix path:

1. Run `auggy doctor --cloud`.
2. Confirm required env vars exist in Railway.
3. Confirm persistent volume is configured when durable data is required.
4. Check Railway logs using the deploy output or dashboard.
5. Avoid printing secret values.

## Provider Overloaded Or Rate Limited

Retryable provider errors should appear as normalized console errors. Wait and
try again. If persistent, reduce request volume, check provider status, or
switch model/provider after creator approval.

# Auth Strategy for Agent-Native Apps

> Auggy should own agent-native identity and trust, not become a general auth provider.

## Core principle

The agent should not verify authentication by reasoning.

The agent can ask for auth, explain why auth is needed, or render/link to an auth flow. The runtime must verify credentials deterministically, mint or validate tokens, resolve identity, and expose verified state to tools, routes, memory, budgets, and model context.

Flow:

1. Agent or app asks the visitor to authenticate.
2. Route/component/provider performs deterministic verification.
3. Runtime mints or validates a credential.
4. Transport or route layer resolves identity.
5. Agent receives compact verified-state context.
6. Tools/routes receive structured auth state.

Never promote identity because the user says "I am Alice" in chat.

## Auth surfaces

Auggy has several auth problems. They should be related, but not collapsed into one vague "auth" feature.

### Creator auth

Who is operating this agent?

Current shape:

- Web bearer token resolves to creator-like access.
- Console/admin surfaces are creator-gated.

Future needs:

- Multi-operator identity
- Better creator route auth semantics
- Audit attribution per operator

### Visitor auth

Is an anonymous public visitor now a recognized human visitor?

Current shape:

- `visitorAuth`
- Email magic link
- Visitor token
- `publicSubstate: "recognized"`
- Memory continuity
- Revocation/reverify

Keep `visitorAuth` focused on human/public visitor identity. Do not rename it to `agentAuth`.

### Agent auth

Is this machine or agent peer admitted to interact with this Auggy?

Current adjacent pieces:

- `webTransport.access.agents`
- `x-agent-id` / `x-agent-secret`
- `trustLevel: "agent"`
- `link` augment direction

Future `agentAuth` should be a sibling to `visitorAuth`, not a rename.

It should own:

- Agent peer IDs
- Admission/allowlist
- Secret or signed-token verification
- Rotation
- Agent-card or peer metadata
- Per-agent budgets
- Revocation
- Link/A2A compatibility

### Staff/person auth

Future operational apps likely need a trust tier between public and creator.

Examples:

- Technician
- Support rep
- Dispatcher
- Store staff

This should not be rushed into the `0.5.0` route-auth foundation. It likely
needs either a `staff` trust tier, external OAuth/SSO integration, or both.

### Webhook auth

External services do not fit visitor/creator/agent auth.

Examples:

- Stripe webhook signature
- Shopify webhook signature
- GitHub webhook signature
- AgentMail/Svix webhook verification

Webhook auth should be route policy owned by the relevant augment or route helper. It should not resolve to a normal human peer unless the webhook is explicitly tied to one.

## Three visitor auth flows

Auggy should support three visitor-auth entry modes over time.

### 1. Agent-initiated magic link

Best for chat-first flows.

1. Visitor gives an email.
2. Agent calls `request_auth({ method: "email", email })`.
3. `visitorAuth` sends a magic link through AgentMail or console adapter.
4. Visitor verifies through `/visitor-auth/verify`.
5. Runtime mints a visitor token.
6. Future chat/app requests resolve as `public/recognized`.

This is the current `visitorAuth` direction.

### 2. Route/component login

Best for chat-first apps with richer UI.

1. Agent says auth is needed.
2. Chat renders or links to a login component.
3. Component calls deterministic auth routes.
4. Runtime verifies credentials and stores/mints the visitor credential.
5. Next chat request includes the credential.
6. Transport resolves recognized identity.

The agent orchestrates; the component/runtime verifies.

### 3. Normal app login

Best when Auggy backs a broader app or customer portal.

1. User logs in through normal app UI.
2. App/backend session exists.
3. Browser asks the app backend for a short-lived Auggy assertion.
4. App backend verifies the session and signs explicit scopes/grants.
5. Chat and app routes send `x-auggy-auth-assertion`.
6. Auggy resolves recognized visitor context and enforces route/tool
   `requires`.

This is the current delegated authorization bridge. The app keeps its login
system; Auggy gets only the compact authorization signal it needs.

## Unified identity output

Different auth mechanisms should normalize to one route/tool/model identity shape.

Conceptual shape:

```ts
interface ResolvedAuthState {
  trustLevel: "creator" | "agent" | "public";
  publicSubstate?: "anonymous" | "recognized";
  peerId?: string;
  claims?: {
    email?: string;
    provider?: string;
    subject?: string;
    orgId?: string;
    roles?: string[];
    verifiedAt?: string;
    agentId?: string;
    operatorId?: string;
  };
}
```

The exact type can differ, but the principle matters: tools and routes should receive structured auth state; the model should receive compact context.

## What the model sees

The model should see a short context block, not raw credentials.

Example:

> The current visitor is verified as alice@example.com. Verification method: email magic link. Verified at: 2026-06-09T18:30:00Z.

Do not expose:

- tokens
- magic-link secrets
- bearer values
- webhook secrets
- raw session cookies

## Current route and delegated auth contract

The route-auth foundation has landed on `main` for the `0.5.0` candidate.

Current route auth modes:

- `none`
- `bearer`
- `creator`
- `visitor.optional`
- `visitor.required`
- `agent.required`

Route handlers receive structured auth context and a resolved principal. The
model never decides whether a request is authorized.

### External app auth assertions

For apps that already use Supabase Auth, Clerk, Auth0-style middleware, or custom
sessions, the right pattern is a bridge:

1. The app backend verifies the normal app session.
2. The app backend derives explicit scopes/grants for the current user.
3. The app backend signs a short-lived Auggy external auth assertion.
4. The browser or app caller sends it as `x-auggy-auth-assertion`.
5. Auggy verifies audience, provider, TTL, signature, optional key id, and replay
   posture.
6. Auggy enforces route/tool `requires` before handlers or tools run.

External app auth assertions preserve a compact verified claim subset on
recognized visitor route context and protected tool execution context:

```ts
auth.externalAuth // keyId?, provider, subject, orgId?, roles?, scopes?, grants?, authzVersion?, jti?
```

Roles can travel as context, but roles do not satisfy authorization. `requires`
is satisfied only by explicit app-minted scopes or grants. This keeps Auggy out
of the app's RBAC system while still letting Auggy enforce access before route
handlers or model-requested tools run.

Developer reference: [`../26-delegated-authorization.md`](../26-delegated-authorization.md)
describes the Clerk/Supabase/custom app bridge, key rotation, replay protection,
delegated `scopes` / `grants`, and route/tool `requires` examples.
Runnable example: [`../../examples/app-auth-bridge`](../../examples/app-auth-bridge/README.md).

### Resource-bound authorization

Delegated authorization has two enforcement sites:

- Routes bind resource grants from path params with `{ param: "id" }`.
- Tools bind resource grants from validated tool input with
  `{ input: "orderId" }`.

That boundary matters because tools are model-requested. The model can propose an
input, but Auggy evaluates the validated input against app-minted grants before
the tool executes.

### Visitor tokens plus external auth

When a request carries both a valid Auggy visitor token and a valid external app
auth assertion, Auggy keeps the visitor-token identity and attaches
`externalAuth` only if the external assertion maps to the same `visitorId`.
Mismatched app claims are not merged onto the visitor context.

### Agent route auth

`auth: "agent.required"` admits routes through the same `x-agent-id` /
`x-agent-secret` allowlist used by `webTransport` identity resolution. Handlers
receive `auth.mode === "agent"` and an agent principal. Browser generated
clients omit these routes; server generated clients can call them with explicit
agent credentials.

This is useful now for configured machine/agent callers. It is not yet the full
future `agentAuth`/Link/A2A mesh.

### Webhook policies

Webhook signatures are route policies, not peer identity:

```ts
defineRoute.post("/webhooks/stripe", {
  auth: "none",
  policy: webhook.signature("stripe", {
    secretEnv: "STRIPE_WEBHOOK_SECRET",
  }),
  handler: async ({ webhook }) => {
    const event = webhook?.event;
  },
});
```

Stripe verification has shipped because it forces raw-body HMAC handling.
GitHub/Svix-style verifiers can follow without becoming peer identity.

Keep webhook auth separate from route identity:

- The caller is a provider event, not a visitor, creator, or agent peer.
- Verification should run before JSON body parsing mutates the raw payload.
- The verified event can be passed to the handler as structured route context.
- The model should not see webhook secrets, signatures, or raw provider headers.
- Generated browser clients should omit webhook-policy routes by default.
- Server clients may include them only for trusted server-side callers.

## Design cautions

- Do not rename `visitorAuth` to `agentAuth`; create `agentAuth` as a sibling.
- Do not build a generic auth provider.
- Do not add passwords/user tables unless a product use case forces it.
- Do not make route auth depend on model output.
- Do not expose secrets to the model.
- Do not duplicate identity resolution logic in many augments.
- Do not let `auth: "none"` become the default for customer-specific data.
- Do not add new auth modes until route context, generated clients, OpenAPI, and
  doctor/reporting can represent them consistently.

## What Auggy should own

Own:

- Trust levels
- Visitor token verification
- Agent peer admission
- Route auth policy
- Memory/budget identity binding
- Revocation hooks
- Audit posture
- Verified identity context for the model

Do not own:

- General OAuth provider
- Password auth
- Enterprise IAM
- User-management dashboard
- Payment-provider identity
- Generic SSO product

## How this folds into the roadmap

Auth should become part of the app-backend route layer, not a separate platform detour.

Roadmap placement:

1. `0.5.0`: route auth modes, structured route context, delegated app auth,
   route/tool `requires`, Stripe webhook policy, key rotation, audit hooks, and
   replay protection.
2. `0.6.x`: app-builder recipes and scaffolds that teach the bridge without
   normalizing browser bearer usage.
3. `0.7.x`: operator visibility for denials, assertions, route posture, and
   audit review.
4. `0.8.x/0.9.x`: additional provider recipes, webhook verifiers, and any
   staff/person-auth design that real internal apps force.
5. `2.0+`: `agentAuth` alongside `visitorAuth` when mesh/link/A2A needs a real
   peer identity product.

This keeps Auggy focused: integrate with app auth, enforce explicit delegated
permissions, and avoid becoming a generic auth provider.

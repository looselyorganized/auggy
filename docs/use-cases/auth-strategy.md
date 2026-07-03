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

This should not be rushed into v1.0 route auth. It likely needs either a `staff` trust tier, external OAuth/SSO integration, or both.

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
3. Chat and app routes include session cookie or visitor token.
4. Auggy resolves the session to `PeerIdentity`.
5. Agent sees verified visitor context.

This requires a route/session integration story, but should still normalize to the same Auggy identity state.

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

## Route auth plan

Do not jump from `bearer | none` directly to every auth mode.

Recommended sequence:

### Step 1: current stable modes

Keep:

- `none`
- `bearer`

### Step 2: route context auth state

Before adding semantic auth names, route handlers should receive a structured auth state.

Initial shape can be simple:

```ts
{ mode: "none" } | { mode: "bearer" }
```

This creates the slot for richer identity without breaking route helpers.

### Step 3: creator alias

Add `creator` only when bearer-auth routes can expose resolved creator/auth state clearly.

Avoid naming a mode `creator` if it is only a blind bearer check with no route-context identity. Users will infer stronger semantics.

Implementation note: `auth: "creator"` is now a semantic alias for creator-only
routes. It uses the same web bearer credential as `auth: "bearer"`, but route
handlers receive `auth.mode === "creator"` and a creator principal.

External app auth assertions now preserve a compact verified claim subset on
recognized visitor route context:

```ts
auth.externalAuth // { provider, subject, orgId?, roles? }
```

This gives Clerk/Supabase/custom app sessions enough structure for app-owned
authorization checks without making Auggy a general RBAC product.

When a request carries both a valid Auggy visitor token and a valid external app
auth assertion, Auggy keeps the visitor-token identity and attaches
`externalAuth` only if the external assertion maps to the same `visitorId`.
Mismatched app claims are not merged onto the visitor context.

### Step 4: visitor and agent route auth

Add only after route context can resolve credentials consistently:

- `visitor.optional`
- `visitor.required`
- `agent.required`
- `trust: [...]`

These must align with `webTransport` identity resolution and `visitorAuth`, not create a second identity model.

### Step 5: webhook policies

Add as route policies, not peer identity:

- `webhook.signature("stripe")`
- `webhook.signature("github")`
- or augment-specific policy helpers

## Design cautions

- Do not rename `visitorAuth` to `agentAuth`; create `agentAuth` as a sibling.
- Do not build a generic auth provider.
- Do not add passwords/user tables unless a product use case forces it.
- Do not make route auth depend on model output.
- Do not expose secrets to the model.
- Do not duplicate identity resolution logic in many augments.
- Do not let `auth: "none"` become the default for customer-specific data.
- Do not add visitor/agent route auth before route context can carry structured auth state.

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

1. Finish route groups/path params and route helper hardening.
2. Add structured route auth state to app request context.
3. Add `creator` as a semantic alias only when context semantics are ready.
4. Add visitor/agent route auth in v1.x after identity resolution is unified.
5. Add webhook signature policies with integration augments.
6. Add `agentAuth` alongside `visitorAuth` when mesh/link/A2A needs it.

This keeps v1.0 self-hosted agent use intact while enabling app-first and chat-first agent-native apps.

# concierge-services

Custom Auggy augment for the concierge example.

`domain.ts` owns deterministic behavior. `index.ts` exposes that behavior twice:

- HTTP routes for app/backend callers
- Tools for the model during chat

This keeps route behavior and agent behavior from drifting.

## Install

```bash
auggy augment install <agent> ./augments/concierge-services
```

## Test

```bash
auggy augment test ./augments/concierge-services
```

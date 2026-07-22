const requestLeaseOwner: unique symbol = Symbol("requestLeaseOwner");

/** An opaque claim to the latest request for one authority scope. */
export interface RequestLease<Scope> {
  readonly scope: Scope;
  readonly [requestLeaseOwner]: object;
}

/**
 * Coordinate latest-request-wins work without counters or React coupling.
 * Request completions should call `finish(lease)`; `invalidate(scope)` is an
 * external cancellation that intentionally retires whichever lease is current.
 */
export function createRequestAuthority<Scope>() {
  const owner = Object.freeze({});
  const currentByScope = new Map<Scope, RequestLease<Scope>>();

  function begin(scope: Scope): RequestLease<Scope> {
    const lease: RequestLease<Scope> = Object.freeze({
      scope,
      [requestLeaseOwner]: owner,
    });
    currentByScope.set(scope, lease);
    return lease;
  }

  function isCurrent(lease: RequestLease<Scope>): boolean {
    return (
      lease[requestLeaseOwner] === owner && currentByScope.get(lease.scope) === lease
    );
  }

  function finish(lease: RequestLease<Scope>): boolean {
    if (!isCurrent(lease)) return false;
    return currentByScope.delete(lease.scope);
  }

  function invalidate(scope: Scope): boolean {
    return currentByScope.delete(scope);
  }

  function invalidateAll(): void {
    currentByScope.clear();
  }

  return { begin, isCurrent, finish, invalidate, invalidateAll };
}

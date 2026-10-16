/**
 * C1 — Project ownership keys (pure, no next-auth import → unit-testable).
 *
 * A project's `ownerToken` column holds ONE of:
 *   - `account:<userId>`  — owned by a signed-in account (private to that account), or
 *   - a per-browser anonymous UUID (the legacy P6.1 `x-owner-token`), or
 *   - null — a legacy/anonymous project open to all (pre-ownership rows).
 *
 * Signing in upgrades a request's owner key from the anonymous UUID to
 * `account:<id>`, so account projects are private to the account while the
 * no-account "draw + ask + save locally" flow keeps working unchanged.
 */

const ACCOUNT_PREFIX = 'account:'

/** Namespaced owner key for a signed-in account. */
export function accountOwnerKey(userId: string): string {
  return `${ACCOUNT_PREFIX}${userId}`
}

/** True when an owner key belongs to a real account (vs an anonymous UUID). */
export function isAccountOwner(ownerKey: string | null | undefined): boolean {
  return typeof ownerKey === 'string' && ownerKey.startsWith(ACCOUNT_PREFIX)
}

/**
 * Resolve the owner key for a request: prefer the signed-in account id, else fall
 * back to the anonymous browser token. Returns '' when neither is present (an
 * unauthenticated request with no token — lists nothing, owns nothing).
 */
export function resolveOwnerKey(input: { accountId?: string | null; anonToken?: string | null }): string {
  const id = input.accountId?.trim()
  if (id) return accountOwnerKey(id)
  return (input.anonToken ?? '').slice(0, 128)
}

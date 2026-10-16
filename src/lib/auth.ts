/**
 * C1 — next-auth configuration (JWT strategy — no DB adapter, no schema migration).
 *
 * Auth is **additive + inert by default**: providers register only when their env
 * vars are present. With no provider configured, sign-in is simply unavailable and
 * the app stays fully anonymous (the free "draw + ask + save locally" flow is
 * unchanged). When GitHub OAuth is configured, a signed-in user's projects become
 * private to their account (owner key `account:<id>`) via `getRequestOwner`.
 *
 * Why JWT (not the Prisma adapter): account-scoping only needs a stable user id on
 * the session, which the JWT carries — so we avoid adding an adapter dependency and
 * the User/Account/Session tables. Email magic-link (which needs an adapter for
 * verification tokens) is a documented follow-up.
 *
 * Live sign-in verification needs operator credentials (GITHUB_ID / GITHUB_SECRET +
 * NEXTAUTH_SECRET) — see .env.example. The ownership logic is unit-tested without them.
 */

import { randomBytes } from 'node:crypto'
import type { NextAuthOptions } from 'next-auth'
import { getServerSession } from 'next-auth'
import GitHubProvider from 'next-auth/providers/github'

import { resolveOwnerKey } from './owner'

/** Build the provider list from whatever credentials are configured (may be empty). */
function buildProviders(): NextAuthOptions['providers'] {
  const providers: NextAuthOptions['providers'] = []
  const ghId = process.env.GITHUB_ID?.trim()
  const ghSecret = process.env.GITHUB_SECRET?.trim()
  if (ghId && ghSecret) {
    providers.push(GitHubProvider({ clientId: ghId, clientSecret: ghSecret }))
  }
  return providers
}

/** next-auth throws NO_SECRET on every request without a secret. With no provider
 *  configured nothing is ever signed in, so a throwaway per-process secret is
 *  harmless and keeps the (inert) auth routes quiet. With providers configured,
 *  a missing NEXTAUTH_SECRET stays a genuine misconfiguration and is left unset. */
function resolveSecret(providers: NextAuthOptions['providers']): string | undefined {
  const configured = process.env.NEXTAUTH_SECRET?.trim()
  if (configured) return configured
  return providers.length === 0 ? randomBytes(32).toString('hex') : undefined
}

const providers = buildProviders()

export const authOptions: NextAuthOptions = {
  // JWT sessions — no database adapter needed for account-scoping.
  session: { strategy: 'jwt' },
  providers,
  // NEXTAUTH_SECRET signs the JWT (see resolveSecret for the no-provider case).
  secret: resolveSecret(providers),
  callbacks: {
    // Persist a stable account id on the token (GitHub provides `account.providerAccountId`).
    async jwt({ token, account, profile }) {
      if (account?.providerAccountId) {
        token.accountId = `${account.provider}:${account.providerAccountId}`
      } else if (profile && (profile as any).id) {
        token.accountId = `${token.accountId ?? 'oauth'}:${(profile as any).id}`
      }
      return token
    },
    // Expose the stable id on the session for server-side owner resolution.
    async session({ session, token }) {
      if (session.user) {
        ;(session.user as any).id = (token as any).accountId ?? token.sub ?? null
      }
      return session
    },
  },
}

/** True when at least one auth provider is configured (sign-in is available). */
export function authEnabled(): boolean {
  return buildProviders().length > 0
}

/**
 * Resolve the owner key for an API request: the signed-in account id (`account:<id>`)
 * when a session exists, else the anonymous `x-owner-token` header. Never throws — a
 * misconfigured/unavailable auth layer transparently degrades to the anonymous token,
 * so project access for anonymous users is never broken by auth.
 */
export async function getRequestOwner(req: Request): Promise<string> {
  const anonToken = req.headers.get('x-owner-token') || ''
  let accountId: string | null = null
  try {
    const session = await getServerSession(authOptions)
    accountId = (session?.user as any)?.id ?? null
  } catch {
    // auth not configured / token undecodable → anonymous fallback
    accountId = null
  }
  return resolveOwnerKey({ accountId, anonToken })
}

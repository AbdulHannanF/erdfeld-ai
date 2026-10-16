/**
 * C1 — next-auth App Router handler. Inert unless a provider is configured
 * (see src/lib/auth.ts). Anonymous use needs none of this.
 */

import NextAuth from 'next-auth'
import { authOptions } from '@/lib/auth'

const handler = NextAuth(authOptions)

export { handler as GET, handler as POST }

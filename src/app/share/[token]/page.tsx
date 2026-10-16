/**
 * P6.2 — Share landing route. A clean, memorable `/share/:token` URL that simply
 * forwards into the main app's share handler (`/?share=:token`), which loads the
 * read-only snapshot into preview mode. Kept as a thin server-side redirect so
 * the heavy client app + map only mount once, on the canonical route.
 */

import { redirect } from 'next/navigation'

export default async function SharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  redirect(`/?share=${encodeURIComponent(token)}`)
}

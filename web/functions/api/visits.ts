/**
 * Cloudflare Pages Function: /api/visits, backed by D1 (binding "DB", see wrangler.toml).
 * The same handler as the Node server (server/visits.ts), with a store and salt shared by every instance.
 */
import { d1Store, type D1Like } from '../../server/d1Store.ts'
import { createVisits } from '../../server/visits.ts'

interface Context {
  request: Request
  env: { DB: D1Like }
}

export async function onRequest({ request, env }: Context): Promise<Response> {
  const store = d1Store(env.DB)
  const visits = createVisits(store, { dailySalt: store.dailySalt })
  // Cloudflare sets the visitor's address; it is hashed and never stored.
  return visits.handle(request, request.headers.get('cf-connecting-ip') ?? '')
}

/** Run the visit counter inside a Node HTTP server (Vite's dev/preview servers, or plain node:http). */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { createVisits } from './visits.ts'

type Visits = ReturnType<typeof createVisits>

export interface NodeOptions {
  /**
   * Behind a reverse proxy or CDN the socket address is the proxy's; set this to read the
   * client's address from X-Forwarded-For instead. Never set it when clients connect directly,
   * or anyone could spoof the header.
   */
  trustProxy?: boolean
}

function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  const forwarded = trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() : ''
  return forwarded || req.socket.remoteAddress || ''
}

/** Connect-style middleware: answers /api/visits, passes everything else on. */
export function visitsMiddleware(visits: Visits, opts: NodeOptions = {}) {
  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const path = (req.url ?? '').split('?')[0]
    if (path !== '/api/visits') return next()
    try {
      const headers = new Headers()
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v)
      const request = new Request(`http://${req.headers.host ?? 'localhost'}${req.url}`, { method: req.method, headers })
      const response = await visits.handle(request, clientIp(req, !!opts.trustProxy))
      res.statusCode = response.status
      response.headers.forEach((v, k) => res.setHeader(k, v))
      res.end(await response.text())
    } catch (e) {
      console.error('visits:', e)
      res.statusCode = 500
      res.end()
    }
  }
}

/**
 * Anonymous visitor counts from /api/visits (see web/server/visits.ts for what is and isn't kept).
 * The page sends a heartbeat when it opens and every minute while it is visible; hidden tabs
 * stop, so they drop out of "exploring now" after five minutes. Automated browsers only read.
 */

export interface VisitCounts {
  active: number
  total: number
}

const BEAT_MS = 60_000

/** Start counting; calls `onCounts` with each answer, or null if there is no counter. Returns a stop function. */
export function trackVisits(onCounts: (c: VisitCounts | null) => void): () => void {
  const counted = !navigator.webdriver
  let stopped = false
  let timer = 0

  const beat = async () => {
    if (stopped || document.hidden) return
    try {
      const r = await fetch('/api/visits', counted ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' } : {})
      if (!r.ok || !(r.headers.get('content-type') ?? '').includes('json')) throw new Error(String(r.status))
      if (!stopped) onCounts((await r.json()) as VisitCounts)
    } catch {
      // No counter on this host (a static deployment): hide the numbers and stop asking.
      stop()
      onCounts(null)
    }
  }
  const onVisible = () => {
    if (!document.hidden) beat()
  }
  function stop() {
    stopped = true
    window.clearInterval(timer)
    document.removeEventListener('visibilitychange', onVisible)
  }

  beat()
  timer = window.setInterval(beat, BEAT_MS)
  document.addEventListener('visibilitychange', onVisible)
  return stop
}

export const formatCount = (n: number) => n.toLocaleString('en-IN')

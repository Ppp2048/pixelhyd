import { formatCount, type VisitCounts } from '../lib/visits'

const PRIVACY = 'Anonymous counts: no cookies, and nothing that identifies you is stored.'

/** "● 3 exploring now · 1,204 visits": quiet, in the bottom-left corner (in settings on phones). */
export function VisitCounter({ counts, inline = false }: { counts: VisitCounts; inline?: boolean }) {
  const now = `${formatCount(counts.active)} exploring now`
  const total = `${formatCount(counts.total)} ${counts.total === 1 ? 'visit' : 'visits'}`
  return (
    <p className={inline ? 'visits-inline' : 'visits'} title={PRIVACY} aria-label={`${now}, ${total}. ${PRIVACY}`}>
      <span className="live-dot" aria-hidden="true" />
      {now} <span aria-hidden="true">·</span> {total}
    </p>
  )
}

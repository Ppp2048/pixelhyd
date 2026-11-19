import { useDeferredValue, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { Corporate } from '../lib/corporate'
import { loadPlaces, type Places } from '../lib/places'
import { buildIndex, countGroups, groupHits, groupLabels, hitGroup, hitKey, hitSub, hitTitle, type Hit } from '../lib/discover'
import { CloseIcon, SearchIcon } from './icons'

interface Props {
  corporate: Corporate | null
  onPick: (hit: Hit) => void
}

/** How many ranked hits feed the filter counts; the list itself shows fewer. */
const POOL = 200

/**
 * Unified search over companies and the citywide place index: suggestions as you type,
 * grouped by kind, with filter chips. ↑ ↓ Enter to choose, "/" to focus, Esc to leave.
 * The place index (~0.6 MB) loads the first time the box is focused.
 */
export function SearchBox({ corporate, onPick }: Props) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [places, setPlaces] = useState<Places | null>(null)
  const [placesState, setPlacesState] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle')
  const input = useRef<HTMLInputElement>(null)
  const listId = useId()

  const ensurePlaces = () => {
    if (placesState === 'loading' || placesState === 'ready') return
    setPlacesState('loading')
    loadPlaces().then((p) => {
      setPlaces(p)
      setPlacesState(p ? 'ready' : 'failed')
    })
  }

  const index = useMemo(() => buildIndex(corporate, places), [corporate, places])
  const labels = useMemo(() => groupLabels(places), [places])
  // Typing stays responsive; ranking ~15 000 entries trails a keystroke at most.
  const q = useDeferredValue(query)
  const pool = useMemo(() => index.search(q, POOL), [index, q])
  const counts = useMemo(() => countGroups(pool), [pool])
  const activeFilter = filter && counts.has(filter) ? filter : null
  const groups = useMemo(() => groupHits(pool, labels, activeFilter, activeFilter ? 30 : 10), [pool, labels, activeFilter])
  const flat = useMemo(() => groups.flatMap((g) => g.hits), [groups])
  // Chips in the order the categories are listed, companies first.
  const chips = Object.keys(labels).filter((id) => counts.has(id))

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) {
        e.preventDefault()
        input.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const pick = (h: Hit) => {
    setQuery(hitTitle(h))
    setOpen(false)
    input.current?.blur()
    onPick(h)
  }
  const showList = open && query.trim().length > 0
  const loadingPlaces = placesState === 'loading' || placesState === 'idle'
  // Index of each group's first option in the flat list (for ↑ ↓ and aria-activedescendant).
  const starts = groups.map((_, g) => groups.slice(0, g).reduce((sum, x) => sum + x.hits.length, 0))

  return (
    <div className="search" role="search">
      <SearchIcon />
      <input
        ref={input}
        value={query}
        placeholder="Search companies, places, streets"
        aria-label="Search companies, places and streets in Hyderabad"
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-activedescendant={showList && flat[active] ? `${listId}-${active}` : undefined}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => {
          setQuery(e.target.value)
          if (!e.target.value.trim()) setFilter(null) // a new search starts unfiltered
          setActive(0)
          setOpen(true)
        }}
        onFocus={() => {
          setOpen(true)
          ensurePlaces()
        }}
        onBlur={() => window.setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setActive((a) => Math.min(a + 1, flat.length - 1))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setActive((a) => Math.max(a - 1, 0))
          } else if (e.key === 'Enter' && flat[active]) {
            pick(flat[active])
          } else if (e.key === 'Escape') {
            setOpen(false)
            input.current?.blur()
          }
        }}
      />
      {query ? (
        <button
          className="icon-btn ghost"
          aria-label="Clear search"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            setQuery('')
            setFilter(null)
            input.current?.focus()
          }}
        >
          <CloseIcon size={16} />
        </button>
      ) : (
        <kbd className="hint" aria-hidden="true">/</kbd>
      )}
      {showList ? (
        // Keep focus in the input while clicking chips and results.
        <div className="results" onMouseDown={(e) => e.preventDefault()}>
          {chips.length > 1 ? (
            <div className="filters" role="toolbar" aria-label="Filter results">
              <button className="filter" aria-pressed={!activeFilter} onClick={() => { setFilter(null); setActive(0) }}>
                All
              </button>
              {chips.map((id) => (
                <button
                  key={id}
                  className="filter"
                  aria-pressed={activeFilter === id}
                  onClick={() => {
                    setFilter(activeFilter === id ? null : id)
                    setActive(0)
                  }}
                >
                  {labels[id]} <span className="count">{counts.get(id)! >= POOL ? `${POOL}+` : counts.get(id)}</span>
                </button>
              ))}
            </div>
          ) : null}
          <div id={listId} role="listbox" aria-label="Search results">
            {groups.map((g, gi) => (
              <div key={g.id} role="group" aria-label={g.label}>
                <div className="results-group" aria-hidden="true">{g.label}</div>
                {g.hits.map((h, hi) => {
                  const i = starts[gi] + hi
                  return (
                    <div
                      key={hitKey(h)}
                      id={`${listId}-${i}`}
                      role="option"
                      aria-selected={i === active}
                      className={`result${i === active ? ' active' : ''}`}
                      onMouseEnter={() => setActive(i)}
                      onClick={() => pick(h)}
                    >
                      <span className={`monogram${h.type === 'site' ? '' : ' plain'}`} aria-hidden="true">
                        {hitTitle(h).slice(0, 1).toUpperCase()}
                      </span>
                      <span className="result-text">
                        <span className="result-name">{hitTitle(h)}</span>
                        <span className="result-sub">{hitSub(h)}</span>
                      </span>
                      {h.type === 'site' && h.site.status === 'unverified' ? <span className="chip unverified">Unverified</span> : null}
                      {hitGroup(h) === 'office' ? <span className="tag" title="Listed in OpenStreetMap; not verified">OSM</span> : null}
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
          {!flat.length ? (
            <div className="results-empty">
              {loadingPlaces ? 'Loading places…' : 'No matches. Try another spelling, or a nearby area or street.'}
            </div>
          ) : null}
          {placesState === 'failed' ? <div className="results-empty">Places could not be loaded; only companies are searched.</div> : null}
        </div>
      ) : null}
    </div>
  )
}

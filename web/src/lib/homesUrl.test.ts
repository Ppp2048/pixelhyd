import { describe, expect, it } from 'vitest'
import { NO_PREFERENCES } from './homes'
import { decodeHomes, encodeHomes, type HomesUrl } from './homesUrl'

const state: HomesUrl = {
  workplace: { lat: 17.440462, lon: 78.382852, label: 'Mindspace Technology Park' },
  prefs: {
    ...NO_PREFERENCES,
    budget: 40000,
    bhk: [2, 3],
    furnishing: 'semi-furnished',
    neighbourhoods: ['madhapur', 'kondapur'],
    maxCommute: 30,
    amenities: ['hospital', 'metro'],
  },
  society: 'my-home-abhra',
  compare: ['my-home-abhra', 'aparna-sarovar'],
}

describe('residential mode in the URL', () => {
  it('round-trips every preference', () => {
    expect(decodeHomes(new URLSearchParams(encodeHomes(state)))).toEqual(state)
  })

  it('round-trips the PG choices, and a society-only search writes none of them', () => {
    const pgs: HomesUrl = {
      ...state,
      prefs: { ...state.prefs, show: 'both', sharing: ['double'], gender: ['women', 'mixed'], services: ['food', 'ac'], confirmed: true },
      society: 'pg-zolo-bourbon',
      compare: ['my-home-abhra', 'pg-zolo-bourbon'],
    }
    expect(decodeHomes(new URLSearchParams(encodeHomes(pgs)))).toEqual(pgs)
    expect(encodeHomes(state).map(([k]) => k)).not.toContain('ht')
    expect(decodeHomes(new URLSearchParams('hw=17.44,78.38&ht=pg&hr=double,quad,double&hg=other&hi=pool&hv=yes'))!.prefs).toEqual({
      ...NO_PREFERENCES,
      show: 'pgs',
      sharing: ['double'],
    })
  })

  it('writes only what is set', () => {
    const minimal: HomesUrl = { ...state, prefs: NO_PREFERENCES, society: null, compare: [] }
    expect(encodeHomes(minimal).map(([k]) => k)).toEqual(['hw', 'hl'])
    expect(decodeHomes(new URLSearchParams(encodeHomes(minimal)))).toEqual(minimal)
  })

  it('is off without a valid workplace', () => {
    expect(decodeHomes(new URLSearchParams(''))).toBeUndefined()
    expect(decodeHomes(new URLSearchParams('hw=abc&hb=40000'))).toBeUndefined()
    expect(decodeHomes(new URLSearchParams('hw=95,78'))).toBeUndefined()
  })

  it('drops values it does not understand', () => {
    const h = decodeHomes(new URLSearchParams('hw=17.44,78.38&hb=-5&hk=2,7,x&hf=luxury&hc=0'))!
    expect(h.prefs).toEqual({ ...NO_PREFERENCES, bhk: [2] })
    expect(h.workplace.label).toBe('Chosen workplace')
  })

  it('keeps at most three compared societies, once each', () => {
    expect(decodeHomes(new URLSearchParams('hw=17.44,78.38&hx=a,b,a,,c,d'))!.compare).toEqual(['a', 'b', 'c'])
  })
})

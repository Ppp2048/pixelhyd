import { describe, expect, it } from 'vitest'
import { editDistance, search, type SearchItem } from './search'

const items: SearchItem<string>[] = [
  { terms: ['Microsoft', 'Microsoft India Development Center', 'Gachibowli'], value: 'msft' },
  { terms: ['Wells Fargo', 'Wells Fargo Tower 4', 'Raidurg'], value: 'wf' },
  { terms: ['Infosys', 'Gachibowli'], value: 'infy' },
]

describe('search', () => {
  it('matches prefixes and whole names', () => {
    expect(search(items, 'micro')).toEqual(['msft'])
    expect(search(items, 'wells fargo')).toEqual(['wf'])
  })
  it('tolerates typos', () => {
    expect(search(items, 'microsfot')).toEqual(['msft'])
    expect(search(items, 'wels farg')).toEqual(['wf'])
  })
  it('finds aliases and areas, main names first', () => {
    expect(search(items, 'tower 4')).toEqual(['wf'])
    expect(search(items, 'gachibowli')).toEqual(['msft', 'infy'])
  })
  it('needs every word to match', () => {
    expect(search(items, 'microsoft raidurg')).toEqual([])
    expect(search(items, '')).toEqual([])
  })
  it('counts an adjacent swap as one edit', () => {
    expect(editDistance('fargo', 'fagro', 2)).toBe(1)
  })
})

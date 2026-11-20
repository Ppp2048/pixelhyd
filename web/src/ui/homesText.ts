/** Wording shared by the home search panel, the society card and the map's hover text. */
import { METRO, type Check, type Preference, type Verdict } from '../lib/homes'
import { SERVICE_TEXT } from '../lib/pgs'

export const VERDICT_TEXT: Record<Verdict, string> = {
  match: 'Match',
  likely: 'Likely match',
  unknown: 'Not enough data',
  no: 'Does not match',
}

const PREF_LABEL: Record<Preference, string> = {
  budget: 'Rent',
  bhk: 'BHK',
  furnishing: 'Furnishing',
  commute: 'Drive',
  neighbourhood: 'Area',
  amenity: 'Nearby',
  sharing: 'Sharing',
  gender: 'Who can stay',
  service: 'Included',
  listing: 'Listing',
}

export const checkLabel = (c: Check, categories: Record<string, string>) =>
  c.pref === 'service' && c.service
    ? SERVICE_TEXT[c.service]
    : c.pref !== 'amenity'
      ? PREF_LABEL[c.pref]
      : c.amenity === METRO
        ? 'Metro'
        : categories[c.amenity ?? ''] ?? c.amenity ?? 'Nearby'

export const rupees = (n: number) => `₹${n.toLocaleString('en-IN')}`

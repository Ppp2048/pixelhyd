# Company and office-site data model — plan

Status: **design approved 2026-11-27. B1–B4 implemented 2026-11-27 (not committed):** `corporate_model.py`
(structures, confidence, validation), `corporate_migrate.py` (migration; report in
`pipeline/corporate/migration-report.md`), and `corporate.py` now builds from `companies.json` / `sites.json` /
`leads.json`. The rebuilt `corporate.json` matched the previous file in every v1 field (only `generated_at`
and the §5 additions differ). **B5 (2026-11-27):** `matches.json` retired. Every record field was checked as
transferred to `sites.json` / `leads.json`, and the file is kept byte for byte at
`pipeline/corporate/legacy/matches-2026-11.json` (SHA-256 `42832153…4fb4e1db`). The migration is retired too:
`hitec-pipeline corporate migrate` only prints a notice, and `companies.json`, `sites.json` and `leads.json` are
edited directly from now on. `corporate_migrate.py` stays as the record of the migration; its tests re-run it on
the archived inputs and check the output against the recorded checksums. Workstream 2 of the November 2026 audit
([audit-2026-11.md](audit-2026-11.md), finding C1). Implementation needs a separate approval.

Approved decisions:

1. The existing research seed is version-controlled, byte for byte (done: see §9).
2. `matches.json` is merged into `sites.json`, which becomes the single source of truth for office sites.
3. Confidence is computed by the deterministic rules in §4.4, never entered by hand.
4. `leads.json` holds the four Financial District discoveries and the aVance property inventory.

## 1. Current model

| Part | What it is |
|---|---|
| `data/corporate/pixelhyd_hyderabad_corporate_seed_dataset.json` (and `.csv`) | 10 research rows, all `last_checked` 2026-11-19. `company_id` (e.g. `microsoft_india_development_center`) really names *a company at one property*. Columns `building_osm_id`, `building_overture_id`, `latitude` and `longitude` are empty in every row. **Git-ignored** (under `data/`) |
| `pipeline/corporate/matches.json` | One entry per seed row: `status` (`confirmed`, `unverified`, `needs_manual_verification`), `match`, a named OSM `campus` and `buildings` with `expect_name`, plus `match_note` or `reason`. Tracked in git |
| `pipeline/src/hitec_pipeline/corporate.py` | `build()` joins seed and matches and resolves OSM ids through `locate()` (also used by `places.py` and `residential.py`). It checks names and campus containment, and writes `web/public/data/corporate.json` with only `confirmed` and `unverified` entries |
| `web/src/types.ts` `CorporateSite` / `CorporateData` | The output shape |
| `web/src/lib/corporate.ts` | `indexCorporate`: `byId`, `byBuilding`, `confirmedBuildings`, search entries (`company_name`, `brand_or_entity`, `campus_or_property`, campus and building names, `city_area`); `siteTitle`, `sitePlace` |
| Other consumers | `MapView.tsx` (dots for confirmed sites, building outlines, tooltips, `flyToSite`); `Inspector.tsx` (company section: status chip, sector, campus, buildings, address, `match_note`, `source_note`, `evidence_level`, `last_checked`, sources); `discover.ts` (search hits); `App.tsx` (`?s=<site id>` in shared links, "Find homes near" label) |

## 2. Why one company cannot have several offices

1. **No company entity.** A row is a company *at one place*. A second Amazon office needs a second row
   with a new ad-hoc id, and only the free-text `company_name` would link them; search would show two
   unrelated "Amazon" results.
2. **A row's footprint must agree with its single address.** When OSM names a different site, the only
   option is rejection. This has already happened four times:
   - Amazon: way 782009439
   - Google: way 1247721916
   - Cognizant: way 342243558
   - Cyient: way 879132633
3. **Verification is spread over three unstructured fields:** seed `verification_status` (free text),
   seed `evidence_level` (free text) and `matches.json` `status`. There is no confidence, no source type
   and no retrieval date per source, and at most two URLs per row.
4. **A non-company row is mixed in.** `avance_business_hub_building_inventory` has no company; it is a
   property's building list.
5. **The research claims are not versioned.** The seed is git-ignored; only the links in `matches.json` are
   tracked.

## 3. Files (source of truth, all in `pipeline/corporate/`, tracked)

| File | Holds |
|---|---|
| `companies.json` | Who: id, canonical name, aliases, sector, notes |
| `sites.json` | Each office: company, place, footprint links (from `matches.json`), status, evidence, history |
| `leads.json` | Unpublished research leads: candidate sites and property inventories |
| `legacy/seed-2026-11-19.json` | The original seed, byte for byte, kept for provenance (never edited) |

After migration, `matches.json` and the git-ignored seed are no longer read by the build.
`matches.json` is deleted only in the implementation change that replaces it.

## 4. Schema

### 4.1 Company

```json
{
  "id": "microsoft",
  "name": "Microsoft",
  "aliases": ["Microsoft India Development Center (IDC)"],
  "sector": "Technology / Software / R&D",
  "notes": null
}
```

- `id`: lowercase slug, unique, never reused.
- `aliases`: only names that appear in a cited source or in the seed; no invented variants.

### 4.2 Site (office)

```json
{
  "id": "microsoft_india_development_center",
  "company_id": "microsoft",
  "entity": "Microsoft India Development Center (IDC)",
  "property": "Microsoft Hyderabad Campus",
  "building_name": "Building 3 (candidate specific building); campus has 3 buildings",
  "address": "ISB Road, Gachibowli, Hyderabad, Telangana 500032, India",
  "city_area": "Gachibowli",
  "association_type": "campus_and_named_building_candidate",
  "operational_status": { "value": "active", "as_of": "2026-11-19" },
  "presence": "confirmed",
  "footprint": {
    "basis": "campus",
    "campus": { "osm_id": "w159299918", "expect_name": "Microsoft" },
    "buildings": [{ "osm_id": "w543748700", "expect_name": "Microsoft Building 1" }],
    "note": "<matches.json match_note, verbatim>"
  },
  "evidence": [
    { "url": "https://www.microsoft.com/en-in/msidc/", "type": "official", "publisher": "Microsoft",
      "retrieved": "2026-11-19", "supports": ["presence", "address"], "note": null }
  ],
  "evidence_summary": "<seed evidence_level, verbatim>",
  "source_note": "<seed source_note, verbatim>",
  "legacy": { "verification_status": "<seed text, verbatim>" },
  "last_checked": "2026-11-19",
  "history": []
}
```

(The values are illustrative, taken from the existing Microsoft records; the migration copies the real
values exactly.)

| Field | Values | Rule |
|---|---|---|
| `presence` | `confirmed`, `probable`, `unverified`, `closed` | Is the company at this property? Graded by evidence (§4.3) |
| `footprint.basis` | `campus`, `building`, `property_only`, `address_only`, `none` | How the site is tied to the map. Only `campus` and `building` carry OSM refs, and only they can be published |
| `operational_status.value` | `active`, `under_construction`, `closed`, `unknown` | Always with `as_of` (ISO date) |
| `evidence[].type` | `official`, `annual_report`, `regulatory`, `property_owner`, `press`, `listing`, `osm`, `third_party` | Source kind |
| `evidence[].supports` | `presence`, `address`, `building`, `status`, or `[]` | What the source says, not what we infer. `[]` is a **retained context-only source** (added 2026-11-27, B3): the seed cites it, but it says nothing about the company at this site (e.g. a city-wide list of companies). It is kept in `evidence` and in the output `sources`, but it never counts towards `presence`, confidence or publication |
| `history[]` | `{ "date", "change", "by", "reason" }` | Appended on every status, footprint or evidence change; ids are never deleted |

### 4.3 What evidence can establish

| `presence` | Needs |
|---|---|
| `confirmed` | ≥ 1 source of type `official`, `annual_report` or `regulatory` with `supports` ∋ `presence`, `retrieved` ≤ `last_checked` |
| `probable` | ≥ 1 `press` or `property_owner` source supporting presence (property owners name tenants only when they say so) |
| `unverified` | Anything less: listings, third parties, or no source |
| `closed` | A source supporting `status` that the office closed or moved; never published |

An `osm` source supports `building` (a footprint's name) but never `presence`; an OSM building named after a
company is not proof that the company is there. A `property_owner` source may confirm building names, not
occupants.

### 4.4 Confidence (computed, deterministic)

Inputs:
- `presence`;
- `footprint.basis`;
- `age`: whole months since `last_checked`, measured against the build date, or a fixed date in tests.

| Confidence | Rule (first that applies) |
|---|---|
| none (`null`) | `presence` = `closed` |
| `low` | `last_checked` missing or unreadable, or `age` > 24 months |
| `high` | `presence` = `confirmed` and `basis` ∈ {`campus`, `building`} and `age` ≤ 12 |
| `medium` | `presence` = `confirmed` (any other basis, or `age` 13–24); or `presence` = `probable` and `basis` ∈ {`campus`, `building`} and `age` ≤ 12 |
| `low` | Everything else (including every `unverified` site) |

The thresholds (12 and 24 months) are named constants in code and match the rent rule in
`web/src/lib/freshness.ts`. Confidence is written into the output and never stored in `sites.json`.

### 4.5 Lead

```json
{
  "id": "lead-amazon-financial-district",
  "kind": "candidate_site",
  "company_id": "amazon",
  "osm": [{ "osm_id": "w782009439", "name": "<OSM name as found>" }],
  "found": "2026-11-19",
  "why_not_a_site": "Named in OSM only; no company source places Amazon here yet.",
  "source": "pipeline/corporate/matches.json reason for amazon_development_centre_hyderabad"
}
```

| `kind` | Use |
|---|---|
| `candidate_site` | A place a company may occupy, pending a company source |
| `property_inventory` | A property's buildings with no company (the aVance row) |

A lead becomes a site only through a research change that adds qualifying evidence. Leads are never
published.

## 5. Output: `web/public/data/corporate.json` (backward compatible)

**Unchanged.** `sites[]` keeps every current field with the same name and meaning:

| Output field | Source |
|---|---|
| `id` | Site id, unchanged, so `?s=` links keep working |
| `company_name` | Company `name` |
| `brand_or_entity` | Site `entity` |
| `sector` | Company `sector` |
| `campus_or_property` | `property` |
| `building_name`, `address`, `city_area`, `association_type`, `source_note`, `last_checked` | Site fields of the same names |
| `evidence_level` | `evidence_summary` |
| `verification_status` | `legacy.verification_status` (for migrated rows) or a generated phrase |
| `sources` | `evidence[].url` |
| `match` | Footprint basis |
| `match_note` | `footprint.note` |
| `campus`, `buildings`, `lat`, `lon` | Resolved exactly as today |

The publishing rule is unchanged:

- A site is published only when `footprint.basis` is `campus` or `building` and its refs resolve, and
  `presence` is not `closed`.
- `status: "confirmed"` means `presence` = `confirmed` **and** a footprint whose OSM name matches.
- Every other published site is `"unverified"`.

**Added (ignored by the current app):**
- per site: `company_id`, `presence`, `footprint_basis`, `confidence`, `operational_status`,
  `evidence` (structured), `stale` (age > 12 months);
- at the top level: `schema_version: 2` and `companies[]` (companies with at least one published site).

`types.ts` gets these as optional fields only. No UI change in this workstream; grouping search results by
company and listing "other sites" on a card would be a separate, later UI phase.

## 6. Migration (one-off, `hitec-pipeline corporate migrate`)

No company or site is invented, merged, duplicated or upgraded.

1. **Seed preserved:** done (§9).
2. **Companies:** one per distinct non-empty `company_name` in the seed, 9 in all:

   | | | |
   |---|---|---|
   | Microsoft | Google | Amazon |
   | Cognizant | Cyient | Deloitte |
   | Wells Fargo | JPMorgan Chase | EY |

   Aliases: the row's `brand_or_entity` when it differs from the name. Sector: the seed's `sector`.
3. **Sites:** each of the 9 company rows becomes one site with **the same id**, and every text field is
   copied verbatim. Footprint data is copied from the row's `matches.json` entry.
   - Evidence: `source_url` and `supporting_source_url`, typed by a reviewed table (one row per URL) and
     `retrieved` = the seed's `last_checked`.
   - Statuses are mapped, never raised:

   | Today (`matches.json`) | `presence` | `footprint.basis` | Published | Confidence (at 2026-11-27) |
   |---|---|---|---|---|
   | Microsoft: `confirmed` | `confirmed` | `campus` | yes, `confirmed` | `high` |
   | Wells Fargo: `unverified` | `unverified` | `building` | yes, `unverified` | `low` |
   | 7 others: `needs_manual_verification` | `unverified` | `none` | no (as today) | `low` |

   `operational_status`: `unknown` with `as_of` = `last_checked` unless a cited source states otherwise.
4. **Leads (5):**
   - The four Financial District OSM discoveries, from the `reason` text in `matches.json`: Amazon
     (w782009439), Google (w1247721916, under construction), Cognizant (w342243558), Cyient (w879132633).
   - The aVance row, as a `property_inventory`.
5. **Equivalence check:** `corporate.json` built from the migrated files must equal today's file field for
   field (ignoring `generated_at` and the added fields).
6. The command is **idempotent**: a second run produces identical files.

## 7. Validation rules (the build fails)

| Area | Rule |
|---|---|
| Structure | JSON schema and fixed values; every `site.company_id` exists; ids unique, slug-shaped, never reused (closed sites keep their id) |
| Evidence | `presence` meets §4.3; `osm` sources never support `presence`; `retrieved` ≤ `last_checked` ≤ build date |
| Duplicates | Two companies with colliding normalised names or aliases. Two sites of one company sharing an OSM footprint, or with the same normalised `property` + `address`. Sites of different companies may share a building (multi-tenant); overlapping claims to the same whole campus give a warning |
| Map links | As today: OSM ids resolve; the OSM name contains `expect_name` (case-insensitive); buildings lie inside the campus (5 m tolerance) |
| Sources | `https` only; Google Maps links (`google.*/maps`, `maps.app.goo.gl`, `goo.gl/maps`) rejected (CLAUDE.md rule 3) |
| Coordinates | Published coordinates come only from resolved footprints; no hand-entered latitude/longitude |
| Freshness | Age > 12 months: warning and `stale: true`; > 24 months: warning and confidence `low` |
| Leads | Every lead has `why_not_a_site` and a source; a lead id never equals a site id |

## 8. Tests and acceptance criteria

**Pipeline (`pipeline/tests/test_corporate.py`, extended):**
- The three existing tests, ported to the new inputs.
- **Golden compatibility:** migrated inputs produce today's `corporate.json` fields.
- **One company with two published sites:** both are published and the company appears once in `companies[]`.
- **Presence rules:**
  - An `osm`-only source cannot confirm.
  - A `press` source gives at most `probable`.
  - A `closed` site is not published.
- **Confidence table:** one case per row of §4.4, at a fixed "today".
- **Duplicates:** duplicate site, footprint shared within one company, alias collision.
- **Sources:** a Google Maps source is rejected; `stale` is set.
- **Migration:**
  - idempotent;
  - produces 9 companies, 9 sites and 5 leads;
  - no new site ids;
  - every seed field is accounted for.

**Web:**
- `indexCorporate` gives identical `byId`, `byBuilding`, `confirmedBuildings` and search terms for the v1
  file and the v2 file built from the same data.
- A v1 file without the new fields still loads.

**Acceptance:**
- One company can hold any number of sites, each with its own location, footprint, evidence, status and
  computed confidence.
- With today's data, the published file is unchanged apart from added fields. The app needs no change, and
  `?s=` links open the same sites.
- The migration adds, merges or upgrades nothing. The seed stays preserved byte for byte.
- All suites, the type check and lint pass.

## 9. Done in this step (2026-11-27)

The seed was copied to `pipeline/corporate/legacy/seed-2026-11-19.json`. Not committed.

| | |
|---|---|
| Size | 11,828 bytes |
| SHA-256 | `be6c23550ba66f8c05e8f79487fef35ee0549b19c61fd4fc667b7fc9a924d521` (identical to `data/corporate/pixelhyd_hyderabad_corporate_seed_dataset.json`; `cmp` found no difference) |
| Git status | Not ignored, so it is ready to be committed |

The `.csv` export of the same seed was not copied; the JSON is the file the build reads.

## 10. Implementation order (after approval)

1. Schema, validation and confidence (pure functions) with tests.
2. `corporate migrate` and its outputs (`companies.json`, `sites.json`, `leads.json`), checked against the
   golden output.
3. `corporate.py` reads the new files; `matches.json` is retired in the same change.
4. `types.ts`: optional fields only.

Files likely to change: `pipeline/src/hitec_pipeline/corporate.py`, `pipeline/tests/test_corporate.py`,
`pipeline/corporate/*` and `web/src/types.ts`. `locate()` keeps its signature (also used by `places.py` and
`residential.py`).

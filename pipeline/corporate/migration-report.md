# Corporate migration report

Seed: `pipeline/corporate/legacy/seed-2026-11-19.json` (SHA-256 `be6c23550ba66f8c05e8f79487fef35ee0549b19c61fd4fc667b7fc9a924d521`) and `pipeline/corporate/matches.json`.
Validated with `corporate_model.validate` at 2026-11-27: no errors, 0 warnings.

9 companies, 9 sites, 5 leads.

| Output | SHA-256 |
|---|---|
| `companies.json` | `7b8109d675c011330d4984f90532f9fbdfd2215c5d0af8c3b5282c04b8f72e91` |
| `sites.json` | `1b9a6d71dc6ecb09a1f1e3e2150c0e50314666a1df5da7abb19074e2c71b4d32` |
| `leads.json` | `dedadb57da1d2f55b11a92c5964b0f742b909f52ba9737ea957a8656dbd18234` |

## Every source record and its destination

| Source record | Destination | Presence | Basis | Published | Confidence |
|---|---|---|---|---|---|
| `microsoft_india_development_center` | sites.json microsoft_india_development_center (company microsoft) | confirmed | campus | yes | high |
| `google_hyderabad` | sites.json google_hyderabad (company google) | unverified | none | no | low |
| `amazon_development_centre_hyderabad` | sites.json amazon_development_centre_hyderabad (company amazon) | unverified | none | no | low |
| `cognizant_mindspace_hyderabad` | sites.json cognizant_mindspace_hyderabad (company cognizant) | unverified | none | no | low |
| `cyient_infocity_madhapur` | sites.json cyient_infocity_madhapur (company cyient) | unverified | none | no | low |
| `deloitte_meenakshi_techpark` | sites.json deloitte_meenakshi_techpark (company deloitte) | unverified | none | no | low |
| `wells_fargo_divyasree_orion` | sites.json wells_fargo_divyasree_orion (company wells-fargo) | unverified | building | yes | low |
| `jpmorgan_sattva_knowledge_city` | sites.json jpmorgan_sattva_knowledge_city (company jpmorgan-chase) | unverified | none | no | low |
| `ey_skyview_10` | sites.json ey_skyview_10 (company ey) | unverified | none | no | low |
| avance_business_hub_building_inventory | leads.json avance_business_hub_building_inventory (property_inventory) | | | no (lead) | |
| matches.json amazon_development_centre_hyderabad (way 782009439) | leads.json lead-amazon-financial-district (candidate_site) | | | no (lead) | |
| matches.json google_hyderabad (way 1247721916) | leads.json lead-google-financial-district (candidate_site) | | | no (lead) | |
| matches.json cognizant_mindspace_hyderabad (way 342243558) | leads.json lead-cognizant-financial-district (candidate_site) | | | no (lead) | |
| matches.json cyient_infocity_madhapur (way 879132633) | leads.json lead-cyient-financial-district (candidate_site) | | | no (lead) | |

## Evidence typing

| Site | Type | Supports | URL |
|---|---|---|---|
| `microsoft_india_development_center` | official | presence | https://www.microsoft.com/en-in/msidc/hyderabad-campus |
| `microsoft_india_development_center` | regulatory | [] context only | https://www.hmda.gov.in/wp-content/uploads/2020/07/Kokapet.pdf |
| `google_hyderabad` | regulatory | [] context only | https://www.hmda.gov.in/wp-content/uploads/2020/07/Kokapet.pdf |
| `amazon_development_centre_hyderabad` | property_owner | presence | https://www.capitaland.com/en/about-capitaland/newsroom/news-releases/international/2021/feb/a-iTrust-entered-definitive-agreements-proposed-acquisition-aVance-6-Hyderabad.html |
| `amazon_development_centre_hyderabad` | property_owner | [] context only | https://www.capitaland.com/en/find-a-property/global-property-listing/businesspark-industrial-logistics/avance-hitec-cityhyderabad.html |
| `cognizant_mindspace_hyderabad` | property_owner | building | https://www.mindspaceindia.com/madhapur/ |
| `cyient_infocity_madhapur` | annual_report | presence, address | https://www.cyient.com/hubfs/2027/Investors/Financial-Information/annual-report/35th%20Annual%20Report%20FY%202025-26.pdf |
| `deloitte_meenakshi_techpark` | regulatory | [] context only | https://www.hmda.gov.in/wp-content/uploads/2020/07/Kokapet.pdf |
| `wells_fargo_divyasree_orion` | regulatory | [] context only | https://www.nsearchives.nseindia.com/corporate/MINDSPACE_24072025083436_AcquisitionofQCity.pdf |
| `jpmorgan_sattva_knowledge_city` | third_party | presence | https://hyderabadoffices.blogspot.com/ |
| `jpmorgan_sattva_knowledge_city` | property_owner | [] context only | https://www.mindspaceindia.com/clients/ |
| `ey_skyview_10` | annual_report | address | https://www.cyient.com/hubfs/2027/Investors/Financial-Information/annual-report/35th%20Annual%20Report%20FY%202025-26.pdf |

## Seed fields

company_id → site id (lead id for the aVance row); company_name, sector → company; brand_or_entity → site entity and company alias; campus_or_property → property; building_name, address, city_area, association_type, source_note, last_checked → site; evidence_level → evidence_summary; verification_status → legacy.verification_status; source_url, supporting_source_url → evidence; building_osm_id, building_overture_id, latitude, longitude → empty in every row, not copied. The aVance row is kept whole in its lead's seed_record. matches.json status → legacy.matches_status and presence; match, campus, buildings → footprint; match_note or reason → footprint.note.

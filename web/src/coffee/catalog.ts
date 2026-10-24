// SPDX-License-Identifier: GPL-2.0-or-later
import type { BeanInput, BeanProcess, CoffeeMetadata, RoastColor } from '../engine/shotTypes';

/** A dated, manually curated factual record, not a live inventory or measured chemistry dataset. */
export interface CoffeeCatalogEntry {
  id: string;
  name: string;
  roaster: string;
  country: string;
  region?: string;
  producer?: string;
  varieties: string[];
  process_label: string;
  process?: BeanProcess;
  roast_label?: string;
  /** Explicit modelling estimate from the roaster's label, never an Agtron conversion. */
  roast_level?: number;
  altitude_m?: number;
  altitude_range_m?: [number, number];
  arabica_fraction: 0 | 1;
  source_url: string;
  verified_at: string;
  harvest?: string;
  roast_color?: RoastColor;
  availability: 'current' | 'archived' | 'unknown';
  assumptions: string[];
}

const VERIFIED_AT = '2026-10-23';
const COMMON_ASSUMPTIONS = [
  'Roast index is an editable estimate from the published roast label, not measured roast chemistry or a conversion from roast color.',
  'Arabica share is inferred from the listed varieties and origin; no species assay was supplied.',
  'Roast date, age, storage, bean temperature and physical coefficients are not supplied by this listing. Enter your bag details; otherwise simulator defaults apply.',
];

function entry(
  facts: Omit<
    CoffeeCatalogEntry,
    'verified_at' | 'availability' | 'arabica_fraction' | 'assumptions'
  > & {
    availability?: CoffeeCatalogEntry['availability'];
    assumptions?: string[];
  },
): CoffeeCatalogEntry {
  return {
    ...facts,
    verified_at: VERIFIED_AT,
    availability: facts.availability ?? 'current',
    arabica_fraction: 1,
    assumptions: [...COMMON_ASSUMPTIONS, ...(facts.assumptions ?? [])],
  };
}

/**
 * Single-origin lots only. A producer/cooperative lot can contain multiple cultivars;
 * it is not a recipe assembled from coffees of different origins. Product names,
 * short factual fields and source links are retained; no retailer prose or images.
 * Seasonal records are snapshots: a returning name does not establish the same lot.
 */
export const COFFEE_CATALOG: readonly CoffeeCatalogEntry[] = [
  entry({
    id: 'counter-culture-idido-2026',
    name: 'Idido',
    roaster: 'Counter Culture',
    country: 'Ethiopia',
    region: 'Yirgacheffe',
    producer: 'Idido cooperative',
    varieties: [
      'Kurume',
      'Wolisho',
      'Dega',
      '74110',
      '74112',
      '74165',
      'JARC Yirgacheffe Specialty varieties',
    ],
    process_label: 'Washed',
    process: 'washed',
    roast_label: 'Light',
    roast_level: 0.25,
    altitude_range_m: [1900, 2400],
    harvest: 'November 2025–January 2026',
    source_url: 'https://counterculturecoffee.com/collections/single-origins/products/idido',
    assumptions: [
      'The listing projects availability through mid-December 2026; that is not a stock guarantee.',
    ],
  }),
  entry({
    id: 'counter-culture-finca-el-puente-honey-2026',
    name: 'Finca El Puente — Honey Processed',
    roaster: 'Counter Culture',
    country: 'Honduras',
    region: 'Marcala',
    producer: 'Marysabel Caballero and Moisés Herrera',
    varieties: ['Catuai'],
    process_label: 'Honey',
    process: 'honey',
    roast_label: 'Light',
    roast_level: 0.25,
    altitude_range_m: [1500, 1680],
    harvest: 'January–March 2026',
    source_url:
      'https://counterculturecoffee.com/collections/single-origins/products/finca-el-puente-honey',
  }),
  entry({
    id: 'onyx-las-lajas-natural-2026',
    name: 'Costa Rica Las Lajas Natural',
    roaster: 'Onyx Coffee Lab',
    country: 'Costa Rica',
    producer: 'Las Lajas',
    varieties: ['Catuai', 'Caturra'],
    process_label: 'Natural',
    process: 'natural',
    roast_label: 'Light',
    roast_level: 0.25,
    altitude_m: 1600,
    roast_color: {
      scale: 'agtron-gourmet',
      value: 128,
      sample: 'ground',
      instrument: 'Agtron M Basic III',
    },
    source_url: 'https://onyxcoffeelab.com/products/costa-rica-las-lajas-natural-26',
    assumptions: [
      'Published ground Agtron 128 is retained as reported; it does not determine the model roast index.',
    ],
  }),
  entry({
    id: 'onyx-aponte-village-honey-2026',
    name: 'Colombia Aponte Village Honey',
    roaster: 'Onyx Coffee Lab',
    country: 'Colombia',
    region: 'Aponte, Nariño',
    producer: 'Inga producers of Aponte',
    varieties: ['Field Blend (individual cultivars unspecified)'],
    process_label: 'Red Honey',
    process: 'honey',
    roast_label: 'Light',
    roast_level: 0.25,
    altitude_m: 2100,
    roast_color: {
      scale: 'agtron-gourmet',
      value: 128,
      sample: 'ground',
      instrument: 'Agtron M Basic III',
    },
    source_url: 'https://onyxcoffeelab.com/products/colombia-aponte-village-honey-26',
    assumptions: [
      'The single-origin community lot contains unspecified cultivars; no cultivar percentages are assumed.',
      'Published ground Agtron 128 is retained as reported; it does not determine the model roast index.',
    ],
  }),
  entry({
    id: 'verve-kiunyu-2026-10',
    name: 'Kenya Kiunyu',
    roaster: 'Verve',
    country: 'Kenya',
    region: 'Kirinyaga',
    producer: 'Kiunyu station / Karithathi Farmers’ Cooperative Society',
    varieties: ['Batian', 'Ruiru', 'SL28'],
    process_label: 'Washed',
    process: 'washed',
    roast_label: 'Light (3/10 on Verve’s scale)',
    roast_level: 0.25,
    altitude_m: 1670,
    source_url: 'https://www.vervecoffee.com/products/kiunyu',
    assumptions: ['Verve’s 3/10 label is its own roast scale, not a calibrated color measurement.'],
  }),
  entry({
    id: 'verve-biftu-gudina-2026-10',
    name: 'Ethiopia Biftu Gudina',
    roaster: 'Verve',
    country: 'Ethiopia',
    region: 'Limu',
    producer: 'Biftu Gudina Cooperative',
    varieties: ['Ethiopian Heirloom'],
    process_label: 'Washed',
    process: 'washed',
    roast_label: 'Light',
    roast_level: 0.25,
    altitude_m: 2100,
    source_url: 'https://www.vervecoffee.com/products/biftu-gudina',
  }),
  entry({
    id: 'intelligentsia-cauca-castillo-2026',
    name: 'Colombia Cauca Castillo Single Origin Espresso',
    roaster: 'Intelligentsia',
    country: 'Colombia',
    region: 'Cauca',
    producer: 'Various smallholders',
    varieties: ['Castillo'],
    process_label: 'Washed',
    process: 'washed',
    roast_label: 'Comforting',
    roast_level: 0.375,
    altitude_range_m: [1600, 1900],
    harvest: 'March–April 2026',
    source_url:
      'https://www.intelligentsia.com/products/colombia-cauca-castillo-single-origin-espresso',
    assumptions: [
      'Comforting is the roaster’s label; 0.375 is a medium-light model starting assumption, not a measured calibration.',
      'The roaster’s suggested espresso recipe is not an observed shot and is not used to fit equipment.',
    ],
  }),
  entry({
    id: 'black-white-ushirika-washed-2026-10',
    name: 'Ushirika — Washed',
    roaster: 'Black & White',
    country: 'Kenya',
    region: 'Nyeri',
    producer: 'Othaya Farmers Cooperative',
    varieties: ['SL28', 'SL34', 'Batian', 'Ruiru 11'],
    process_label: 'Washed',
    process: 'washed',
    roast_label: 'Lighter',
    roast_level: 0.25,
    altitude_range_m: [1600, 1900],
    source_url:
      'https://www.blackwhiteroasters.com/collections/all-coffee/products/r-ushirika-washed',
  }),
  entry({
    id: 'black-white-limu-kossa-washed-2026-10',
    name: 'Limu Kossa — Washed',
    roaster: 'Black & White',
    country: 'Ethiopia',
    region: 'Limu Kossa, Jimma',
    producer: 'Haider Abamecha',
    varieties: ['JARC 7410', '74140', '7440'],
    process_label: 'Washed',
    process: 'washed',
    roast_label: 'Lighter',
    roast_level: 0.25,
    altitude_range_m: [1865, 2090],
    source_url:
      'https://www.blackwhiteroasters.com/collections/all-coffee/products/r-limu-kossa-washed',
    assumptions: [
      'Cultivar identifiers are transcribed as the roaster publishes them, without silently correcting or expanding them.',
    ],
  }),
  entry({
    id: 'george-howell-yulnimox-2025',
    name: 'Yulnimox, Guatemala',
    roaster: 'George Howell',
    country: 'Guatemala',
    region: 'Huehuetenango',
    producer: 'Dominga Perez Juan',
    varieties: ['Caturra'],
    process_label: 'Washed',
    process: 'washed',
    roast_label: 'Light',
    roast_level: 0.25,
    altitude_m: 1798.32,
    harvest: 'March 2025',
    source_url: 'https://georgehowellcoffee.com/products/yulnimox-guatemala',
    assumptions: [
      'Elevation is a unit conversion of the published 5,900 ft, not a new measurement.',
      'The source still lists a March 2025 harvest; harvest year is not roast date.',
    ],
  }),
  entry({
    id: 'george-howell-dota-dark-2026',
    name: 'Dota Dark, Costa Rica',
    roaster: 'George Howell',
    country: 'Costa Rica',
    region: 'Dota, San José Province',
    producer: 'Small farmers',
    varieties: ['Caturra', 'Catuai'],
    process_label: 'Washed',
    process: 'washed',
    roast_label: 'Dark',
    roast_level: 0.8,
    altitude_range_m: [1524, 1889.76],
    harvest: 'January 2026',
    source_url: 'https://georgehowellcoffee.com/products/dota-dark',
    assumptions: ['Elevation endpoints are unit conversions of the published 5,000–6,200 ft.'],
  }),
  entry({
    id: 'klatch-sumatra-mutu-batak-2026-10',
    name: 'Sumatra Mutu Batak',
    roaster: 'Klatch',
    country: 'Indonesia',
    region: 'Sumatra',
    producer: 'Multiple smallholder farms',
    varieties: ['Ateng', 'Jember'],
    process_label: 'Wet-Hulled',
    roast_label: 'Medium',
    roast_level: 0.5,
    source_url: 'https://www.klatchcoffee.com/products/sumatra-mutu-batak',
    assumptions: [
      'Wet-hulled has no matching process in the current simulator; the model process is left unspecified instead of relabelled as washed.',
      'No lot-specific elevation is supplied.',
    ],
  }),
  entry({
    id: 'pts-el-socorro-red-bourbon-2026-10',
    name: 'Finca El Socorro Red Bourbon Washed',
    roaster: 'PT’s Coffee',
    country: 'Guatemala',
    region: 'Palencia, Guatemala Department',
    producer: 'Juan Diego de la Cerda',
    varieties: ['Red Bourbon'],
    process_label: 'Washed',
    process: 'washed',
    roast_label: 'Light',
    roast_level: 0.25,
    altitude_range_m: [1800, 1890],
    source_url: 'https://ptscoffee.com/products/red-bourbon-washed',
    availability: 'unknown',
    assumptions: [
      'Listed in the roaster’s current single-origin collection; the product page did not expose a stock status when checked.',
    ],
  }),
];

/** Creates a fresh leaf; it never invents a bag roast date or measured physical properties. */
export function coffeeToBeanInput(entry: CoffeeCatalogEntry): BeanInput {
  const range = entry.altitude_range_m;
  const altitude = entry.altitude_m ?? (range ? (range[0] + range[1]) / 2 : undefined);
  const altitudeBasis = range
    ? ` Model elevation is the estimated midpoint of the published ${range[0]}–${range[1]} m range.`
    : '';
  const coffee: CoffeeMetadata = {
    id: entry.id,
    name: entry.name,
    roaster: entry.roaster,
    country: entry.country,
    region: entry.region,
    producer: entry.producer,
    varieties: [...entry.varieties],
    process_label: entry.process_label,
    roast_label: entry.roast_label,
    roast_color: entry.roast_color ? { ...entry.roast_color } : undefined,
    source_url: entry.source_url,
    verified_at: entry.verified_at,
    harvest: entry.harvest,
    model_roast_basis: `${entry.assumptions.join(' ')}${altitudeBasis}`,
  };
  return {
    coffee,
    arabica_fraction: entry.arabica_fraction,
    roast_level: entry.roast_level,
    process: entry.process ?? null,
    altitude_m: altitude,
    variety_group: 'unspecified',
  };
}

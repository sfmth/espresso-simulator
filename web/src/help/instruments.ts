// SPDX-License-Identifier: GPL-2.0-or-later
export interface InstrumentSuggestion {
  id: 'scale' | 'timer' | 'thermometer' | 'water-kit' | 'calipers' | 'refractometer';
  name: string;
  purpose: string;
  typicalCost: string;
  priceUsd?: number;
  url: string;
  checkedAt: string;
  limitations: string;
  /** Extra primary references when the price and specifications have different sources. */
  sources?: { label: string; url: string }[];
}

/** US price snapshots, before tax and shipping. Examples with documented specs, not a cheapest-price guarantee. */
export const INSTRUMENTS: readonly InstrumentSuggestion[] = [
  {
    id: 'scale',
    name: 'Greater Goods Premium Coffee Scale (0460)',
    purpose:
      'Weigh the dry dose and beverage yield. The manufacturer specifies 0.1 g increments and a built-in count-up/count-down timer.',
    typicalCost: '$30.99; keep your existing 0.1 g scale if it works well',
    priceUsd: 30.99,
    url: 'https://shop.greatergoods.com/products/premium-coffee-scale-onyx-black',
    checkedAt: '2026-10-23',
    limitations:
      'Display resolution is not a guarantee of accuracy. Check that the scale and cup fit your drip tray, tare before each shot, and let the reading settle. It cannot measure grind size, burr gap or extraction percentage.',
  },
  {
    id: 'timer',
    name: 'Your phone’s stopwatch or the scale’s timer',
    purpose:
      'Record elapsed time with a consistent start and stop event. Use pump-on time when entering pump-on observations.',
    typicalCost: '$0 extra if you already have a phone or a scale with a timer',
    priceUsd: 0,
    url: 'https://support.apple.com/en-asia/guide/iphone/iph96b1e460/ios',
    checkedAt: '2026-10-23',
    limitations:
      'Manual reaction time adds uncertainty. First-drip time and pump-on time are different measurements; do not interchange them.',
    sources: [{ label: 'Android Clock help', url: 'https://support.google.com/clock/faq/6273949' }],
  },
  {
    id: 'thermometer',
    name: 'TempPro (formerly ThermoPro) TP03H probe thermometer',
    purpose:
      'Check room-temperature beans or a collected water sample with a low-cost contact probe.',
    typicalCost: '$15.99 listed sale price ($16.99 regular)',
    priceUsd: 15.99,
    url: 'https://temppro.com/products/tp03h-instant-read-meat-thermometer',
    checkedAt: '2026-10-23',
    limitations:
      'The manufacturer page gives conflicting ±0.5°C and ±1°C accuracy claims; allow at least ±1°C and check the probe in an ice bath. Water collected in a cup cools and does not establish temperature at the puck under pressure. A $39 ThermoPop 2 is an optional upgrade with a published ±0.5°C specification from −10 to 98°C and an individual NIST-traceable certificate.',
    sources: [
      {
        label: 'ThermoPop 2 specifications and price',
        url: 'https://www.thermoworks.com/products/thermopop-2',
      },
    ],
  },
  {
    id: 'water-kit',
    name: 'API GH & KH liquid drop test kit',
    purpose:
      'Measure general hardness (calcium and magnesium together) and carbonate hardness/alkalinity. Enter the reported units and convert to mg/L as CaCO₃ when needed.',
    typicalCost: '$11.98 one-time price at Chewy',
    priceUsd: 11.98,
    url: 'https://www.chewy.com/api-gh-kh-general-carbonate-hardness/dp/121951',
    checkedAt: '2026-10-23',
    limitations:
      'Follow the kit’s sample volume and drop conversion; this is a coarse titration with an endpoint uncertainty. It does not separate calcium from magnesium or determine every dissolved ion. A cheap electrical TDS pen cannot substitute for GH/KH tests or measure coffee beverage TDS. Test a separate sample and discard it after adding reagents.',
    sources: [
      {
        label: 'API manufacturer description and instructions',
        url: 'https://www.apifishcare.com/products/api-general-carbonate-hardness-test-kit',
      },
    ],
  },
  {
    id: 'calipers',
    name: 'Pittsburgh 6-inch steel digital caliper (63731)',
    purpose:
      'Optionally measure accessible basket diameter, depth and other external dimensions. Published resolution is 0.01 mm and accuracy is 0.03 mm.',
    typicalCost: '$24.99; a ruler is enough for an initial approximate basket size',
    priceUsd: 24.99,
    url: 'https://www.harborfreight.com/6-in-digital-caliper-with-sae-and-metric-fractional-readings-63731.html',
    checkedAt: '2026-10-23',
    limitations:
      'Measure a cool, removed basket and distinguish internal diameter from the rim. These calipers do not determine the operating burr gap, burr alignment or coffee particle-size distribution. Do not place them inside a running grinder.',
  },
  {
    id: 'refractometer',
    name: 'DiFluid R2 Extract coffee refractometer (optional)',
    purpose:
      'Measure brewed-coffee TDS to add an independent concentration observation. Manufacturer specifications: 0–30% TDS, 0.01 percentage-point resolution, ±0.03 percentage-point accuracy.',
    typicalCost: '$229.99; optional, after a scale and repeatable measurements',
    priceUsd: 229.99,
    url: 'https://digitizefluid.com/products/r2-extract',
    checkedAt: '2026-10-23',
    limitations:
      'Use a coffee-specific refractometer, calibrate as instructed, and prepare a cooled, mixed sample using the manufacturer’s espresso filtration procedure. Oils, suspended fines, bubbles and temperature can bias a reading. TDS plus dose and yield estimates extraction; it does not reveal channeling, individual compounds or flavor by itself.',
    sources: [
      {
        label: 'R2 Extract technical specifications',
        url: 'https://digitizefluid.com/pages/r2-extract',
      },
    ],
  },
];

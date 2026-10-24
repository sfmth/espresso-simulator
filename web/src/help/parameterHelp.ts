// SPDX-License-Identifier: GPL-2.0-or-later
import type { RegistryParameter } from '../engine/shotTypes';
import { GLOSSARY } from '../shot/glossary';
import { OUTPUT_HELP } from './outputHelp';
import type { InstrumentSuggestion } from './instruments';

export interface ParameterHelp {
  title: string;
  meaning: string;
  effect: string;
  measure: string;
  instruments?: readonly InstrumentSuggestion['id'][];
}
const help = (
  title: string,
  meaning: string,
  effect: string,
  measure: string,
  instruments?: ParameterHelp['instruments'],
): ParameterHelp => ({ title, meaning, effect, measure, instruments });

const TERMS: Record<string, ParameterHelp> = {
  sweep: help(
    'Parameter sweep',
    'A series of simulations changing one selected input between the stated endpoints.',
    'The number of points controls how closely spaced the sampled settings are. Other inputs stay fixed; it is a model comparison rather than a measured calibration.',
    'Choose a sensible range for the equipment and use Standard for final comparisons.',
  ),
  'recorded-grinder': help(
    'Grinder specification',
    'A stated burr diameter or rotation speed for your grinder.',
    'The value is saved as equipment information. The current particle model uses the chosen burr family and effective fineness; entering a diameter or RPM does not add an independently calibrated physical effect.',
    'Use the manufacturer specification. A caliper can check an accessible, removed part if needed, but no measurement is required for initial setup.',
  ),
  'blend-weight': help(
    'Blend amount',
    'The dry amount of one single-origin coffee relative to the others. Grams, parts or percentages can be used consistently.',
    'Positive amounts are normalized to dry-mass shares. Each coffee is modeled separately before its inventories and particle properties are combined into a homogeneous mixture.',
    'Weigh each coffee before mixing. For a 70/30 blend use 70 and 30, or 7 and 3.',
    ['scale'],
  ),
  'search-depth': help(
    'Search depth',
    'The maximum amount of work allowed when looking for equipment setups.',
    'A deeper search can explore more combinations and takes longer. It cannot prove that every possible solution has been found or improve the physical model itself.',
    'Start with Standard. Try a deeper search if no satisfactory match appears after you check measurements and allowed ranges.',
  ),
  'visual-resolution': help(
    'Explore resolution',
    'The number of depth cells used to calculate the puck, and the number of representative particles drawn.',
    'The high-resolution run computes five times as many depth cells. Displayed particles add visual detail but do not change the extraction calculation. This remains a set of parallel one-dimensional flow paths.',
    'Choose Standard first; use High resolution to inspect finer depth detail after running the new calculation.',
  ),
  'visual-selection': help(
    'Puck view selection',
    'The time, cell, particle or cutaway position currently being inspected.',
    'This changes the view of saved simulation results; it does not change your recipe, extraction or predicted cup.',
    'Select a time or cell to compare matching cross-section and particle data.',
  ),
  'local-solubles': help(
    'Local dissolved coffee concentration',
    'The mass of dissolved coffee per volume of liquid at the selected puck cell and snapshot.',
    'This output describes transport through the bed. It can differ from accumulated cup TDS because it refers to a local place and time.',
    'This local internal value cannot be directly measured with inexpensive household equipment. A coffee refractometer checks the collected sample instead.',
  ),
  'setup-name': help(
    'Equipment setup name',
    'A name for the bag and equipment you want to compare.',
    'The name organizes saved shots and setups. It does not change the physical simulation.',
    'Use a name you recognize, such as your grinder, machine and coffee.',
  ),
  'shot-label': help(
    'Shot name',
    'Your label for this recorded or planned shot.',
    'Labels organize the journal; they do not change the simulated shot.',
    'Use a memorable name or date.',
  ),
  'shot-notes': help(
    'Shot notes',
    'Your observations about preparation, taste or anything unusual.',
    'Notes are saved with the shot. The physical model does not infer parameter values from free text.',
    'Record what you changed and what you tasted.',
  ),
  rating: help(
    'Personal rating',
    'Your own enjoyment score for a measured shot.',
    'With enough varied rated shots, optional preference ranking can favor settings you liked. It does not alter chemistry or establish sensory accuracy.',
    'Use a consistent personal scale and rate the actual drink.',
  ),
  heater: help(
    'Machine heating system',
    'The boiler or thermoblock that heats your machine’s water.',
    'This is recorded equipment information. The current model accepts a separate inlet-water temperature; it does not simulate boiler recovery or PID cycling from this choice.',
    'Read the machine specification. Use unknown if the heating arrangement is unclear.',
  ),
  advice: help(
    'Recipe search goal',
    'What you want the next-shot search to aim for: time and weight, a cup measurement, or an adjustment based on the last shot.',
    'The solver searches allowed recipe controls and checks candidates with a full simulation. A matching model prediction does not guarantee a matching real shot.',
    'Start with a time and beverage-weight target; optional coffee TDS can add information.',
  ),
  taste: help(
    'Relative taste estimate',
    'A model index for acidity, bitterness, astringency or body.',
    'These indices summarize modeled chemistry. They have not been validated as a prediction of what you will taste, so use them for cautious comparisons.',
    'Taste the actual cup and record your own rating. There is no inexpensive instrument that measures enjoyment.',
  ),
  'shot-settings': help(
    'Settings specific to one shot',
    'Known changes such as its dose or grinder number that differ from your shared equipment setup.',
    'The observation uses these saved settings while the solver varies the shared unknowns. This lets several shots narrow the same setup.',
    'Select the settings you actually know and record each shot with its own values.',
  ),
  dose: help(
    'Coffee dose',
    'The dry ground coffee placed in the basket, in grams.',
    'More coffee makes a deeper bed and usually increases resistance. At the same cup weight it also changes the brew ratio and available dissolved material.',
    'Tare the empty basket or dosing cup, then weigh the coffee before brewing.',
    ['scale'],
  ),
  beverage: help(
    'Beverage weight',
    'The mass of espresso collected in the cup. Final weight includes any drips after pump stop.',
    'The target ends the shot when reached. A larger target usually extracts more material but dilutes the final cup; post-stop dripping depends on the machine valve.',
    'Tare the empty cup and weigh the final drink. For observations, say whether you weighed at pump stop or after dripping.',
    ['scale'],
  ),
  'shot-time': help(
    'Shot time',
    'Elapsed time from the selected starting event to pump stop.',
    'A time target stops a future simulation. When fitting a recorded shot, its observed duration sets the replay time; the resulting cup weight and optional TDS test the setup.',
    'Start consistently at pump-on or first drip, and select that convention when recording the shot.',
    ['timer'],
  ),
  'first-drops': help(
    'First drops',
    'The time when liquid first leaves the basket after the headspace and puck begin filling.',
    'A longer wetting delay leaves less flowing time within a fixed pump-on duration. It changes the interpretation of a first-drip timer.',
    'Watch for the first liquid entering the cup and compare it with pump-on time.',
    ['timer'],
  ),
  ratio: help(
    'Brew ratio',
    'Final beverage mass divided by dry coffee dose: 18 g in and 36 g out is 1:2.',
    'It connects dose and yield. Increasing the ratio generally makes a more dilute drink while allowing more material to be extracted.',
    'Divide the cup weight by the dry dose; no additional instrument is needed.',
    ['scale'],
  ),
  tds: help(
    'Coffee strength (TDS)',
    'The percentage of the drink that consists of dissolved coffee material.',
    'This is a predicted output, or an optional measured observation used to narrow possible setups. Strength alone does not say how evenly the puck extracted or how the cup tastes.',
    'Use a coffee-specific refractometer and the manufacturer’s espresso sample procedure. An electrical water TDS pen measures something different.',
    ['refractometer'],
  ),
  ey: help(
    'Extraction yield (EY)',
    'The percentage of the dry dose that reaches the cup as dissolved material.',
    'This output helps compare extraction. It is calculated from coffee TDS, final cup mass and dry dose; different flow patterns can produce the same overall yield.',
    'EY (%) = TDS (%) × beverage grams ÷ dose grams. It needs an actual TDS measurement to calculate measured EY.',
    ['scale', 'refractometer'],
  ),
  temperature: help(
    'Brew-water temperature',
    'Water temperature entering the puck in this model, in °C.',
    'Temperature changes viscosity, flow resistance and dissolution/diffusion rates. The machine’s display can differ from water at the coffee.',
    'Use a measured inlet value if available. Otherwise enter an estimate separately from the machine display; a probe in collected water is only an approximate check.',
    ['thermometer'],
  ),
  'display-temperature': help(
    'Machine display temperature',
    'The temperature set or shown on the machine.',
    'This is a recorded equipment fact. It is kept separate from inlet-water temperature; it does not automatically change the simulated water temperature.',
    'Read the display or manufacturer specification. Use the separate Brew temperature field for water entering the coffee.',
  ),
  roast: help(
    'Roast information',
    'The roaster’s own roast description, roast date and, when published, a measured color reading.',
    'The model uses a roast estimate to set composition, particle properties and remaining CO₂. Roast labels and color are useful evidence but do not uniquely determine chemistry.',
    'Copy the label and date from the bag or roaster. For color, retain the scale, instrument and whether the sample was whole beans or ground. No extra instrument is required.',
  ),
  age: help(
    'Time since roasting',
    'Days between the roast date and the shot.',
    'Fresh beans retain more CO₂ in this model, which can reduce early flow. Aging changes modeled gas and aroma inventories.',
    'Use the roast date on your bag and the date you pulled the shot. A best-before date does not establish roast age.',
  ),
  species: help(
    'Coffee species',
    'Arabica or Canephora (often called Robusta), as identified by the roaster.',
    'Species changes the starting composition, including caffeine. Variety and country do not supply a measured chemical assay.',
    'Use the bag or producer listing. Choose each single coffee separately when composing a blend.',
  ),
  variety: help(
    'Coffee variety',
    'The named cultivar or local variety listed by the roaster, such as Caturra, SL28 or Gesha.',
    'The exact name is preserved as coffee information. The current model does not apply a separate measured chemistry correction to every named cultivar.',
    'Copy the published variety. Leave it unknown when the roaster does not identify it.',
  ),
  process: help(
    'Coffee processing',
    'How the coffee was processed after picking, such as washed, natural, honey or a specified fermentation.',
    'Supported processing assumptions can affect composition. Keep the original description: wet-hulled, decaffeinated and fermentation details cannot all be reduced to “washed.”',
    'Read the bag or source listing. Choose unknown when the physical model has no matching category.',
  ),
  altitude: help(
    'Growing altitude',
    'Elevation of the farm or growing area, usually given as a range in metres.',
    'It is preserved as origin information. There is no universal altitude multiplier in the simulation, so entering a more exact altitude does not manufacture more exact chemistry.',
    'Use the roaster’s farm information. Keep a published range rather than treating its midpoint as a measured farm height.',
  ),
  storage: help(
    'Bean storage',
    'Whether beans were kept sealed, exposed to air or frozen.',
    'Storage adjusts the model’s aging and aroma assumptions. It does not reconstruct an unknown storage history.',
    'Choose how this bag was actually stored; use the same storage description for comparable shots.',
  ),
  'bean-temperature': help(
    'Bean temperature when grinding',
    'Temperature of the beans just before they enter the grinder.',
    'Colder beans change the predicted particle distribution at the same grinder setting. This differs from brew-water temperature.',
    'Room temperature is a practical starting estimate. A contact probe can check a separate bean sample; frozen beans need their actual preparation temperature.',
    ['thermometer'],
  ),
  grind: help(
    'Grinder setting',
    'The number or click count you use on your own grinder.',
    'A calibrated local conversion maps your numbers to effective fineness. Finer particles tend to add resistance and extract faster, but extremely fine settings can increase uneven flow.',
    'Record the exact number, direction and zero reference. Use several shots at different settings to estimate the conversion; you do not need to measure an operating burr gap.',
  ),
  gap: help(
    'Effective burr gap',
    'The internal fineness coordinate used by the grinder model, expressed in micrometres.',
    'It helps generate the particle-size distribution. A value inferred from shots is an effective model fit, not a direct measurement of the physical separation between your burrs.',
    'Use your grinder numbers and the calibration workflow. A ruler or ordinary caliper cannot establish the operating burr gap.',
  ),
  'dial-reference': help(
    'Reference grinder setting',
    'The dial number at which the calibration’s reference fineness is defined.',
    'Moving the reference changes the meaning of the offset. It lets a dial start at any number and supports scales that run in either direction.',
    'Use a stable setting on your grinder, usually the setting of a recorded reference shot.',
  ),
  'dial-slope': help(
    'Grinder sensitivity',
    'How much effective fineness changes for one unit of your grinder number.',
    'Its sign determines whether larger numbers are coarser or finer. Its magnitude determines how strongly a dial change affects the predicted shot.',
    'Estimate it from multiple known settings and measured shots. Mechanical click travel is not automatically the effective grinding gap.',
  ),
  pressure: help(
    'Pressure',
    'Pressure applied to the puck, displayed in bar.',
    'Pressure and puck resistance jointly determine flow. More pressure can also compact the bed, so flow does not necessarily increase in proportion.',
    'Use an installed gauge or the machine’s specified program. A gauge elsewhere in the machine may not equal pressure at the puck.',
  ),
  flow: help(
    'Water flow',
    'Water volume per second through the machine or puck, depending on the selected control.',
    'Flow determines contact time and transport. A pump’s free-flow test measures its zero-resistance delivery, not the flow through a coffee puck.',
    'For a free-flow check, collect water for a known duration and weigh it. Follow the machine’s instructions and keep that value separate from shot flow.',
    ['scale', 'timer'],
  ),
  headspace: help(
    'Space above the puck',
    'The space between the dry coffee bed and shower screen, including unused basket volume.',
    'It holds water before pressure builds and can feed post-stop drip. Dose and basket shape change the available space. A puck screen affects modeled flow distribution, but its thickness is not subtracted from this volume.',
    'Start with the basket’s recommended dose and dimensions. It is usually estimated rather than directly measured under pressure.',
    ['calipers'],
  ),
  'bed-height': help(
    'Coffee-bed height',
    'Depth of the tamped coffee bed inside the basket.',
    'It contributes to resistance and headspace. It is derived from dose, basket geometry and estimated coffee density/porosity.',
    'Dose and basket dimensions give a useful starting estimate. A visible dry puck can be measured approximately with the basket removed.',
    ['scale', 'calipers'],
  ),
  basket: help(
    'Basket dimensions',
    'The internal geometry that holds the coffee: diameter, depth, wall shape and outlet.',
    'Geometry sets bed area, depth and flow paths. A pressurised outlet adds its own resistance and behaves differently from a single-wall basket.',
    'Use the basket’s stated model and dose range first; measure accessible internal dimensions only if needed.',
    ['calipers'],
  ),
  wdt: help(
    'Grounds distribution',
    'How the grounds were spread before tamping.',
    'More even preparation narrows the model’s spread of flow paths and reduces the likelihood of concentrated high-flow channels.',
    'Choose the preparation actually used: none, tapping or needle stirring (WDT).',
  ),
  tamp: help(
    'Tamp force',
    'Force used to compress and level the dry grounds.',
    'This model records the value but does not invent a continuous flow benefit from harder tamping. Level, repeatable preparation is more useful than a very precise force estimate.',
    'A normal level tamp is enough for initial setup. A calibrated tamper can improve repeatability; a new force-measuring instrument is optional.',
  ),
  screen: help(
    'Puck screen or paper',
    'A screen or paper layer placed above or below the coffee.',
    'Supported layers adjust modeled flow distribution or outlet behavior. An unsupported layer is recorded without a fabricated physical effect.',
    'Select the layers actually used and their position. No measuring instrument is needed.',
  ),
  alkalinity: help(
    'Water alkalinity',
    'How much acid the water can neutralize, expressed here as mg/L as CaCO₃.',
    'It buffers the cup’s acids and affects calculated chemistry. It is different from hardness and from an electrical TDS reading.',
    'Use a water report or KH titration kit. Convert the kit’s units according to its instructions.',
    ['water-kit'],
  ),
  hardness: help(
    'Water hardness',
    'Calcium and magnesium content expressed as equivalent mg/L CaCO₃.',
    'This is recorded water information in the current model. It does not independently change extraction or acid balance; alkalinity, starting pH and total water TDS have separate modeled uses. A hardness total cannot identify calcium and magnesium separately.',
    'Use a water report or GH drop test. Do not substitute a conductivity/TDS pen.',
    ['water-kit'],
  ),
  mineral: help(
    'Water mineral concentration',
    'The stated amount of a particular mineral or total dissolved material in brew water.',
    'Total water TDS contributes to the modeled refractometer reading and mineral blank. Individual calcium and magnesium values are currently recorded and validated without independent extraction or acid-balance effects. A total TDS value does not identify its ions.',
    'Use the bottled-water analysis or utility report for individual ions. GH/KH kits provide useful totals; a cheap pen does not identify each ion.',
    ['water-kit'],
  ),
  ph: help(
    'pH',
    'A measure of how acidic or alkaline a liquid is.',
    'It describes acid balance, but pH alone is not perceived sourness and does not specify how much buffering the water has.',
    'Use a water report or a calibrated pH meter when needed. For initial setup, a reliable water analysis is usually more useful than buying a pH meter.',
  ),
  uniformity: help(
    'Extraction uniformity',
    'How far local extraction differs across regions of the modeled puck.',
    'A large spread can reveal uneven flow even when overall EY looks ordinary. It is a simulated diagnostic, not a number inferred uniquely from shot time and weight.',
    'There is no inexpensive direct instrument for this value. Use preparation consistency and additional shot observations rather than guessing a precise spread.',
  ),
  numerical: help(
    'Simulation accuracy',
    'Settings that control calculation detail, computation time or numerical checks.',
    'They change how accurately or quickly the model is solved, not your physical equipment. They are not variables to calibrate against a real shot.',
    'Use Standard for final comparisons. Technical diagnostics are available in the calculation-details section.',
  ),
  chemistry: help(
    'Cup chemistry',
    'Calculated composition and post-extraction behavior of material in the drink.',
    'These outputs help explain the model. Individual compounds and taste indices have different evidence limits and cannot be measured with a water TDS pen.',
    'Use optional coffee TDS measurements for overall concentration. Individual compound assays require laboratory equipment.',
    ['refractometer'],
  ),
  tolerance: help(
    'Measurement tolerance',
    'The amount of measurement variation you allow when comparing a recorded shot with a simulation.',
    'Wider tolerances admit more possible setups. Smaller tolerances do not make a scale or timer more accurate.',
    'Use the instrument’s uncertainty and your repeatability, including reaction time and post-stop dripping.',
  ),
};

const PATH_TERMS: Record<string, string> = {
  'prep.dose_g': 'dose',
  'stop.beverage_g': 'beverage',
  'stop.time_s': 'shot-time',
  'bean.preset': 'roast',
  'bean.arabica_fraction': 'species',
  'bean.roast_level': 'roast',
  'bean.roast-description': 'roast',
  'bean.days_off_roast': 'age',
  'bean.bean_temp_c': 'bean-temperature',
  'bean.altitude_m': 'altitude',
  'bean.variety_group': 'variety',
  'bean.process': 'process',
  'bean.storage': 'storage',
  'grinder.preset': 'grind',
  'grinder.family': 'grind',
  'grinder.setting': 'grind',
  'grinder.my_number': 'grind',
  'grinder.gap_um': 'gap',
  'grinder.gap_at_ref_um': 'gap',
  'grinder.setting_ref': 'dial-reference',
  'grinder.gap_per_unit_um': 'dial-slope',
  'grinder.rpm': 'recorded-grinder',
  'grinder.burr_diameter_mm': 'recorded-grinder',
  'machine.temperature_c': 'temperature',
  'machine.display_temperature_c': 'display-temperature',
  'machine.headspace_ml': 'headspace',
  'prep.distribution': 'wdt',
  'prep.tamp_kgf': 'tamp',
  'prep.puck_screen': 'screen',
  'prep.paper_bottom': 'screen',
  'prep.paper_top': 'screen',
  'water.alkalinity_mg_l_caco3': 'alkalinity',
  'water.hardness_mg_l_caco3': 'hardness',
  'water.calcium_mg_l': 'mineral',
  'water.magnesium_mg_l': 'mineral',
  'water.tds_mg_l': 'mineral',
  'water.ph': 'ph',
  'shot-time': 'shot-time',
  'first-drops': 'first-drops',
  beverage: 'beverage',
  ratio: 'ratio',
  tds: 'tds',
  ey: 'ey',
  'max-pressure': 'pressure',
  'bed-height': 'bed-height',
  headspace: 'headspace',
  uniformity: 'uniformity',
  'mass-balance': 'numerical',
  'outflow-check': 'numerical',
  runtime: 'numerical',
  tier: 'numerical',
  'size-classes': 'numerical',
};

export function parameterHelp(
  pathOrTerm: string,
  title?: string,
  registry?: RegistryParameter,
): ParameterHelp {
  const path = pathOrTerm.replace(/bean\.components\.\d+\.bean\./, 'bean.');
  const term = /bean\.components\.\d+\.weight$/.test(path)
    ? 'blend-weight'
    : (PATH_TERMS[path] ?? path);
  if (OUTPUT_HELP[term]) return OUTPUT_HELP[term];
  if (TERMS[term]) return TERMS[term];
  if (path.startsWith('basket.')) return { ...TERMS.basket, title: title ?? TERMS.basket.title };
  if (path.startsWith('numerics.'))
    return { ...TERMS.numerical, title: title ?? TERMS.numerical.title };
  if (path.startsWith('chemistry.'))
    return { ...TERMS.chemistry, title: title ?? TERMS.chemistry.title };
  if (path.startsWith('bean.coffee.'))
    return { ...TERMS.roast, title: title ?? 'Coffee information' };
  if (path.startsWith('machine.pump.'))
    return {
      ...(path.includes('pressure') || path.endsWith('opv_bar') ? TERMS.pressure : TERMS.flow),
      title: title ?? 'Pump setting',
    };
  if (/machine\.(?:profile|phases)\./.test(path))
    return help(
      title ?? 'Shot program',
      'A target, transition or stop condition in the machine’s pressure/flow program.',
      'The selected phase controls water delivery until its exit condition is reached. Pressure targets, flow targets and timing interact with puck resistance.',
      'Copy the program from your machine if known; otherwise keep a simple repeatable program.',
      ['timer', 'scale'],
    );
  const glossary = GLOSSARY[term];
  if (glossary)
    return help(
      glossary.title,
      glossary.text,
      term === 'flags' || term === 'provenance'
        ? 'This explains the source and confidence of a value; it is not a physical control.'
        : 'This is part of the physical description used to calculate the shot. Change it only when it describes your setup or a deliberate experiment.',
      'Use the equipment specification or a measured value when available; otherwise retain an explicit estimate.',
    );
  const id = path.replace(/^overrides\./, '');
  const effect = /diffus/.test(id)
    ? 'A larger diffusion rate moves soluble material out of particle interiors faster.'
    : /permeab/.test(id)
      ? 'A larger permeability allows more flow for the same pressure and bed geometry.'
      : /partition/.test(id)
        ? 'This sets the equilibrium split between dissolved material and the particle interior; it is not a flow-rate setting.'
        : /composition|inventory/.test(id)
          ? 'This changes how much of a substance is initially available, which changes calculated composition and possible extraction.'
          : /thermal|temperature/.test(id)
            ? 'This changes the model’s heat storage, heat loss or temperature-dependent rates.'
            : /gas|co2/.test(id)
              ? 'This affects retained gas or its estimated resistance to early flow.'
              : 'This advanced value changes the corresponding model calculation. It should be inferred or sourced with the rest of the setup rather than treated as directly measured.';
  return help(
    title ?? registry?.description ?? path,
    registry?.description ??
      `The ${title ?? path.replaceAll('_', ' ')} setting used for this part of the shot.`,
    effect,
    registry
      ? 'Use the linked parameter source or keep the documented estimate. This coefficient normally needs model fitting or laboratory evidence, not a household instrument.'
      : 'Use the equipment specification or record an observation. If the value is unknown, mark it unknown rather than assigning false precision.',
  );
}

export { TERMS as HELP_TERMS };

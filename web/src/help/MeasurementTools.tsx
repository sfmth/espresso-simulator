// SPDX-License-Identifier: GPL-2.0-or-later
import { INSTRUMENTS } from './instruments';

export function MeasurementTools() {
  return (
    <div className="measurement-tools">
      <p>
        A scale and your phone timer cover the essential shot measurements. Use your bag, equipment
        specifications and water report before buying another instrument.
      </p>
      {INSTRUMENTS.map((tool) => (
        <article className="help-instrument" key={tool.id}>
          <h4>
            <a href={tool.url} target="_blank" rel="noreferrer">
              {tool.name}
            </a>
          </h4>
          <p>{tool.typicalCost}</p>
          <p>{tool.purpose}</p>
          <p>{tool.limitations}</p>
          <small>US price checked {tool.checkedAt}; before tax and shipping.</small>
          {tool.sources?.map((source) => (
            <a key={source.url} href={source.url} target="_blank" rel="noreferrer">
              {source.label}
            </a>
          ))}
        </article>
      ))}
    </div>
  );
}

// SPDX-License-Identifier: GPL-2.0-or-later
//
// A small SPDX licence-expression evaluator shared by check-licenses.mjs and
// rust-notices.mjs. Dependency-free.

/**
 * Licences allowed in shipped code (ADR 0007,
 * docs/decisions/0007-licensing-and-dependency-policy.md). Apache-2.0 is
 * allowed, but a build that needs it is distributed under GPLv3 (D12).
 */
export const ALLOWED = new Set([
  'MIT',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'Apache-2.0',
  '0BSD',
  'Zlib',
  'Unicode-3.0',
  'Unicode-DFS-2016',
  'CC0-1.0',
  'BlueOak-1.0.0',
]);

/** Licences to avoid when an expression offers a choice: using them makes the build GPLv3. */
export const AVOID = new Set(['Apache-2.0']);

/**
 * Parses an SPDX expression into a tree of `{ id }`, `{ and: [a, b] }` and
 * `{ or: [a, b] }`. AND binds tighter than OR. "X WITH exception" is read as X
 * (exceptions only add permissions) and "X+" (or later) as X. Throws on
 * malformed input.
 * @param {string} expression
 */
export function parseExpression(expression) {
  const tokens = expression.replace(/[()]/g, ' $& ').trim().split(/\s+/).filter(Boolean);
  let i = 0;
  const fail = (why) => {
    throw new Error(`${why} in licence expression "${expression}"`);
  };
  const atom = () => {
    const token = tokens[i++];
    if (token === '(') {
      const node = or();
      if (tokens[i++] !== ')') fail('unbalanced parentheses');
      return node;
    }
    if (!token || ['AND', 'OR', 'WITH', ')'].includes(token)) fail('unexpected token');
    if (tokens[i] === 'WITH') {
      if (!tokens[i + 1]) fail('missing exception');
      i += 2;
    }
    return { id: token.replace(/\+$/, '') };
  };
  const and = () => {
    let node = atom();
    while (tokens[i] === 'AND') {
      i++;
      node = { and: [node, atom()] };
    }
    return node;
  };
  const or = () => {
    let node = and();
    while (tokens[i] === 'OR') {
      i++;
      node = { or: [node, and()] };
    }
    return node;
  };
  const tree = or();
  if (i !== tokens.length) fail('trailing tokens');
  return tree;
}

/**
 * The licences to comply with when using a package licensed under
 * `expression`: for OR, an allowed side, preferring one without a licence in
 * `avoid` (then the first named); for AND, both sides. Returns null when no
 * choice is allowed. Throws on malformed input.
 * @param {string} expression
 * @returns {Set<string> | null}
 */
export function electLicences(expression, allowed = ALLOWED, avoid = AVOID) {
  const visit = (node) => {
    if (node.id) return allowed.has(node.id) ? new Set([node.id]) : null;
    if (node.and) {
      const [a, b] = node.and.map(visit);
      return a && b ? new Set([...a, ...b]) : null;
    }
    const [a, b] = node.or.map(visit);
    if (!a || !b) return a ?? b;
    const avoids = (set) => [...set].some((id) => avoid.has(id));
    return avoids(a) && !avoids(b) ? b : a;
  };
  return visit(parseExpression(expression));
}

/** True if the expression can be satisfied with allowed licences. Throws on malformed input. */
export function isAllowedExpression(expression, allowed = ALLOWED) {
  return electLicences(expression, allowed) !== null;
}

/** True if every allowed way of using the package includes Apache-2.0 (so the build becomes GPLv3). */
export function needsApache(expression, allowed = ALLOWED) {
  const elected = electLicences(expression, allowed);
  return elected !== null && elected.has('Apache-2.0');
}

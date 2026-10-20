// SPDX-License-Identifier: GPL-2.0-or-later
/// <reference types="vitest/config" />
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { offlineBuild } from './scripts/offline-build.mjs';
import { engineNotices } from './scripts/rust-notices.mjs';

const { version } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as {
  version: string;
};

/** Notices of the third-party code in the build (must match src/config.ts). */
const LICENSES_FILE = 'third-party-licenses.md';

/**
 * Repository URL for the footer's "Source code" link: every deployed build of
 * this GPL program must point to its source. Taken from PUCKWORKS_SOURCE_URL,
 * else from GitHub Actions' GITHUB_SERVER_URL and GITHUB_REPOSITORY. A local
 * build may have none; a build with PUCKWORKS_REQUIRE_SOURCE_URL=1 (all CI
 * builds, including the one that is deployed) fails instead.
 */
function sourceUrl(): string | null {
  const { PUCKWORKS_SOURCE_URL, GITHUB_SERVER_URL, GITHUB_REPOSITORY } = process.env;
  const url =
    PUCKWORKS_SOURCE_URL ||
    (GITHUB_SERVER_URL && GITHUB_REPOSITORY ? `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}` : '');
  if (url && !/^https:\/\/\S+$/.test(url)) {
    throw new Error(`The source URL must be an https:// URL, got "${url}".`);
  }
  if (!url && process.env.PUCKWORKS_REQUIRE_SOURCE_URL === '1') {
    throw new Error(
      'PUCKWORKS_REQUIRE_SOURCE_URL=1 but no source URL: set PUCKWORKS_SOURCE_URL, or build in ' +
        'GitHub Actions (GITHUB_SERVER_URL and GITHUB_REPOSITORY).',
    );
  }
  return url || null;
}

/**
 * Content-Security-Policy of the production build (docs/PLAN.md §7.7, D9).
 *
 * GitHub Pages cannot send HTTP headers, so the policy ships as a <meta> tag,
 * and a <meta> policy covers only the page itself: the browser holds the page
 * to its own origin, but not the engine worker (a worker gets its policy from
 * the HTTP headers of its script, which Pages cannot set). The worker's
 * traffic is audited instead by the browser smoke test (scripts/e2e.mjs).
 * 'wasm-unsafe-eval' (WebAssembly compilation, not JavaScript eval) keeps the
 * engine loading in any browser that applies the page's policy to its workers.
 *
 * Dev mode is exempt: Vite's dev server needs an inline script and a websocket.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

function contentSecurityPolicy(): Plugin {
  return {
    name: 'puckworks:content-security-policy',
    apply: 'build',
    transformIndexHtml: () => [
      {
        tag: 'meta',
        attrs: { 'http-equiv': 'Content-Security-Policy', content: CONTENT_SECURITY_POLICY },
        // Before the script and stylesheet tags, so the policy covers them.
        injectTo: 'head-prepend',
      },
    ],
  };
}

/**
 * Appends the Rust crates compiled into the WebAssembly engine, with their
 * licence texts, to the notices Vite writes for the bundled npm packages.
 * Generated from `cargo metadata` on every build (scripts/rust-notices.mjs).
 */
function engineCrateNotices(): Plugin {
  return {
    name: 'puckworks:engine-crate-notices',
    apply: 'build',
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        const asset = bundle[LICENSES_FILE];
        if (asset?.type !== 'asset') return;
        const npmNotices =
          typeof asset.source === 'string' ? asset.source : new TextDecoder().decode(asset.source);
        const manifest = fileURLToPath(new URL('../Cargo.toml', import.meta.url));
        asset.source = `${npmNotices}\n${engineNotices(manifest)}`;
      },
    },
  };
}

export default defineConfig({
  // Relative asset URLs, so the site works under any GitHub Pages sub-path.
  base: './',
  plugins: [react(), contentSecurityPolicy(), engineCrateNotices(), offlineBuild()],
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __SOURCE_URL__: JSON.stringify(sourceUrl()),
  },
  server: {
    // The editor reads its field ranges from the recipe schema (src/shot/recipeFields.ts).
    fs: { allow: ['.', '../data/schema'] },
  },
  worker: {
    // ES-module workers: engine.worker.ts imports the wasm-bindgen glue as a module.
    format: 'es',
  },
  build: {
    target: 'es2022',
    // Always ship the engine as a separate file: wasm must not become a data: URI.
    assetsInlineLimit: (filePath) => (filePath.endsWith('.wasm') ? false : undefined),
    // Notices of the bundled npm packages; engineCrateNotices adds the Rust crates.
    license: { fileName: LICENSES_FILE },
  },
  test: {
    // Pure-logic tests run in Node; DOM tests opt in with `// @vitest-environment jsdom`.
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}', 'test/**/*.test.{ts,mjs}'],
    restoreMocks: true,
  },
});

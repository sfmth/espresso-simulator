// SPDX-License-Identifier: GPL-2.0-or-later
/** App-wide constants, injected at build time by vite.config.ts. */

/**
 * The repository the deployed build comes from (GPL: every copy points to its
 * source). In GitHub Actions it is derived from GITHUB_SERVER_URL and
 * GITHUB_REPOSITORY (or set with PUCKWORKS_SOURCE_URL); a local build without
 * either has none, and the footer says so instead of linking.
 */
export const SOURCE_URL: string | null = __SOURCE_URL__;

/** Version of the web app (web/package.json). */
export const APP_VERSION: string = __APP_VERSION__;

/** Notices of the third-party code in the build, generated next to index.html. */
export const LICENSES_FILE = 'third-party-licenses.md';

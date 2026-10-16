// SPDX-License-Identifier: GPL-2.0-or-later
// Constants replaced at build time (vite.config.ts, `define`).

/** Version of the web app from package.json. */
declare const __APP_VERSION__: string;

/** Repository URL of the build, or null in a local build without one. */
declare const __SOURCE_URL__: string | null;

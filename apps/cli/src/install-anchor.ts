/** Installation facts shared by Profile boot and the pre-Loader transaction owner. @module @deepseek-ai/dsh/install-anchor */

import { fileURLToPath } from 'node:url'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Exact application package file used by Profile bundle resolution. */
    dshInstallAnchor?: string
  }
}

/** Absolute package manifest used as the first bundle-resolution anchor in source and built launches. */
export const INSTALL_ANCHOR = fileURLToPath(new URL('../package.json', import.meta.url))

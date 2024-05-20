/**
 * Load PEM certificates from a directory.
 *
 * @param {string} dir Cert directory.
 * @param {{ logLevel: number }} options Options.
 * @returns {string[]} The certificates.
 */
export function loadCertDir(
  dir: string,
  options: {
    logLevel: number;
  },
): string[];

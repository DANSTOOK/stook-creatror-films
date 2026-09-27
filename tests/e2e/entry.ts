import { runScenario, type E2EInput } from './scenario';
import { runColourExport, type ColourInput } from './colourExport';

/**
 * Renderer entry for the end-to-end run.
 *
 * Deliberately free of any `electron` import: the harness page is built like a
 * normal renderer bundle, and the host drives it with `executeJavaScript`,
 * which resolves the promise this exposes.
 */
declare global {
  interface Window {
    __runE2E(input: E2EInput): Promise<unknown>;
    __runColourExport(input: ColourInput): Promise<unknown>;
  }
}

window.__runE2E = (input) => runScenario(input);
window.__runColourExport = (input) => runColourExport(input);

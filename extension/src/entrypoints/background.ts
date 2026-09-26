import { defineBackground } from 'wxt/utils/define-background';
import { setupBackground } from '../lib/background';

/** MV3 service worker: a thin, stateless relay (see src/lib/background.ts). */
export default defineBackground({
  type: 'module',
  main() {
    setupBackground();
  },
});

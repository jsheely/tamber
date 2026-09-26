/**
 * In-page floating mini-player. Registered at runtime only (no static content_scripts and no host
 * permissions): the background injects it with scripting.executeScript({ files }) into the tab
 * being read, under the activeTab grant of the context-menu click / shortcut.
 *
 * It lives in a shadow root so page CSS cannot reach it and its CSS cannot leak out. Its CSS is
 * inlined into the shadow root (cssInjectionMode 'manual' + `css`), so nothing needs to be exposed
 * through web_accessible_resources. It never talks to the API: state arrives from the background
 * via tabs.sendMessage, and buttons send control messages back.
 */
import { createRoot, type Root } from 'react-dom/client';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { createShadowRootUi } from 'wxt/utils/content-script-ui/shadow-root';
import { MiniPlayer, SHOW_EVENT } from './MiniPlayer';
import css from './style.css?inline';

declare global {
  interface Window {
    __tamberMiniPlayer?: boolean;
  }
}

export default defineContentScript({
  registration: 'runtime',
  cssInjectionMode: 'manual',
  async main(ctx) {
    // Injected again for a new reading: just bring the existing player back.
    if (window.__tamberMiniPlayer) {
      window.dispatchEvent(new CustomEvent(SHOW_EVENT));
      return 'shown';
    }
    window.__tamberMiniPlayer = true;
    ctx.onInvalidated(() => {
      window.__tamberMiniPlayer = false;
    });

    const ui = await createShadowRootUi<Root>(ctx, {
      name: 'tamber-mini-player',
      position: 'inline',
      anchor: 'html',
      append: 'last',
      css,
      isolateEvents: true,
      onMount(container, _shadow, host) {
        host.style.setProperty('position', 'fixed', 'important');
        host.style.setProperty('right', '16px', 'important');
        host.style.setProperty('bottom', '16px', 'important');
        host.style.setProperty('z-index', '2147483647', 'important');
        host.style.setProperty('display', 'block', 'important');
        const root = createRoot(container);
        root.render(<MiniPlayer host={host} />);
        return root;
      },
      onRemove(root) {
        root?.unmount();
      },
    });
    ui.mount();
    return 'mounted';
  },
});

import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// jsdom gaps used by Mantine / the app ---------------------------------------------------------

if (!window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (!('ResizeObserver' in window)) {
  Object.defineProperty(window, 'ResizeObserver', { writable: true, configurable: true, value: ResizeObserverStub });
}

window.scrollTo = (() => undefined) as typeof window.scrollTo;

// Mantine's Textarea autosize listens to font loading.
if (!('fonts' in document)) {
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: {
      ready: Promise.resolve(),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    },
  });
}
Element.prototype.scrollIntoView = function scrollIntoView() {};

// jsdom prints "not implemented" for canvas; the visuals skip drawing when there is no context.
HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement['getContext'];

if (!URL.createObjectURL) URL.createObjectURL = () => 'blob:tamber-test';
if (!URL.revokeObjectURL) URL.revokeObjectURL = () => undefined;

// Media elements are not implemented in jsdom.
window.HTMLMediaElement.prototype.play = function play() {
  return Promise.resolve();
};
window.HTMLMediaElement.prototype.pause = function pause() {};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  try {
    window.localStorage.clear();
  } catch {
    // ignore
  }
});

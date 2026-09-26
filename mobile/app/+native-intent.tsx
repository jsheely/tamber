/**
 * expo-router system-path hook. The iOS Share Extension opens the app with
 * `tamber://dataUrl=tamberShareKey...`; that is not a route, so send it to the home screen and let
 * the root layout's share-intent effect take over (it routes to /player and starts reading).
 */
import { getShareExtensionKey } from 'expo-share-intent';

export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    if (path.includes(`dataUrl=${getShareExtensionKey()}`)) return '/';
    return path;
  } catch {
    return '/';
  }
}

import { Redirect } from 'expo-router';

/** Unknown deep links (including stale share-extension URLs) land on the home screen. */
export default function NotFound() {
  return <Redirect href="/" />;
}

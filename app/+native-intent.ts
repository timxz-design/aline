import { getShareExtensionKey } from 'expo-share-intent';

/**
 * The share extension opens ALINE with `aline://dataUrl=<key>`. Send that to
 * the chat, which reads the shared content and hands it to the agent; any
 * other link passes through unchanged.
 */
export function redirectSystemPath({ path }: { path: string; initial: boolean }) {
  try {
    if (path.includes(`dataUrl=${getShareExtensionKey()}`)) return '/agent';
    return path;
  } catch {
    return '/';
  }
}

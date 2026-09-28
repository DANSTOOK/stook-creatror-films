import { useEffect, useState } from 'react';
import { knownLocalFamilies, loadLocalFamilies, onLocalFamilies } from './fonts';

/**
 * The font families installed on this computer, for a component: null until
 * they are known, then the set. Re-renders once when they arrive, so a
 * "font missing" note appears without anything else having to change.
 */
export function useLocalFamilies(): ReadonlySet<string> | null {
  const [families, setFamilies] = useState(knownLocalFamilies);
  useEffect(() => {
    const unsubscribe = onLocalFamilies(() => setFamilies(knownLocalFamilies()));
    void loadLocalFamilies().then(() => setFamilies(knownLocalFamilies()));
    return unsubscribe;
  }, []);
  return families;
}

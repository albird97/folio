import { useEffect, useState } from 'react';

const currentRatio = () =>
  typeof window === 'undefined' ? 1 : Math.max(0.5, window.devicePixelRatio || 1);

/** devicePixelRatio, updated when the window moves to another screen or the page zoom changes. */
export function useDevicePixelRatio(): number {
  const [ratio, setRatio] = useState(currentRatio);
  useEffect(() => {
    let query: MediaQueryList | null = null;
    const onChange = () => watch();
    const watch = () => {
      query?.removeEventListener('change', onChange);
      const value = currentRatio();
      setRatio(value);
      query = window.matchMedia?.(`(resolution: ${value}dppx)`) ?? null;
      query?.addEventListener('change', onChange);
    };
    watch();
    return () => query?.removeEventListener('change', onChange);
  }, []);
  return ratio;
}

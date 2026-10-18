import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// Teach tailwind-merge about Folio's custom font-size scale so `text-2xs`
// is treated as a size (not a color) when merging.
const merge = extendTailwindMerge({
  extend: { classGroups: { 'font-size': [{ text: ['2xs'] }] } },
});

export function cn(...inputs: ClassValue[]): string {
  return merge(clsx(inputs));
}

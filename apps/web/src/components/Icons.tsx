import type { SVGProps } from 'react';

export type IconName =
  | 'overview'
  | 'intents'
  | 'capital'
  | 'plans'
  | 'orders'
  | 'evidence'
  | 'settings'
  | 'search'
  | 'arrow'
  | 'shield'
  | 'clock'
  | 'alert'
  | 'check'
  | 'copy';

const PATHS: Record<IconName, readonly string[]> = {
  overview: ['M4 13h6V4H4v9Z', 'M14 20h6v-9h-6v9Z', 'M4 20h6v-3H4v3Z', 'M14 7h6V4h-6v3Z'],
  intents: ['M5 5h14', 'M5 12h10', 'M5 19h7', 'm16 16-3 3 3 3'],
  capital: ['M3 7h18', 'M5 7V5h14v2', 'M5 11h14v8H5z', 'M8 15h4'],
  plans: ['M6 3h9l3 3v15H6z', 'M15 3v4h4', 'M9 12h6', 'M9 16h6'],
  orders: ['M4 6h16v12H4z', 'M8 10h8', 'M8 14h5'],
  evidence: ['M5 3h14v18H5z', 'm8 8 2 2 4-4', 'M8 15h8'],
  settings: ['M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z', 'M4 12h2m12 0h2M12 4v2m0 12v2'],
  search: ['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Z', 'm16 16 4 4'],
  arrow: ['M5 12h14', 'm14 0-5-5', 'm5 5-5 5'],
  shield: ['M12 3 4 6v5c0 4.5 3 7 8 8 5-1 8-3.5 8-8V6l-8-3Z', 'm9 12 2 2 4-5'],
  clock: ['M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16Z', 'M12 8v5l3 2'],
  alert: ['M12 4 3 20h18L12 4Z', 'M12 10v4', 'M12 17h.01'],
  check: ['M5 12l4 4L19 6'],
  copy: ['M8 8h11v11H8z', 'M5 16H4V4h12v1'],
};

export function Icon({ name, ...props }: SVGProps<SVGSVGElement> & { name: IconName }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      {PATHS[name].map((path) => (
        <path d={path} key={path} />
      ))}
    </svg>
  );
}

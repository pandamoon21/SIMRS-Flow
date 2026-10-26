/**
 * Small set of tabler.io outline icons (https://tabler.io/icons), inlined as
 * SVG so the bundle stays dependency-free. Each is a 24×24 stroke glyph that
 * inherits `currentColor`; size defaults to 18px.
 */
import type { SVGProps } from 'react';

export type IconName =
  | 'chart-bar'
  | 'chart-line'
  | 'chart-area'
  | 'download'
  | 'copy'
  | 'users'
  | 'note'
  | 'plus'
  | 'trash'
  | 'point'
  | 'search';

const PATHS: Record<IconName, string> = {
  search: 'M10 10m-7 0a7 7 0 1 0 14 0a7 7 0 1 0 -14 0 M21 21l-6 -6',
  'chart-bar':
    'M3 13a1 1 0 0 1 1 -1h2a1 1 0 0 1 1 1v6a1 1 0 0 1 -1 1h-2a1 1 0 0 1 -1 -1z M9 9a1 1 0 0 1 1 -1h2a1 1 0 0 1 1 1v10a1 1 0 0 1 -1 1h-2a1 1 0 0 1 -1 -1z M15 5a1 1 0 0 1 1 -1h2a1 1 0 0 1 1 1v14a1 1 0 0 1 -1 1h-2a1 1 0 0 1 -1 -1z M4 20h16',
  'chart-line': 'M4 19l16 0 M4 15l4 -6l4 2l4 -5l4 4',
  'chart-area': 'M4 19l16 0 M4 15l4 -6l4 2l4 -5l4 4 M4 19l0 -4l4 -6l4 2l4 -5l4 4l0 9z',
  download: 'M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2 M7 11l5 5l5 -5 M12 4l0 12',
  copy: 'M8 10a2 2 0 0 1 2 -2h8a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-8a2 2 0 0 1 -2 -2z M16 8v-2a2 2 0 0 0 -2 -2h-8a2 2 0 0 0 -2 2v8a2 2 0 0 0 2 2h2',
  users:
    'M9 7a4 4 0 1 0 0 -0.001 M3 21v-2a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v2 M16 3.13a4 4 0 0 1 0 7.75 M21 21v-2a4 4 0 0 0 -3 -3.85',
  note: 'M13 20l7 -7 M13 20v-6a1 1 0 0 1 1 -1h6v-7a2 2 0 0 0 -2 -2h-12a2 2 0 0 0 -2 2v14a2 2 0 0 0 2 2h8',
  plus: 'M12 5l0 14 M5 12l14 0',
  trash: 'M4 7l16 0 M10 11l0 6 M14 11l0 6 M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2 -2l1 -12 M9 7v-3a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v3',
  point: 'M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0 -8',
};

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName;
  size?: number;
}

export function Icon({ name, size = 18, className, ...rest }: IconProps) {
  const filled = name === 'point';
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={['tab-icon', className].filter(Boolean).join(' ')}
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {PATHS[name].split(' M').map((seg, i) => (
        <path key={i} d={i === 0 ? seg : `M${seg}`} />
      ))}
    </svg>
  );
}

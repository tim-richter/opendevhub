/** The opendevhub mark (same shape as `public/logo.svg`), drawn in the current text colour. */
export function Logo({ size = 16 }: { size?: number }) {
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 100 100" aria-hidden="true" focusable="false">
      <g stroke="currentColor" strokeWidth={6} fill="none" strokeLinejoin="round" strokeLinecap="round">
        <polygon points="50,10 84.64,30 84.64,70 50,90 15.36,70 15.36,30" />
        <circle cx="50" cy="50" r="15" />
        <line x1="50" y1="10" x2="50" y2="35" />
        <line x1="84.64" y1="30" x2="62.99" y2="42.5" />
        <line x1="84.64" y1="70" x2="62.99" y2="57.5" />
        <line x1="50" y1="90" x2="50" y2="65" />
        <line x1="15.36" y1="70" x2="37.01" y2="57.5" />
        <line x1="15.36" y1="30" x2="37.01" y2="42.5" />
      </g>
    </svg>
  );
}

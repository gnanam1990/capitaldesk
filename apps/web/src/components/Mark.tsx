/**
 * The CapitalDesk mark: four aligned ledger leaves, drawn as geometry rather than shipped
 * as a raster placeholder. `currentColor` lets it inherit the surface it sits on.
 */
export function Mark({ size = 24, title }: { size?: number; title?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      role={title === undefined ? 'presentation' : 'img'}
      aria-hidden={title === undefined ? true : undefined}
      aria-label={title}
    >
      {title !== undefined ? <title>{title}</title> : null}
      <rect
        x="2.5"
        y="3.5"
        width="19"
        height="17"
        rx="2.5"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path d="M6.5 8.25h7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M6.5 12h11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M6.5 15.75h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

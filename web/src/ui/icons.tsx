/** Line icons on a 20 px grid, drawn in currentColor. */
import type { ReactNode } from 'react'

const Icon = ({ children, size = 18 }: { children: ReactNode; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
)

export const SearchIcon = () => (
  <Icon>
    <circle cx="8.5" cy="8.5" r="5.5" />
    <path d="m13 13 4 4" />
  </Icon>
)
export const PlusIcon = () => (
  <Icon>
    <path d="M10 4v12M4 10h12" />
  </Icon>
)
export const MinusIcon = () => (
  <Icon>
    <path d="M4 10h12" />
  </Icon>
)
/** Reset to the whole city: four corners pulled outward. */
export const ExtentIcon = () => (
  <Icon>
    <path d="M3 7V3h4M13 3h4v4M17 13v4h-4M7 17H3v-4" />
  </Icon>
)
export const SlidersIcon = () => (
  <Icon>
    <path d="M4 6h7M15 6h1M4 14h1M9 14h7" />
    <circle cx="13" cy="6" r="2" />
    <circle cx="7" cy="14" r="2" />
  </Icon>
)
export const CloseIcon = ({ size }: { size?: number }) => (
  <Icon size={size}>
    <path d="m5 5 10 10M15 5 5 15" />
  </Icon>
)
export const BuildingIcon = ({ size }: { size?: number }) => (
  <Icon size={size}>
    <path d="M4 17V5l6-2v14M10 7l6 2v8M2.5 17h15M6.5 7.5v.01M6.5 10.5v.01M6.5 13.5v.01M13 11v.01M13 14v.01" />
  </Icon>
)
export const ExternalIcon = () => (
  <Icon size={13}>
    <path d="M11 4h5v5M16 4l-7 7M14 12v4H4V6h4" />
  </Icon>
)

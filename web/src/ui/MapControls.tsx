import { ExtentIcon, MinusIcon, PlusIcon, SlidersIcon } from './icons'

interface Props {
  onZoomIn: () => void
  onZoomOut: () => void
  onReset: () => void
  settingsOpen: boolean
  onSettings: () => void
}

/** The floating control column: zoom, whole-city view, settings. */
export function MapControls({ onZoomIn, onZoomOut, onReset, settingsOpen, onSettings }: Props) {
  return (
    <nav className="controls" aria-label="Map controls">
      <div className="control-group">
        <button className="icon-btn" onClick={onZoomIn} aria-label="Zoom in" title="Zoom in">
          <PlusIcon />
        </button>
        <button className="icon-btn" onClick={onZoomOut} aria-label="Zoom out" title="Zoom out">
          <MinusIcon />
        </button>
      </div>
      <div className="control-group">
        <button className="icon-btn" onClick={onReset} aria-label="Show the whole city" title="Whole city">
          <ExtentIcon />
        </button>
      </div>
      <div className="control-group">
        <button className="icon-btn" onClick={onSettings} aria-label="Map settings" aria-expanded={settingsOpen} aria-pressed={settingsOpen} title="Settings">
          <SlidersIcon />
        </button>
      </div>
    </nav>
  )
}

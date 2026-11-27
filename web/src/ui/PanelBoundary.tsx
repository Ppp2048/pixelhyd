import { Component, type ErrorInfo, type ReactNode } from 'react'
import { CloseIcon } from './icons'

interface Props {
  children: ReactNode
  /** What the panel shows (a card, a home, the search); a new value clears an earlier failure. */
  resetKey: string
  /** Close the panel (back to the plain map). */
  onClose: () => void
}

interface State {
  /** The panel (resetKey) that failed; CATCHING until componentDidCatch knows it; null when none has. */
  failedFor: string | null
}

const CATCHING = '__catching__' // never a resetKey (those start with homes:, card: or a home id)

/**
 * Keeps a failing side panel (a card, home search, the comparison) from taking the map down with it:
 * React unmounts everything under the nearest boundary, and without one that is the whole app. The
 * notice stays only for the panel that failed: once the panel shows something else, it renders again.
 */
export class PanelBoundary extends Component<Props, State> {
  state: State = { failedFor: null }

  static getDerivedStateFromError(): Partial<State> {
    return { failedFor: CATCHING }
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    this.setState({ failedFor: this.props.resetKey })
    console.error('Side panel failed', error, info.componentStack)
  }

  render() {
    const { failedFor } = this.state
    if (failedFor === null || (failedFor !== CATCHING && failedFor !== this.props.resetKey)) return this.props.children
    return (
      <aside className="panel card" role="alert" aria-label="Panel error">
        <button className="icon-btn ghost card-close" onClick={this.props.onClose} aria-label="Close">
          <CloseIcon size={16} />
        </button>
        <p className="caution">This panel could not be shown. The map still works; close this and try again.</p>
      </aside>
    )
  }
}

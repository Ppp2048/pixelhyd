import { isValidElement, type ReactElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { PanelBoundary } from './PanelBoundary'

// No DOM in these tests: the boundary's lifecycle is driven directly, as React would drive it.
function boundary(resetKey: string, onClose = () => {}) {
  const b = new PanelBoundary({ children: 'the card', resetKey, onClose })
  b.setState = (s) => Object.assign(b.state, typeof s === 'function' ? s(b.state, b.props) : s)
  return b
}

describe('PanelBoundary', () => {
  it('shows the panel while nothing has failed', () => {
    expect(boundary('card:b1').render()).toBe('the card')
  })

  it('replaces a failed panel with a closable notice, not the whole app', () => {
    const onClose = vi.fn()
    const b = boundary('card:b1', onClose)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    Object.assign(b.state, PanelBoundary.getDerivedStateFromError())
    b.componentDidCatch(new Error('boom'), { componentStack: '' })
    const out = b.render() as ReactElement<{ role: string; children: ReactElement<{ onClick: () => void }>[] }>
    expect(isValidElement(out)).toBe(true)
    expect(out.props.role).toBe('alert')
    out.props.children[0].props.onClick()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('shows the panel again once it shows something else', () => {
    const b = boundary('card:b1')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    Object.assign(b.state, PanelBoundary.getDerivedStateFromError())
    b.componentDidCatch(new Error('boom'), { componentStack: '' })
    expect(b.render()).not.toBe('the card') // the same panel re-rendered: still the notice
    ;(b as { props: typeof b.props }).props = { ...b.props, resetKey: 'card:b2' }
    expect(b.render()).toBe('the card')
  })
})

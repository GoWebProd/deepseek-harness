// @vitest-environment jsdom
import { StrictMode, useMemo } from 'react'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { DisclosureBinding, DisclosureObserver } from '../src/client/contract/slots.ts'
import { bindDisclosure } from '../src/client/chat/use-disclosure.ts'

afterEach(cleanup)

interface Material {
  readonly expanded: boolean
  readonly text: string
}

function observer() {
  const store = createSnapshotStore<Material>({ expanded: false, text: 'preview' })
  const listeners = new Set<() => void>()
  let active = false
  let pending: AbortController | undefined
  const reads: Array<{ signal: AbortSignal; finish(): void }> = []
  const activate = vi.fn(() => { active = true })
  const dispose = vi.fn(() => { active = false; pending?.abort() })
  const source: DisclosureObserver<Material> = {
    getSnapshot: () => store.getSnapshot(),
    subscribe: (listener) => {
      listeners.add(listener)
      const release = store.subscribe(listener)
      return () => { release(); listeners.delete(listener) }
    },
    activate,
    dispose,
    setExpanded: vi.fn((expanded: boolean) => {
      if (!active || expanded === store.getSnapshot().expanded) return
      if (!expanded) pending?.abort()
      store.set({ ...store.getSnapshot(), expanded })
      if (expanded) {
        const request = pending = new AbortController()
        reads.push({ signal: request.signal, finish: () => {
          if (!request.signal.aborted) store.set({ ...store.getSnapshot(), text: 'full material' })
        } })
      }
    }),
  }
  return { source, activate, dispose, reads, listeners, isActive: () => active }
}

function Reader({ binding }: { binding: DisclosureBinding<Material> }) {
  const snapshot = binding.useSnapshot()
  const disclosure = binding.useDisclosure()
  return <button type="button" onClick={disclosure.toggle}>{snapshot.text}:{String(disclosure.expanded)}</button>
}

describe('framework disclosure observers', () => {
  it('keeps abandoned Strict Mode descriptors inert and reacquires only committed readers', async () => {
    const created: ReturnType<typeof observer>[] = []
    const useDisclosure = bindDisclosure(createSnapshotStore(0))
    function View() {
      const binding = useMemo(() => {
        const next = observer()
        created.push(next)
        return useDisclosure.withObserver!(next.source)
      }, [])
      return <Reader binding={binding} />
    }
    const view = render(<StrictMode><View /></StrictMode>)
    expect(created).toHaveLength(2)
    const active = created.find(value => value.isActive())!
    const abandoned = created.find(value => value !== active)!
    expect(abandoned.activate).not.toHaveBeenCalled()
    expect(abandoned.listeners.size).toBe(0)
    expect(active.activate).toHaveBeenCalledTimes(2)
    expect(active.dispose).toHaveBeenCalledOnce()
    expect(active.listeners.size).toBe(1)
    fireEvent.click(view.getByRole('button'))
    await waitFor(() => { expect(active.reads).toHaveLength(1) })
    view.unmount()
    expect(active.isActive()).toBe(false)
    expect(active.listeners.size).toBe(0)
    expect(active.reads[0]!.signal.aborted).toBe(true)
    expect(active.dispose).toHaveBeenCalledTimes(2)
    act(() => { active.reads[0]!.finish() })
    expect(active.source.getSnapshot().text).toBe('preview')
  })

  it('cancels expanded material when the enclosing turn resets its disclosures', async () => {
    const reset = createSnapshotStore(0)
    const material = observer()
    const binding = bindDisclosure(reset).withObserver!(material.source)
    const view = render(<Reader binding={binding} />)
    fireEvent.click(view.getByRole('button'))
    await waitFor(() => { expect(material.reads).toHaveLength(1) })
    act(() => { reset.set(1) })
    await waitFor(() => { expect(view.getByRole('button').textContent).toContain(':false') })
    expect(material.reads[0]!.signal.aborted).toBe(true)
    expect(material.source.getSnapshot().expanded).toBe(false)
    view.unmount()
    expect(material.dispose).toHaveBeenCalledOnce()
  })

  it('keeps independent disclosures and holds resources until the last snapshot reader leaves', async () => {
    const material = observer()
    const binding = bindDisclosure(createSnapshotStore(0)).withObserver!(material.source)
    const view = render(<><Reader binding={binding} /><Reader binding={binding} /></>)
    expect(material.activate).toHaveBeenCalledOnce()
    expect(material.listeners.size).toBe(2)
    fireEvent.click(view.getAllByRole('button')[0]!)
    await waitFor(() => { expect(material.reads).toHaveLength(1) })
    expect(material.source.getSnapshot().expanded).toBe(true)
    view.unmount()
    expect(material.dispose).toHaveBeenCalledOnce()
    expect(material.listeners.size).toBe(0)
  })

  it('retains the observer receiver when reading snapshots', () => {
    const material = observer()
    const read = material.source.getSnapshot.bind(material.source)
    material.source.getSnapshot = function () {
      expect(this).toBe(material.source)
      return read()
    }
    const binding = bindDisclosure(createSnapshotStore(0)).withObserver!(material.source)
    const view = render(<Reader binding={binding} />)
    expect(view.getByRole('button').textContent).toBe('preview:false')
  })

  it('releases partial resources if activation throws', () => {
    const material = observer()
    const expected = new Error('activation failed')
    material.source.activate = () => { throw expected }
    const binding = bindDisclosure(createSnapshotStore(0)).withObserver!(material.source)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const suppressExpectedError = (event: ErrorEvent) => { if (event.error === expected) event.preventDefault() }
    window.addEventListener('error', suppressExpectedError)
    try { expect(() => render(<Reader binding={binding} />)).toThrow(expected) }
    finally { window.removeEventListener('error', suppressExpectedError); error.mockRestore() }
    expect(material.listeners.size).toBe(0)
    expect(material.dispose).toHaveBeenCalledOnce()
  })

  it('disposes activated resources even if subscription rollback also throws', () => {
    const material = observer()
    const activationError = new Error('activation failed')
    const unsubscribeError = new Error('unsubscribe failed')
    const activate = material.source.activate.bind(material.source)
    const subscribe = material.source.subscribe.bind(material.source)
    material.source.activate = () => { activate(); throw activationError }
    material.source.subscribe = (listener) => {
      const release = subscribe(listener)
      return () => { release(); throw unsubscribeError }
    }
    const binding = bindDisclosure(createSnapshotStore(0)).withObserver!(material.source)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const suppressExpectedError = (event: ErrorEvent) => {
      if (event.error instanceof AggregateError && event.error.errors.includes(activationError)) event.preventDefault()
    }
    window.addEventListener('error', suppressExpectedError)
    let reported: unknown
    try {
      expect(() => {
        try { render(<Reader binding={binding} />) } catch (caught) { reported = caught; throw caught }
      }).toThrow(AggregateError)
    } finally { window.removeEventListener('error', suppressExpectedError); error.mockRestore() }
    expect((reported as AggregateError).errors).toEqual([activationError, unsubscribeError])
    expect(material.isActive()).toBe(false)
    expect(material.listeners.size).toBe(0)
    expect(material.dispose).toHaveBeenCalledOnce()
  })
})

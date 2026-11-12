/** Bind independent disclosure state to a Chat seat's reset source. */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { DisclosureBinding, DisclosureObserver, UseDisclosure } from '../contract/slots.ts'

/**
 * Own one initially collapsed disclosure without an external subscription.
 * @param version - reset generation; unchanged generations retain local open state.
 * @returns the open state, an explicit setter, and a toggle action.
 */
export function useDisclosure(version = 0): ReturnType<UseDisclosure> {
  const [expandedVersion, setExpandedVersion] = useState<number | null>(null)
  const expanded = expandedVersion === version
  const setExpanded = useCallback((open: boolean) => {
    setExpandedVersion(open ? version : null)
  }, [version])
  const toggle = useCallback(() => {
    setExpandedVersion(previous => previous === version ? null : version)
  }, [version])
  return { expanded, setExpanded, toggle }
}

/**
 * Bind a Hook without subscribing until a component calls it.
 * @param reset - stable source whose version advances when the seat is hidden by its Turn.
 * @returns a Hook with independent open state for each invocation.
 */
export function bindDisclosure(reset: ObservableSnapshot<number>): UseDisclosure {
  const subscribe = (listener: () => void) => reset.subscribe(listener)
  const getSnapshot = () => reset.getSnapshot()
  const useBoundDisclosure: UseDisclosure = function useBoundDisclosure() {
    const version = useSyncExternalStore(subscribe, getSnapshot)
    return useDisclosure(version)
  }
  useBoundDisclosure.withObserver = observer => bindObserver(useBoundDisclosure, observer)
  return useBoundDisclosure
}

function bindObserver<State>(useBase: UseDisclosure, observer: DisclosureObserver<State>): DisclosureBinding<State> {
  const expandedViews = new Set<symbol>()
  const getSnapshot = () => observer.getSnapshot()
  let readers = 0
  const subscribe = (listener: () => void): (() => void) => {
    const unsubscribe = observer.subscribe(listener)
    if (readers++ === 0) {
      try { observer.activate(); observer.setExpanded(expandedViews.size > 0) } catch (error) {
        readers--
        const errors: unknown[] = [error]
        try { unsubscribe() } catch (cleanupError) { errors.push(cleanupError) }
        try { observer.dispose() } catch (cleanupError) { errors.push(cleanupError) }
        if (errors.length === 1) throw error
        throw new AggregateError(errors, 'Disclosure observer activation failed')
      }
    }
    let active = true
    return () => {
      if (!active) return
      active = false
      try { unsubscribe() } finally {
        if (--readers === 0) { expandedViews.clear(); observer.dispose() }
      }
    }
  }
  return {
    useSnapshot: () => useSyncExternalStore(subscribe, getSnapshot, getSnapshot),
    useDisclosure: function useObservedDisclosure() {
      const disclosure = useBase()
      const [identity] = useState(() => Symbol('disclosure'))
      useEffect(() => {
        if (disclosure.expanded) expandedViews.add(identity)
        else expandedViews.delete(identity)
        if (readers > 0) observer.setExpanded(expandedViews.size > 0)
        return () => {
          expandedViews.delete(identity)
          if (readers > 0) observer.setExpanded(expandedViews.size > 0)
        }
      }, [disclosure.expanded, identity, observer, expandedViews])
      return disclosure
    },
  }
}

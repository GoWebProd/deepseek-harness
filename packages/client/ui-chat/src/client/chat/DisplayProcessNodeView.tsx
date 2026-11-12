import { memo } from 'react'
import { IconChevronDownOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatNodeViewProps } from '../contract/slots.ts'
import css from './TurnProcessNodeView.module.css'

/** Disclosure for a display exchange; no Engine timing or step count is inferred. */
export const DisplayProcessNodeView = memo(function DisplayProcessNodeView({ node, displayProcess, t }: ChatNodeViewProps<'display-process'>) {
  if (displayProcess === undefined || node.data.status !== 'completed') return null
  const canCollapse = displayProcess.foldable && displayProcess.hasContent
  return <button type="button" className={css.root} disabled={!canCollapse}
    data-display-process={node.data.id} data-open={displayProcess.open || undefined}
    data-display-tool-count={node.data.toolCallCount} aria-expanded={displayProcess.hasContent ? displayProcess.open : undefined}
    onClick={(event) => { event.currentTarget.focus(); displayProcess.setOpen(!displayProcess.open) }}>
    <span className={css.label}>{t('message.turnProcess.worked')}</span>
    {canCollapse && <IconChevronDownOutlineRegular className={css.chevron} />}
  </button>
})

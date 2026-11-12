/** Root/subcall Tool composition with one keyed atomic dispatch path. */
import { memo, useCallback, useMemo, type ReactNode } from 'react'
import type { DisclosureBinding, ToolCallBlock } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ToolCallOwnerProps, ToolCallPhaseProps, ToolMaterialSnapshot, ToolTreeProps } from '../contract/slots.ts'
import { toolRowModel } from './models/tool-call-model.ts'
import { GenericToolCard } from './toolviews/GenericToolCard.tsx'
import css from './ToolCallTree.module.css'

const EMPTY_MATERIAL: ToolMaterialSnapshot = { expanded: false, loading: false, error: '', loadingLabel: '', retryLabel: '' }

function toolCallPhase(block: ToolCallBlock): ToolCallPhaseProps {
  if ('kind' in block) return { phase: 'result', block }
  return block.phase === 'preparing' ? { phase: 'preparing', block } : { phase: 'start', block }
}

/** Resolve a Tool call's wire name from its current stage. */
function callName(call: ToolCallPhaseProps): string {
  return call.phase === 'result' ? call.block.call?.name ?? '' : call.block.name
}

type ToolCallProps = Pick<ToolTreeProps, 'renderSlot' | 'createToolMaterial' | 'openFile' | 'cwd' | 'inspectCall' | 'loadImage' | 'useDisclosure'> & {
  source?: unknown
  renderFallback: (owner: ToolCallOwnerProps) => ReactNode
  callId: string
  toolName: string
  call: ToolCallPhaseProps
  home?: string | undefined
  children?: ReactNode
}

/** One atomic call dispatched through the Tool-owned keyed slot. */
const ToolCall = memo(function ToolCall(props: ToolCallProps) {
  const { source, createToolMaterial, callId, useDisclosure } = props
  const material = useMemo(() => createToolMaterial?.(source, callId), [createToolMaterial, source, callId])
  const binding = useMemo(() => {
    if (material === undefined) return undefined
    if (useDisclosure.withObserver === undefined) throw new Error('Tool material requires a framework disclosure binding')
    return useDisclosure.withObserver(material)
  }, [material, useDisclosure])
  const retry = useCallback(() => { material?.retry() }, [material])
  return binding === undefined
    ? <AtomicToolCall {...props} snapshot={EMPTY_MATERIAL} />
    : <ObservedToolCall {...props} binding={binding} retry={retry} />
})

function ObservedToolCall({ binding, ...props }: ToolCallProps & {
  binding: DisclosureBinding<ToolMaterialSnapshot>
  retry: (() => void) | undefined
}) {
  const snapshot = binding.useSnapshot()
  return <AtomicToolCall {...props} snapshot={snapshot} useDisclosure={binding.useDisclosure} />
}

const AtomicToolCall = memo(function AtomicToolCall({
  renderSlot, callId, toolName, call, openFile, renderFallback,
  cwd, home, inspectCall, loadImage, useDisclosure, children, snapshot, retry,
}: ToolCallProps & { snapshot: ToolMaterialSnapshot; retry?: (() => void) | undefined }) {
  const resolvedCall = useMemo(() => snapshot.block === undefined ? call : toolCallPhase(snapshot.block), [snapshot.block, call])
  const owner: ToolCallOwnerProps = useMemo(() => ({
    callId,
    toolName,
    ...resolvedCall,
    openFile,
    cwd,
    home,
    loadImage,
    useDisclosure,
    inspect: inspectCall === undefined ? undefined : () => { inspectCall(callId) },
  }), [callId, toolName, resolvedCall, openFile, cwd, home, loadImage, inspectCall, useDisclosure])
  const autoReviewDenied = useMemo(
    () => resolvedCall.phase === 'result' && toolRowModel(toolName, resolvedCall.block).autoReviewDenial !== null,
    [toolName, resolvedCall],
  )
  return (
    <div
      className={css.callRow}
      data-chat-anchor-key={`call:${callId}`}
      data-chat-call-id={callId}
    >
      {autoReviewDenied
        ? renderFallback(owner)
        : renderSlot('tool.call.toolview', owner, {
          entryKey: toolName,
          fallback: renderFallback(owner),
        })}
      {snapshot.expanded && (snapshot.loading || snapshot.error !== '') && (
        <div className={css.materialStatus}>
          <p role={snapshot.error === '' ? 'status' : 'alert'}>{snapshot.error || snapshot.loadingLabel}</p>
          {snapshot.error !== '' && <button type="button" onClick={retry}>{snapshot.retryLabel}</button>}
        </div>
      )}
      {children}
    </div>
  )
})

const ToolCallBranch = memo(function ToolCallBranch({
  renderSlot, source, createToolMaterial, block, cwd, home, openFile, renderFallback, inspectCall, loadImage, useDisclosure,
}: Pick<ToolTreeProps, 'renderSlot' | 'createToolMaterial' | 'cwd' | 'openFile' | 'inspectCall' | 'loadImage' | 'useDisclosure'> & {
  source?: unknown
  renderFallback: (owner: ToolCallOwnerProps) => ReactNode
  block: ToolCallBlock
  home?: string | undefined
}) {
  const call = useMemo(() => toolCallPhase(block), [block])
  return (
    <ToolCall
      renderSlot={renderSlot}
      source={source}
      createToolMaterial={createToolMaterial}
      callId={call.block.callId}
      toolName={callName(call)}
      call={call}
      openFile={openFile}
      renderFallback={renderFallback}
      cwd={cwd}
      home={home}
      inspectCall={inspectCall}
      useDisclosure={useDisclosure}
      loadImage={loadImage}
    >
      {call.phase !== 'preparing' && call.block.subCalls.length > 0 ? (
        <div className={css.subCalls} data-subcalls>
          {call.block.subCalls.map(child => (
            <ToolCallBranch
              key={child.callId}
              renderSlot={renderSlot}
              createToolMaterial={createToolMaterial}
              block={child}
              cwd={cwd}
              home={home}
              openFile={openFile}
              renderFallback={renderFallback}
              inspectCall={inspectCall}
              useDisclosure={useDisclosure}
              loadImage={loadImage}
            />
          ))}
        </div>
      ) : null}
    </ToolCall>
  )
})

/**
 * Render one root Tool call and its recursive children through the same
 * atomic keyed dispatch.
 * @param props - whole-Tool owner data and the Tool-owned child-slot share.
 * @returns the Tool call tree.
 */
export function ToolCallTree({
  renderSlot, node, createToolMaterial, cwd, openFile, inspectCall, loadImage,
  useDisclosure, useHostInfo, t, useContextMenu, sessionId, resolveFilePath,
}: ToolTreeProps) {
  const { getTriggerProps } = useContextMenu()
  const getFileTriggerProps = useCallback((path: string) => getTriggerProps(() => ({
    kind: 'file', value: { sessionId, path: resolveFilePath(path) },
  })), [getTriggerProps, sessionId, resolveFilePath])
  const renderFallback = useCallback((owner: ToolCallOwnerProps) =>
    <GenericToolCard {...owner} t={t} getFileTriggerProps={getFileTriggerProps} />, [t, getFileTriggerProps])
  const home = useHostInfo(info => info.home)
  return (
    <ToolCallBranch
      renderSlot={renderSlot}
      source={node.data}
      createToolMaterial={createToolMaterial}
      block={node.data.root}
      cwd={cwd}
      home={home}
      openFile={openFile}
      renderFallback={renderFallback}
      inspectCall={inspectCall}
      useDisclosure={useDisclosure}
      loadImage={loadImage}
    />
  )
}

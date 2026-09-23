import { AlertDialog, Button } from '@heroui/react'
import { useState } from 'react'
import { notifyError } from '../lib/notify'

type ConfirmContent = {
  title: string
  body: string
  confirmLabel: string
  cancelLabel: string
  danger: boolean
}

function sameContent(a: ConfirmContent, b: ConfirmContent): boolean {
  return (
    a.title === b.title &&
    a.body === b.body &&
    a.confirmLabel === b.confirmLabel &&
    a.cancelLabel === b.cancelLabel &&
    a.danger === b.danger
  )
}

/**
 * While `onConfirm` runs the dialog cannot be dismissed (Esc, backdrop, cancel button), so an
 * action in flight can never be mistaken for a newer confirm. Give each distinct confirm its
 * own `key` so that the pending state never carries over.
 */
export function ConfirmDialog(props: {
  isOpen: boolean
  title: string
  body: string
  confirmLabel: string
  cancelLabel?: string
  danger?: boolean
  isPending?: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void | Promise<void>
}) {
  const live: ConfirmContent = {
    title: props.title,
    body: props.body,
    confirmLabel: props.confirmLabel,
    cancelLabel: props.cancelLabel ?? '取消',
    danger: Boolean(props.danger),
  }
  // Callers usually clear their content together with isOpen; keep showing the last open
  // content while the exit animation runs instead of flashing an empty dialog.
  const [frozen, setFrozen] = useState(live)
  if (props.isOpen && !sameContent(frozen, live)) setFrozen(live)
  const content = props.isOpen ? live : frozen

  const [running, setRunning] = useState(false)
  const pending = running || Boolean(props.isPending)

  async function confirm() {
    if (pending) return
    setRunning(true)
    try {
      await props.onConfirm()
    } catch (error) {
      // invoke() already toasts internal errors; user-facing ones are shown here.
      notifyError(error)
    } finally {
      setRunning(false)
    }
  }

  return (
    <AlertDialog.Backdrop
      isOpen={props.isOpen}
      onOpenChange={(open) => {
        if (!open && pending) return
        props.onOpenChange(open)
      }}
      isDismissable={!pending}
      isKeyboardDismissDisabled={pending}
    >
      <AlertDialog.Container size="sm">
        <AlertDialog.Dialog>
          <AlertDialog.Header>
            <AlertDialog.Heading>{content.title}</AlertDialog.Heading>
          </AlertDialog.Header>
          <AlertDialog.Body>
            <p className="text-sm text-muted">{content.body}</p>
          </AlertDialog.Body>
          <AlertDialog.Footer>
            <Button slot="close" variant="ghost" isDisabled={pending}>
              {content.cancelLabel}
            </Button>
            <Button
              variant={content.danger ? 'danger' : 'primary'}
              isPending={pending}
              onPress={() => {
                void confirm()
              }}
            >
              {content.confirmLabel}
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Dialog>
      </AlertDialog.Container>
    </AlertDialog.Backdrop>
  )
}

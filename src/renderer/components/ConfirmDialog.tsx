import { AlertDialog, Button, toast } from '@heroui/react'
import { useState } from 'react'

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
      const err = error as { message?: unknown; user?: unknown }
      if (err.user === true && typeof err.message === 'string') toast.danger(err.message)
      else console.error('confirm action failed', error)
    } finally {
      setRunning(false)
    }
  }

  return (
    <AlertDialog.Backdrop
      isOpen={props.isOpen}
      onOpenChange={props.onOpenChange}
      isDismissable
      isKeyboardDismissDisabled={false}
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
            <Button slot="close" variant="ghost">
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

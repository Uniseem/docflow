/**
 * 「重新启动」 on the 处理引擎未运行 screen. With the bridge present (main did not answer at
 * startup) main relaunches the app; without it (preload failed), or when main still does
 * not answer, reloading the page is all the renderer can do.
 */
export async function relaunchApp(): Promise<void> {
  if (window.docflow) {
    try {
      await window.docflow.invoke('app:relaunch', {})
      return
    } catch {
      // Fall back to a reload below.
    }
  }
  window.location.reload()
}

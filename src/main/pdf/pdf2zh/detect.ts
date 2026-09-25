// OnnxModel.predict of pdf2zh with onnxruntime-web (WebAssembly, no native module) in a
// worker thread. The session is kept for the life of the worker.
import { availableParallelism } from 'node:os'
import type * as OrtModule from 'onnxruntime-web'
import type { PageLayout } from '../../../shared/pdf-types'
import { imageSize, postprocess, prepareInput } from './doclayout'
import { renderPage, type Pixmap } from './render'

type Ort = typeof OrtModule
type Session = Awaited<ReturnType<Ort['InferenceSession']['create']>>

let loaded: { path: string; ort: Ort; session: Promise<Session> } | undefined

async function sessionFor(modelPath: string): Promise<{ ort: Ort; session: Session }> {
  if (!loaded || loaded.path !== modelPath) {
    const ort = await import('onnxruntime-web')
    ort.env.wasm.numThreads = Math.max(1, Math.min(16, availableParallelism()))
    const { readFile } = await import('node:fs/promises')
    const session = readFile(modelPath).then((bytes) =>
      ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] }),
    )
    loaded = { path: modelPath, ort, session }
  }
  return { ort: loaded.ort, session: await loaded.session }
}

/** `model.predict(image, imgsz=int(pix.height / 32) * 32)` on one pixmap. */
export async function detectPixmap(modelPath: string, pix: Pixmap): Promise<PageLayout> {
  const { ort, session } = await sessionFor(modelPath)
  const input = prepareInput(pix.rgb, pix.width, pix.height, imageSize(pix.height))
  const tensor = new ort.Tensor('float32', input.data, [1, 3, input.height, input.width])
  const outputs = await session.run({ [session.inputNames[0] ?? 'images']: tensor })
  const output = outputs[session.outputNames[0] ?? 'output0']
  const boxes = output
    ? postprocess(output.data as Float32Array, output.dims[1] ?? 0, input, pix)
    : []
  return { width: pix.width, height: pix.height, boxes }
}

/** translate_patch for one page: render it, then detect its layout. */
export async function detectPage(
  path: string,
  index: number,
  modelPath: string,
): Promise<PageLayout> {
  return detectPixmap(modelPath, await renderPage(path, index))
}

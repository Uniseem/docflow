export function collectPdfDrop(files: File[]): { paths: string[]; ignored: number } {
  const pdfs: File[] = []
  let ignored = 0
  for (const file of files) {
    if (file.name.toLowerCase().endsWith('.pdf')) pdfs.push(file)
    else ignored += 1
  }
  if (pdfs.length === 0 || !window.docflow) return { paths: [], ignored: ignored + pdfs.length }
  const paths: string[] = []
  for (const path of window.docflow.pathsForFiles(pdfs)) {
    // webUtils.getPathForFile returns '' for files that are not backed by a local path
    // (e.g. dragged out of a browser); those cannot be added.
    if (path) paths.push(path)
    else ignored += 1
  }
  return { paths, ignored }
}

import type { AnalysisResult, LayoutUnit } from '../../../shared/pdf-types'

/** converter worker(): blank strings and pure formulas are not sent to the translator. */
export function needsTranslation(text: string): boolean {
  return text.trim() !== '' && !/^\{v\d+\}$/.test(text)
}

export function segmentId(unit: LayoutUnit, index: number): string {
  return `${unit.id}#${index}`
}

export type Segment = { id: string; text: string }

export function segmentsOf(analysis: AnalysisResult): Segment[] {
  const out: Segment[] = []
  for (const unit of analysis.units) {
    unit.texts.forEach((text, index) => {
      if (needsTranslation(text)) out.push({ id: segmentId(unit, index), text })
    })
  }
  return out
}

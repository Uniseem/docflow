import { describe, expect, test } from 'vitest'
import type { Matrix } from '../../../shared/pdf-types'
import { figureWidth, interpretPage, multMatrix, pageCtm, type InterpForm } from './interp'

const enc = (text: string) => new TextEncoder().encode(text)
const dec = (bytes: Uint8Array) => new TextDecoder('latin1').decode(bytes)
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

function run(content: string, forms: Record<string, InterpForm> = {}, ctm = IDENTITY) {
  return interpretPage(enc(content), ctm, 612, (name) => forms[name])
}

describe('interpretPage: ops_base (pdfinterp.execute)', () => {
  test('drops every T operator, quotes, marked content and inline images; keeps BT/ET', () => {
    const { units } = run(
      '/Span <</MCID 0>> BDC BT /F1 12 Tf 1 0 0 1 72 700 Tm (Hi) Tj [(a) -20 (b)] TJ ' +
        '(x) \' 1 2 (y) " ET EMC /P BMC EMC /T MP /T <<>> DP 0 0 1 rg 10 10 m 20 10 l f ' +
        'BI /W 1 /H 1 /BPC 8 /CS /G ID \x00 EI q 1 0 0 1 5 5 cm Q',
    )
    const base = dec(units[0]!.opsBase)
    expect(base).toBe('BT ET 0 0 1 rg 10 10 m 20 10 l f q 1 0 0 1 5 5 cm Q ')
    expect(units[0]!.removed).toBe(4)
  })

  test('unknown operators are skipped, operands of kept ones are copied byte for byte', () => {
    const { units } = run('1 0 0 1 0.50 -3 cm foo 7 /Name1 gs [3 1] 0 d')
    expect(dec(units[0]!.opsBase)).toBe('1 0 0 1 0.50 -3 cm /Name1 gs [3 1] 0 d ')
  })

  test('true/false/null are operands, not operators', () => {
    const { units } = run('/OC /L1 BDC /Artifact <</Visible true>> BDC EMC EMC 1 w')
    expect(dec(units[0]!.opsBase)).toBe('1 w ')
  })
})

describe('interpretPage: do_S lines', () => {
  test('a two-point horizontal black stroke becomes an LTLine and "n S"', () => {
    const { units } = run('0.4 w 0 G 10 100 m 60 100 l S')
    expect(dec(units[0]!.opsBase)).toBe('0.4 w 0 G 10 100 m 60 100 l n S ')
    expect(units[0]!.events).toEqual([
      {
        kind: 'line',
        line: {
          x0: 10,
          y0: 100,
          pts: [
            [10, 100],
            [60, 100],
          ],
          linewidth: 0.4,
        },
      },
    ])
  })

  test.each([
    ['no stroke colour set', '10 100 m 60 100 l S'],
    ['grey', '0.5 G 10 100 m 60 100 l S'],
    ['CMYK black (sum is 1)', '0 0 0 1 K 10 100 m 60 100 l S'],
    ['SCN colour', '/CS0 CS 0 SCN 10 100 m 60 100 l S'],
    ['not horizontal', '0 G 10 100 m 60 101 l S'],
    ['three points', '0 G 10 100 m 30 100 l 60 100 l S'],
    ['closed with s', '0 G 10 100 m 60 100 l s'],
  ])('kept as a path: %s', (_name, content) => {
    const { units } = run(content)
    expect(units[0]!.events).toEqual([])
    expect(dec(units[0]!.opsBase)).not.toContain('n S')
  })

  test('RG 0 0 0 is black; the CTM maps the points', () => {
    const { units } = run('q 2 0 0 2 5 5 cm 0 0 0 RG 1 1 m 3 1 l S Q')
    const line = units[0]!.events[0]
    expect(line).toEqual({
      kind: 'line',
      line: {
        x0: 7,
        y0: 7,
        pts: [
          [7, 7],
          [11, 7],
        ],
        linewidth: 0,
      },
    })
  })
})

describe('interpretPage: text operators and forms', () => {
  test('records the Tf resource name and start point of every show-text operator', () => {
    const { textOps } = run(
      'BT /F2 10 Tf 72 700 Td (a) Tj [-100 (b)] TJ 0 -12 Td (c) Tj 14 TL T* (d) Tj ET',
    )
    expect(textOps.map((op) => [op.font, op.start, op.positioned])).toEqual([
      ['F2', [72, 700], true],
      ['F2', [73, 700], false],
      ['F2', [72, 688], true],
      ['F2', [72, 674], true],
    ])
  })

  test('forms are interpreted in their own unit with Matrix × CTM; no BBox → only counted', () => {
    const inner: InterpForm = {
      handle: '9 0',
      matrix: IDENTITY,
      bbox: undefined,
      content: enc('BT /F1 5 Tf (z) Tj ET'),
      resources: undefined,
      getForm: () => undefined,
    }
    const form: InterpForm = {
      handle: '8 0',
      matrix: [1, 0, 0, 1, 100, 0],
      bbox: [0, 0, 50, 20],
      content: enc('BT /F9 8 Tf (x) Tj ET /Inner Do'),
      resources: 'form-resources',
      getForm: (name) => (name === 'Inner' ? inner : undefined),
    }
    const { units, textOps } = run('BT (a) Tj ET /Fm1 Do /Fm1 Do', { Fm1: form })
    expect(units.map((u) => [u.formPath, u.handle, u.width])).toEqual([
      ['', undefined, 612],
      ['1', '8 0', 50],
      ['2', '8 0', 50],
    ])
    expect(units[1]!.ctm).toEqual([1, 0, 0, 1, 100, 0])
    expect(units[1]!.resources).toBe('form-resources')
    expect(dec(units[1]!.opsBase)).toBe('BT ET /Inner Do ')
    // Page, form 1, its BBox-less inner form, form 2, its inner form.
    expect(textOps.map((op) => [op.formPath, op.font])).toEqual([
      ['', ''],
      ['1', 'F9'],
      ['1/1', 'F1'],
      ['2', 'F9'],
      ['2/1', 'F1'],
    ])
  })
})

describe('pdfminer geometry helpers', () => {
  test('pageCtm follows process_page for each /Rotate', () => {
    expect(pageCtm([10, 20, 610, 820], 0)).toEqual([1, 0, 0, 1, -10, -20])
    expect(pageCtm([10, 20, 610, 820], 90)).toEqual([0, -1, 1, 0, -20, 610])
    expect(pageCtm([10, 20, 610, 820], 180)).toEqual([-1, 0, 0, -1, 610, 820])
    expect(pageCtm([10, 20, 610, 820], 270)).toEqual([0, 1, -1, 0, 820, -10])
  })

  test('multMatrix(m1, m0) applies m1 first; LTFigure reads BBox as x, y, w, h', () => {
    expect(multMatrix([2, 0, 0, 2, 0, 0], [1, 0, 0, 1, 5, 5])).toEqual([2, 0, 0, 2, 5, 5])
    expect(figureWidth([10, 0, 60, 20], IDENTITY)).toBe(60)
  })
})

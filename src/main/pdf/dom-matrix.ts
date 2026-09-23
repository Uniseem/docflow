/**
 * pdf.js polyfills DOMMatrix from the optional native `@napi-rs/canvas`, which we don't ship
 * (no native modules). Parsing only needs 2D affine math — the worker builds Type3 bitmap
 * glyph outlines with `new DOMMatrix().scaleSelf(…).translateSelf(…)` — so a small pure-JS
 * matrix covers it. Import this module before pdf.js.
 */
export class AffineMatrix {
  a = 1
  b = 0
  c = 0
  d = 1
  e = 0
  f = 0

  constructor(init?: ArrayLike<number>) {
    if (init && init.length >= 6) {
      this.a = Number(init[0])
      this.b = Number(init[1])
      this.c = Number(init[2])
      this.d = Number(init[3])
      this.e = Number(init[4])
      this.f = Number(init[5])
    }
  }

  get is2D(): boolean {
    return true
  }

  get isIdentity(): boolean {
    return (
      this.a === 1 && this.b === 0 && this.c === 0 && this.d === 1 && this.e === 0 && this.f === 0
    )
  }

  /** this = this × other */
  multiplySelf(other: AffineMatrix): this {
    const { a, b, c, d, e, f } = this
    this.a = a * other.a + c * other.b
    this.b = b * other.a + d * other.b
    this.c = a * other.c + c * other.d
    this.d = b * other.c + d * other.d
    this.e = a * other.e + c * other.f + e
    this.f = b * other.e + d * other.f + f
    return this
  }

  /** this = other × this */
  preMultiplySelf(other: AffineMatrix): this {
    const copy = new AffineMatrix([other.a, other.b, other.c, other.d, other.e, other.f])
    copy.multiplySelf(this)
    return this.assign(copy)
  }

  translateSelf(tx = 0, ty = 0): this {
    return this.multiplySelf(new AffineMatrix([1, 0, 0, 1, tx, ty]))
  }

  scaleSelf(sx = 1, sy = sx): this {
    return this.multiplySelf(new AffineMatrix([sx, 0, 0, sy, 0, 0]))
  }

  invertSelf(): this {
    const { a, b, c, d, e, f } = this
    const det = a * d - b * c
    if (det === 0) return this.assign(new AffineMatrix([NaN, NaN, NaN, NaN, NaN, NaN]))
    return this.assign(
      new AffineMatrix([
        d / det,
        -b / det,
        -c / det,
        a / det,
        (c * f - d * e) / det,
        (b * e - a * f) / det,
      ]),
    )
  }

  multiply(other: AffineMatrix): AffineMatrix {
    return this.clone().multiplySelf(other)
  }

  translate(tx = 0, ty = 0): AffineMatrix {
    return this.clone().translateSelf(tx, ty)
  }

  scale(sx = 1, sy = sx): AffineMatrix {
    return this.clone().scaleSelf(sx, sy)
  }

  inverse(): AffineMatrix {
    return this.clone().invertSelf()
  }

  transformPoint(point: { x?: number; y?: number } = {}): { x: number; y: number } {
    const x = point.x ?? 0
    const y = point.y ?? 0
    return { x: this.a * x + this.c * y + this.e, y: this.b * x + this.d * y + this.f }
  }

  private clone(): AffineMatrix {
    return new AffineMatrix([this.a, this.b, this.c, this.d, this.e, this.f])
  }

  private assign(other: AffineMatrix): this {
    this.a = other.a
    this.b = other.b
    this.c = other.c
    this.d = other.d
    this.e = other.e
    this.f = other.f
    return this
  }
}

const scope = globalThis as { DOMMatrix?: unknown }
scope.DOMMatrix ??= AffineMatrix

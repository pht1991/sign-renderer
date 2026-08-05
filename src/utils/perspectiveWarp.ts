/**
 * 透视变换：透视校正网格细分法
 *
 * 用单应矩阵（homography）把源矩形精确映射到任意目标四边形，
 * 再把目标区域细分成密集小网格，每个顶点用逆单应矩阵反算源 UV。
 * 相比原来只用两个大三角形做仿射近似，消除了对角折痕和中间歪折。
 */

export type Point = { x: number; y: number }

type Matrix3 = [number, number, number, number, number, number, number, number, number]

/**
 * 将图像透视变换绘制到目标四边形区域
 *
 * @param ctx 目标 Canvas 2D 上下文
 * @param image 源图像（Canvas 或 Image）
 * @param srcW 源图像宽度
 * @param srcH 源图像高度
 * @param dst 四个目标点 [左上, 右上, 右下, 左下]
 * @param segments 目标细分段数；不传则根据画布尺寸自适应（8~32）
 */
export function warpPerspective(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource,
  srcW: number,
  srcH: number,
  dst: [Point, Point, Point, Point],
  segments?: number,
): void {
  const src: [Point, Point, Point, Point] = [
    { x: 0, y: 0 },
    { x: srcW, y: 0 },
    { x: srcW, y: srcH },
    { x: 0, y: srcH },
  ]

  // 退化 fallback：如果目标四边形接近共线或单应解不出，退回到双三角形仿射近似，
  // 至少保证有图可出。
  const H = solveHomography(src, dst)
  const Hinv = solveHomography(dst, src)
  if (!H || !Hinv) {
    fallbackAffine(ctx, image, srcW, srcH, dst)
    return
  }

  const canvasW = ctx.canvas.width
  const canvasH = ctx.canvas.height
  const cols =
    segments ?? Math.max(8, Math.min(32, Math.ceil(Math.max(canvasW, canvasH) / 60)))
  const rows = Math.max(1, Math.round(cols * (srcH / srcW)))

  for (let i = 0; i < cols; i++) {
    const u0 = i / cols
    const u1 = (i + 1) / cols
    for (let j = 0; j < rows; j++) {
      const v0 = j / rows
      const v1 = (j + 1) / rows

      // 目标四边形内部的双线性插值点（参数空间）
      const d00 = bilinearQuad(dst, u0, v0)
      const d10 = bilinearQuad(dst, u1, v0)
      const d11 = bilinearQuad(dst, u1, v1)
      const d01 = bilinearQuad(dst, u0, v1)

      // 用逆单应反算对应的源 UV：真正的透视校正采样点
      const s00 = applyHomography(Hinv, d00)
      const s10 = applyHomography(Hinv, d10)
      const s11 = applyHomography(Hinv, d11)
      const s01 = applyHomography(Hinv, d01)

      // 每个小 quad 拆成两个三角形绘制；三角形越小，仿射近似误差越低
      drawTriangle(ctx, image, [s00, s10, s11], [d00, d10, d11])
      drawTriangle(ctx, image, [s00, s11, s01], [d00, d11, d01])
    }
  }
}

/**
 * 双三角形仿射 fallback（原算法）
 */
function fallbackAffine(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource,
  srcW: number,
  srcH: number,
  dst: [Point, Point, Point, Point],
): void {
  const [tl, tr, br, bl] = dst
  drawTriangle(
    ctx,
    image,
    [
      { x: 0, y: 0 },
      { x: srcW, y: 0 },
      { x: srcW, y: srcH },
    ],
    [tl, tr, br],
  )
  drawTriangle(
    ctx,
    image,
    [
      { x: 0, y: 0 },
      { x: srcW, y: srcH },
      { x: 0, y: srcH },
    ],
    [tl, br, bl],
  )
}

/**
 * 求解单应矩阵 H，使得 dst_i ≈ H * src_i（齐次坐标）。
 * 设 h22 = 1，用 4 组对应点建立 8 个线性方程，高斯消元求解。
 * 若方程组奇异（如三点共线），返回 null。
 */
function solveHomography(
  src: [Point, Point, Point, Point],
  dst: [Point, Point, Point, Point],
): Matrix3 | null {
  // A * x = b，x = [h00 h01 h02 h10 h11 h12 h20 h21]^T
  const A: number[][] = []
  const b: number[] = []

  for (let i = 0; i < 4; i++) {
    const s = src[i]
    const d = dst[i]
    A.push([
      s.x, s.y, 1, 0, 0, 0, -s.x * d.x, -s.y * d.x,
    ])
    b.push(d.x)
    A.push([
      0, 0, 0, s.x, s.y, 1, -s.x * d.y, -s.y * d.y,
    ])
    b.push(d.y)
  }

  const x = solveLinear(8, A, b)
  if (!x) return null
  return [x[0], x[1], x[2], x[3], x[4], x[5], x[6], x[7], 1]
}

/**
 * 应用 3x3 单应矩阵到二维点
 */
function applyHomography(H: Matrix3, p: Point): Point {
  const w = H[6] * p.x + H[7] * p.y + H[8]
  if (Math.abs(w) < 1e-10) return { x: p.x, y: p.y }
  return {
    x: (H[0] * p.x + H[1] * p.y + H[2]) / w,
    y: (H[3] * p.x + H[4] * p.y + H[5]) / w,
  }
}

/**
 * 估算照片中墙面的法线方向（2D 投影）。
 *
 * 原理：矩形墙面的两组对边在透视下分别相交于两个灭点，灭点连线为灭线；
 * 墙面法线在照片中的投影垂直于灭线。返回单位向量，符号指向观众（图像中心）。
 */
export function estimateWallNormal(
  quad: [Point, Point, Point, Point],
  imgW: number,
  imgH: number,
): { x: number; y: number } | null {
  const [tl, tr, br, bl] = quad

  // 上下边灭点（垂直方向平行线）与左右边灭点（水平方向平行线）
  const vpY = lineIntersection(tl, tr, bl, br)
  const vpX = lineIntersection(tl, bl, tr, br)

  let dx = 0
  let dy = 0
  let valid = false

  if (vpX && vpY) {
    const vx = vpX.x - vpY.x
    const vy = vpX.y - vpY.y
    // 墙面法线垂直于灭线
    dx = -vy
    dy = vx
    valid = true
  } else if (vpX) {
    // 左右边平行：墙面绕垂直轴不转，法线方向近似垂直于上下边中点连线
    const mx = (tl.x + tr.x - bl.x - br.x) / 2
    const my = (tl.y + tr.y - bl.y - br.y) / 2
    dx = -my
    dy = mx
    valid = true
  } else if (vpY) {
    // 上下边平行：墙面绕水平轴不转，法线方向近似垂直于左右边中点连线
    const mx = (tr.x + br.x - tl.x - bl.x) / 2
    const my = (tr.y + br.y - tl.y - bl.y) / 2
    dx = -my
    dy = mx
    valid = true
  }

  if (!valid) return null

  const len = Math.hypot(dx, dy)
  if (len < 1e-6) return null
  dx /= len
  dy /= len

  // 选择指向观众的符号：大致指向图像中心
  const cx = (tl.x + tr.x + br.x + bl.x) / 4
  const cy = (tl.y + tr.y + br.y + bl.y) / 4
  const toCenterX = imgW / 2 - cx
  const toCenterY = imgH / 2 - cy
  if (dx * toCenterX + dy * toCenterY < 0) {
    dx = -dx
    dy = -dy
  }

  return { x: dx, y: dy }
}

/**
 * 求两条直线（分别由点 a1-a2 和 b1-b2 确定）的交点；平行时返回 null。
 */
function lineIntersection(a1: Point, a2: Point, b1: Point, b2: Point): Point | null {
  const dx1 = a2.x - a1.x
  const dy1 = a2.y - a1.y
  const dx2 = b2.x - b1.x
  const dy2 = b2.y - b1.y
  const det = dx1 * dy2 - dy1 * dx2
  if (Math.abs(det) < 1e-6) return null
  const t = ((b1.x - a1.x) * dy2 - (b1.y - a1.y) * dx2) / det
  return { x: a1.x + t * dx1, y: a1.y + t * dy1 }
}

/**
 * 计算单应矩阵 H 在点 (x,y) 处的 2x2 雅可比矩阵。
 * 返回 [dXdx, dXdy, dYdx, dYdy]，作用于齐次坐标归一化后的向量。
 */
function jacobianOfHomography(H: Matrix3, x: number, y: number): [number, number, number, number] | null {
  const D = H[6] * x + H[7] * y + H[8]
  if (Math.abs(D) < 1e-10) return null
  const X = (H[0] * x + H[1] * y + H[2]) / D
  const Y = (H[3] * x + H[4] * y + H[5]) / D
  const invD = 1 / D
  return [
    (H[0] - X * H[6]) * invD,
    (H[1] - X * H[7]) * invD,
    (H[3] - Y * H[6]) * invD,
    (H[4] - Y * H[7]) * invD,
  ]
}

/**
 * 根据目标四边形（照片中的标识框）计算源画布（signCanvas）空间中
 * 厚度应预倾斜的方向。返回单位向量；若墙面近似正对相机则返回 null。
 */
export function computeSourceTilt(
  quad: [Point, Point, Point, Point],
  srcW: number,
  srcH: number,
): { x: number; y: number } | null {
  const nImg = estimateWallNormal(quad, srcW, srcH)
  if (!nImg) return null

  const src: [Point, Point, Point, Point] = [
    { x: 0, y: 0 },
    { x: srcW, y: 0 },
    { x: srcW, y: srcH },
    { x: 0, y: srcH },
  ]
  const Hinv = solveHomography(quad, src)
  if (!Hinv) return null

  const cx = (quad[0].x + quad[2].x) / 2
  const cy = (quad[0].y + quad[2].y) / 2
  const Jinv = jacobianOfHomography(Hinv, cx, cy)
  if (!Jinv) return null

  const sx = Jinv[0] * nImg.x + Jinv[1] * nImg.y
  const sy = Jinv[2] * nImg.x + Jinv[3] * nImg.y
  const len = Math.hypot(sx, sy)
  if (len < 1e-6) return null
  // signCanvas 与照片的 y 轴同向（均向下），但 x 轴符号经单应映射后相反，
  // 实测（无头 + 用户截图）显示厚度横切方向左右反了，这里取反 x 使其贴合外立面。
  return { x: -sx / len, y: sy / len }
}

/**
 * 在任意四边形上做双线性插值。
 * 注意：这只是用来在目标四边形内部生成规则网格顶点，不是真正的透视映射；
 * 真正的源 UV 由 applyHomography(Hinv, ...) 给出。
 */
function bilinearQuad(quad: [Point, Point, Point, Point], u: number, v: number): Point {
  const [p0, p1, p2, p3] = quad
  const x =
    (1 - u) * (1 - v) * p0.x +
    u * (1 - v) * p1.x +
    u * v * p2.x +
    (1 - u) * v * p3.x
  const y =
    (1 - u) * (1 - v) * p0.y +
    u * (1 - v) * p1.y +
    u * v * p2.y +
    (1 - u) * v * p3.y
  return { x, y }
}

/**
 * 求解 n 元线性方程组 A*x = b（A 为 n×n），带列主元高斯消元。
 */
function solveLinear(n: number, A: number[][], b: number[]): number[] | null {
  // 构建增广矩阵
  const M: number[][] = []
  for (let i = 0; i < n; i++) {
    M.push([...A[i], b[i]])
  }

  for (let col = 0; col < n; col++) {
    // 列主元
    let maxRow = col
    let maxVal = Math.abs(M[col][col])
    for (let row = col + 1; row < n; row++) {
      const v = Math.abs(M[row][col])
      if (v > maxVal) {
        maxVal = v
        maxRow = row
      }
    }
    if (maxVal < 1e-12) return null
    if (maxRow !== col) {
      ;[M[col], M[maxRow]] = [M[maxRow], M[col]]
    }

    // 消元
    for (let row = col + 1; row < n; row++) {
      const factor = M[row][col] / M[col][col]
      if (Math.abs(factor) < 1e-15) continue
      for (let k = col; k <= n; k++) {
        M[row][k] -= factor * M[col][k]
      }
    }
  }

  // 回代
  const x = new Array(n).fill(0)
  for (let i = n - 1; i >= 0; i--) {
    let sum = M[i][n]
    for (let j = i + 1; j < n; j++) {
      sum -= M[i][j] * x[j]
    }
    const denom = M[i][i]
    if (Math.abs(denom) < 1e-12) return null
    x[i] = sum / denom
  }

  return x
}

/**
 * 绘制单个三角形（带仿射变换）
 * 矩阵推导：给定 3 个源点和 3 个目标点，求 2D 仿射变换 [a b c d e f]
 * 使得 dst = M * src
 */
function drawTriangle(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource,
  src: [Point, Point, Point],
  dst: [Point, Point, Point],
): void {
  const [s0, s1, s2] = src
  const [d0, d1, d2] = dst

  const denom = s0.x * (s2.y - s1.y) + s1.x * (s0.y - s2.y) + s2.x * (s1.y - s0.y)
  if (Math.abs(denom) < 1e-10) return

  const a = (d0.x * (s2.y - s1.y) + d1.x * (s0.y - s2.y) + d2.x * (s1.y - s0.y)) / denom
  const b = (d0.y * (s2.y - s1.y) + d1.y * (s0.y - s2.y) + d2.y * (s1.y - s0.y)) / denom
  const c = (d0.x * (s1.x - s2.x) + d1.x * (s2.x - s0.x) + d2.x * (s0.x - s1.x)) / denom
  const d = (d0.y * (s1.x - s2.x) + d1.y * (s2.x - s0.x) + d2.y * (s0.x - s1.x)) / denom
  const e =
    (d0.x * (s2.x * s1.y - s1.x * s2.y) +
      d1.x * (s0.x * s2.y - s2.x * s0.y) +
      d2.x * (s1.x * s0.y - s0.x * s1.y)) /
    denom
  const f =
    (d0.y * (s2.x * s1.y - s1.x * s2.y) +
      d1.y * (s0.x * s2.y - s2.x * s0.y) +
      d2.y * (s1.x * s0.y - s0.x * s1.y)) /
    denom

  ctx.save()
  ctx.beginPath()
  ctx.moveTo(d0.x, d0.y)
  ctx.lineTo(d1.x, d1.y)
  ctx.lineTo(d2.x, d2.y)
  ctx.closePath()
  ctx.clip()
  ctx.transform(a, b, c, d, e, f)
  ctx.drawImage(image, 0, 0)
  ctx.restore()
}

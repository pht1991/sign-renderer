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
 * 相机位姿：由单应矩阵分解得到的内外参。
 *
 * - 内参 K = diag(fx, fy, 1)，主点 (cx, cy)；
 * - 外参 world→camera：Xc = R·Xw + t，R 为 3×3 行主序，t 为相机空间平移。
 *
 * 标识正面（模型 z=0）在该相机下精确映射到照片四边形；厚度方向（世界 +Z）
 * 即墙面外法线，挤出后侧/厚度在透视投影下自动呈现真实长方体效果——
 * 方向完全由几何动态决定，随四边形形状、远近、视角自然变化，无任何写死。
 */
export interface CameraPose {
  fx: number
  fy: number
  cx: number
  cy: number
  R: number[] // 9，行主序
  t: number[] // 3
}

/**
 * 由标识正面矩形（模型坐标，z=0）与照片中四边形反解相机位姿。
 *
 * 原理：单应 H 将正面矩形映射到照片四边形；对针孔相机 K（主点取画面中心、
 * 焦距取典型建筑照片 FOV≈53°，即 max(W,H) 量级）作分解 H = K·[r1 r2 t]，
 * 得到世界 X/Y 轴在相机空间的朝向 r1/r2 与平移 t，法线 r3 = r1×r2 即墙面
 * 外法线（世界 +Z）。因 H 由矩形↔四边形精确求得，正面必精确贴合四边形，
 * 厚度方向由 r3 决定——像真实长方体那样随视角/远近动态变化。
 *
 * @param modelRect 标识正面矩形四角 [左上,右上,右下,左下]（模型坐标，须与渲染
 *                   管线中 normalizeGroup 后的前脸包围盒一致：最大边=2、居中）
 * @param quad       照片中四边形四角（与 modelRect 同序，单位须与 imgW/imgH 一致）
 * @param imgW       画布宽（与 quad 同单位）
 * @param imgH       画布高
 */
export function recoverCameraPose(
  modelRect: [Point, Point, Point, Point],
  quad: [Point, Point, Point, Point],
  imgW: number,
  imgH: number,
): CameraPose | null {
  const H = solveHomography(modelRect, quad)
  if (!H) return null

  const cx = imgW / 2
  const cy = imgH / 2
  // 典型建筑照片垂直 FOV≈53°，焦距取 max(W,H) 量级；仅影响透视强弱，不改变方向正确性
  const f = Math.max(imgW, imgH)

  // M = K^-1 · H  = [r1 r2 t]
  // 注意：r1/r2 必须保留 H 自带的「模型单位→像素」缩放，绝不能归一化为单位向量——
  // 否则投影尺度错乱、前脸无法贴合四边形。直接用 M 的列，P=K·[R|t] 才能精确还原 H。
  const Kinv: Matrix3 = [1 / f, 0, -cx / f, 0, 1 / f, -cy / f, 0, 0, 1]
  const M = mul3(Kinv, H)

  const r1 = col3(M, 0)
  const r2 = col3(M, 1)
  const t = col3(M, 2)

  // 把 r1/r2 归一化为单位旋转列；同时把 t 除以同一尺度，使 K·[R|t] 与 H 保持
  // 射影等价，前脸(z=0)仍能精确映射到四边形。若不统一缩放 t，相机位置会错乱，
  // 甚至陷进标识几何体内部导致渲染为空。
  const len1 = Math.hypot(...r1)
  const len2 = Math.hypot(...r2)
  const scale = (len1 + len2) / 2 || 1
  const nr1: [number, number, number] = [r1[0] / scale, r1[1] / scale, r1[2] / scale]
  const nr2: [number, number, number] = [r2[0] / scale, r2[1] / scale, r2[2] / scale]
  const nt: [number, number, number] = [t[0] / scale, t[1] / scale, t[2] / scale]

  // 法线 r3 = nr1 × nr2（墙面外法线，世界 +Z 在 OpenCV 相机空间的朝向），挤出方向由此决定。
  // 注意：OpenCV 相机看向 +Z，而 WebGL/Three.js 相机看向 -Z；renderSign 会把视图矩阵
  // 通过 diag(1,-1,-1) 转换到 WebGL 约定，保证墙面位于可见区域且厚度朝相机突出。
  const r3 = cross3(nr1, nr2)

  const R = [nr1[0], nr2[0], r3[0], nr1[1], nr2[1], r3[1], nr1[2], nr2[2], r3[2]]
  return { fx: f, fy: f, cx, cy, R, t: [nt[0], nt[1], nt[2]] }
}

// ---- 3×3 矩阵 / 向量小工具（行主序） ----
function mul3(A: Matrix3, B: Matrix3): Matrix3 {
  const C: number[] = new Array(9).fill(0)
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      let s = 0
      for (let k = 0; k < 3; k++) s += A[i * 3 + k] * B[k * 3 + j]
      C[i * 3 + j] = s
    }
  }
  return C as Matrix3
}
function col3(M: Matrix3, j: number): [number, number, number] {
  return [M[j], M[3 + j], M[6 + j]]
}
function cross3(
  a: [number, number, number],
  b: [number, number, number],
): [number, number, number] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ]
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

import { type Point } from './perspectiveWarp'

// 导出像素上限：避免 4x 导出大照片时 canvas 超过浏览器上限（约 16384 边）或爆内存
export const MAX_EXPORT_DIM = 8000
export const MAX_EXPORT_PIXELS = 64_000_000

/**
 * 接触阴影双层参数：外层柔晕（宽模糊、低透明度）+ 内层贴边影（窄模糊、稍高透明度）。
 * 偏移量克制在标识边缘内，避免「悬浮」的硬投影；方向跟随光照方位角。
 * 导出（compositeImage）与实时预览（drawOverlay）共用，保证所见即所得。
 */
export interface ContactShadowPass {
  color: string
  blur: number
  offX: number
  offY: number
}
export function contactShadowPasses(
  canvasW: number,
  shadowDepth: number,
  shadowAzimuth: number,
): { outer: ContactShadowPass; inner: ContactShadowPass } {
  const depthNorm = Math.min(1, shadowDepth / 80)
  const az = (shadowAzimuth * Math.PI) / 180
  const unit = canvasW * 0.0016
  const offX = -Math.sin(az) * unit * (0.8 + depthNorm * 0.6) // 光从左侧(az<0)来 → 影向右，幅度克制
  const offY = unit * (0.6 + depthNorm * 0.7) // 重力向下，厚度加成但始终贴边
  return {
    outer: {
      color: 'rgba(0,0,0,0.25)',
      blur: Math.max(4, canvasW * 0.012 * (0.7 + depthNorm)),
      offX: offX * 1.5,
      offY: offY * 1.5,
    },
    inner: {
      color: 'rgba(0,0,0,0.35)',
      blur: Math.max(2, canvasW * 0.005 * (0.5 + depthNorm)),
      offX,
      offY,
    },
  }
}


/**
 * 计算安全的导出倍率：在不超出最大边长与最大像素总量的前提下尽量接近 requested。
 * 返回 [0, requested] 之间的有效倍率。
 */
export function safeExportScale(
  natW: number,
  natH: number,
  requested: number,
): number {
  if (natW <= 0 || natH <= 0) return Math.max(0.1, requested)
  let s = requested
  s = Math.min(s, MAX_EXPORT_DIM / natW, MAX_EXPORT_DIM / natH)
  s = Math.min(s, Math.sqrt(MAX_EXPORT_PIXELS / (natW * natH)))
  return Math.max(0.1, s)
}

/**
 * 合成最终效果图：建筑照片底图 + 3D标识透视贴合
 *
 * @param photoImage 建筑照片 Image 对象
 * @param signCanvas 3D标识渲染结果 Canvas（带 alpha）
 * @param points 四个标记点 [左上, 右上, 右下, 左下]（基于照片显示尺寸的坐标）
 * @param displayWidth 照片显示宽度
 * @param displayHeight 照片显示高度
 * @param outputScale 期望导出倍率（内部会按 safeExportScale 限幅，不抛错）
 * @returns 合成后的 Canvas
 */
export function compositeImage(
  photoImage: HTMLImageElement,
  signCanvas: HTMLCanvasElement,
  points: [Point, Point, Point, Point],
  displayWidth: number,
  displayHeight: number,
  outputScale: number = 1,
  shadowDepth: number = 20,
  shadowAzimuth: number = 0,
): HTMLCanvasElement {
  // 双保险：即便调用方未限幅，这里也保证不超出画布上限
  const scale = safeExportScale(
    photoImage.naturalWidth,
    photoImage.naturalHeight,
    outputScale,
  )
  const outW = Math.max(1, Math.round(photoImage.naturalWidth * scale))
  const outH = Math.max(1, Math.round(photoImage.naturalHeight * scale))
  const canvas = document.createElement('canvas')
  canvas.width = outW
  canvas.height = outH
  const ctx = canvas.getContext('2d')!

  // 绘制建筑照片底图（按输出分辨率放大填充）
  ctx.drawImage(photoImage, 0, 0, canvas.width, canvas.height)

  // 将显示坐标换算为输出图坐标（已含 outputScale 倍率）
  const scaleX = canvas.width / displayWidth
  const scaleY = canvas.height / displayHeight

  const dstPoints: [Point, Point, Point, Point] = [
    { x: points[0].x * scaleX, y: points[0].y * scaleY },
    { x: points[1].x * scaleX, y: points[1].y * scaleY },
    { x: points[2].x * scaleX, y: points[2].y * scaleY },
    { x: points[3].x * scaleX, y: points[3].y * scaleY },
  ]

  // signCanvas 已是照片坐标系里的透视投影图（带 alpha），1:1 贴到合成图
  // （与渲染分辨率同比例，导出高倍率时自动等比放大，保持清晰）。
  const sp = contactShadowPasses(canvas.width, shadowDepth, shadowAzimuth)
  ctx.save()
  ctx.shadowColor = sp.outer.color
  ctx.shadowBlur = sp.outer.blur
  ctx.shadowOffsetX = sp.outer.offX
  ctx.shadowOffsetY = sp.outer.offY
  ctx.drawImage(signCanvas, 0, 0, canvas.width, canvas.height)
  ctx.shadowColor = sp.inner.color
  ctx.shadowBlur = sp.inner.blur
  ctx.shadowOffsetX = sp.inner.offX
  ctx.shadowOffsetY = sp.inner.offY
  ctx.drawImage(signCanvas, 0, 0, canvas.width, canvas.height)
  ctx.restore()

  // 再绘制清晰标识（无阴影）
  ctx.drawImage(signCanvas, 0, 0, canvas.width, canvas.height)

  // 绘制四点标记（参考线，半透明）
  drawGuideLines(ctx, dstPoints)

  return canvas
}

/**
 * 在合成图上绘制四点参考线（用于确认标记位置）
 */
function drawGuideLines(
  ctx: CanvasRenderingContext2D,
  points: [Point, Point, Point, Point],
): void {
  ctx.save()
  ctx.strokeStyle = 'rgba(255, 200, 0, 0.6)'
  ctx.lineWidth = Math.max(2, ctx.canvas.width * 0.003)
  ctx.setLineDash([10, 6])
  ctx.beginPath()
  ctx.moveTo(points[0].x, points[0].y)
  for (let i = 1; i < 4; i++) {
    ctx.lineTo(points[i].x, points[i].y)
  }
  ctx.closePath()
  ctx.stroke()

  // 标记点
  ctx.setLineDash([])
  ctx.fillStyle = 'rgba(255, 200, 0, 0.9)'
  for (const p of points) {
    ctx.beginPath()
    ctx.arc(p.x, p.y, Math.max(4, ctx.canvas.width * 0.005), 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()
}

/**
 * 将 Canvas 导出并下载，支持 PNG / JPG / WebP 三种格式。
 * 合成图以照片为底（不透明），故 JPG/WebP 导出无透明黑边问题。
 * @param mime   目标格式，默认 image/png（PNG 无损，忽略 quality）
 * @param quality JPG/WebP 有损质量 0~1，默认 0.92
 */
export function downloadCanvas(
  canvas: HTMLCanvasElement,
  filename: string = '效果图.png',
  mime: string = 'image/png',
  quality = 0.92,
): void {
  canvas.toBlob(
    (blob) => {
      if (!blob) return
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.click()
      URL.revokeObjectURL(url)
    },
    mime,
    mime === 'image/png' ? undefined : quality,
  )
}

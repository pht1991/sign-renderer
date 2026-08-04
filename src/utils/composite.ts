import { warpPerspective, type Point } from './perspectiveWarp'

// 导出像素上限：避免 4x 导出大照片时 canvas 超过浏览器上限（约 16384 边）或爆内存
export const MAX_EXPORT_DIM = 8000
export const MAX_EXPORT_PIXELS = 64_000_000

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

  // 透视变换并绘制标识
  // 先把标识 warp 到临时 canvas，便于叠加柔和接触阴影
  const tmp = document.createElement('canvas')
  tmp.width = canvas.width
  tmp.height = canvas.height
  const tctx = tmp.getContext('2d')!
  warpPerspective(tctx, signCanvas, signCanvas.width, signCanvas.height, dstPoints)

  // 柔和接触阴影：让标识"贴"在墙上有立体感。
  // 阴影方向跟随光照方位角（背光方向偏移），偏移/模糊随标识厚度增大——
  // 越厚的立体标识，在墙上的投影越大越虚，与 3D 厚度、光照方向物理一致。
  const depthNorm = Math.min(1, shadowDepth / 80)
  const baseOff = Math.max(1, canvas.width * 0.002)
  const off = baseOff * (0.6 + depthNorm)
  const az = (shadowAzimuth * Math.PI) / 180
  const shadowOffX = -Math.sin(az) * off * 1.3 // 光从左侧(az<0)来 → 影向右
  const shadowOffY = off * (1 + depthNorm * 0.8) // 重力向下，厚度加成
  const shadowBlur = Math.max(2, canvas.width * 0.006 * (0.6 + depthNorm))
  ctx.save()
  ctx.shadowColor = 'rgba(0,0,0,0.45)'
  ctx.shadowBlur = shadowBlur
  ctx.shadowOffsetX = shadowOffX
  ctx.shadowOffsetY = shadowOffY
  ctx.drawImage(tmp, 0, 0)
  ctx.restore()

  // 再绘制清晰标识（无阴影）
  ctx.drawImage(tmp, 0, 0)

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

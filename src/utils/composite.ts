import { warpPerspective, type Point } from './perspectiveWarp'

/**
 * 合成最终效果图：建筑照片底图 + 3D标识透视贴合
 *
 * @param photoImage 建筑照片 Image 对象
 * @param signCanvas 3D标识渲染结果 Canvas（带 alpha）
 * @param points 四个标记点 [左上, 右上, 右下, 左下]（基于照片显示尺寸的坐标）
 * @param displayWidth 照片显示宽度
 * @param displayHeight 照片显示高度
 * @returns 合成后的 Canvas
 */
export function compositeImage(
  photoImage: HTMLImageElement,
  signCanvas: HTMLCanvasElement,
  points: [Point, Point, Point, Point],
  displayWidth: number,
  displayHeight: number,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = photoImage.naturalWidth
  canvas.height = photoImage.naturalHeight
  const ctx = canvas.getContext('2d')!

  // 绘制建筑照片底图
  ctx.drawImage(photoImage, 0, 0)

  // 将显示坐标换算为原图坐标
  const scaleX = photoImage.naturalWidth / displayWidth
  const scaleY = photoImage.naturalHeight / displayHeight

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

  // 柔和接触阴影（偏移 + 高斯模糊），让标识"贴"在墙上有立体感
  const shadowBlur = Math.max(2, canvas.width * 0.006)
  const shadowOff = Math.max(1, canvas.width * 0.002)
  ctx.save()
  ctx.shadowColor = 'rgba(0,0,0,0.45)'
  ctx.shadowBlur = shadowBlur
  ctx.shadowOffsetX = shadowOff
  ctx.shadowOffsetY = shadowOff * 1.5
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
 * 将 Canvas 导出为 PNG 并下载
 */
export function downloadCanvas(canvas: HTMLCanvasElement, filename: string = '效果图.png'): void {
  canvas.toBlob((blob) => {
    if (!blob) return
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }, 'image/png')
}

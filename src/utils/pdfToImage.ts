/**
 * 将 AI / EPS / PDF 文件渲染成位图图片（HTMLImageElement）。
 *
 * 现代 .ai 文件本质是 PDF 封装，可被 pdf.js 直接解析；
 * 纯 PostScript 的 .eps 并非 PDF，pdf.js 可能解析失败 —— 调用方应捕获异常并引导用户转 SVG。
 *
 * 渲染结果转成 PNG dataURL 的 HTMLImageElement，直接复用图片标识渲染管线（renderImageToCanvas）。
 */
export async function pdfFileToImage(file: File, maxSize = 1024): Promise<HTMLImageElement> {
  // pdf.js 体积较大（~500KB+），按需动态加载，避免拖慢首屏
  const pdfjsLib = await import('pdfjs-dist')
  const workerMod = await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
  pdfjsLib.GlobalWorkerOptions.workerSrc = workerMod.default

  const buf = await file.arrayBuffer()
  const loadingTask = pdfjsLib.getDocument({ data: buf })
  const doc = await loadingTask.promise
  try {
    const page = await doc.getPage(1)
    const baseViewport = page.getViewport({ scale: 1 })
    const scale = Math.min(maxSize / baseViewport.width, maxSize / baseViewport.height, 4)
    const viewport = page.getViewport({ scale })
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.ceil(viewport.width))
    canvas.height = Math.max(1, Math.ceil(viewport.height))
    const ctx = canvas.getContext('2d')!
    // 白底填充：透明页若直接渲染在透明背景上会被合成层当作黑底，广告设计稿多为白纸
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    await page.render({ canvas, viewport }).promise
    const img = new Image()
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('pdf canvas to image failed'))
      img.src = canvas.toDataURL('image/png')
    })
    return img
  } finally {
    loadingTask.destroy()
  }
}

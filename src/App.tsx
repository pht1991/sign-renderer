import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { renderSignToCanvas, renderImageToCanvas } from './utils/renderSign'
import { pdfFileToImage } from './utils/pdfToImage'
import { PRESETS, type SignPreset } from './utils/svgToMesh'
import { warpPerspective, type Point } from './utils/perspectiveWarp'
import { compositeImage, downloadCanvas } from './utils/composite'

/**
 * 从 SVG 的 viewBox / width / height 中提取宽高比
 */
function getSvgAspectRatio(svgString: string): number | null {
  try {
    const doc = new DOMParser().parseFromString(svgString, 'image/svg+xml')
    const svg = doc.querySelector('svg')
    if (!svg) return null
    const viewBox = svg.getAttribute('viewBox')
    if (viewBox) {
      const parts = viewBox.trim().split(/\s+/).map(Number)
      if (parts.length >= 4 && parts[2] > 0 && parts[3] > 0) {
        return parts[2] / parts[3]
      }
    }
    const w = parseFloat(svg.getAttribute('width') || '0')
    const h = parseFloat(svg.getAttribute('height') || '0')
    if (w > 0 && h > 0) return w / h
  } catch {
    // ignore
  }
  return null
}

/**
 * 校验 SVG 字符串是否可被解析并包含可见内容。
 * 返回 null 表示通过；返回字符串表示错误原因（用于给用户提示）。
 * 两层防护：1) 上传前就拦掉非法/空 SVG；2) 配合渲染阶段 catch 兜底。
 */
function validateSvg(svgString: string): string | null {
  if (!svgString || !svgString.trim().toLowerCase().includes('<svg')) {
    return '文件内容不是有效的 SVG（缺少 <svg> 根元素）'
  }
  try {
    const doc = new DOMParser().parseFromString(svgString, 'image/svg+xml')
    if (doc.getElementsByTagName('parsererror').length > 0) {
      return 'SVG 解析失败：文件可能存在 XML 语法错误，请检查后重试'
    }
    const svg = doc.querySelector('svg')
    if (!svg) return '未找到 <svg> 根元素，请确认文件为 SVG 格式'
    const hasContent = svg.querySelector(
      'path, rect, circle, ellipse, line, polyline, polygon, text, image, g',
    )
    if (!hasContent) {
      return 'SVG 中未找到可渲染的图形（path / rect / circle / text 等），请检查内容'
    }
    return null
  } catch {
    return 'SVG 解析失败，请确认文件内容正确'
  }
}

// 视图缩放范围
const MIN_ZOOM = 0.1
const MAX_ZOOM = 8

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v))
}

/**
 * 在标识自身坐标系内生成对齐网格：随标识一起透视 warp，网格即与标识内容完全对齐。
 * 用于开关打开时检查标识内容在四点框内是否端正、居中。
 */
function buildSignGrid(srcW: number, srcH: number): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = srcW
  c.height = srcH
  const ctx = c.getContext('2d')
  if (!ctx) return c
  const cols = 10
  const rows = 10
  const cw = srcW / cols
  const ch = srcH / rows
  // 细网格：边界线内收 0.5px，避免落在画布外被裁掉导致下/右边缘缺线
  ctx.lineWidth = 1
  ctx.strokeStyle = 'rgba(0, 230, 255, 0.45)'
  ctx.beginPath()
  for (let i = 0; i <= cols; i++) {
    const x = Math.min(srcW - 0.5, Math.round(i * cw) + 0.5)
    ctx.moveTo(x, 0)
    ctx.lineTo(x, srcH)
  }
  for (let j = 0; j <= rows; j++) {
    const y = Math.min(srcH - 0.5, Math.round(j * ch) + 0.5)
    ctx.moveTo(0, y)
    ctx.lineTo(srcW, y)
  }
  ctx.stroke()
  // 中心十字（强调，便于判断居中）
  ctx.strokeStyle = 'rgba(0, 230, 255, 0.9)'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(srcW / 2, 0)
  ctx.lineTo(srcW / 2, srcH)
  ctx.moveTo(0, srcH / 2)
  ctx.lineTo(srcW, srcH / 2)
  ctx.stroke()
  return c
}

/**
 * 采样建筑照片的平均颜色，用于环境光自动匹配，让标识光照与场景协调
 */
function sampleAverageColor(img: HTMLImageElement): string | null {
  try {
    const n = 16
    const c = document.createElement('canvas')
    c.width = n
    c.height = n
    const ctx = c.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(img, 0, 0, n, n)
    const data = ctx.getImageData(0, 0, n, n).data
    let r = 0
    let g = 0
    let b = 0
    const count = data.length / 4
    for (let i = 0; i < data.length; i += 4) {
      r += data[i]
      g += data[i + 1]
      b += data[i + 2]
    }
    r = Math.round(r / count)
    g = Math.round(g / count)
    b = Math.round(b / count)
    return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`
  } catch {
    return null
  }
}

const SAMPLE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 80">
  <rect x="5" y="5" width="190" height="70" rx="8" fill="none" stroke="#e74c3c" stroke-width="3"/>
  <text x="100" y="52" font-family="Arial,sans-serif" font-size="36" font-weight="bold"
        text-anchor="middle" fill="#e74c3c">LOGO</text>
</svg>`

type DragState = {
  index: number
  offsetX: number
  offsetY: number
} | null

export default function App() {
  const [photoUrl, setPhotoUrl] = useState<string>('')
  const [svgString, setSvgString] = useState<string>('')
  const [signImageSrc, setSignImageSrc] = useState<string>('')
  const [signWarn, setSignWarn] = useState<string>('')
  const [imageAspect, setImageAspect] = useState<number | null>(null)
  const [depth, setDepth] = useState<number>(30)
  const [color, setColor] = useState<string>('#dddddd')
  const [stretch, setStretch] = useState(false)
  const [lockRatio, setLockRatio] = useState(false)
  const [preset, setPreset] = useState<SignPreset>('matte')
  const [perspective, setPerspective] = useState<number>(0)
  const [ambientColor, setAmbientColor] = useState<string>('')
  const [signCanvas, setSignCanvas] = useState<HTMLCanvasElement | null>(null)
  const [isRendering, setIsRendering] = useState(false)
  const [photoLoaded, setPhotoLoaded] = useState(false)
  const [showGrid, setShowGrid] = useState(false)
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)
  // 拖拽上传高亮状态（照片区 / 标识区分别指示）
  const [photoDrag, setPhotoDrag] = useState(false)
  const [signDrag, setSignDrag] = useState(false)
  const [photoWarn, setPhotoWarn] = useState('')

  const photoRef = useRef<HTMLImageElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DragState>(null)
  const signGridRef = useRef<HTMLCanvasElement | null>(null)

  // 视图变换（缩放 + 平移），仅用于视觉呈现；指针→图像坐标统一用 inner 实际包围盒换算
  const [view, setView] = useState<{ zoom: number; panX: number; panY: number }>({
    zoom: 1,
    panX: 0,
    panY: 0,
  })
  // 手势状态
  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map())
  const panStartRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null)
  const pinchStartRef = useRef<{
    dist: number
    zoom: number
    focalX: number
    focalY: number
    stageCx: number
    stageCy: number
  } | null>(null)

  // 四个标记点（基于显示坐标）
  const [points, setPoints] = useState<[Point, Point, Point, Point]>([
    { x: 100, y: 100 },
    { x: 300, y: 100 },
    { x: 300, y: 200 },
    { x: 100, y: 200 },
  ])

  // 照片显示尺寸
  const [displaySize, setDisplaySize] = useState({ w: 0, h: 0 })

  // SVG 自然宽高比（图片标识用已加载的图片宽高比，统一收敛到 signAspect）
  const svgAspect = useMemo(() => getSvgAspectRatio(svgString), [svgString])
  const signAspect = svgAspect ?? imageAspect

  // === 1. 标识变化时重新渲染 3D 标识（SVG 或图片分流） ===
  useEffect(() => {
    if (!svgString && !signImageSrc) {
      setSignCanvas(null)
      return
    }
    let cancelled = false
    setIsRendering(true)
    const run: Promise<HTMLCanvasElement> = svgString
      ? renderSignToCanvas(svgString, depth, 512, {
          stretch,
          color,
          preset,
          ambientColor: ambientColor || undefined,
        })
      : new Promise<HTMLCanvasElement>((resolve) => {
          const img = new Image()
          img.onload = () => {
            setImageAspect(img.width / img.height)
            renderImageToCanvas(img, depth, 512, {
              stretch,
              color,
              preset,
              ambientColor: ambientColor || undefined,
            }).then(resolve)
          }
          img.onerror = () => {
            setSignWarn('图片加载失败，请换一张试试')
            setSignCanvas(null)
            setIsRendering(false)
          }
          img.src = signImageSrc
        })
    run.then((canvas) => {
      if (!cancelled) {
        setSignCanvas(canvas)
        setIsRendering(false)
      }
    }).catch(() => {
      if (!cancelled) {
        // 区分输入类型给出针对性提示：SVG 与图片/AI/EPS 的失败原因不同
        const msg = svgString
          ? 'SVG 渲染失败，可能包含当前不支持的元素，建议导出为精简 SVG 后重试'
          : '图片 / AI / EPS 加载失败，请换一张试试，或导出为 SVG 后上传'
        setSignWarn(msg)
        setSignCanvas(null)
        setIsRendering(false)
      }
    })
    return () => { cancelled = true }
  }, [svgString, signImageSrc, depth, color, stretch, preset, ambientColor])

  // === 2. 实时预览合成 ===
  const updatePreview = useCallback(() => {
    const overlay = overlayRef.current
    const img = photoRef.current
    if (!overlay || !img || !displaySize.w || !signCanvas) return

    overlay.width = displaySize.w
    overlay.height = displaySize.h
    const ctx = overlay.getContext('2d')!
    ctx.clearRect(0, 0, overlay.width, overlay.height)

    // 在显示尺寸下做透视变换预览
    warpPerspective(ctx, signCanvas, signCanvas.width, signCanvas.height, points)

    // 辅助网格：在标识自身坐标系内生成，并随标识一起透视 warp，
    // 使网格与标识内容完全对齐，用于判断标识在四点框内是否端正、居中。
    // 网格只画在屏幕 overlay 层，不进入导出成品图。
    if (showGrid) {
      if (
        !signGridRef.current ||
        signGridRef.current.width !== signCanvas.width ||
        signGridRef.current.height !== signCanvas.height
      ) {
        signGridRef.current = buildSignGrid(signCanvas.width, signCanvas.height)
      }
      warpPerspective(
        ctx,
        signGridRef.current,
        signGridRef.current.width,
        signGridRef.current.height,
        points,
      )
    }
  }, [signCanvas, displaySize, points, showGrid])

  useEffect(() => {
    updatePreview()
  }, [updatePreview])

  // === 3. 照片加载后初始化点位 ===
  const onPhotoLoad = () => {
    const img = photoRef.current
    if (!img) return

    // 基于图片原始尺寸等比缩放，不依赖容器宽度（避免 0 宽死循环）
    const maxW = 900
    const maxH = 600
    const ratio = img.naturalWidth / img.naturalHeight

    let w = img.naturalWidth
    let h = img.naturalHeight
    if (w > maxW) {
      w = maxW
      h = w / ratio
    }
    if (h > maxH) {
      h = maxH
      w = h * ratio
    }
    w = Math.round(w)
    h = Math.round(h)

    setDisplaySize({ w, h })

    // 采样照片平均色，用于环境光自动匹配（Step3）
    const avg = sampleAverageColor(img)
    if (avg) setAmbientColor(avg)

    // 初始化四点为照片中央偏上的矩形
    const cx = w / 2
    const cy = h / 2
    const rw = w * 0.35
    const rh = rw * 0.4
    setPoints([
      { x: cx - rw / 2, y: cy - rh / 2 },
      { x: cx + rw / 2, y: cy - rh / 2 },
      { x: cx + rw / 2, y: cy + rh / 2 },
      { x: cx - rw / 2, y: cy + rh / 2 },
    ])
    setPhotoLoaded(true)
  }

  // === 4. 视图缩放 / 平移 / 四点拖拽交互 ===
  // 指针坐标 → 图像坐标：用 inner 实际渲染包围盒换算，天然兼容缩放/平移/响应式
  const screenToImage = (clientX: number, clientY: number) => {
    const inner = innerRef.current
    if (!inner || !displaySize.w) return { x: 0, y: 0 }
    const r = inner.getBoundingClientRect()
    return {
      x: ((clientX - r.left) / r.width) * displaySize.w,
      y: ((clientY - r.top) / r.height) * displaySize.h,
    }
  }

  // 适配视口：初始 / 尺寸变化时把整图缩放到刚好可见并居中
  const fitToStage = useCallback(() => {
    const stage = stageRef.current
    if (!stage || !displaySize.w) return
    const r = stage.getBoundingClientRect()
    const z = Math.min(r.width / displaySize.w, r.height / displaySize.h, 1)
    setView({ zoom: z > 0 ? z : 1, panX: 0, panY: 0 })
  }, [displaySize])

  useEffect(() => {
    fitToStage()
  }, [displaySize, fitToStage])

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const ro = new ResizeObserver(() => fitToStage())
    ro.observe(stage)
    return () => ro.disconnect()
  }, [fitToStage])

  // 角点拖拽
  const onPointDown = (e: React.PointerEvent, index: number) => {
    e.preventDefault()
    e.stopPropagation()
    const m = screenToImage(e.clientX, e.clientY)
    dragRef.current = {
      index,
      offsetX: m.x - points[index].x,
      offsetY: m.y - points[index].y,
    }
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }

  const onPointMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return
    const m = screenToImage(e.clientX, e.clientY)
    let px = m.x - dragRef.current.offsetX
    let py = m.y - dragRef.current.offsetY
    const idx = dragRef.current.index

    // 锁比例：拖动单个角点时以对角为锚点，保持 SVG 宽高比，避免适配后还要手动微调
    if (lockRatio && svgAspect && svgAspect > 0) {
      const anchor = points[idx ^ 2] // 对角点（0↔2, 1↔3）作为固定锚点
      const dx = px - anchor.x
      const dy = py - anchor.y
      const ax = Math.abs(dx)
      const ay = Math.abs(dy)
      if (ax >= ay) {
        // 横向移动为主，纵向按宽高比约束
        py = anchor.y + (dy >= 0 ? 1 : -1) * (ax / svgAspect)
      } else {
        // 纵向移动为主，横向按宽高比约束
        px = anchor.x + (dx >= 0 ? 1 : -1) * (ay * svgAspect)
      }
    }

    const fx = px
    const fy = py
    setPoints((prev) => {
      const next = [...prev] as [Point, Point, Point, Point]
      next[idx] = {
        x: Math.max(0, Math.min(displaySize.w, fx)),
        y: Math.max(0, Math.min(displaySize.h, fy)),
      }
      return next
    })
  }

  const onPointUp = () => {
    dragRef.current = null
  }

  // 滚轮缩放（指向光标）：用原生非 passive 监听以便 preventDefault 阻止页面滚动
  const handleWheel = useCallback(
    (e: WheelEvent) => {
      e.preventDefault()
      const stage = stageRef.current
      const inner = innerRef.current
      if (!stage || !inner || !displaySize.w) return
      const r = stage.getBoundingClientRect()
      const rect = inner.getBoundingClientRect()
      const focalX = ((e.clientX - rect.left) / rect.width) * displaySize.w
      const focalY = ((e.clientY - rect.top) / rect.height) * displaySize.h
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12
      setView((v) => {
        const z2 = clamp(v.zoom * factor, MIN_ZOOM, MAX_ZOOM)
        const stageCx = r.left + r.width / 2
        const stageCy = r.top + r.height / 2
        return {
          zoom: z2,
          panX: e.clientX - stageCx - (focalX - displaySize.w / 2) * z2,
          panY: e.clientY - stageCy - (focalY - displaySize.h / 2) * z2,
        }
      })
    },
    [displaySize],
  )

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    stage.addEventListener('wheel', handleWheel, { passive: false })
    return () => stage.removeEventListener('wheel', handleWheel)
  }, [handleWheel])

  // 双指 pinch 缩放 + 空白拖拽平移
  const onStagePointerDown = (e: React.PointerEvent) => {
    const stage = stageRef.current
    const inner = innerRef.current
    if (!stage || !inner) return
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    stage.setPointerCapture(e.pointerId)
    if (pointersRef.current.size === 1) {
      panStartRef.current = { x: e.clientX, y: e.clientY, panX: view.panX, panY: view.panY }
      pinchStartRef.current = null
    } else if (pointersRef.current.size === 2) {
      const pts = [...pointersRef.current.values()]
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)
      const midX = (pts[0].x + pts[1].x) / 2
      const midY = (pts[0].y + pts[1].y) / 2
      const rect = inner.getBoundingClientRect()
      const focalX = ((midX - rect.left) / rect.width) * displaySize.w
      const focalY = ((midY - rect.top) / rect.height) * displaySize.h
      const r2 = stage.getBoundingClientRect()
      pinchStartRef.current = {
        dist,
        zoom: view.zoom,
        focalX,
        focalY,
        stageCx: r2.left + r2.width / 2,
        stageCy: r2.top + r2.height / 2,
      }
      panStartRef.current = null
    }
  }

  const onStagePointerMove = (e: React.PointerEvent) => {
    if (!pointersRef.current.has(e.pointerId)) return
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pinchStartRef.current && pointersRef.current.size >= 2) {
      const pts = [...pointersRef.current.values()]
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)
      const midX = (pts[0].x + pts[1].x) / 2
      const midY = (pts[0].y + pts[1].y) / 2
      const ps = pinchStartRef.current
      const z2 = clamp((ps.zoom * dist) / ps.dist, MIN_ZOOM, MAX_ZOOM)
      setView({
        zoom: z2,
        panX: midX - ps.stageCx - (ps.focalX - displaySize.w / 2) * z2,
        panY: midY - ps.stageCy - (ps.focalY - displaySize.h / 2) * z2,
      })
    } else if (panStartRef.current && pointersRef.current.size === 1) {
      const dx = e.clientX - panStartRef.current.x
      const dy = e.clientY - panStartRef.current.y
      setView((v) => ({
        ...v,
        panX: panStartRef.current!.panX + dx,
        panY: panStartRef.current!.panY + dy,
      }))
    }
  }

  const onStagePointerUp = (e: React.PointerEvent) => {
    pointersRef.current.delete(e.pointerId)
    try {
      stageRef.current?.releasePointerCapture(e.pointerId)
    } catch {
      // ignore
    }
    if (pointersRef.current.size < 2) pinchStartRef.current = null
    if (pointersRef.current.size === 0) panStartRef.current = null
  }

  // 重置视图（缩放 / 平移回到初始）
  const resetView = () => {
    setView({ zoom: 1, panX: 0, panY: 0 })
  }

  // === 5. 文件上传处理 ===
  const processPhotoFile = (file: File) => {
    const url = URL.createObjectURL(file)
    setPhotoUrl(url)
    setPhotoLoaded(false)
    setPhotoWarn('')
  }

  const handlePhotoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) processPhotoFile(file)
  }

  const processSignFile = (file: File) => {
    const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
    const type = file.type
    if (ext === 'svg' || type.includes('svg')) {
      const reader = new FileReader()
      reader.onload = () => {
        const text = reader.result as string
        const err = validateSvg(text)
        if (err) {
          setSignImageSrc('')
          setImageAspect(null)
          setSvgString('')
          setSignWarn(err)
          return
        }
        setSignImageSrc('')
        setImageAspect(null)
        setSignWarn('')
        setSvgString(text)
      }
      reader.readAsText(file)
    } else if (
      ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext) ||
      type.startsWith('image/')
    ) {
      const url = URL.createObjectURL(file)
      setSvgString('')
      setImageAspect(null)
      setSignWarn('')
      setSignImageSrc(url)
    } else if (['ai', 'eps'].includes(ext) || type.includes('postscript')) {
      // 现代 .ai 本质是 PDF 封装，用 pdf.js 渲染成位图走图片管线；
      // 纯 PostScript 的 .eps 解析失败则由 catch 引导转 SVG
      pdfFileToImage(file)
        .then((img) => {
          setSvgString('')
          setImageAspect(null)
          setSignWarn('')
          setSignImageSrc(img.src) // PNG dataURL
        })
        .catch(() => {
          setSignWarn(
            'AI / EPS 解析失败：请在 Illustrator 或 Inkscape 中“导出为 SVG”后再上传',
          )
        })
    } else {
      setSignWarn('不支持的文件格式，请上传 SVG 矢量图或 PNG / JPG / WebP 图片')
    }
  }

  const handleSignUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) processSignFile(file)
  }

  // 照片拖拽：接受图片文件（非矢量），矢量引导到右侧标识区
  const onPhotoDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setPhotoDrag(false)
    const file = e.dataTransfer.files?.[0]
    if (!file) return
    const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
    const isVector = ['svg', 'ai', 'eps'].includes(ext) || file.type.includes('svg')
    if (isVector) {
      setPhotoWarn('矢量文件（SVG / AI / EPS）请在右侧「广告标识」区上传')
      return
    }
    processPhotoFile(file)
  }

  const onPhotoDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    setPhotoDrag(true)
  }

  const onPhotoDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    if (e.currentTarget === e.target) setPhotoDrag(false)
  }

  // 标识拖拽：接受任意标识文件，复用 processSignFile 统一分流
  const onSignDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setSignDrag(false)
    const file = e.dataTransfer.files?.[0]
    if (file) processSignFile(file)
  }

  const onSignDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    setSignDrag(true)
  }

  const onSignDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    if (e.currentTarget === e.target) setSignDrag(false)
  }

  const loadSampleSvg = () => {
    setSignImageSrc('')
    setImageAspect(null)
    setSignWarn('')
    setSvgString(SAMPLE_SVG)
  }

  // === 6. 导出效果图 ===
  const handleExport = () => {
    const img = photoRef.current
    if (!img || !signCanvas) return
    const canvas = compositeImage(img, signCanvas, points, displaySize.w, displaySize.h)
    downloadCanvas(canvas, '广告标识安装效果图.png')
  }

  // === 7. 按 SVG 比例适配四点（透视梯形） ===
  // 以当前四点中心为基准，按 SVG 比例生成标识区域；
  // perspective > 0 时顶边收窄成梯形，模拟招牌在立面上的纵深透视，强透视招牌一键贴合。
  const fitPointsToSvgRatio = () => {
    if (!svgAspect || !displaySize.w || !displaySize.h) return
    const cx = (points[0].x + points[1].x + points[2].x + points[3].x) / 4
    const cy = (points[0].y + points[1].y + points[2].y + points[3].y) / 4
    const baseW = Math.max(40, Math.min(displaySize.w * 0.5, displaySize.w))
    const baseH = baseW / svgAspect
    const topHalf = (baseW / 2) * (1 - perspective * 0.6) // 顶边随透视收窄
    const botHalf = baseW / 2
    setPoints([
      { x: cx - topHalf, y: cy - baseH / 2 }, // 左上
      { x: cx + topHalf, y: cy - baseH / 2 }, // 右上
      { x: cx + botHalf, y: cy + baseH / 2 }, // 右下
      { x: cx - botHalf, y: cy + baseH / 2 }, // 左下
    ])
  }

  const pointLabels = ['左上', '右上', '右下', '左下']
  const pointColors = ['#e74c3c', '#2ecc71', '#3498db', '#f39c12']

  return (
    <div className="app">
      <header className="app-header">
        <h1>广告标识外立面安装效果图生成器</h1>

      </header>

      <div className="main-layout">
        {/* 左侧：照片 + 标记 + 预览 */}
        <div className="canvas-area">
          {!photoUrl ? (
            <div
              className={`upload-zone${photoDrag ? ' drag-active' : ''}`}
              onDragOver={onPhotoDragOver}
              onDragLeave={onPhotoDragLeave}
              onDrop={onPhotoDrop}
            >
              <p>上传建筑外立面照片</p>
              <p className="drag-hint">或将照片拖拽到此处</p>
              <label className="upload-btn">
                选择照片
                <input type="file" accept="image/*" onChange={handlePhotoUpload} hidden />
              </label>
              {photoWarn && <p className="status-warn">{photoWarn}</p>}
            </div>
          ) : (
            <div
              className={`photo-stage${photoDrag ? ' drag-active' : ''}`}
              ref={stageRef}
              onPointerDown={onStagePointerDown}
              onPointerMove={onStagePointerMove}
              onPointerUp={onStagePointerUp}
              onPointerCancel={onStagePointerUp}
              onDragOver={onPhotoDragOver}
              onDragLeave={onPhotoDragLeave}
              onDrop={onPhotoDrop}
            >
              <div className="stage-toolbar">
                <button
                  className="reset-btn"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={resetView}
                >
                  重置视图
                </button>
                {photoWarn && <p className="status-warn photo-warn">{photoWarn}</p>}
              </div>
              <div
                className="photo-inner"
                ref={innerRef}
                style={{
                  width: displaySize.w,
                  height: displaySize.h,
                  transform: `translate(-50%, -50%) translate(${view.panX}px, ${view.panY}px) scale(${view.zoom})`,
                }}
              >
                <img
                  ref={photoRef}
                  src={photoUrl}
                  alt="建筑外立面"
                  onLoad={onPhotoLoad}
                  style={{ width: displaySize.w, height: displaySize.h }}
                  draggable={false}
                />
                <canvas
                  ref={overlayRef}
                  className="overlay-canvas"
                  style={{ width: displaySize.w, height: displaySize.h }}
                />
                {photoLoaded && points.map((p, i) => (
                  <div
                    key={i}
                    className="drag-point"
                    style={{
                      left: p.x,
                      top: p.y,
                      borderColor: pointColors[i],
                      color: pointColors[i],
                    }}
                    onPointerDown={(e) => onPointDown(e, i)}
                    onPointerMove={onPointMove}
                    onPointerUp={onPointUp}
                    onPointerEnter={() => setHoverIdx(i)}
                    onPointerLeave={() => setHoverIdx((h) => (h === i ? null : h))}
                  >
                    <span>{i + 1}</span>
                    {hoverIdx === i && (
                      <div className="coord-tip">
                        {Math.round(p.x)}, {Math.round(p.y)}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* 右侧：控制面板 */}
        <div className="control-panel">
          <section
            className={`panel-section${signDrag ? ' drag-active' : ''}`}
            onDragOver={onSignDragOver}
            onDragLeave={onSignDragLeave}
            onDrop={onSignDrop}
          >
            <h2>广告标识</h2>
            <label className="upload-btn small">
              上传标识（SVG / 图片）
              <input
                type="file"
                accept=".svg,image/svg+xml,.png,.jpg,.jpeg,.webp,.gif,.ai,.eps,application/postscript,image/*"
                onChange={handleSignUpload}
                hidden
              />
            </label>
            <button className="text-btn" onClick={loadSampleSvg}>
              使用示例 LOGO
            </button>
            {svgString && <p className="status-ok">SVG 标识已加载</p>}
            {signImageSrc && !svgString && <p className="status-ok">图片标识已加载</p>}
            {signWarn && <p className="status-warn">{signWarn}</p>}
            {isRendering && (
              <div className="loading-row">
                <span className="spinner" />
                <span>正在渲染 3D 标识...</span>
              </div>
            )}
          </section>

          <section className="panel-section">
            <h2>参数设置</h2>
            <div className="param-row">
              <label>厚度</label>
              <input
                type="range"
                min="5"
                max="80"
                value={depth}
                onChange={(e) => setDepth(Number(e.target.value))}
              />
              <span className="param-value">{depth}</span>
            </div>
            <div className="param-row">
              <label>{signImageSrc && !svgString ? '边框色' : '颜色'}</label>
              <input
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
              />
              <span className="param-value">{color}</span>
            </div>
            <div className="param-row">
              <label>拉伸铺满</label>
              <input
                type="checkbox"
                checked={stretch}
                onChange={(e) => setStretch(e.target.checked)}
              />
              <span className="param-value">{stretch ? '开' : '关'}</span>
            </div>
            <div className="param-row">
              <label>材质</label>
              <select
                value={preset}
                onChange={(e) => setPreset(e.target.value as SignPreset)}
                className="preset-select"
              >
                {(Object.keys(PRESETS) as SignPreset[]).map((key) => (
                  <option key={key} value={key}>
                    {PRESETS[key].label}
                  </option>
                ))}
              </select>
            </div>
            <div className="param-row">
              <label>锁定 SVG 比例</label>
              <input
                type="checkbox"
                checked={lockRatio}
                onChange={(e) => setLockRatio(e.target.checked)}
              />
              <span className="param-value">{lockRatio ? '开' : '关'}</span>
            </div>
            {signAspect && (
              <div className="param-row">
                <label>标识比例</label>
                <span className="param-value">{signAspect.toFixed(2)}</span>
              </div>
            )}
            {lockRatio && signAspect && (
              <>
                <div className="param-row">
                  <label>透视</label>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    value={perspective}
                    onChange={(e) => setPerspective(Number(e.target.value))}
                  />
                  <span className="param-value">{perspective.toFixed(2)}</span>
                </div>
                <button className="text-btn" onClick={fitPointsToSvgRatio}>
                  按 SVG 比例适配四点（梯形）
                </button>
              </>
            )}
          </section>

          <section className="panel-section">
            <h2>标记说明</h2>
            <div className="param-row">
              <label>辅助网格</label>
              <input
                type="checkbox"
                checked={showGrid}
                onChange={(e) => setShowGrid(e.target.checked)}
              />
              <span className="param-value">{showGrid ? '开' : '关'}</span>
            </div>
            <div className="point-legend">
              {pointLabels.map((label, i) => (
                <div key={i} className="legend-item">
                  <span className="legend-dot" style={{ background: pointColors[i] }}>
                    {i + 1}
                  </span>
                  {label}
                </div>
              ))}
            </div>
            <p className="hint">拖动四个角点对齐标识位置；在画面空白处拖拽可平移，滚轮 / 双指捏合可缩放查看细节</p>
          </section>

          <section className="panel-section">
            <button
              className="export-btn"
              disabled={!photoUrl || !signCanvas}
              onClick={handleExport}
            >
              导出效果图
            </button>
            {!photoUrl && <p className="hint">请先上传建筑照片</p>}
            {!signCanvas && <p className="hint">请先上传 SVG 标识</p>}
          </section>
        </div>
      </div>
    </div>
  )
}

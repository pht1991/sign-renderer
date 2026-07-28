import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { renderSignToCanvas, renderImageToCanvas } from './utils/renderSign'
import { pdfFileToImage } from './utils/pdfToImage'
import { PRESETS, type SignPreset, detectSvgLayers } from './utils/svgToMesh'
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
 * 判断点是否落在标识四边形（凸多边形，四点按 TL/TR/BR/BL 顺序）内部。
 * 用于区分「在标识上拖动 = 整体移动图层」与「在空白处拖动 = 平移视图」。
 */
function pointInQuad(
  p: { x: number; y: number },
  pts: [Point, Point, Point, Point],
): boolean {
  let sign = 0
  for (let i = 0; i < 4; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % 4]
    const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)
    if (cross !== 0) {
      const s = cross > 0 ? 1 : -1
      if (sign === 0) sign = s
      else if (s !== sign) return false
    }
  }
  return true
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

// 示例 LOGO：双图层（底板 + 文字）。文字必须用 <path> 而非 <text>——
// Three.js SVGLoader 无法把 <text> 拉伸成 3D 几何，分层模式下会整层消失。
const SAMPLE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 80">
  <g id="底板">
    <rect x="5" y="5" width="190" height="70" rx="10" fill="#2c3e50"/>
  </g>
  <g id="文字">
    <path fill="#e74c3c" d="M40 22 h10 v26 h16 v10 h-26 z"/>
    <path fill="#e74c3c" fill-rule="evenodd" d="M76 22 h26 v36 h-26 z M86 32 h6 v16 h-6 z"/>
    <path fill="#e74c3c" d="M112 22 h26 v10 h-16 v16 h6 v-6 h10 v16 h-26 z"/>
    <path fill="#e74c3c" fill-rule="evenodd" d="M148 22 h26 v36 h-26 z M158 32 h6 v16 h-6 z"/>
  </g>
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
  // 立体分层：检测到多层 SVG 时启用，沿 Z 堆叠成浮雕；层间距控制浮雕间隙
  const [layered, setLayered] = useState(false)
  const [layerGap, setLayerGap] = useState(10)
  // 高清边缘：2x 超采样渲染后经 warp 下采样，边缘更干净（质量设置，不计入撤销历史）
  const [aa, setAa] = useState(true)
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
  // 指针是否悬停在标识四边形内（用于显示 move 光标，提示可整体拖动）
  const [overQuad, setOverQuad] = useState(false)

  const photoRef = useRef<HTMLImageElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DragState>(null)
  const signGridRef = useRef<HTMLCanvasElement | null>(null)
  // 整体移动图层状态：按下时记录起始图像坐标与原始四点快照，移动时整体平移
  const layerMoveRef = useRef<{
    startImg: { x: number; y: number }
    origPoints: [Point, Point, Point, Point]
  } | null>(null)

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
  const INITIAL_POINTS: [Point, Point, Point, Point] = [
    { x: 100, y: 100 },
    { x: 300, y: 100 },
    { x: 300, y: 200 },
    { x: 100, y: 200 },
  ]
  const [points, setPoints] = useState<[Point, Point, Point, Point]>(INITIAL_POINTS)

  // 照片显示尺寸
  const [displaySize, setDisplaySize] = useState({ w: 0, h: 0 })

  // SVG 自然宽高比（图片标识用已加载的图片宽高比，统一收敛到 signAspect）
  const svgAspect = useMemo(() => getSvgAspectRatio(svgString), [svgString])
  const signAspect = svgAspect ?? imageAspect

  // 检测 SVG 图层数（顶层 <g> / 可绘制元素），用于立体分层开关
  const layerCount = useMemo(
    () => (svgString ? detectSvgLayers(svgString)?.length ?? 0 : 0),
    [svgString],
  )
  // 上传新的多层 SVG 时自动开启分层；单/无图层时关闭
  useEffect(() => {
    setLayered(layerCount > 1)
  }, [layerCount])

  // === 光照 / 导出分辨率控制 ===
  const [lightAzimuth, setLightAzimuth] = useState<number>(0)
  const [lightIntensity, setLightIntensity] = useState<number>(1)
  const [exportScale, setExportScale] = useState<number>(1)

  // === 撤销 / 重做历史系统 ===
  type EditState = {
    points: [Point, Point, Point, Point]
    depth: number
    color: string
    stretch: boolean
    lockRatio: boolean
    preset: SignPreset
    perspective: number
    lightAzimuth: number
    lightIntensity: number
    layered: boolean
    layerGap: number
  }
  const editRef = useRef<EditState>({
    points: INITIAL_POINTS,
    depth, color, stretch, lockRatio, preset, perspective,
    lightAzimuth: 0, lightIntensity: 1, layered, layerGap,
  })
  const pointsRef = useRef<[Point, Point, Point, Point]>(INITIAL_POINTS)
  const dragStartRef = useRef<EditState | null>(null)
  const historyRef = useRef<{ stack: EditState[]; index: number }>({ stack: [], index: -1 })
  const [historyTick, setHistoryTick] = useState(0)

  // 把可撤销状态同步到 editRef（points 用 pointsRef 保证拖拽即时最新）
  useEffect(() => {
    editRef.current = {
      points: pointsRef.current,
      depth, color, stretch, lockRatio, preset, perspective,
      lightAzimuth, lightIntensity, layered, layerGap,
    }
  }, [points, depth, color, stretch, lockRatio, preset, perspective, lightAzimuth, lightIntensity, layered, layerGap])

  const applyState = useCallback((s: EditState) => {
    setPoints(s.points)
    setDepth(s.depth)
    setColor(s.color)
    setStretch(s.stretch)
    setLockRatio(s.lockRatio)
    setPreset(s.preset)
    setPerspective(s.perspective)
    setLightAzimuth(s.lightAzimuth)
    setLightIntensity(s.lightIntensity)
    setLayered(s.layered)
    setLayerGap(s.layerGap)
  }, [])

  const commit = useCallback((before?: EditState) => {
    const full = before ?? { ...editRef.current, points: pointsRef.current }
    const h = historyRef.current
    h.stack = h.stack.slice(0, h.index + 1)
    h.stack.push(full)
    if (h.stack.length > 100) h.stack.shift()
    h.index = h.stack.length - 1
    setHistoryTick((t) => t + 1)
  }, [])

  const undo = useCallback(() => {
    const h = historyRef.current
    if (h.index <= 0) return
    h.index -= 1
    applyState(h.stack[h.index])
    setHistoryTick((t) => t + 1)
  }, [applyState])

  const redo = useCallback(() => {
    const h = historyRef.current
    if (h.index >= h.stack.length - 1) return
    h.index += 1
    applyState(h.stack[h.index])
    setHistoryTick((t) => t + 1)
  }, [applyState])

  // === 1. 标识变化时重新渲染 3D 标识（SVG 或图片分流） ===
  useEffect(() => {
    if (!svgString && !signImageSrc) {
      setSignCanvas(null)
      return
    }
    let cancelled = false
    setIsRendering(true)
    // 渲染本身是重活（SVG 解析 + ExtrudeGeometry 拉伸 / 图片贴图），
    // 拖动滑块等高频参数变化会连续触发，用 250ms 防抖合并为一次渲染，避免卡顿。
    const run = (): Promise<HTMLCanvasElement> =>
      svgString
        ? renderSignToCanvas(svgString, depth, aa ? 1024 : 512, {
            stretch,
            color,
            preset,
            ambientColor: ambientColor || undefined,
            lightAzimuth,
            lightIntensity,
            layered: layerCount > 1 ? layered : false,
            layerGap,
          })
        : new Promise<HTMLCanvasElement>((resolve) => {
            const img = new Image()
            img.onload = () => {
              setImageAspect(img.width / img.height)
              renderImageToCanvas(img, depth, aa ? 1024 : 512, {
                stretch,
                color,
                preset,
                ambientColor: ambientColor || undefined,
                lightAzimuth,
                lightIntensity,
              }).then(resolve)
            }
            img.onerror = () => {
              setSignWarn('图片加载失败，请换一张试试')
              setSignCanvas(null)
              setIsRendering(false)
            }
            img.src = signImageSrc
          })
    const timer = window.setTimeout(() => {
      run()
        .then((canvas) => {
          if (!cancelled) {
            setSignCanvas(canvas)
            setIsRendering(false)
          }
        })
        .catch(() => {
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
    }, 250)
    return () => {
      window.clearTimeout(timer)
      cancelled = true
    }
  }, [svgString, signImageSrc, depth, color, stretch, preset, ambientColor, lightAzimuth, lightIntensity, layered, layerGap, aa, layerCount])

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
      pointsRef.current = next
      return next
    })
  }

  const onPointDown = (e: React.PointerEvent, index: number) => {
    e.preventDefault()
    e.stopPropagation()
    dragStartRef.current = { ...editRef.current, points: pointsRef.current }
    const m = screenToImage(e.clientX, e.clientY)
    dragRef.current = {
      index,
      offsetX: m.x - points[index].x,
      offsetY: m.y - points[index].y,
    }
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }

  const onPointUp = () => {
    if (dragRef.current) commit(dragStartRef.current ?? undefined)
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
      // 在标识四边形内按下 → 整体移动图层；否则平移视图
      const m = screenToImage(e.clientX, e.clientY)
      if (pointInQuad(m, points)) {
        dragStartRef.current = { ...editRef.current, points: pointsRef.current }
        layerMoveRef.current = { startImg: m, origPoints: points }
        pinchStartRef.current = null
        return
      }
      panStartRef.current = { x: e.clientX, y: e.clientY, panX: view.panX, panY: view.panY }
      pinchStartRef.current = null
    } else if (pointersRef.current.size === 2) {
      layerMoveRef.current = null
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
    // 整体移动标识图层：把原始四点快照整体平移，形状不变，且夹在画面内不丢失
    if (layerMoveRef.current) {
      const lm = layerMoveRef.current
      const cur = screenToImage(e.clientX, e.clientY)
      const dx = cur.x - lm.startImg.x
      const dy = cur.y - lm.startImg.y
      const xs = lm.origPoints.map((p) => p.x)
      const ys = lm.origPoints.map((p) => p.y)
      const minX = Math.min(...xs)
      const maxX = Math.max(...xs)
      const minY = Math.min(...ys)
      const maxY = Math.max(...ys)
      const dxC = clamp(dx, -minX, displaySize.w - maxX)
      const dyC = clamp(dy, -minY, displaySize.h - maxY)
      setPoints((prev) => {
        const next = lm.origPoints.map((p) => ({ x: p.x + dxC, y: p.y + dyC })) as [
          Point,
          Point,
          Point,
          Point,
        ]
        pointsRef.current = next
        return next
      })
      return
    }
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
    // hover 反馈：在标识区域内显示 move 光标，提示可整体拖动
    if (!layerMoveRef.current && !panStartRef.current && pointersRef.current.size <= 1) {
      const m = screenToImage(e.clientX, e.clientY)
      const inside = pointInQuad(m, points)
      setOverQuad((prev) => (prev === inside ? prev : inside))
    }
  }

  const onStagePointerUp = (e: React.PointerEvent) => {
    pointersRef.current.delete(e.pointerId)
    try {
      stageRef.current?.releasePointerCapture(e.pointerId)
    } catch {
      // ignore
    }
    if (layerMoveRef.current) commit(dragStartRef.current ?? undefined)
    layerMoveRef.current = null
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
  // 快捷键：撤销 / 重做（Ctrl/⌘+Z，Ctrl/⌘+Shift+Z 或 Ctrl+Y）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.ctrlKey || e.metaKey
      if (!meta) return
      const key = e.key.toLowerCase()
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault()
        undo()
      } else if ((key === 'z' && e.shiftKey) || key === 'y') {
        e.preventDefault()
        redo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo])

  const handleExport = () => {
    const img = photoRef.current
    if (!img || !signCanvas) return
    const canvas = compositeImage(img, signCanvas, points, displaySize.w, displaySize.h, exportScale, depth, lightAzimuth)
    downloadCanvas(canvas, `广告标识安装效果图_${exportScale}x.png`)
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
              style={{ cursor: overQuad ? 'move' : 'grab' }}
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
                onPointerDown={() => { dragStartRef.current = { ...editRef.current, points: pointsRef.current } }}
                onPointerUp={() => commit(dragStartRef.current ?? undefined)}
                onKeyUp={() => commit()}
              />
              <span className="param-value">{depth}</span>
            </div>
            <div className="param-row">
              <label>{signImageSrc && !svgString ? '边框色' : '颜色'}</label>
              <input
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                onBlur={() => commit()}
              />
              <span className="param-value">{color}</span>
            </div>
            <div className="param-row">
              <label>拉伸铺满</label>
              <input
                type="checkbox"
                checked={stretch}
                onChange={(e) => { setStretch(e.target.checked); commit() }}
              />
              <span className="param-value">{stretch ? '开' : '关'}</span>
            </div>
            <div className="param-row">
              <label>材质</label>
              <select
                value={preset}
                onChange={(e) => { setPreset(e.target.value as SignPreset); commit() }}
                className="preset-select"
              >
                {(Object.keys(PRESETS) as SignPreset[]).map((key) => (
                  <option key={key} value={key}>
                    {PRESETS[key].label}
                  </option>
                ))}
              </select>
            </div>
            {layerCount > 1 && (
              <>
                <div className="param-row">
                  <label>立体分层</label>
                  <input
                    type="checkbox"
                    checked={layered}
                    onChange={(e) => { setLayered(e.target.checked); commit() }}
                  />
                  <span className="param-value">{layered ? '开' : '关'}</span>
                </div>
                {layered && (
                  <div className="param-row">
                    <label>层间距</label>
                    <input
                      type="range"
                      min="0"
                      max="40"
                      step="1"
                      value={layerGap}
                      onChange={(e) => setLayerGap(Number(e.target.value))}
                      onPointerDown={() => { dragStartRef.current = { ...editRef.current, points: pointsRef.current } }}
                      onPointerUp={() => commit(dragStartRef.current ?? undefined)}
                      onKeyUp={() => commit()}
                    />
                    <span className="param-value">{layerGap}</span>
                  </div>
                )}
                <p className="hint layer-note">
                  检测到 {layerCount} 个图层，分层后沿厚度方向堆叠成立体浮雕（底板 + 上层图案）
                </p>
              </>
            )}
            <div className="param-row">
              <label>高清边缘</label>
              <input
                type="checkbox"
                checked={aa}
                onChange={(e) => setAa(e.target.checked)}
              />
              <span className="param-value">{aa ? '开' : '关'}</span>
            </div>
            <div className="param-row">
              <label>锁定 SVG 比例</label>
              <input
                type="checkbox"
                checked={lockRatio}
                onChange={(e) => { setLockRatio(e.target.checked); commit() }}
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
                    onPointerDown={() => { dragStartRef.current = { ...editRef.current, points: pointsRef.current } }}
                    onPointerUp={() => commit(dragStartRef.current ?? undefined)}
                    onKeyUp={() => commit()}
                  />
                  <span className="param-value">{perspective.toFixed(2)}</span>
                </div>
                <button className="text-btn" onClick={fitPointsToSvgRatio}>
                  按 SVG 比例适配四点（梯形）
                </button>
              </>
            )}
            {/* 光照控制：方位角 + 强度，解决背光照片不自然 */}
            <div className="param-row">
              <label>光照方向</label>
              <input
                type="range"
                min="-90"
                max="90"
                value={lightAzimuth}
                onChange={(e) => setLightAzimuth(Number(e.target.value))}
                onPointerDown={() => { dragStartRef.current = { ...editRef.current, points: pointsRef.current } }}
                onPointerUp={() => commit(dragStartRef.current ?? undefined)}
                onKeyUp={() => commit()}
              />
              <span className="param-value">{lightAzimuth}°</span>
            </div>
            <div className="param-row">
              <label>光照强度</label>
              <input
                type="range"
                min="0.3"
                max="2.5"
                step="0.1"
                value={lightIntensity}
                onChange={(e) => setLightIntensity(Number(e.target.value))}
                onPointerDown={() => { dragStartRef.current = { ...editRef.current, points: pointsRef.current } }}
                onPointerUp={() => commit(dragStartRef.current ?? undefined)}
                onKeyUp={() => commit()}
              />
              <span className="param-value">{lightIntensity.toFixed(1)}</span>
            </div>
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
            <p className="hint">拖动四个角点对齐形状；在标识区域内拖拽可整体移动图层，在画面空白处拖拽平移视图，滚轮 / 双指捏合缩放查看细节</p>
          </section>

          <section className="panel-section">
            <div className="param-row">
              <label>导出分辨率</label>
              <select
                value={exportScale}
                onChange={(e) => setExportScale(Number(e.target.value))}
                className="preset-select"
              >
                <option value={1}>1x（原图）</option>
                <option value={2}>2x（高清）</option>
                <option value={4}>4x（超清）</option>
              </select>
            </div>
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

          <section className="panel-section">
            <div className="undo-redo-row">
              <button
                className="text-btn"
                onClick={undo}
                disabled={historyRef.current.index <= 0}
              >
                ↶ 撤销
              </button>
              <button
                className="text-btn"
                onClick={redo}
                disabled={historyRef.current.index >= historyRef.current.stack.length - 1}
              >
                ↷ 重做
              </button>
            </div>
            <p className="hint">Ctrl/⌘+Z 撤销，Ctrl/⌘+Shift+Z 或 Ctrl+Y 重做</p>
          </section>
        </div>
      </div>
    </div>
  )
}

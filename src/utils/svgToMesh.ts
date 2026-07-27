import * as THREE from 'three'
import { SVGLoader } from 'three/examples/jsm/loaders/SVGLoader.js'

/**
 * 材质预设：决定标识表面的金属度 / 粗糙度 / 自发光，营造不同质感
 */
export type SignPreset = 'matte' | 'metal' | 'acrylic' | 'neon' | 'brushed'

export const PRESETS: Record<
  SignPreset,
  {
    label: string
    metalness: number
    roughness: number
    emissiveIntensity: number
    emissiveFromColor: boolean
  }
> = {
  matte: { label: '哑光', metalness: 0.1, roughness: 0.75, emissiveIntensity: 0, emissiveFromColor: false },
  metal: { label: '金属', metalness: 0.85, roughness: 0.28, emissiveIntensity: 0, emissiveFromColor: false },
  acrylic: { label: '亚克力', metalness: 0.0, roughness: 0.12, emissiveIntensity: 0, emissiveFromColor: false },
  neon: { label: '霓虹', metalness: 0.0, roughness: 0.4, emissiveIntensity: 0.9, emissiveFromColor: true },
  brushed: { label: '拉丝', metalness: 0.6, roughness: 0.55, emissiveIntensity: 0, emissiveFromColor: false },
}

type SvgBBox = { minX: number; minY: number; w: number; h: number }

/**
 * 将 SVG 字符串解析为带厚度的 3D Group
 *
 * 链路：SVGLoader.parse → paths → createShapes → ExtrudeGeometry
 * - 每个 shape 生成 ExtrudeGeometry，材质为 [正面, 侧面] 数组
 * - 正面 UV 用全局包围盒做 planar 映射，配合 SVG 光栅贴图可还原真实渐变/多色
 * - group.userData.svgBBox 记录 SVG 坐标系下的内容包围盒，供渲染阶段光栅化贴图对齐
 */
export function svgToGroup(
  svgString: string,
  depth: number,
  bevelEnabled: boolean = true,
): THREE.Group {
  // 预解析渐变代表色：用于两处
  // 1) 预处理 SVG，把 fill/stroke 的 url(#id) 引用替换成实体色，避免 SVGLoader.parse 内部
  //    path.color.setStyle(url(...)) 直接抛 "Unknown color model"（三.js 不实现 url 属性）
  // 2) resolveFillColor 兜底材质色
  const gradientColors = extractGradientColors(svgString)
  const parseSvg = stripUrlRefs(svgString, gradientColors)

  const loader = new SVGLoader()
  const data = loader.parse(parseSvg)
  const group = new THREE.Group()

  const geometries: THREE.ExtrudeGeometry[] = []

  data.paths.forEach((path) => {
    const shapes = SVGLoader.createShapes(path)
    shapes.forEach((shape) => {
      const safeDepth = Math.max(depth, 0.1)
      const geometry = new THREE.ExtrudeGeometry(shape, {
        depth: safeDepth,
        bevelEnabled,
        bevelThickness: safeDepth * 0.08,
        bevelSize: safeDepth * 0.04,
        bevelSegments: 1,
        curveSegments: 12,
      })
      const fillColor = path.userData?.style?.fill
      const color = resolveFillColor(fillColor, gradientColors)
      const faceMaterial = new THREE.MeshStandardMaterial({ color, metalness: 0.1, roughness: 0.75 })
      const sideMaterial = new THREE.MeshStandardMaterial({ color, metalness: 0.1, roughness: 0.85 })
      const mesh = new THREE.Mesh(geometry, [faceMaterial, sideMaterial])
      group.add(mesh)
      geometries.push(geometry)
    })
  })

  // 计算所有几何体的全局 2D 包围盒（SVG 坐标系，Y 向下），用于统一 UV 映射
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const g of geometries) {
    const p = g.attributes.position
    for (let i = 0; i < p.count; i++) {
      minX = Math.min(minX, p.getX(i))
      maxX = Math.max(maxX, p.getX(i))
      minY = Math.min(minY, p.getY(i))
      maxY = Math.max(maxY, p.getY(i))
    }
  }
  const bbox: SvgBBox = {
    minX,
    minY,
    w: maxX - minX || 1,
    h: maxY - minY || 1,
  }
  for (const g of geometries) {
    applyPlanarUV(g, bbox)
  }
  group.userData.svgBBox = bbox

  // SVG 坐标系 Y 轴向下，Three.js Y 轴向上，需翻转
  group.scale.y *= -1

  return group
}

/**
 * 为几何体写入 planar UV：把每个顶点按全局包围盒归一化到 0..1
 * 正面/侧面共用同一套 UV，侧面用纯色材质，UV 不影响显示
 */
function applyPlanarUV(geometry: THREE.BufferGeometry, bbox: SvgBBox): void {
  const pos = geometry.attributes.position
  const uv: number[] = []
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const y = pos.getY(i)
    uv.push((x - bbox.minX) / bbox.w, (y - bbox.minY) / bbox.h)
  }
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
}

/**
 * 安全解析颜色：THREE.Color 无法识别的写法（url(...)、currentColor 等）返回 null
 */
function safeColor(c: string): THREE.Color | null {
  try {
    return new THREE.Color(c)
  } catch {
    return null
  }
}

/**
 * 解析 fill 值：
 * - url(#id) 渐变引用 → 查渐变表取代表色
 * - none / 空 → 回退灰色
 * - 普通颜色 → 直接解析
 */
function resolveFillColor(
  fill: string | undefined,
  gradientColors: Map<string, string>,
): THREE.Color {
  const fallback = new THREE.Color(0xcccccc)
  if (!fill || fill === 'none' || fill === 'transparent') return fallback

  const trimmed = fill.trim()
  const urlMatch = trimmed.match(/^url\(['"]?#([^'"\)]+)['"]?\)$/i)
  if (urlMatch) {
    const id = urlMatch[1]
    const gradColor = gradientColors.get(id)
    if (gradColor) {
      const c = safeColor(gradColor)
      if (c) return c
    }
    return fallback
  }

  return safeColor(trimmed) ?? fallback
}

/**
 * 预处理 SVG：把所有 url(#id) 引用（fill / stroke / style / href）替换为对应实体色，
 * currentColor 也替换为灰色兜底。这样 SVGLoader.parse 内部不会再遇到 url() 而崩溃。
 *
 * 注意：只用于几何解析版本；纹理贴图仍使用原始 SVG（浏览器原生光栅化能正确渲染渐变），
 * 因此渐变观感不受影响。
 */
function stripUrlRefs(svg: string, gradientColors: Map<string, string>): string {
  const resolve = (id: string): string => {
    const raw = gradientColors.get(id)
    if (raw) {
      const c = safeColor(raw)
      if (c) return '#' + c.getHexString()
    }
    return '#cccccc'
  }
  let out = svg.replace(
    /url\(\s*['"]?#([\w.-]+)['"]?\s*\)/gi,
    (_m, id) => resolve(id),
  )
  // currentColor 同样会让 setStyle 抛错，一并替换
  out = out.replace(/\bcurrentColor\b/gi, '#cccccc')
  return out
}

/**
 * 从 SVG 的 <defs> 中提取所有 linearGradient / radialGradient 的代表色
 * 代表色取中间那个 stop 的颜色（简单稳健）
 */
function extractGradientColors(svg: string): Map<string, string> {
  const map = new Map<string, string>()
  try {
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
    const grads = doc.querySelectorAll('linearGradient, radialGradient')
    grads.forEach((grad) => {
      const id = grad.getAttribute('id')
      if (!id) return
      const stops = grad.querySelectorAll('stop')
      if (stops.length === 0) return
      const mid = stops[Math.floor(stops.length / 2)]
      const attr =
        mid.getAttribute('stop-color') ||
        mid.getAttribute('style')?.match(/stop-color:\s*([^;]+)/i)?.[1] ||
        undefined
      if (attr) map.set(id, attr.trim())
    })
  } catch {
    // 解析失败则忽略渐变，回退默认色
  }
  return map
}

/**
 * 将 Group 自动缩放到指定尺寸并居中
 */
export function normalizeGroup(group: THREE.Group, targetSize: number = 2): void {
  const box = new THREE.Box3().setFromObject(group)
  const size = new THREE.Vector3()
  box.getSize(size)
  const maxDim = Math.max(size.x, size.y, 0.001)
  const scale = targetSize / maxDim
  group.scale.multiplyScalar(scale)

  // 重新居中
  const box2 = new THREE.Box3().setFromObject(group)
  const center = box2.getCenter(new THREE.Vector3())
  group.position.sub(center)
}

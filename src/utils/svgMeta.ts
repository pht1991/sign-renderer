/**
 * 纯元数据模块：不含任何 three 依赖，供首屏同步使用（材质预设、图层识别）。
 * 把这一部分从 svgToMesh.ts 拆出，可避免 three 被打进首屏主包——
 * three 仅在动态引入的 renderSign 链路里按需加载。
 */

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

export type SvgBBox = { minX: number; minY: number; w: number; h: number }

/**
 * 识别出的 SVG 图层：顶层 <g> 或顶层可绘制元素各自成一层。
 * svg 为该层独立的、可直接交给 SVGLoader 解析的独立 SVG 字符串（已带上原 <defs>）。
 */
export interface SvgLayer {
  id: string
  label: string
  svg: string
}

/**
 * 检测 SVG 中的「图层」结构，用于立体分层渲染。
 *
 * 识别规则：取根 <svg> 的直接子元素中可绘制的部分（<g>/<path>/<rect> 等）。
 * - 顶层 <g> 通常对应 Illustrator / Inkscape 导出的图层（id 或 inkscape:label 即层名）。
 * - 顶层散落的可绘制元素（无 <g> 包裹）各自算一层。
 * 当可绘制顶层元素 <= 1 时，视为「无分层结构」，返回 null（调用方回退到单层逻辑）。
 *
 * 每个图层导出一个完整、坐标系一致的独立 SVG 字符串（复制原 <defs>，保留 viewBox），
 * 因此可单独交给 SVGLoader 解析、单独光栅化贴图，UV 与几何严格对齐。
 */
export function detectSvgLayers(svgString: string): SvgLayer[] | null {
  try {
    const doc = new DOMParser().parseFromString(svgString, 'image/svg+xml')
    const root = doc.querySelector('svg')
    if (!root) return null

    const drawable = [
      'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'image', 'g', 'use',
    ]
    const topLevel = Array.from(root.children).filter((el) =>
      drawable.includes(el.tagName.toLowerCase()),
    )
    if (topLevel.length <= 1) return null

    // 复制原 <defs>（渐变 / clip 等），保证每层独立解析时引用仍可解析
    const defsNode = root.querySelector('defs')

    const layers: SvgLayer[] = topLevel.map((el, i) => {
      const label =
        el.getAttribute('id') ||
        el.getAttribute('inkscape:label') ||
        el.getAttribute('data-name') ||
        `图层 ${i + 1}`
      const newSvg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg')
      // 复制根 <svg> 的属性（xmlns / viewBox / width / height），保留原坐标系
      for (const attr of Array.from(root.attributes)) {
        newSvg.setAttribute(attr.name, attr.value)
      }
      if (defsNode) newSvg.appendChild(defsNode.cloneNode(true))
      newSvg.appendChild(el.cloneNode(true))
      const svg = new XMLSerializer().serializeToString(newSvg)
      return {
        id: el.getAttribute('id') || `layer-${i}`,
        label,
        svg,
      }
    })
    return layers
  } catch {
    return null
  }
}

import * as THREE from 'three'
import { svgToGroup, normalizeGroup } from './svgToMesh'
import { PRESETS, type SignPreset, type SvgBBox, detectSvgLayers } from './svgMeta'

/**
 * Three.js 离屏渲染：将标识渲染为带 3D 厚度 + 光照 + 材质质感的透明背景 Canvas
 *
 * 输出：HTMLCanvasElement，带 alpha 通道，可直接用于透视变换与合成。
 * 多种输入（SVG / 图片）都收敛到统一渲染核心 renderGroupToCanvas。
 */
export interface RenderOptions {
  stretch?: boolean
  color?: string
  preset?: SignPreset
  /** 建筑照片平均色（hex），用于环境光自动匹配，让标识光照与场景协调 */
  ambientColor?: string
  /** 主光水平方位角（度），-90~90，控制光照左右方向，0 为正前方 */
  lightAzimuth?: number
  /** 主光强度系数，1 为默认，范围约 0.3~2.5 */
  lightIntensity?: number
  /** 立体分层：将 SVG 顶层 <g>/可绘制元素按图层分别拉伸并沿 Z 堆叠成浮雕 */
  layered?: boolean
  /** 层间距：相邻图层在 Z 方向的间隙（单位与 depth 一致），越大浮雕越明显 */
  layerGap?: number
}

/** 渲染核心所需的公共参数 */
interface CoreRenderInput {
  group: THREE.Group
  renderSize: number
  ambientColor?: string
  preset: SignPreset
  /** 主光水平方位角（度），-90~90 */
  lightAzimuth?: number
  /** 主光强度系数 */
  lightIntensity?: number
  /** 由调用方根据自身的材质数组顺序，设置正面 / 侧面材质 */
  applyMaterial: (mesh: THREE.Mesh) => void
  /** 渲染完成后需要额外 dispose 的纹理（如贴图） */
  extraDispose?: THREE.Texture[]
  /**
   * 开启实时阴影（分层模式用）：上层图案在下层底板上投下柔和阴影。
   * 正交相机正对标识时层间 Z 堆叠没有视差，层间距的立体感只能靠投影体现——
   * 间距越大，影子偏移越大越柔，且方向跟随光照方位角。
   */
  enableShadow?: boolean
}

/**
 * 共用渲染核心：搭建场景 / 相机 / 光照 / 环境贴图 → 应用材质 → 渲染 → 导出 canvas → 清理
 * SVG 标识与图片标识共用此函数，保证光感、材质、导出格式完全一致。
 */
async function renderGroupToCanvas(input: CoreRenderInput): Promise<HTMLCanvasElement> {
  const { group, renderSize, ambientColor, applyMaterial, extraDispose = [], enableShadow = false } = input

  const scene = new THREE.Scene()
  scene.add(group)

  // 正交相机：视锥精确匹配标识「平面尺寸」（xy），仅留 2% 余量防裁切。
  // 注意：视锥只看 xy，不能把 z（厚度）算进去，否则大厚度会把标识缩成画布中央的小图。
  const bbox = new THREE.Box3().setFromObject(group)
  const bboxSize = new THREE.Vector3()
  bbox.getSize(bboxSize)
  const sizeXY = Math.max(bboxSize.x, bboxSize.y, 0.001)
  const halfSize = sizeXY * 0.51 * 1.02
  // 相机 z 位置必须位于标识「正面」之前：
  // 图片标识的贴图面在 +z（z = +depth/2），SVG 标识的图案 cap 在 z=0；
  // 若相机固定 z=10 而厚度较大（如默认 30），+z 面会落到相机背后被裁掉 → 图片看不见。
  // 因此相机按厚度方向后移，保证正面恒在相机前方，且远小于视锥尺寸不影响平面缩放。
  const cameraZ = bboxSize.z / 2 + 5
  const camera = new THREE.OrthographicCamera(
    -halfSize, halfSize, halfSize, -halfSize,
    0.1, cameraZ + halfSize + 10,
  )
  camera.position.set(0, 0, cameraZ)
  camera.lookAt(0, 0, 0)

  const renderer = new THREE.WebGLRenderer({
    alpha: true,
    antialias: true,
    preserveDrawingBuffer: true,
  })
  renderer.setSize(renderSize, renderSize)
  renderer.setClearColor(0x000000, 0)
  renderer.setPixelRatio(1)
  if (enableShadow) {
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
  }

  // 环境反射：渐变环境贴图，让金属/亚克力质感真实（避免金属发黑）
  const env = buildEnvTexture(renderer, ambientColor)
  if (env) scene.environment = env

  // 光照系统：主光（方位角 + 强度可调） + 补光 + 轮廓光 + 环境光（由照片平均色驱动）
  // 分层模式下降低环境/补光，让主光投影更突出，层间距变化才能被肉眼察觉
  const tint = ambientColor ? new THREE.Color(ambientColor) : new THREE.Color(0xffffff)
  scene.add(new THREE.AmbientLight(tint.getHex(), enableShadow ? 0.35 : 0.6))

  // 主光方向：方位角 az（-90~90，0=正前），俯仰固定 30°，保证光恒在正面半区（z≥0）不把招牌打黑
  const lightAz = ((input.lightAzimuth ?? 0) * Math.PI) / 180
  const lightEl = (30 * Math.PI) / 180
  const lightR = 6
  const lx = Math.sin(lightAz) * Math.cos(lightEl) * lightR
  const ly = Math.sin(lightEl) * lightR
  const lz = Math.cos(lightAz) * Math.cos(lightEl) * lightR
  const keyLight = new THREE.DirectionalLight(0xffffff, 1.5 * (input.lightIntensity ?? 1))
  keyLight.position.set(lx, ly, lz)
  if (enableShadow) {
    // 主光投影：覆盖整个标识（归一化后最大边=2），高分辨率软阴影
    keyLight.castShadow = true
    keyLight.shadow.mapSize.set(2048, 2048)
    const sc = keyLight.shadow.camera
    sc.left = -3
    sc.right = 3
    sc.top = 3
    sc.bottom = -3
    sc.near = 0.1
    sc.far = 50
    keyLight.shadow.bias = -0.0008
    keyLight.shadow.normalBias = 0.02
    keyLight.shadow.radius = 6
    keyLight.target.position.set(0, 0, 0)
    scene.add(keyLight.target)
  }
  scene.add(keyLight)

  const fillLight = new THREE.DirectionalLight(0xaabbff, enableShadow ? 0.25 : 0.6)
  fillLight.position.set(-3, -1, 2)
  scene.add(fillLight)

  const rimLight = new THREE.DirectionalLight(0xffeecc, enableShadow ? 0.25 : 0.5)
  rimLight.position.set(0, 2, -3)
  scene.add(rimLight)

  // 应用材质（正面 / 侧面由调用方决定）
  group.traverse((child) => {
    if (child instanceof THREE.Mesh && Array.isArray(child.material)) {
      applyMaterial(child)
      if (enableShadow) {
        child.castShadow = true
        child.receiveShadow = true
      }
    }
  })

  renderer.render(scene, camera)

  // 导出 canvas
  const canvas = document.createElement('canvas')
  canvas.width = renderSize
  canvas.height = renderSize
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(renderer.domElement, 0, 0)

  // 清理 GPU 资源
  scene.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.geometry?.dispose()
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material]
      mats.forEach((m) => m?.dispose())
    }
  })
  extraDispose.forEach((t) => t.dispose())
  if (env) env.dispose()
  renderer.dispose()

  return canvas
}

/**
 * SVG 标识渲染入口
 */
export async function renderSignToCanvas(
  svgString: string,
  depth: number,
  renderSize: number = 512,
  opts: RenderOptions = {},
): Promise<HTMLCanvasElement> {
  const {
    stretch = false,
    color = '#dddddd',
    preset = 'matte',
    ambientColor,
    lightAzimuth,
    lightIntensity,
    layered = false,
    layerGap = 10,
  } = opts

  const overrideColor = color && color !== '#dddddd' ? new THREE.Color(color) : null

  // 立体分层：检测 SVG 顶层图层，逐层拉伸 + Z 轴堆叠成浮雕。
  // 若有效几何图层不足两层（如某层全是 <text> 等无法拉伸的元素），返回 null 回退单层。
  const layers = layered ? detectSvgLayers(svgString) : null
  if (layers && layers.length > 1) {
    const layeredCanvas = await renderLayeredToCanvas(layers, depth, renderSize, {
      preset,
      ambientColor,
      lightAzimuth,
      lightIntensity,
      layerGap,
      overrideColor,
      stretch,
    })
    if (layeredCanvas) return layeredCanvas
  }

  // 创建标识 Group（归一化到最大边长 = 2，居中于原点）
  // 拉伸铺满时关闭倒角，避免倒角外扩导致正面无法精确填满画布
  const group = svgToGroup(svgString, depth, !stretch)
  normalizeGroup(group, 2)

  // 拉伸铺满：非等比缩放填满正方形画布；必须重新居中，否则几何中心偏离原点
  if (stretch) {
    const preBox = new THREE.Box3().setFromObject(group)
    const preSize = new THREE.Vector3()
    preBox.getSize(preSize)
    if (preSize.x > 0 && preSize.y > 0) {
      group.scale.x *= 2 / preSize.x
      group.scale.y *= 2 / preSize.y
    }
    const recenterBox = new THREE.Box3().setFromObject(group)
    const recenterCenter = recenterBox.getCenter(new THREE.Vector3())
    group.position.sub(recenterCenter)
  }

  let mapTex: THREE.Texture | null = null
  if (!overrideColor) {
    const raster = await rasterizeSvg(svgString, group.userData.svgBBox as SvgBBox, renderSize)
    if (raster) mapTex = makeTexture(raster)
  }

  return renderGroupToCanvas({
    group,
    renderSize,
    ambientColor,
    preset,
    lightAzimuth,
    lightIntensity,
    extraDispose: mapTex ? [mapTex] : [],
    applyMaterial: (mesh) => {
      const mats = mesh.material as THREE.MeshStandardMaterial[]
      const face = mats[0]
      const side = mats[1]
      const presetDef = PRESETS[preset] ?? PRESETS.matte

      face.metalness = presetDef.metalness
      face.roughness = presetDef.roughness
      side.metalness = presetDef.metalness * 0.7
      side.roughness = Math.min(1, presetDef.roughness + 0.15)

      if (overrideColor) {
        face.map = null
        face.color = overrideColor
        side.color = overrideColor
      } else if (mapTex) {
        face.map = mapTex
        face.color = new THREE.Color(0xffffff)
        // SVG 贴图常有镂空/透明区域，开启 alpha 混合避免透明处显黑
        face.transparent = true
        face.alphaTest = 0.05
      }

      if (presetDef.emissiveIntensity > 0) {
        face.emissive = overrideColor ?? face.color.clone()
        face.emissiveIntensity = presetDef.emissiveIntensity
      } else {
        face.emissiveIntensity = 0
      }

      face.needsUpdate = true
      side.needsUpdate = true
    },
  })
}

/**
 * 立体分层渲染：把每一层 SVG 单独拉伸为 3D 几何体，沿 Z 轴按 (depth + layerGap) 堆叠，
 * 形成「多层浮雕」立体标识（类似亚克力分层字 / 底板 + 发光面 + 装饰层）。
 *
 * - 每层使用 svgToGroup 单独解析与拉伸，UV 与各自光栅化贴图严格对齐，多色分层正确显色。
 * - 整体归一化到最大边长 = 2 居中，下游 warp / 阴影 / 导出完全复用同一张 signCanvas。
 * - 若用户设了统一颜色（overrideColor），所有层用该色，跳过逐层贴图。
 */
async function renderLayeredToCanvas(
  layers: { id: string; label: string; svg: string }[],
  depth: number,
  renderSize: number,
  opts: {
    preset: SignPreset
    ambientColor?: string
    lightAzimuth?: number
    lightIntensity?: number
    layerGap: number
    overrideColor: THREE.Color | null
    stretch?: boolean
  },
): Promise<HTMLCanvasElement | null> {
  const { preset, ambientColor, lightAzimuth, lightIntensity, layerGap, overrideColor, stretch = false } = opts

  // 逐层解析几何，过滤掉零几何图层（如 <text>、空 <g> 等 SVGLoader 无法拉伸的内容）
  const built = layers.map((ly) => ({ sub: svgToGroup(ly.svg, depth, true), svg: ly.svg }))
  const layerGroups = built.filter((b) => b.sub.children.length > 0)

  // 有效图层不足两层：分层无意义，清理已建几何并回退单层渲染
  if (layerGroups.length < 2) {
    built.forEach((b) =>
      b.sub.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry?.dispose()
          const mats = Array.isArray(obj.material) ? obj.material : [obj.material]
          mats.forEach((m) => m?.dispose())
        }
      }),
    )
    return null
  }

  const parent = new THREE.Group()
  layerGroups.forEach((b, i) => {
    // 分层模式固定带倒角，浮雕侧面更真实；每层沿 +Z 堆叠
    b.sub.position.z = i * (depth + layerGap)
    parent.add(b.sub)
  })

  // 整体归一化：把整座浮雕缩放居中到原点（仅按 xy 平面尺寸，z 厚度不并入视锥）
  normalizeGroup(parent, 2)

  // 拉伸铺满：与单层路径一致，非等比缩放填满 2x2 正方形画布后重新居中。
  // 注意必须在归一化之后做，且只缩 xy，层间距（z）不受影响。
  if (stretch) {
    const preBox = new THREE.Box3().setFromObject(parent)
    const preSize = new THREE.Vector3()
    preBox.getSize(preSize)
    if (preSize.x > 0 && preSize.y > 0) {
      parent.scale.x *= 2 / preSize.x
      parent.scale.y *= 2 / preSize.y
    }
    const recenterBox = new THREE.Box3().setFromObject(parent)
    const recenterCenter = recenterBox.getCenter(new THREE.Vector3())
    parent.position.sub(recenterCenter)
  }

  // 逐层光栅化贴图（仅在不使用统一颜色时），挂到各子组的 userData.layerTex
  const extraDispose: THREE.Texture[] = []
  if (!overrideColor) {
    for (const lg of layerGroups) {
      const bbox = lg.sub.userData.svgBBox as SvgBBox | undefined
      if (!bbox) continue
      const raster = await rasterizeSvg(lg.svg, bbox, renderSize)
      if (raster) {
        const tex = makeTexture(raster)
        ;(lg.sub.userData as Record<string, unknown>).layerTex = tex
        extraDispose.push(tex)
      }
    }
  }

  return renderGroupToCanvas({
    group: parent,
    renderSize,
    ambientColor,
    preset,
    lightAzimuth,
    lightIntensity,
    extraDispose,
    // 层间立体感靠上层在下层的投影体现：间距越大影子偏移越大
    enableShadow: true,
    applyMaterial: (mesh) => {
      // 向上回溯找到所属图层的贴图（userData.layerTex），找不到则用统一色
      let o: THREE.Object3D | null = mesh
      let tex: THREE.Texture | null = null
      while (o) {
        const t = (o.userData as Record<string, unknown>).layerTex
        if (t) {
          tex = t as THREE.Texture
          break
        }
        o = o.parent
      }

      const mats = mesh.material as THREE.MeshStandardMaterial[]
      const face = mats[0]
      const side = mats[1]
      const presetDef = PRESETS[preset] ?? PRESETS.matte

      face.metalness = presetDef.metalness
      face.roughness = presetDef.roughness
      side.metalness = presetDef.metalness * 0.7
      side.roughness = Math.min(1, presetDef.roughness + 0.15)

      if (overrideColor) {
        face.map = null
        face.color = overrideColor
        side.color = overrideColor
      } else if (tex) {
        face.map = tex
        face.color = new THREE.Color(0xffffff)
        // 分层贴图通常只覆盖该层图案（其余区域透明），必须开启 alpha 混合，
        // 否则 WebGL 会把透明区域渲成黑色，遮挡下层内容。
        face.transparent = true
        face.alphaTest = 0.05
      } else {
        // 该层贴图缺失：回退纯色，避免整片透明
        face.map = null
        face.color = new THREE.Color(0xcccccc)
      }

      if (presetDef.emissiveIntensity > 0) {
        face.emissive = overrideColor ?? face.color.clone()
        face.emissiveIntensity = presetDef.emissiveIntensity
      } else {
        face.emissiveIntensity = 0
      }

      face.needsUpdate = true
      side.needsUpdate = true
    },
  })
}

/**
 * 图片标识渲染入口（PNG/JPG/WebP 等位图）
 *
 * 将图片作为正面贴图映射到带厚度的薄盒（BoxGeometry），复用全部材质预设 / 环境光 /
 * 三光源 / 环境贴图，因此图片标识同样具备厚度与材质质感，且下游 warp / 阴影 / 导出
 * 与 SVG 标识完全一致（都收敛为同一张 signCanvas）。
 *
 * 材质数组顺序（BoxGeometry）：[+x, -x, +y, -y, +z, -z]，+z 为朝相机的正面。
 */
export async function renderImageToCanvas(
  img: HTMLImageElement,
  depth: number,
  renderSize: number = 512,
  opts: RenderOptions = {},
): Promise<HTMLCanvasElement> {
  const { color = '#dddddd', preset = 'matte', ambientColor, lightAzimuth, lightIntensity } = opts

  // 归一化：最大边 = 2 居中，厚度沿 Z 轴
  const aspect = img.width && img.height ? img.width / img.height : 1
  let w = 2
  let h = 2
  if (aspect >= 1) h = 2 / aspect
  else w = 2 * aspect

  const geo = new THREE.BoxGeometry(w, h, Math.max(0.1, depth))

  // 图片纹理：flipY 默认 true（图片的正确方向），BoxGeometry +Z 面 UV 标准，正立
  const imgTex = new THREE.Texture()
  imgTex.image = img
  imgTex.flipY = true
  imgTex.colorSpace = THREE.SRGBColorSpace
  imgTex.anisotropy = 4
  imgTex.needsUpdate = true

  const group = new THREE.Group()
  const face = new THREE.MeshStandardMaterial()
  const side = new THREE.MeshStandardMaterial()
  // 仅 +z 面（index 4）使用贴图，其余面为边框色
  const mesh = new THREE.Mesh(geo, [side, side, side, side, face, side])
  group.add(mesh)

  return renderGroupToCanvas({
    group,
    renderSize,
    ambientColor,
    preset,
    lightAzimuth,
    lightIntensity,
    extraDispose: [imgTex],
    applyMaterial: (m) => {
      const presetDef = PRESETS[preset] ?? PRESETS.matte
      const mats = m.material as THREE.MeshStandardMaterial[]
      const f = mats[4] // +z 正面
      const s = mats[0] // 侧面 / 边框（数组首元素，与 SVG 一致）

      f.map = imgTex
      f.color = new THREE.Color(0xffffff)
      f.metalness = presetDef.metalness
      f.roughness = presetDef.roughness

      s.color = new THREE.Color(color)
      s.metalness = presetDef.metalness * 0.7
      s.roughness = Math.min(1, presetDef.roughness + 0.15)

      if (presetDef.emissiveIntensity > 0) {
        f.emissive = new THREE.Color(0xffffff)
        f.emissiveIntensity = presetDef.emissiveIntensity
      } else {
        f.emissiveIntensity = 0
      }

      f.needsUpdate = true
      s.needsUpdate = true
    },
  })
}

/**
 * 生成渐变环境贴图（PMREM），让金属/亚克力有真实反射，避免纯金属发黑。
 * tint 为照片平均色，使反射带场景色调（环境光自动匹配）。
 */
function buildEnvTexture(
  renderer: THREE.WebGLRenderer,
  tint?: string,
): THREE.Texture | null {
  try {
    const c = document.createElement('canvas')
    c.width = 32
    c.height = 32
    const g = c.getContext('2d')!
    const grad = g.createLinearGradient(0, 0, 0, 32)
    grad.addColorStop(0, '#ffffff')
    grad.addColorStop(1, tint || '#9aa0a6')
    g.fillStyle = grad
    g.fillRect(0, 0, 32, 32)
    const tex = new THREE.CanvasTexture(c)
    tex.mapping = THREE.EquirectangularReflectionMapping
    const pmrem = new THREE.PMREMGenerator(renderer)
    const env = pmrem.fromEquirectangular(tex).texture
    tex.dispose()
    pmrem.dispose()
    return env
  } catch {
    return null
  }
}

/**
 * 将 SVG 光栅化为 2D canvas：
 * - 用 group.userData.svgBBox 设置 viewBox，确保光栅内容与几何 UV 精确对齐
 * - 失败（如含外部引用导致污染）时返回 null，回退到纯色材质
 */
async function rasterizeSvg(
  svgString: string,
  bbox: { minX: number; minY: number; w: number; h: number },
  size: number,
): Promise<HTMLCanvasElement | null> {
  try {
    const rw = size
    const rh = Math.max(1, Math.round((size * bbox.h) / bbox.w))
    // 只清理根 <svg> 标签上的尺寸属性。
    // 注意：绝不能对全文做 replace（无 g 且不限定标签时，首个匹配可能是
    // <rect width="..."> 等图形元素，误删会导致该图形在贴图里消失 → alpha=0 → 黑块/黑框）。
    const s = svgString.replace(/<svg[^>]*>/i, (tag) =>
      tag
        .replace(/\s(?:width|height|viewBox)\s*=\s*"[^"]*"/gi, ' ')
        .replace(
          /<svg/i,
          `<svg viewBox="${bbox.minX} ${bbox.minY} ${bbox.w} ${bbox.h}" width="${rw}" height="${rh}"`,
        ),
    )
    const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(s)
    const img = new Image()
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('svg raster failed'))
      img.src = url
    })
    const c = document.createElement('canvas')
    c.width = rw
    c.height = rh
    const ctx = c.getContext('2d')!
    ctx.drawImage(img, 0, 0, rw, rh)
    return c
  } catch {
    return null
  }
}

/**
 * 从 2D canvas 生成 Three.js 纹理（翻转 Y 以匹配 SVG 坐标系）
 */
function makeTexture(canvas: HTMLCanvasElement): THREE.Texture {
  const tex = new THREE.CanvasTexture(canvas)
  tex.flipY = false
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  return tex
}

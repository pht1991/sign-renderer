import * as THREE from 'three'
import { svgToGroup, normalizeGroup, PRESETS, type SignPreset } from './svgToMesh'

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
}

/** 渲染核心所需的公共参数 */
interface CoreRenderInput {
  group: THREE.Group
  renderSize: number
  ambientColor?: string
  preset: SignPreset
  /** 由调用方根据自身的材质数组顺序，设置正面 / 侧面材质 */
  applyMaterial: (mesh: THREE.Mesh) => void
  /** 渲染完成后需要额外 dispose 的纹理（如贴图） */
  extraDispose?: THREE.Texture[]
}

/**
 * 共用渲染核心：搭建场景 / 相机 / 光照 / 环境贴图 → 应用材质 → 渲染 → 导出 canvas → 清理
 * SVG 标识与图片标识共用此函数，保证光感、材质、导出格式完全一致。
 */
async function renderGroupToCanvas(input: CoreRenderInput): Promise<HTMLCanvasElement> {
  const { group, renderSize, ambientColor, applyMaterial, extraDispose = [] } = input

  const scene = new THREE.Scene()
  scene.add(group)

  // 正交相机：视锥精确匹配标识实际包围盒，仅留 2% 余量防裁切
  const bbox = new THREE.Box3().setFromObject(group)
  const bboxSize = new THREE.Vector3()
  bbox.getSize(bboxSize)
  // 必须包含 z 轴（厚度方向），否则大厚度时视锥算小了会裁掉正面
  const maxDim = Math.max(bboxSize.x, bboxSize.y, bboxSize.z, 0.001)
  const halfSize = (maxDim / 2) * 1.02
  // 相机必须位于标识正面之前：
  // 图片标识的贴图面在 +z（z = +depth/2），SVG 标识的图案 cap 在 z=0；
  // 若相机固定 z=10 而厚度较大（如默认 30），+z 面会落到相机背后被裁掉 → 图片看不见。
  // 改为按包围盒动态后移，保证正面恒在相机前方。
  const cameraZ = halfSize + 5
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

  // 环境反射：渐变环境贴图，让金属/亚克力质感真实（避免金属发黑）
  const env = buildEnvTexture(renderer, ambientColor)
  if (env) scene.environment = env

  // 光照系统：主光 + 补光 + 轮廓光 + 环境光（由照片平均色驱动）
  const tint = ambientColor ? new THREE.Color(ambientColor) : new THREE.Color(0xffffff)
  scene.add(new THREE.AmbientLight(tint.getHex(), 0.6))

  const keyLight = new THREE.DirectionalLight(0xffffff, 1.5)
  keyLight.position.set(2, 3, 5)
  scene.add(keyLight)

  const fillLight = new THREE.DirectionalLight(0xaabbff, 0.6)
  fillLight.position.set(-3, -1, 2)
  scene.add(fillLight)

  const rimLight = new THREE.DirectionalLight(0xffeecc, 0.5)
  rimLight.position.set(0, 2, -3)
  scene.add(rimLight)

  // 应用材质（正面 / 侧面由调用方决定）
  group.traverse((child) => {
    if (child instanceof THREE.Mesh && Array.isArray(child.material)) {
      applyMaterial(child)
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
  const { stretch = false, color = '#dddddd', preset = 'matte', ambientColor } = opts

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

  const overrideColor = color && color !== '#dddddd' ? new THREE.Color(color) : null
  let mapTex: THREE.Texture | null = null
  if (!overrideColor) {
    const raster = await rasterizeSvg(svgString, group.userData.svgBBox as any, renderSize)
    if (raster) mapTex = makeTexture(raster)
  }

  return renderGroupToCanvas({
    group,
    renderSize,
    ambientColor,
    preset,
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
  const { color = '#dddddd', preset = 'matte', ambientColor } = opts

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
    let s = svgString
    s = s.replace(/\swidth="[^"]*"/, ' ')
    s = s.replace(/\sheight="[^"]*"/, ' ')
    s = s.replace(/\sviewBox="[^"]*"/, ' ')
    s = s.replace(
      /<svg/i,
      `<svg viewBox="${bbox.minX} ${bbox.minY} ${bbox.w} ${bbox.h}" width="${rw}" height="${rh}"`,
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

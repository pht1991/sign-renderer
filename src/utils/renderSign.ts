import * as THREE from 'three'
import { svgToGroup, normalizeGroup, PRESETS, type SignPreset } from './svgToMesh'

/**
 * Three.js 离屏渲染：将 SVG 标识渲染为带 3D 厚度 + 光照 + 材质质感的透明背景 Canvas
 *
 * 输出：HTMLCanvasElement，带 alpha 通道，可直接用于透视变换
 */
export interface RenderOptions {
  stretch?: boolean
  color?: string
  preset?: SignPreset
  /** 建筑照片平均色（hex），用于环境光自动匹配，让标识光照与场景协调 */
  ambientColor?: string
}

export async function renderSignToCanvas(
  svgString: string,
  depth: number,
  renderSize: number = 512,
  opts: RenderOptions = {},
): Promise<HTMLCanvasElement> {
  const { stretch = false, color = '#dddddd', preset = 'matte', ambientColor } = opts

  const scene = new THREE.Scene()

  // 创建标识 Group（已归一化到最大边长 = 2，居中于原点）
  // 拉伸铺满时关闭倒角，避免倒角外扩导致正面无法精确填满画布
  const group = svgToGroup(svgString, depth, !stretch)
  normalizeGroup(group, 2)
  scene.add(group)

  // 拉伸铺满：非等比缩放，让标识在 X/Y 两个方向都填满正方形画布。
  // 开启后 warp 到四点区域会铺满，代价是标识可能按四边形比例变形。
  if (stretch) {
    const preBox = new THREE.Box3().setFromObject(group)
    const preSize = new THREE.Vector3()
    preBox.getSize(preSize)
    if (preSize.x > 0 && preSize.y > 0) {
      group.scale.x *= 2 / preSize.x
      group.scale.y *= 2 / preSize.y
    }
    // 关键：stretch 改变 scale 会破坏 normalizeGroup 的居中，需重新居中，
    // 否则几何中心偏离原点，标识在源图里下沉、顶边留空。
    const recenterBox = new THREE.Box3().setFromObject(group)
    const recenterCenter = recenterBox.getCenter(new THREE.Vector3())
    group.position.sub(recenterCenter)
  }

  // 正交相机，正面观察。相机视锥精确匹配标识实际包围盒，仅留 2% 余量防裁切。
  const bbox = new THREE.Box3().setFromObject(group)
  const bboxSize = new THREE.Vector3()
  bbox.getSize(bboxSize)
  const maxDim = Math.max(bboxSize.x, bboxSize.y, 0.001)
  const halfSize = (maxDim / 2) * 1.02
  const camera = new THREE.OrthographicCamera(-halfSize, halfSize, halfSize, -halfSize, 0.1, 100)
  camera.position.set(0, 0, 10)
  camera.lookAt(0, 0, 0)

  // 渲染器
  const renderer = new THREE.WebGLRenderer({
    alpha: true,
    antialias: true,
    preserveDrawingBuffer: true,
  })
  renderer.setSize(renderSize, renderSize)
  renderer.setClearColor(0x000000, 0)
  renderer.setPixelRatio(1)

  // 环境反射：用渐变环境贴图，让金属/亚克力等质感真实（避免金属发黑）
  const env = buildEnvTexture(renderer, ambientColor)
  if (env) scene.environment = env

  // 光照系统：主光 + 补光 + 轮廓光 + 环境光（由照片平均色驱动，见 Step3）
  const tint = ambientColor ? new THREE.Color(ambientColor) : new THREE.Color(0xffffff)
  const ambient = new THREE.AmbientLight(tint.getHex(), 0.6)
  scene.add(ambient)

  const keyLight = new THREE.DirectionalLight(0xffffff, 1.5)
  keyLight.position.set(2, 3, 5)
  scene.add(keyLight)

  const fillLight = new THREE.DirectionalLight(0xaabbff, 0.6)
  fillLight.position.set(-3, -1, 2)
  scene.add(fillLight)

  const rimLight = new THREE.DirectionalLight(0xffeecc, 0.5)
  rimLight.position.set(0, 2, -3)
  scene.add(rimLight)

  // 渐变 / 多色贴图：将 SVG 光栅化为 2D canvas，作为正面贴图还原真实颜色与渐变
  const overrideColor = color && color !== '#dddddd' ? new THREE.Color(color) : null
  let mapTex: THREE.Texture | null = null
  if (!overrideColor) {
    const raster = await rasterizeSvg(svgString, group.userData.svgBBox as any, renderSize)
    if (raster) mapTex = makeTexture(raster)
  }

  // 应用材质预设 + 颜色 / 贴图覆盖
  const presetDef = PRESETS[preset] ?? PRESETS.matte
  group.traverse((child) => {
    if (child instanceof THREE.Mesh && Array.isArray(child.material)) {
      const face = child.material[0] as THREE.MeshStandardMaterial
      const side = child.material[1] as THREE.MeshStandardMaterial

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
    }
  })

  // 渲染
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
  if (mapTex) mapTex.dispose()
  if (env) env.dispose()
  renderer.dispose()

  return canvas
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

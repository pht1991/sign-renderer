import * as THREE from 'three'
import { svgToGroup, normalizeGroup } from './svgToMesh'
import { PRESETS, type SignPreset, type SvgBBox, detectSvgLayers } from './svgMeta'
import { buildSignProjectionMatrix, SIGN_FORESHORTEN, type Point } from './perspectiveWarp'

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
  /**
   * 真实 3D 透视投影：给定照片中四边形与画布尺寸，由单应分解反解相机位姿，
   * 让标识沿墙面外法线做真实透视挤出（不再用正交相机 + 2D 错切近似）。
   * 不传则回退到正交相机直视渲染（用于无照片/无标记点的独立预览）。
   */
  camera?: {
    quad: [Point, Point, Point, Point]
    imgW: number
    imgH: number
    /** 厚度方向透视收缩强度（等效相机远近）：0=无透视平行厚度，越大立体边越明显。默认 0.1 */
    foreshorten?: number
    /** 视角方位倾角（度）：旋转标识凸出的深度轴，后脸在屏幕左右偏移，模拟从左/右观察。前脸仍钉在四点 */
    tiltYaw?: number
    /** 视角俯仰倾角（度）：后脸在屏幕上下偏移，模拟从上/下观察。前脸仍钉在四点 */
    tiltPitch?: number
  }
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
  /**
   * 真实 3D 透视投影：给定照片中四边形与画布尺寸，由单应分解反解相机位姿，
   * 让标识沿墙面外法线做真实透视挤出。不传则回退到正交相机直视渲染。
   */
  camera?: {
    quad: [Point, Point, Point, Point]
    imgW: number
    imgH: number
    /** 厚度方向透视收缩强度（等效相机远近）：0=无透视平行厚度，越大立体边越明显。默认 0.1 */
    foreshorten?: number
    /** 视角方位倾角（度）：旋转标识凸出的深度轴，后脸在屏幕左右偏移，模拟从左/右观察。前脸仍钉在四点 */
    tiltYaw?: number
    /** 视角俯仰倾角（度）：后脸在屏幕上下偏移，模拟从上/下观察。前脸仍钉在四点 */
    tiltPitch?: number
  }
  /** 标识厚度（同一单位体系下的滑块值），用于把厚度侧边错切幅度限制在合理比例 */
  depth?: number
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

// applyWallTilt 已移除：厚度方向现在由单应直接嵌入的 4×4 投影矩阵 +
// 真实透视投影决定，不再用 2D 错切近似（见 renderGroupToCanvas 的透视分支）。

/**
 * 共用渲染核心：搭建场景 / 相机 / 光照 / 环境贴图 → 应用材质 → 渲染 → 导出 canvas → 清理
 * SVG 标识与图片标识共用此函数，保证光感、材质、导出格式完全一致。
 *
 * 当传入 `camera`（照片四边形 + 画布尺寸）时，采用「真实 3D 透视投影」：
 * 把标识前脸贴到墙面（z=0）、沿墙面外法线做透视挤出，用反解出的透视相机渲染，
 * 输出的 canvas 已位于照片坐标系（无需再 warp）。厚度方向完全由几何动态决定。
 * 否则回退到正交相机直视渲染（用于无照片/无标记点的独立预览）。
 */
async function renderGroupToCanvas(input: CoreRenderInput): Promise<HTMLCanvasElement> {
  const { group, renderSize, ambientColor, applyMaterial, extraDispose = [], enableShadow = false, camera, depth } = input

  // 包围盒：取正面平面尺寸与自然比例，并判定前脸（z 最大面）用于贴墙定位。
  // 拉伸模式（stretch）下 group 已被拉成 2×2，naturalAspect≈1；
  // 非拉伸模式天然保留标识真实比例（如 2.5:1 横向 LOGO）。
  const preBox = new THREE.Box3().setFromObject(group)
  const preSize = new THREE.Vector3()
  preBox.getSize(preSize)
  const natW = Math.max(preSize.x, 0.001)
  const natH = Math.max(preSize.y, 0.001)
  const naturalAspect = natW / natH

  if (camera) {
    return renderPerspective(input, preBox, naturalAspect)
  }

  const scene = new THREE.Scene()
  scene.add(group)

  const postBox = new THREE.Box3().setFromObject(group)
  const postSize = new THREE.Vector3()
  postBox.getSize(postSize)
  const contentCenter = postBox.getCenter(new THREE.Vector3())

  // 画布尺寸：跟随标识自然宽高比；当厚度倾斜使背面超出正面范围时，
  // 提高渲染分辨率（而非缩小正面），保证正面像素密度不变、厚度边可见。
  const scaleUpX = Math.max(1, postSize.x / natW)
  const scaleUpY = Math.max(1, postSize.y / natH)
  const scaleUp = Math.min(2.0, Math.max(scaleUpX, scaleUpY))
  const renderSizeEff = Math.round(renderSize * scaleUp)

  let canvasW: number
  let canvasH: number
  if (naturalAspect >= 1) {
    canvasW = renderSizeEff
    canvasH = Math.max(1, Math.round(renderSizeEff / naturalAspect))
  } else {
    canvasW = Math.max(1, Math.round(renderSizeEff * naturalAspect))
    canvasH = renderSizeEff
  }

  // 正交相机：视锥按内容取景，比例保持自然比例，使正面 logo 保持原比例不被撑小。
  const margin = 1.03
  const contentHalfW = Math.max(postSize.x, 0.001) / 2
  const contentHalfH = Math.max(postSize.y, 0.001) / 2
  const halfW = Math.max(contentHalfW, contentHalfH * naturalAspect) * margin
  const halfH = halfW / naturalAspect

  const cameraZ = preBox.max.z + 5
  const ortho = new THREE.OrthographicCamera(
    -halfW, halfW, halfH, -halfH,
    0.1, cameraZ + halfW + 10,
  )
  ortho.position.set(contentCenter.x, contentCenter.y, cameraZ)
  ortho.lookAt(contentCenter.x, contentCenter.y, 0)

  const renderer = new THREE.WebGLRenderer({
    alpha: true,
    antialias: true,
    preserveDrawingBuffer: true,
  })
  renderer.setSize(canvasW, canvasH)
  renderer.setClearColor(0x000000, 0)
  renderer.setPixelRatio(1)
  if (enableShadow) {
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
  }

  const env = buildEnvTexture(renderer, ambientColor)
  if (env) scene.environment = env

  const tint = ambientColor ? new THREE.Color(ambientColor) : new THREE.Color(0xffffff)
  scene.add(new THREE.AmbientLight(tint.getHex(), enableShadow ? 0.35 : 0.6))

  const lightAz = ((input.lightAzimuth ?? 0) * Math.PI) / 180
  const lightEl = (30 * Math.PI) / 180
  const lightR = 6
  const lx = Math.sin(lightAz) * Math.cos(lightEl) * lightR
  const ly = Math.sin(lightEl) * lightR
  const lz = Math.cos(lightAz) * Math.cos(lightEl) * lightR
  const keyLight = new THREE.DirectionalLight(0xffffff, 1.5 * (input.lightIntensity ?? 1))
  keyLight.position.set(lx, ly, lz)
  if (enableShadow) {
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
    keyLight.shadow.radius = 10
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

  group.traverse((child) => {
    if (child instanceof THREE.Mesh && Array.isArray(child.material)) {
      applyMaterial(child)
      if (enableShadow) {
        child.castShadow = true
        child.receiveShadow = true
      }
    }
  })

  renderer.render(scene, ortho)

  const canvas = document.createElement('canvas')
  canvas.width = canvasW
  canvas.height = canvasH
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(renderer.domElement, 0, 0)

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
 * 真实 3D 透视渲染：标识前脸贴墙（z=0）、沿外法线透视挤出，用反解相机渲染。
 * 输出 canvas 尺寸 = 照片画布尺寸（受 cap 限制），已位于照片坐标系，合成时直接贴图。
 */
async function renderPerspective(
  input: CoreRenderInput,
  preBox: THREE.Box3,
  naturalAspect: number,
): Promise<HTMLCanvasElement> {
  const { group, renderSize, ambientColor, applyMaterial, extraDispose = [], enableShadow = false, camera } = input
  const cam = camera!

  // 关键：把“标识正面”（贴图面，z 最大面）对齐到单应约束平面 z=0。
  // buildSignProjectionMatrix 由正面矩形↔照片四边形直接构造投影矩阵，因此正面
  // 必须位于 z=0 才能精确贴合用户标记的四个点；若把背面对齐到 z=0，正面会沿法线
  // 方向再往外凸出一段厚度距离，导致标识在照片中偏离四点框。
  // 平移后背面位于 z=-depthZ（墙内方向），正面位于 z=0 精确贴合四点；从侧面仍
  // 能看到厚度边，立体感由真实透视投影动态决定。
  const frontZ = preBox.max.z
  group.position.z += -frontZ // 前脸(z=max.z)对齐到世界 z=0，由单应精确贴合四点

  // 视角倾角：以剪切矩阵旋转“凸出的深度轴”。前脸(z=0)不受剪切影响、仍钉在四点；
  // 后脸(z=-depth)随 tiltYaw/tiltPitch 在屏幕偏移，模拟标识从某角度被观察。
  // a=tan(yaw) 控制左右、b=tan(pitch) 控制上下；小角度保证观感自然。
  const yaw = ((cam.tiltYaw ?? 0) * Math.PI) / 180
  const pitch = ((cam.tiltPitch ?? 0) * Math.PI) / 180
  const a = Math.tan(yaw)
  const b = Math.tan(pitch)
  group.updateMatrix()
  const shear = new THREE.Matrix4().set(1, 0, a, 0, 0, 1, b, 0, 0, 0, 1, 0, 0, 0, 0, 1)
  group.matrix.premultiply(shear)
  group.matrixAutoUpdate = false
  group.matrixWorldAutoUpdate = false
  group.matrixWorld.copy(group.matrix)

  // 模型矩形（前脸包围盒，与 normalizeGroup 后一致）：最大边=2、居中、z=0。
  const hw = Math.max((preBox.max.x - preBox.min.x) / 2, 1e-4)
  const hh = Math.max((preBox.max.y - preBox.min.y) / 2, 1e-4)
  const modelRect: [Point, Point, Point, Point] = [
    { x: -hw, y: hh },
    { x: hw, y: hh },
    { x: hw, y: -hh },
    { x: -hw, y: -hh },
  ]

  // 渲染分辨率上限（大照片降档以保性能/显存），并同步缩放 quad 与画布。
  const maxDim = Math.max(cam.imgW, cam.imgH)
  const cap = 2000
  const scale = maxDim > cap ? cap / maxDim : 1
  const W = Math.max(1, Math.round(cam.imgW * scale))
  const Hh = Math.max(1, Math.round(cam.imgH * scale))
  const q: [Point, Point, Point, Point] = cam.quad.map((p) => ({
    x: p.x * scale,
    y: p.y * scale,
  })) as [Point, Point, Point, Point]

  const depthZ = Math.max(0.001, frontZ - preBox.min.z)
  const proj = buildSignProjectionMatrix(modelRect, q, W, Hh, depthZ, cam.foreshorten ?? SIGN_FORESHORTEN)
  if (!proj) {
    // 退化：恢复前脸位置并回退正交渲染，避免整段渲染失败。
    group.position.z += frontZ
    return renderGroupToCanvas({ ...input, camera: undefined })
  }

  const scene = new THREE.Scene()
  scene.add(group)

  const renderer = new THREE.WebGLRenderer({
    alpha: true,
    antialias: true,
    preserveDrawingBuffer: true,
  })
  renderer.setSize(W, Hh)
  renderer.setClearColor(0x000000, 0)
  renderer.setPixelRatio(1)
  if (enableShadow) {
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
  }

  const env = buildEnvTexture(renderer, ambientColor)
  if (env) scene.environment = env

  const tint = ambientColor ? new THREE.Color(ambientColor) : new THREE.Color(0xffffff)
  scene.add(new THREE.AmbientLight(tint.getHex(), enableShadow ? 0.35 : 0.6))

  // 主光：方位角 + 固定俯仰，保证正面（朝相机）被照亮；侧/厚度随视角自然受光。
  const lightAz = ((input.lightAzimuth ?? 0) * Math.PI) / 180
  const lightEl = (30 * Math.PI) / 180
  const lightR = 6
  const lx = Math.sin(lightAz) * Math.cos(lightEl) * lightR
  const ly = Math.sin(lightEl) * lightR
  const lz = Math.cos(lightAz) * Math.cos(lightEl) * lightR
  const keyLight = new THREE.DirectionalLight(0xffffff, 1.5 * (input.lightIntensity ?? 1))
  keyLight.position.set(lx, ly, lz)
  if (enableShadow) {
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
    keyLight.shadow.radius = 10
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

  group.traverse((child) => {
    if (child instanceof THREE.Mesh && Array.isArray(child.material)) {
      applyMaterial(child)
      if (enableShadow) {
        child.castShadow = true
        child.receiveShadow = true
      }
    }
  })

  // ---- 投影相机：直接由单应构造 4×4 投影矩阵 ----
  // 绕过 K·[R|t] 分解（单图位姿恢复近正面时焦距退化、R 无法正交，会扭曲前脸），
  // 把单应 H 嵌入投影矩阵：z=0 前脸由 H 精确映射到照片四边形（必落在四点内），
  // 仅厚度方向(z≠0)保留真实透视缩小。视图矩阵取单位阵（前脸已对齐到世界 z=0）。
  const camera3d = new THREE.PerspectiveCamera()
  camera3d.projectionMatrix.set(
    proj[0], proj[1], proj[2], proj[3],
    proj[4], proj[5], proj[6], proj[7],
    proj[8], proj[9], proj[10], proj[11],
    proj[12], proj[13], proj[14], proj[15],
  )
  camera3d.projectionMatrixInverse.copy(camera3d.projectionMatrix).invert()
  camera3d.matrixWorld.identity()
  camera3d.matrixWorldInverse.identity()
  camera3d.matrixAutoUpdate = false
  camera3d.matrixWorldAutoUpdate = false

  // 自定义投影矩阵下，基于标准视锥的剔除会把标识误杀，关闭逐网格剔除。
  group.traverse((child) => {
    if (child instanceof THREE.Mesh) child.frustumCulled = false
  })

  renderer.render(scene, camera3d)

  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = Hh
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(renderer.domElement, 0, 0)

  scene.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.geometry?.dispose()
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material]
      mats.forEach((m) => m?.dispose())
    }
  })
  extraDispose.forEach((t2) => t2.dispose())
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
    camera,
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
      camera,
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
    camera,
    depth,
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

      // SVG 坐标系 Y 轴向下，svgToMesh 用 group.scale.y=-1 翻转到 Three.js Y 轴向上。
      // 该反射会反转面片朝向，可能导致 front-face 对齐后实际可见的是底 cap（z=-depth），
      // 其投影比 quad 小，造成标识位置偏移。用 DoubleSide 让顶 cap（z=0）也可见，
      // 从而正面贴图精确贴合四个标记点；侧面同样 DoubleSide 保证厚度边可见。
      face.side = THREE.DoubleSide
      side.side = THREE.DoubleSide

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
    camera?: { quad: [Point, Point, Point, Point]; imgW: number; imgH: number }
    layerGap: number
    overrideColor: THREE.Color | null
    stretch?: boolean
  },
): Promise<HTMLCanvasElement | null> {
  const { preset, ambientColor, lightAzimuth, lightIntensity, camera, layerGap, overrideColor, stretch = false } = opts

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
    camera,
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

      face.side = THREE.DoubleSide
      side.side = THREE.DoubleSide

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
 * 采样图片外边框的平均颜色，用于图片标识的侧面材质。
 * 图片标识的“厚度边”本质上是印刷材料的切面，使用图片边缘颜色能让 wallTilt 暴露的
 * 侧面自然融入正面画面，避免纯色边框在边角形成突兀的深色块。
 */
function sampleBorderColor(img: HTMLImageElement, borderPx = 4): THREE.Color {
  const c = document.createElement('canvas')
  const maxSample = 256
  const sw = Math.min(img.width, maxSample)
  const sh = Math.round(sw / (img.width / img.height || 1))
  c.width = sw
  c.height = sh
  const ctx = c.getContext('2d')
  if (!ctx) return new THREE.Color(0xdddddd)
  ctx.drawImage(img, 0, 0, sw, sh)
  let data
  try {
    data = ctx.getImageData(0, 0, sw, sh).data
  } catch {
    return new THREE.Color(0xdddddd)
  }
  let r = 0
  let g = 0
  let bSum = 0
  let count = 0
  const b = borderPx
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      if (x < b || x >= sw - b || y < b || y >= sh - b) {
        const i = (y * sw + x) * 4
        r += data[i]
        g += data[i + 1]
        bSum += data[i + 2]
        count++
      }
    }
  }
  if (count === 0) return new THREE.Color(0xdddddd)
  return new THREE.Color(r / count / 255, g / count / 255, bSum / count / 255)
}

/**
 * 图片标识渲染入口（PNG/JPG/WebP 等位图）
 *
 * 将图片作为正面贴图映射到带厚度的拉伸体（ExtrudeGeometry + 矩形 Shape），复用全部
 * 材质预设 / 环境光 / 三光源 / 环境贴图，因此图片标识同样具备厚度与材质质感，且下游
 * warp / 阴影 / 导出与 SVG 标识完全一致（都收敛为同一张 signCanvas）。
 *
 * 为什么不用 BoxGeometry：BoxGeometry 的 -z 背面是独立大平面，wallTilt 错切后背面
 * 下角容易从正面轮廓下方露出，形成左下/右下两块深色角块；ExtrudeGeometry 的侧面
 * 连续、背 cap 与正 cap 使用同一材质索引，露出的背面也会显示贴图，不会出现孤立黑块。
 *
 * 材质数组顺序（ExtrudeGeometry）：[0=侧面, 1=顶/底 cap]，cap 为朝相机的正面。
 */
export async function renderImageToCanvas(
  img: HTMLImageElement,
  depth: number,
  renderSize: number = 512,
  opts: RenderOptions = {},
): Promise<HTMLCanvasElement> {
  const { color = '#dddddd', preset = 'matte', ambientColor, lightAzimuth, lightIntensity, camera } = opts

  // 与 SVG 同一单位体系：先用名义 200 单位构建平面（保持原图比例），厚度用滑块值，
  // 再整体归一化到最大边=2，使厚度进入 0.3 量级，相机/错切/厚度倾斜与 SVG 一致。
  const aspect = img.width && img.height ? img.width / img.height : 1
  const base = 200
  let w0 = base
  let h0 = base
  if (aspect >= 1) h0 = base / aspect
  else w0 = base * aspect

  // 矩形 Shape，CCW 顶点顺序使 extrude 后的正面 cap（z=depth）法线朝 +z
  const shape = new THREE.Shape()
  shape.moveTo(-w0 / 2, -h0 / 2)
  shape.lineTo(w0 / 2, -h0 / 2)
  shape.lineTo(w0 / 2, h0 / 2)
  shape.lineTo(-w0 / 2, h0 / 2)
  shape.lineTo(-w0 / 2, -h0 / 2)

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(0.1, depth),
    bevelEnabled: false,
  })

  // ExtrudeGeometry 默认 UV 不按 [0,1] 矩形映射，需手动设置：
  // - 正面 cap：完整图片 planar 映射；
  // - 侧面：按所处边（左/右/上/下）映射到图片对应边缘像素，
  //   这样 wallTilt 暴露的侧面会显示图片边缘内容，而非纯色块，自然融入画面。
  const pos = geo.attributes.position as THREE.BufferAttribute
  const uv = geo.attributes.uv as THREE.BufferAttribute
  const box = new THREE.Box3().setFromBufferAttribute(pos)
  const bx = box.min.x
  const by = box.min.y
  const bw = Math.max(box.max.x - box.min.x, 0.001)
  const bh = Math.max(box.max.y - box.min.y, 0.001)
  const zMin = box.min.z
  const zMax = box.max.z
  const capEps = 0.001
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const y = pos.getY(i)
    const z = pos.getZ(i)
    const nx = (x - bx) / bw // 0..1 across width
    const ny = (y - by) / bh // 0..1 across height

    if (Math.abs(z - zMax) < capEps) {
      // 正面 cap：完整图片，v=0 在底部、v=1 在顶部，配合 flipY=true 图片正立
      uv.setXY(i, nx, ny)
    } else if (Math.abs(z - zMin) >= capEps) {
      // 侧面：找最近边，映射到图片边缘
      const dBottom = ny
      const dTop = 1 - ny
      const dLeft = nx
      const dRight = 1 - nx
      const minD = Math.min(dBottom, dTop, dLeft, dRight)
      if (minD === dBottom) {
        uv.setXY(i, nx, 0)
      } else if (minD === dTop) {
        uv.setXY(i, nx, 1)
      } else if (minD === dLeft) {
        uv.setXY(i, 0, ny)
      } else {
        uv.setXY(i, 1, ny)
      }
    }
    // 背面 cap 沿用默认 UV（正常情况下不可见）
  }
  uv.needsUpdate = true

  // 图片纹理：flipY=true，配合上述 UV（v=0 在底部）使图片正立
  const imgTex = new THREE.Texture()
  imgTex.image = img
  imgTex.flipY = true
  imgTex.colorSpace = THREE.SRGBColorSpace
  imgTex.anisotropy = 4
  imgTex.needsUpdate = true

  // 侧面颜色：以图片边框平均色为主（让 wallTilt 暴露的厚度边自然融入正面画面），
  // 再混入少量用户边框色作为风格调节。
  const borderColor = sampleBorderColor(img)
  const userColor = new THREE.Color(color)
  const sideColor = borderColor.clone().lerp(userColor, 0.2)

  const group = new THREE.Group()
  const face = new THREE.MeshStandardMaterial()
  // 侧面使用 BasicMaterial：不受光照角度压暗，避免正面边缘出现突兀深色阴影块。
  const side = new THREE.MeshBasicMaterial({ color: sideColor })
  // ExtrudeGeometry 材质索引：0=cap，1=侧面（与 svgToMesh.ts 一致）
  const mesh = new THREE.Mesh(geo, [face, side])
  group.add(mesh)

  // 与 SVG 同一归一化：最大边（平面）= 2，厚度同步缩放到 0.3 量级
  normalizeGroup(group, 2)

  return renderGroupToCanvas({
    group,
    renderSize,
    ambientColor,
    preset,
    lightAzimuth,
    lightIntensity,
    camera,
    depth,
    extraDispose: [imgTex],
    applyMaterial: (m) => {
      const presetDef = PRESETS[preset] ?? PRESETS.matte
      const mats = m.material as THREE.Material[]
      const f = mats[0] as THREE.MeshStandardMaterial // cap 正面
      const s = mats[1] as THREE.MeshBasicMaterial // 侧面

      f.map = imgTex
      f.color = new THREE.Color(0xffffff)
      f.metalness = presetDef.metalness
      f.roughness = presetDef.roughness
      // 图片本身可能带透明，开启 alpha 混合；不透明图片无影响
      f.transparent = true
      f.alphaTest = 0.01

      if (presetDef.emissiveIntensity > 0) {
        f.emissive = new THREE.Color(0xffffff)
        f.emissiveIntensity = presetDef.emissiveIntensity
      } else {
        f.emissiveIntensity = 0
      }

      f.needsUpdate = true
      // 侧面已在创建时设为图片边框色，applyMaterial 中无需再改
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

import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  type ReactNode,
} from 'react'

export type Lang = 'zh' | 'en'

type Vars = Record<string, string | number>

// 中文为基线，en 为外网投放版。新增文案时两表同步加 key。
const zh: Record<string, string> = {
  title: '广告标识外立面安装效果图生成器',
  uploadPhotoTitle: '上传建筑外立面照片',
  dragPhotoHint: '或将照片拖拽到此处',
  choosePhoto: '选择照片',
  buildingFacadeAlt: '建筑外立面',
  resetView: '重置视图',
  signTitle: '广告标识',
  uploadSign: '上传标识（SVG / 图片）',
  useSampleLogo: '使用示例 LOGO',
  svgLoaded: 'SVG 标识已加载',
  imageLoaded: '图片标识已加载',
  noSignHint: '尚未上传标识：可上传 SVG / 图片 / AI / EPS，或点「使用示例 LOGO」快速体验',
  exporting: '正在导出效果图...',
  rendering: '正在渲染 3D 标识...',
  paramsTitle: '参数设置',
  depth: '厚度',
  borderColor: '边框色',
  color: '颜色',
  stretch: '拉伸铺满',
  material: '材质',
  aa: '高清边缘',
  on: '开',
  off: '关',
  lockRatio: '锁定 SVG 比例',
  signRatio: '标识比例',
  perspective: '透视',
  fitPointsTrapezoid: '按 SVG 比例适配四点（梯形）',
  lightDir: '光照方向',
  lightIntensity: '光照强度',
  autoMatchLight: '自动匹配光照（基于照片）',
  arcTitle: '弧面贴合（圆柱外立面）',
  arcHint: '开启后，标识会随外立面弧形贴合（默认平面显示）。适用于圆弧幕墙、建筑圆角等竖向弧面场景。',
  arcMode: '弧面模式',
  curvature: '曲率',
  arcDepthHint: '正值外凸、负值内凹。厚度沿弧面法线径向凸出，上下边会露出厚度唇（左右边沿圆柱轴不可见，与真实弧面一致）。',
  layerTitle: '层级管理（立体分层）',
  layerHint: '检测到 {{n}} 个图层。开启「立体分层」后，可分别设置每层的厚度组成立体浮雕；默认平面显示，立体效果由你调整。',
  layered: '立体分层',
  showLayerTitle: '显示该层',
  layerGap: '层间距',
  layerListHint: '列表首项为底层（贴合墙面），向上逐层凸出；每层厚度可单独调整，取消勾选的层不参与立体堆叠。',
  textWarnHint: '提示：原 SVG 含文字（<text>），该层可能无法拉伸，建议导出前将文字“创建轮廓 / 转曲为路径”',
  viewTitle: '视角（3D 凸出方向）',
  viewHint: '前脸始终贴合四点；下列控制只调整 3D 凸出部分的透视与观察角度，让立体效果更贴近真实拍摄视角',
  foreshorten: '透视强度',
  viewYaw: '视角·左右',
  viewPitch: '视角·上下',
  markersTitle: '标记说明',
  grid: '辅助网格',
  tl: '左上',
  tr: '右上',
  br: '右下',
  bl: '左下',
  markersHint: '拖动四个角点对齐形状；在标识区域内拖拽可整体移动图层，在画面空白处拖拽平移视图，滚轮 / 双指捏合缩放查看细节',
  exportRes: '导出分辨率',
  res1x: '1x（原图）',
  res2x: '2x（高清）',
  res4x: '4x（超清）',
  exportFormatLabel: '导出格式',
  fmtPng: 'PNG（无损）',
  fmtJpg: 'JPG（体积小）',
  fmtWebp: 'WebP（兼顾）',
  exportBtn: '导出效果图',
  needPhoto: '请先上传建筑照片',
  needSign: '请先上传 SVG 标识',
  undo: '↶ 撤销',
  redo: '↷ 重做',
  undoHint: 'Ctrl/⌘+Z 撤销，Ctrl/⌘+Shift+Z 或 Ctrl+Y 重做',

  // 报错 / 提示（逻辑层抛出）
  errSvgRoot: '文件内容不是有效的 SVG（缺少 <svg> 根元素）',
  errSvgParse: 'SVG 解析失败：文件可能存在 XML 语法错误，请检查后重试',
  errSvgNoRoot: '未找到 <svg> 根元素，请确认文件为 SVG 格式',
  errSvgNoShape: 'SVG 中未找到可渲染的图形（path / rect / circle / text 等），请检查内容',
  errSvgGeneric: 'SVG 解析失败，请确认文件内容正确',
  errQuadSmall: '四点区域过小，请把四个角点拖开成合适的矩形后再导出',
  errQuadOrder: '四个角点顺序错乱（出现交叉），请调整回左上 / 右上 / 右下 / 左下',
  errImgLoad: '图片加载失败，请换一张试试',
  errSvgRender: 'SVG 渲染失败，可能包含当前不支持的元素，建议导出为精简 SVG 后重试',
  errImgRender: '图片 / AI / EPS 加载失败，请换一张试试，或导出为 SVG 后上传',
  warnPhotoLarge: '照片尺寸较大（>4096px），导出 4x 时会自动降档以保证成功',
  exportDownscale: '照片较大，已自动将导出分辨率降至 {{s}}x 以保证导出成功',
  errAiEpsParse: 'AI / EPS 解析失败：请在 Illustrator 或 Inkscape 中“导出为 SVG”后再上传',
  errUnsupportedFormat: '不支持的文件格式，请上传 SVG 矢量图或 PNG / JPG / WebP 图片',
  errVectorWrongArea: '矢量文件（SVG / AI / EPS）请在右侧「广告标识」区上传',
  errExportFail: '导出失败，请降低导出分辨率或重新上传照片后重试',
  downloadName: '广告标识安装效果图_{{s}}x.{{ext}}',

  // 材质预设标签（PRESETS 的 key）
  preset_matte: '哑光',
  preset_metal: '金属',
  preset_acrylic: '亚克力',
  preset_neon: '霓虹',
  preset_brushed: '拉丝',
}

const en: Record<string, string> = {
  title: 'Sign Installation Effect Generator',
  uploadPhotoTitle: 'Upload building facade photo',
  dragPhotoHint: 'Or drag & drop the photo here',
  choosePhoto: 'Choose Photo',
  buildingFacadeAlt: 'Building facade',
  resetView: 'Reset View',
  signTitle: 'Sign',
  uploadSign: 'Upload Sign (SVG / Image)',
  useSampleLogo: 'Use Sample LOGO',
  svgLoaded: 'SVG sign loaded',
  imageLoaded: 'Image sign loaded',
  noSignHint: 'No sign uploaded yet: upload SVG / image / AI / EPS, or click "Use Sample LOGO" to try it out',
  exporting: 'Exporting effect image...',
  rendering: 'Rendering 3D sign...',
  paramsTitle: 'Parameters',
  depth: 'Depth',
  borderColor: 'Border Color',
  color: 'Color',
  stretch: 'Stretch to Fill',
  material: 'Material',
  aa: 'High-Def Edges',
  on: 'On',
  off: 'Off',
  lockRatio: 'Lock SVG Ratio',
  signRatio: 'Sign Ratio',
  perspective: 'Perspective',
  fitPointsTrapezoid: 'Fit 4 Points to SVG Ratio (Trapezoid)',
  lightDir: 'Light Direction',
  lightIntensity: 'Light Intensity',
  autoMatchLight: 'Auto-Match Light (from Photo)',
  arcTitle: 'Curved Surface (Cylindrical Facade)',
  arcHint: 'When enabled, the sign bends to fit the curved facade (flat by default). Suitable for curved curtain walls, building rounded corners, and other vertical curved surfaces.',
  arcMode: 'Curved Mode',
  curvature: 'Curvature',
  arcDepthHint: 'Positive = outward bulge, negative = inward. Depth extrudes radially along the arc normal; the top/bottom edges reveal the thickness lip (left/right edges stay invisible along the cylinder axis, as on a real curved surface).',
  layerTitle: 'Layer Management (3D Layers)',
  layerHint: 'Detected {{n}} layers. Enable "3D Layers" to set each layer’s depth and build a 3D relief; flat by default, you control the 3D effect.',
  layered: '3D Layers',
  showLayerTitle: 'Show this layer',
  layerGap: 'Layer Gap',
  layerListHint: 'The first item is the bottom layer (against the wall), layers stack outward upward; each layer’s depth is adjustable, unchecked layers are excluded from the 3D stack.',
  textWarnHint: 'Note: the original SVG contains text (<text>), which may not be extrudable. Convert text to outlines/paths before exporting.',
  viewTitle: 'View (3D Extrusion Angle)',
  viewHint: 'The front face always snaps to the 4 points; the controls below only adjust the perspective and viewing angle of the 3D extrusion, making it closer to a real photo.',
  foreshorten: 'Perspective Strength',
  viewYaw: 'View · Left/Right',
  viewPitch: 'View · Up/Down',
  markersTitle: 'Marker Guide',
  grid: 'Helper Grid',
  tl: 'Top-Left',
  tr: 'Top-Right',
  br: 'Bottom-Right',
  bl: 'Bottom-Left',
  markersHint: 'Drag the four corner points to align the shape; drag inside the sign area to move the layer, drag on empty space to pan the view, scroll wheel / pinch to zoom in for details.',
  exportRes: 'Export Resolution',
  res1x: '1x (Original)',
  res2x: '2x (HD)',
  res4x: '4x (Ultra)',
  exportFormatLabel: 'Export Format',
  fmtPng: 'PNG (Lossless)',
  fmtJpg: 'JPG (Compact)',
  fmtWebp: 'WebP (Balanced)',
  exportBtn: 'Export Effect Image',
  needPhoto: 'Please upload a building photo first',
  needSign: 'Please upload an SVG sign first',
  undo: '↶ Undo',
  redo: '↷ Redo',
  undoHint: 'Ctrl/⌘+Z to undo, Ctrl/⌘+Shift+Z or Ctrl+Y to redo',

  errSvgRoot: 'File is not a valid SVG (missing <svg> root element)',
  errSvgParse: 'SVG parsing failed: possible XML syntax error, please check and retry',
  errSvgNoRoot: 'No <svg> root element found, please confirm the file is SVG format',
  errSvgNoShape: 'No renderable shapes found in SVG (path / rect / circle / text, etc.), please check the content',
  errSvgGeneric: 'SVG parsing failed, please confirm the file content is correct',
  errQuadSmall: 'Quad area too small; please drag the four corners apart into a proper rectangle before exporting',
  errQuadOrder: 'Corner points are out of order (crossed); please reset to Top-Left / Top-Right / Bottom-Right / Bottom-Left',
  errImgLoad: 'Image failed to load, please try another one',
  errSvgRender: 'SVG rendering failed; it may contain unsupported elements. Export a simplified SVG and retry',
  errImgRender: 'Image / AI / EPS loading failed, please try another, or export as SVG and upload',
  warnPhotoLarge: 'Photo is large (>4096px); export at 4x will auto-downgrade to ensure success',
  exportDownscale: 'Photo is large; export resolution auto-reduced to {{s}}x to ensure success',
  errAiEpsParse: 'AI / EPS parsing failed: please "Export as SVG" in Illustrator or Inkscape, then upload',
  errUnsupportedFormat: 'Unsupported file format; please upload an SVG vector or PNG / JPG / WebP image',
  errVectorWrongArea: 'Vector files (SVG / AI / EPS) should be uploaded in the "Sign" panel on the right',
  errExportFail: 'Export failed; lower the export resolution or re-upload the photo and retry',
  downloadName: 'Sign_Effect_{{s}}x.{{ext}}',

  preset_matte: 'Matte',
  preset_metal: 'Metal',
  preset_acrylic: 'Acrylic',
  preset_neon: 'Neon',
  preset_brushed: 'Brushed',
}

const TABLES: Record<Lang, Record<string, string>> = { zh, en }

export const LANGS: { code: Lang; label: string }[] = [
  { code: 'zh', label: '中文' },
  { code: 'en', label: 'EN' },
]

const STORAGE_KEY = 'sign-renderer-lang'

export function detectLang(): Lang {
  const stored = localStorage.getItem(STORAGE_KEY) as Lang | null
  if (stored === 'zh' || stored === 'en') return stored
  const nav = (navigator.language || 'zh').toLowerCase()
  return nav.startsWith('zh') ? 'zh' : 'en'
}

function storeLang(l: Lang) {
  try {
    localStorage.setItem(STORAGE_KEY, l)
  } catch {
    /* 隐私模式等场景下 localStorage 不可用，忽略即可 */
  }
}

type I18nValue = {
  lang: Lang
  setLang: (l: Lang) => void
  t: (key: string, vars?: Vars) => string
}

const LangContext = createContext<I18nValue | null>(null)

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => detectLang())

  const setLang = useCallback((l: Lang) => {
    storeLang(l)
    setLangState(l)
    document.documentElement.lang = l === 'zh' ? 'zh-CN' : 'en'
  }, [])

  const t = useCallback(
    (key: string, vars?: Vars) => {
      const table = TABLES[lang] ?? zh
      let s = table[key] ?? zh[key] ?? key
      if (vars) {
        for (const k of Object.keys(vars)) {
          s = s.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), String(vars[k]))
        }
      }
      return s
    },
    [lang],
  )

  return (
    <LangContext.Provider value={{ lang, setLang, t }}>{children}</LangContext.Provider>
  )
}

export function useI18n(): I18nValue {
  const ctx = useContext(LangContext)
  if (!ctx) throw new Error('useI18n must be used within LangProvider')
  return ctx
}

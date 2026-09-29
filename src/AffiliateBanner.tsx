import { useState } from 'react'
import { useI18n } from './i18n'

// Affiliate + support block for sign.phtbyte.com (overseas audience).
// Amazon links carry the phtbyte-20 tracking id; prices are intentionally NOT shown
// (Amazon Associates rule). Donate buttons are ToS-compliant.
// The block is collapsible: expanded by default, user can shrink it.
// All user-visible copy is driven by useI18n() so it follows the app language.

const AMAZON_TAG = 'phtbyte-20'
const amazon = (kw: string) =>
  `https://www.amazon.com/s?k=${encodeURIComponent(kw)}&tag=${AMAZON_TAG}`

// kw = Amazon search keyword (kept in English for the affiliate link);
// labelKey = i18n key for the displayed label.
const PRODUCTS = [
  { kw: '3d printer', labelKey: 'abProdPrinter' },
  { kw: '4k monitor', labelKey: 'abProdMonitor' },
  { kw: 'graphics tablet', labelKey: 'abProdTablet' },
]

const KOFI_URL = 'https://ko-fi.com/haitaopan'

export default function AffiliateBanner() {
  const { t } = useI18n()
  const [collapsed, setCollapsed] = useState(false)
  return (
    <footer className="affiliate-banner">
      <button
        type="button"
        className="ab-toggle"
        aria-expanded={!collapsed}
        aria-controls="ab-body"
        onClick={() => setCollapsed((c) => !c)}
      >
        <span className="ab-toggle-label">{t('abToggle')}</span>
        <span className="ab-chevron" aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
      </button>

      <div id="ab-body" className={collapsed ? 'ab-body ab-collapsed' : 'ab-body'}>
        <div className="ab-inner">
          <div className="ab-col">
            <h3 className="ab-title">{t('abGearTitle')}</h3>
            <p className="ab-sub">{t('abGearSub')}</p>
            <div className="ab-chips">
              {PRODUCTS.map((p) => (
                <a
                  key={p.kw}
                  className="ab-chip"
                  href={amazon(p.kw)}
                  target="_blank"
                  rel="sponsored noopener"
                >
                  {t(p.labelKey)}
                  <span className="ab-amz">{t('abOnAmazon')}</span>
                </a>
              ))}
            </div>
          </div>

          <div className="ab-col">
            <h3 className="ab-title">{t('abSupportTitle')}</h3>
            <p className="ab-sub">{t('abSupportSub')}</p>
            <div className="ab-donate">
              <a className="ab-btn ab-kofi" href={KOFI_URL} target="_blank" rel="noopener">
                ☕ Ko-fi
              </a>
            </div>
          </div>
        </div>

        <div className="ab-foot">
          <nav className="ab-nav">
            <a href="about.html">{t('abAbout')}</a>
            <a href="privacy.html">{t('abPrivacy')}</a>
          </nav>
          <p className="ab-ftc">{t('abFtc')}</p>
        </div>
      </div>
    </footer>
  )
}

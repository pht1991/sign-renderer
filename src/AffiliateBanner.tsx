// Affiliate + support block for sign.phtbyte.com (overseas audience).
// Amazon links carry the phtbyte-20 tracking id; prices are intentionally NOT shown
// (Amazon Associates rule). Donate buttons are ToS-compliant.

const AMAZON_TAG = 'phtbyte-20'
const amazon = (kw: string) =>
  `https://www.amazon.com/s?k=${encodeURIComponent(kw)}&tag=${AMAZON_TAG}`

const PRODUCTS = [
  { label: '3D Printer', kw: '3d printer' },
  { label: '4K Monitor', kw: '4k monitor' },
  { label: 'Graphics Tablet', kw: 'graphics tablet' },
]

const KOFI_URL = 'https://ko-fi.com/haitaopan'

export default function AffiliateBanner() {
  return (
    <footer className="affiliate-banner">
      <div className="ab-inner">
        <div className="ab-col">
          <h3 className="ab-title">Gear we recommend</h3>
          <p className="ab-sub">
            Hardware that helps you build signs & 3D previews. Affiliate links — no extra cost to you.
          </p>
          <div className="ab-chips">
            {PRODUCTS.map((p) => (
              <a
                key={p.kw}
                className="ab-chip"
                href={amazon(p.kw)}
                target="_blank"
                rel="sponsored noopener"
              >
                {p.label}
                <span className="ab-amz">on Amazon ↗</span>
              </a>
            ))}
          </div>
        </div>

        <div className="ab-col">
          <h3 className="ab-title">Support this tool</h3>
          <p className="ab-sub">
            Sign Renderer is free to use. If it saved you time, buy me a coffee.
          </p>
          <div className="ab-donate">
            <a className="ab-btn ab-kofi" href={KOFI_URL} target="_blank" rel="noopener">
              ☕ Ko-fi
            </a>
          </div>
        </div>
      </div>

      <div className="ab-foot">
        <nav className="ab-nav">
          <a href="about.html">About</a>
          <a href="privacy.html">Privacy</a>
        </nav>
        <p className="ab-ftc">
          phtbyte.com is a participant in the Amazon Services LLC Associates Program, an affiliate
          advertising program. As an Amazon Associate I earn from qualifying purchases. Prices are not
          shown — check the current price on Amazon.
        </p>
      </div>
    </footer>
  )
}

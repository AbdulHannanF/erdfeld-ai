/**
 * Minimal, DOM-free XML reader for KML/GPX import.
 *
 * Why not DOMParser/@tmcw/togeojson: the importer runs in the browser, in Node (vitest, route
 * handlers) and could run in a worker; Node has no DOMParser and no XML package is installed.
 * This reader handles exactly what KML/GPX need: elements, attributes, text, CDATA, comments,
 * processing instructions, the five predefined entities plus numeric character references.
 * Namespace prefixes are dropped (`gx:coord` -> `coord`). DOCTYPE declarations are skipped and
 * custom entities are NOT expanded, so there is no entity-expansion (billion laughs / XXE) surface.
 */

export interface XmlEl {
  name: string
  attrs: Record<string, string>
  children: XmlEl[]
  /** Concatenated direct text + CDATA of this element (children's text excluded). */
  text: string
}

const NAMED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }

function decodeEntities(s: string): string {
  if (!s.includes('&')) return s
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return ''
      return String.fromCodePoint(cp)
    }
    return NAMED[e] ?? m
  })
}

function localName(n: string): string {
  const i = n.indexOf(':')
  return i >= 0 ? n.slice(i + 1) : n
}

const MAX_DEPTH = 256

export function parseXml(src: string): XmlEl {
  const root: XmlEl = { name: '#root', attrs: {}, children: [], text: '' }
  const stack: XmlEl[] = [root]
  let i = 0
  const n = src.length
  if (src.charCodeAt(0) === 0xfeff) i = 1
  while (i < n) {
    const lt = src.indexOf('<', i)
    const cur = stack[stack.length - 1]
    if (lt < 0) {
      cur.text += decodeEntities(src.slice(i))
      break
    }
    if (lt > i) cur.text += decodeEntities(src.slice(i, lt))
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4)
      if (end < 0) throw new Error('XML: unterminated comment')
      i = end + 3
    } else if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9)
      if (end < 0) throw new Error('XML: unterminated CDATA')
      cur.text += src.slice(lt + 9, end)
      i = end + 3
    } else if (src.startsWith('<?', lt)) {
      const end = src.indexOf('?>', lt + 2)
      if (end < 0) throw new Error('XML: unterminated processing instruction')
      i = end + 2
    } else if (src.startsWith('<!', lt)) {
      // DOCTYPE (possibly with an internal subset in [...]); skipped, never interpreted.
      let depth = 0
      let j = lt + 2
      for (; j < n; j++) {
        const c = src[j]
        if (c === '[') depth++
        else if (c === ']') depth--
        else if (c === '>' && depth <= 0) break
      }
      if (j >= n) throw new Error('XML: unterminated declaration')
      i = j + 1
    } else if (src[lt + 1] === '/') {
      const end = src.indexOf('>', lt + 2)
      if (end < 0) throw new Error('XML: unterminated end tag')
      const name = localName(src.slice(lt + 2, end).trim())
      if (stack.length < 2 || stack[stack.length - 1].name !== name) {
        throw new Error(`XML: mismatched closing tag </${name}>`)
      }
      stack.pop()
      i = end + 1
    } else {
      // start tag; find its end honouring quoted attribute values
      let j = lt + 1
      let quote = ''
      for (; j < n; j++) {
        const c = src[j]
        if (quote) {
          if (c === quote) quote = ''
        } else if (c === '"' || c === "'") quote = c
        else if (c === '>') break
      }
      if (j >= n) throw new Error('XML: unterminated start tag')
      let body = src.slice(lt + 1, j)
      const selfClose = body.endsWith('/')
      if (selfClose) body = body.slice(0, -1)
      const m = /^([^\s/>]+)/.exec(body)
      if (!m) throw new Error('XML: malformed tag')
      const attrs: Record<string, string> = {}
      const re = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g
      let am: RegExpExecArray | null
      const rest = body.slice(m[0].length)
      while ((am = re.exec(rest))) attrs[localName(am[1])] = decodeEntities(am[3] ?? am[4] ?? '')
      const el: XmlEl = { name: localName(m[1]), attrs, children: [], text: '' }
      cur.children.push(el)
      if (!selfClose) {
        if (stack.length > MAX_DEPTH) throw new Error('XML: nesting too deep')
        stack.push(el)
      }
      i = j + 1
    }
  }
  if (stack.length !== 1) throw new Error(`XML: unclosed element <${stack[stack.length - 1].name}>`)
  if (root.children.length === 0) throw new Error('XML: no root element')
  return root.children[0]
}

/** Direct children with the given local name. */
export function kids(el: XmlEl, name: string): XmlEl[] {
  return el.children.filter((c) => c.name === name)
}
export function kid(el: XmlEl, name: string): XmlEl | undefined {
  return el.children.find((c) => c.name === name)
}
/** All descendants (document order) with the given local name. */
export function descendants(el: XmlEl, name: string, out: XmlEl[] = []): XmlEl[] {
  for (const c of el.children) {
    if (c.name === name) out.push(c)
    descendants(c, name, out)
  }
  return out
}

/** Escape text/attribute content for XML output; also strips characters illegal in XML 1.0. */
export function escapeXml(s: string): string {
  return s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

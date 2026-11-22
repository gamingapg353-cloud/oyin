// Kod yordamchisi: textarea uchun VS Code'dagidek ro'yxat (Emmet, HTML, CSS, JS) va JS ishga tushirgich.
// CodeHelp.attach(textarea, { mode: 'html' | 'css' | 'js' | 'auto', peers: () => "boshqa maydonlardagi kod" })
// CodeHelp.run(quti, { html, css, js, modals }) — kodni alohida (himoyalangan) oynada ishga tushiradi
window.CodeHelp = (() => {
  'use strict';

  const STOP = '\u0001'; // qo'yilgan kodda kursor to'xtaydigan joy
  const words = (s) => s.trim().split(/\s+/);

  // ================= Lug'atlar =================
  const VOID = new Set(words('area base br col embed hr img input link meta source track wbr'));
  const INLINE = new Set(words('a abbr b bdi bdo br button cite code em i img input kbd label mark q s samp select small span strong sub sup textarea time u var'));
  const TAGS = words(`a abbr address area article aside audio b base bdi bdo blockquote body br button canvas caption cite code col colgroup
    data datalist dd del details dfn dialog div dl dt em embed fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 head header hr html
    i iframe img input ins kbd label legend li link main map mark menu meta meter nav noscript object ol optgroup option output p picture pre
    progress q s samp script search section select slot small source span strong style sub summary sup svg table tbody td template textarea
    tfoot th thead time title tr track u ul var video wbr`);
  const TAG_SET = new Set(TAGS);
  const DESC = {
    a: 'havola', article: 'maqola', aside: 'yon qism', audio: 'ovoz', b: 'qalin', body: 'sahifa tanasi', br: 'yangi qator', button: 'tugma', canvas: 'chizish',
    div: 'quti', em: 'urg\'u', figcaption: 'rasm izohi', figure: 'rasm qutisi', footer: 'pastki qism', form: 'forma', h1: 'sarlavha', h2: 'sarlavha 2',
    h3: 'sarlavha 3', head: 'sahifa boshi', header: 'yuqori qism', hr: 'chiziq', i: 'qiya', iframe: 'ichki sahifa', img: 'rasm', input: 'maydon',
    label: 'maydon nomi', li: 'ro\'yxat qatori', link: 'CSS ulash', main: 'asosiy qism', nav: 'menyu', ol: 'raqamli ro\'yxat', option: 'variant',
    p: 'paragraf', script: 'JavaScript', section: 'bo\'lim', select: 'tanlash', span: 'matn bo\'lagi', strong: 'muhim', style: 'CSS', table: 'jadval',
    td: 'katak', textarea: 'katta maydon', th: 'sarlavha katak', title: 'sahifa nomi', tr: 'qator', ul: 'ro\'yxat', video: 'video', search: 'qidiruv',
  };
  // Emmet qisqartmalari: nom -> [teg, atributlar]
  const ALIAS = {
    a: ['a', { href: '' }], 'a:blank': ['a', { href: '', target: '_blank' }], 'a:mail': ['a', { href: 'mailto:' }], 'a:tel': ['a', { href: 'tel:+' }],
    img: ['img', { src: '', alt: '' }], link: ['link', { rel: 'stylesheet', href: '' }], 'link:css': ['link', { rel: 'stylesheet', href: 'style.css' }],
    'link:favicon': ['link', { rel: 'icon', href: 'favicon.ico' }], 'meta:utf': ['meta', { charset: 'UTF-8' }],
    'meta:vp': ['meta', { name: 'viewport', content: 'width=device-width, initial-scale=1.0' }],
    'script:src': ['script', { src: '' }], 'script:module': ['script', { type: 'module', src: '' }],
    form: ['form', { action: '' }], 'form:get': ['form', { action: '', method: 'get' }], 'form:post': ['form', { action: '', method: 'post' }],
    label: ['label', { for: '' }], input: ['input', { type: 'text' }], 'input:text': ['input', { type: 'text', name: '', id: '' }],
    'input:password': ['input', { type: 'password', name: '', id: '' }], 'input:email': ['input', { type: 'email', name: '', id: '' }],
    'input:number': ['input', { type: 'number', name: '', id: '' }], 'input:tel': ['input', { type: 'tel', name: '', id: '' }],
    'input:search': ['input', { type: 'search', name: '', id: '' }], 'input:date': ['input', { type: 'date', name: '', id: '' }],
    'input:color': ['input', { type: 'color', name: '', id: '' }], 'input:range': ['input', { type: 'range', name: '', id: '' }],
    'input:file': ['input', { type: 'file', name: '', id: '' }], 'input:checkbox': ['input', { type: 'checkbox', name: '', id: '' }],
    'input:radio': ['input', { type: 'radio', name: '', id: '' }], 'input:submit': ['input', { type: 'submit', value: '' }],
    select: ['select', { name: '', id: '' }], 'select:d': ['select', { name: '', id: '', disabled: null }], 'select:disabled': ['select', { name: '', id: '', disabled: null }],
    option: ['option', { value: '' }], textarea: ['textarea', { name: '', id: '', rows: '5' }], 'button:submit': ['button', { type: 'submit' }],
    'button:disabled': ['button', { disabled: null }], iframe: ['iframe', { src: '' }], video: ['video', { src: '', controls: null }], audio: ['audio', { src: '', controls: null }],
    source: ['source', { src: '', type: '' }], bq: ['blockquote'], fig: ['figure'], figc: ['figcaption'], sect: ['section'], art: ['article'], hdr: ['header'], ftr: ['footer'],
    adr: ['address'], dlg: ['dialog'], str: ['strong'], prog: ['progress'], mn: ['main'], tarea: ['textarea', { name: '', id: '', rows: '5' }], btn: ['button'],
    'btn:s': ['button', { type: 'submit' }], opt: ['option', { value: '' }], fst: ['fieldset'], leg: ['legend'], ifr: ['iframe', { src: '' }], cap: ['caption'], pic: ['picture'],
    tem: ['template'],
  };
  const EXPAND = { // bir so'z — butun tuzilma
    'ul+': 'ul>li', 'ol+': 'ol>li', 'table+': 'table>tr>td', 'select+': 'select>option', 'dl+': 'dl>dt+dd',
  };
  const DOC = `<!DOCTYPE html>\n<html lang="uz">\n<head>\n\t<meta charset="UTF-8">\n\t<meta name="viewport" content="width=device-width, initial-scale=1.0">\n\t<title>${STOP}Sahifa</title>\n</head>\n<body>\n\t${STOP}\n</body>\n</html>`;

  const ATTRS = words('class id style title hidden tabindex lang data- aria-label onclick');
  const TAG_ATTRS = {
    a: 'href target rel download', img: 'src alt width height loading', input: 'type name value placeholder required disabled checked min max maxlength',
    button: 'type disabled onclick', form: 'action method', label: 'for', link: 'rel href', script: 'src type defer async', select: 'name required disabled multiple',
    option: 'value selected disabled', textarea: 'name rows cols placeholder required maxlength', video: 'src controls autoplay loop muted poster width height',
    audio: 'src controls autoplay loop muted', iframe: 'src width height allowfullscreen', meta: 'charset name content', td: 'colspan rowspan', th: 'colspan rowspan scope',
    ol: 'type start reversed', source: 'src type', canvas: 'width height', progress: 'value max', html: 'lang',
  };
  const FLAGS = new Set(words('hidden required disabled checked defer async selected multiple controls autoplay loop muted allowfullscreen download reversed'));
  const ATTR_VALUES = {
    type: 'text password email number tel search date time color range file checkbox radio submit button reset url module', target: '_blank _self',
    rel: 'stylesheet icon noopener', method: 'get post', loading: 'lazy eager', charset: 'UTF-8', name: 'viewport description', lang: 'uz ru en', scope: 'col row',
  };

  const COLORS = words('black white red green blue yellow orange purple pink gray silver gold tomato coral crimson salmon teal navy skyblue royalblue lime olive maroon cyan magenta violet indigo brown beige transparent currentColor');
  const LEN = 'auto 0 10px 20px 1rem 2rem 50% 100%';
  const CSS = {
    display: 'flex grid block inline-block inline none inline-flex contents', position: 'relative absolute fixed sticky static',
    'flex-direction': 'row column row-reverse column-reverse', 'flex-wrap': 'wrap nowrap', 'justify-content': 'center space-between space-around space-evenly flex-start flex-end',
    'align-items': 'center flex-start flex-end stretch baseline', 'align-content': 'center space-between flex-start', 'align-self': 'center flex-start flex-end stretch',
    'justify-items': 'center start end stretch', 'justify-self': 'center start end', 'place-items': 'center', 'place-content': 'center', gap: '10px 20px 1rem', flex: '1 0 auto',
    'flex-grow': '0 1', 'flex-shrink': '0 1', 'flex-basis': 'auto 50%', order: '0 1 -1',
    'grid-template-columns': 'repeat(2, 1fr) repeat(3, 1fr) 1fr 1fr repeat(auto-fit, minmax(200px, 1fr))', 'grid-template-rows': 'auto 1fr', 'grid-column': '1 / -1 span 2', 'grid-row': 'span 2',
    width: `100% ${LEN} fit-content 100vw`, height: `100vh ${LEN} fit-content`, 'max-width': '1200px 600px 100%', 'min-width': '0 200px', 'max-height': '100vh 400px', 'min-height': '100vh 200px',
    margin: '0 0 auto 10px 20px auto', 'margin-top': LEN, 'margin-right': LEN, 'margin-bottom': LEN, 'margin-left': LEN,
    padding: '0 10px 20px 10px 20px', 'padding-top': '10px 20px', 'padding-right': '10px 20px', 'padding-bottom': '10px 20px', 'padding-left': '10px 20px',
    top: '0 50% 10px auto', right: '0 10px auto', bottom: '0 10px auto', left: '0 50% 10px auto', inset: '0', 'z-index': '1 10 100 -1',
    color: '@', background: '@ linear-gradient(90deg, red, blue) url() none', 'background-color': '@', 'background-image': 'url() linear-gradient(90deg, red, blue) none',
    'background-size': 'cover contain', 'background-position': 'center top bottom', 'background-repeat': 'no-repeat repeat repeat-x',
    border: '1px solid black 2px solid red none', 'border-top': '1px solid black none', 'border-right': '1px solid black', 'border-bottom': '1px solid black none', 'border-left': '1px solid black',
    'border-radius': '10px 50% 8px 999px', 'border-color': '@', 'border-style': 'solid dashed dotted none', 'border-width': '1px 2px', 'border-collapse': 'collapse separate', outline: 'none',
    'box-shadow': '0 4px 12px rgba(0, 0, 0, 0.2) none', 'text-shadow': '1px 1px 2px black', 'box-sizing': 'border-box content-box',
    'font-size': '16px 20px 24px 32px 1rem 2rem', 'font-weight': 'bold 400 500 600 700 normal', 'font-family': 'sans-serif serif monospace system-ui Arial, sans-serif', 'font-style': 'italic normal', font: '16px sans-serif',
    'text-align': 'center left right justify', 'text-decoration': 'none underline line-through', 'text-transform': 'uppercase lowercase capitalize none', 'line-height': '1.5 1 1.2', 'letter-spacing': '1px 2px',
    'white-space': 'nowrap pre normal pre-wrap', 'word-break': 'break-word break-all', 'vertical-align': 'middle top bottom', 'list-style': 'none disc square decimal', 'list-style-type': 'none disc square',
    cursor: 'pointer default not-allowed grab text', opacity: '1 0.5 0', overflow: 'hidden auto scroll visible', 'overflow-x': 'auto hidden', 'overflow-y': 'auto hidden', visibility: 'hidden visible',
    'object-fit': 'cover contain fill', 'aspect-ratio': '16 / 9 1', transform: 'translate(-50%, -50%) rotate(45deg) scale(1.1) translateY(-4px)', 'transform-origin': 'center',
    transition: '0.3s all 0.3s ease', animation: 'nom 1s infinite', 'animation-name': 'none', 'animation-duration': '1s', filter: 'blur(4px) grayscale(1) brightness(0.8)', 'backdrop-filter': 'blur(8px)',
    'pointer-events': 'none auto', 'user-select': 'none', 'scroll-behavior': 'smooth', float: 'left right none', clear: 'both', content: "''", 'accent-color': '@', 'mix-blend-mode': 'multiply',
  };
  const PROPS = Object.keys(CSS);
  const CSS_ABBR = { // tayyor qisqartmalar
    df: 'display: flex;', dg: 'display: grid;', db: 'display: block;', dib: 'display: inline-block;', dn: 'display: none;', poa: 'position: absolute;', por: 'position: relative;',
    pof: 'position: fixed;', pos: 'position: sticky;', fdc: 'flex-direction: column;', fdr: 'flex-direction: row;', fww: 'flex-wrap: wrap;', jcc: 'justify-content: center;',
    jcsb: 'justify-content: space-between;', jcsa: 'justify-content: space-around;', aic: 'align-items: center;', tac: 'text-align: center;', tal: 'text-align: left;', tar: 'text-align: right;',
    tdn: 'text-decoration: none;', tdu: 'text-decoration: underline;', ttu: 'text-transform: uppercase;', fwb: 'font-weight: bold;', fsi: 'font-style: italic;', cup: 'cursor: pointer;', bsbb: 'box-sizing: border-box;',
    lsn: 'list-style: none;', ovh: 'overflow: hidden;', ova: 'overflow: auto;', m0a: 'margin: 0 auto;', mauto: 'margin: auto;', ofc: 'object-fit: cover;', pic: 'place-items: center;', bdn: 'border: none;', oln: 'outline: none;',
    tsn: `transition: ${STOP}0.3s;`, trf: `transform: ${STOP};`, bxsh: `box-shadow: 0 4px 12px ${STOP}rgba(0, 0, 0, 0.2);`, bd: `border: 1px solid ${STOP}black;`,
  };
  const CSS_NUM = { // m10 -> margin: 10px
    m: 'margin', mt: 'margin-top', mr: 'margin-right', mb: 'margin-bottom', ml: 'margin-left', p: 'padding', pt: 'padding-top', pr: 'padding-right', pb: 'padding-bottom', pl: 'padding-left',
    w: 'width', h: 'height', maw: 'max-width', mah: 'max-height', miw: 'min-width', mih: 'min-height', fz: 'font-size', fs: 'font-size', lh: 'line-height', bdrs: 'border-radius', br: 'border-radius',
    t: 'top', r: 'right', b: 'bottom', l: 'left', z: 'z-index', g: 'gap', gap: 'gap', op: 'opacity', fw: 'font-weight', ls: 'letter-spacing', fx: 'flex', o: 'order',
  };
  const UNITLESS = new Set(['line-height', 'z-index', 'opacity', 'font-weight', 'flex', 'order']);
  const CSS_SHORT = { c: 'color', bg: 'background', bgc: 'background-color', bgi: 'background-image', bgs: 'background-size', ff: 'font-family', d: 'display', jc: 'justify-content', ai: 'align-items', ta: 'text-align', td: 'text-decoration', gtc: 'grid-template-columns', tt: 'text-transform', ov: 'overflow', cur: 'cursor', trs: 'transition', anim: 'animation', ...CSS_NUM };
  const PSEUDO = words(':hover :active :focus :first-child :last-child :nth-child(2) :not() ::before ::after ::placeholder :checked :disabled :root');
  const AT = {
    '@media': `@media (max-width: ${STOP}600px) {\n\t${STOP}\n}`, '@keyframes': `@keyframes ${STOP}nom {\n\tfrom {\n\t\t${STOP}\n\t}\n\tto {\n\t\t${STOP}\n\t}\n}`,
    '@import': `@import url('${STOP}');`, '@font-face': `@font-face {\n\tfont-family: ${STOP};\n\tsrc: url('${STOP}');\n}`,
  };

  const JS_SNIP = {
    log: [`console.log(${STOP});`, 'konsolga chiqarish'], clg: [`console.log(${STOP});`, 'konsolga chiqarish'],
    fn: [`function ${STOP}nom(${STOP}) {\n\t${STOP}\n}`, 'funksiya'], function: [`function ${STOP}nom(${STOP}) {\n\t${STOP}\n}`, 'funksiya'],
    afn: [`const ${STOP}nom = (${STOP}) => {\n\t${STOP}\n};`, "strelkali funksiya"], if: [`if (${STOP}) {\n\t${STOP}\n}`, 'shart'], ifelse: [`if (${STOP}) {\n\t${STOP}\n} else {\n\t${STOP}\n}`, 'shart / aks holda'],
    for: [`for (let i = 0; i < ${STOP}10; i++) {\n\t${STOP}\n}`, 'sikl'], forof: [`for (const ${STOP}item of ${STOP}list) {\n\t${STOP}\n}`, "ro'yxat bo'ylab"], while: [`while (${STOP}) {\n\t${STOP}\n}`, 'sikl'],
    switch: [`switch (${STOP}) {\n\tcase ${STOP}:\n\t\t${STOP}\n\t\tbreak;\n\tdefault:\n\t\t${STOP}\n}`, 'tanlov'], try: [`try {\n\t${STOP}\n} catch (err) {\n\t${STOP}console.log(err);\n}`, 'xatoni ushlash'],
    class: [`class ${STOP}Nom {\n\tconstructor(${STOP}) {\n\t\t${STOP}\n\t}\n}`, 'klass'], qs: [`document.querySelector('${STOP}')`, 'elementni topish'], qsa: [`document.querySelectorAll('${STOP}')`, 'hammasini topish'],
    gid: [`document.getElementById('${STOP}')`, 'id bilan topish'], ael: [`addEventListener('${STOP}click', () => {\n\t${STOP}\n});`, 'hodisa'], ce: [`document.createElement('${STOP}')`, 'element yaratish'],
    sto: [`setTimeout(() => {\n\t${STOP}\n}, ${STOP}1000);`, 'kechiktirish'], sti: [`setInterval(() => {\n\t${STOP}\n}, ${STOP}1000);`, 'takrorlash'], setTimeout: [`setTimeout(() => {\n\t${STOP}\n}, ${STOP}1000);`, 'kechiktirish'],
    setInterval: [`setInterval(() => {\n\t${STOP}\n}, ${STOP}1000);`, 'takrorlash'], alert: [`alert(${STOP});`, 'xabar'], prompt: [`prompt('${STOP}')`, "so'rash"], confirm: [`confirm('${STOP}')`, 'tasdiqlash'],
    fetch: [`fetch('${STOP}')\n\t.then((res) => res.json())\n\t.then((data) => {\n\t\t${STOP}\n\t});`, "so'rov"], parseInt: [`parseInt(${STOP})`, 'butun son'], parseFloat: [`parseFloat(${STOP})`, 'kasr son'], Number: [`Number(${STOP})`, 'songa aylantirish'], String: [`String(${STOP})`, 'matnga aylantirish'],
  };
  const JS_KEYS = words('const let var return async await break case catch continue default delete else export extends false finally import in instanceof new null of super this throw true typeof undefined void yield');
  const JS_GLOBALS = words('document console window Math JSON Array Object Date Boolean Promise Map Set localStorage sessionStorage location navigator event clearInterval clearTimeout isNaN requestAnimationFrame NaN Infinity');
  const call = (s, a = STOP) => `${s}(${a})`;
  const cb = (s, a) => `${s}((${a}) => ${STOP})`;
  const str = (s) => `${s}('${STOP}')`;
  const DOM = {
    addEventListener: `addEventListener('${STOP}click', () => {\n\t${STOP}\n})`, textContent: 0, innerHTML: 0, value: 0, style: 0, classList: 0, className: 0, id: 0, dataset: 0, children: 0, parentElement: 0, src: 0, href: 0,
    checked: 0, disabled: 0, hidden: 0, append: call('append'), appendChild: call('appendChild'), prepend: call('prepend'), remove: 'remove()', setAttribute: `setAttribute('${STOP}', '${STOP}')`, getAttribute: str('getAttribute'),
    removeAttribute: str('removeAttribute'), querySelector: str('querySelector'), querySelectorAll: str('querySelectorAll'), closest: str('closest'), focus: 'focus()', click: 'click()', insertAdjacentHTML: `insertAdjacentHTML('beforeend', ${STOP})`,
    nextElementSibling: 0, previousElementSibling: 0, offsetWidth: 0, offsetHeight: 0, getBoundingClientRect: 'getBoundingClientRect()', scrollIntoView: 'scrollIntoView()', onclick: 0,
  };
  const ARR = {
    length: 0, push: call('push'), pop: 'pop()', shift: 'shift()', unshift: call('unshift'), map: cb('map', 'x'), filter: cb('filter', 'x'), forEach: `forEach((x) => {\n\t${STOP}\n})`, find: cb('find', 'x'), some: cb('some', 'x'), every: cb('every', 'x'),
    reduce: `reduce((a, b) => a + b, 0${STOP})`, includes: call('includes'), indexOf: call('indexOf'), join: str('join'), slice: call('slice'), splice: call('splice'), sort: `sort((a, b) => a - b${STOP})`, reverse: 'reverse()', concat: call('concat'),
  };
  const STRM = { toUpperCase: 'toUpperCase()', toLowerCase: 'toLowerCase()', trim: 'trim()', split: str('split'), replace: `replace('${STOP}', '${STOP}')`, replaceAll: `replaceAll('${STOP}', '${STOP}')`, startsWith: str('startsWith'), endsWith: str('endsWith'), charAt: call('charAt'), repeat: call('repeat'), padStart: `padStart(${STOP}2, '0')`, toString: 'toString()', toFixed: call('toFixed', `${STOP}2`) };
  const MEMBERS = {
    console: { log: call('log'), error: call('error'), warn: call('warn'), table: call('table'), clear: 'clear()' },
    document: { querySelector: str('querySelector'), querySelectorAll: str('querySelectorAll'), getElementById: str('getElementById'), createElement: str('createElement'), addEventListener: `addEventListener('${STOP}keydown', (e) => {\n\t${STOP}\n})`, body: 0, title: 0, head: 0, getElementsByClassName: str('getElementsByClassName'), documentElement: 0 },
    Math: { random: 'random()', floor: call('floor'), round: call('round'), ceil: call('ceil'), max: call('max'), min: call('min'), abs: call('abs'), sqrt: call('sqrt'), pow: call('pow'), PI: 0, trunc: call('trunc') },
    JSON: { stringify: call('stringify'), parse: call('parse') }, Object: { keys: call('keys'), values: call('values'), entries: call('entries'), assign: call('assign') },
    Array: { from: call('from'), isArray: call('isArray') }, Date: { now: 'now()' }, Number: { isInteger: call('isInteger') },
    localStorage: { getItem: str('getItem'), setItem: `setItem('${STOP}', ${STOP})`, removeItem: str('removeItem'), clear: 'clear()' },
    classList: { add: str('add'), remove: str('remove'), toggle: str('toggle'), contains: str('contains') },
    location: { href: 0, reload: 'reload()' }, window: { addEventListener: `addEventListener('${STOP}load', () => {\n\t${STOP}\n})`, innerWidth: 0, innerHeight: 0, scrollTo: call('scrollTo') },
    e: { target: 0, key: 0, code: 0, preventDefault: 'preventDefault()', clientX: 0, clientY: 0, currentTarget: 0 },
  };
  MEMBERS.event = MEMBERS.e;
  MEMBERS.sessionStorage = MEMBERS.localStorage;
  const ANY = { ...DOM, ...ARR, ...STRM };
  const EVENTS = words('click input change submit keydown keyup mouseover mouseout mousemove load scroll dblclick focus blur touchstart');
  const camel = (p) => p.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

  // ================= Emmet =================
  function parseEmmet(src) {
    let i = 0;
    const fail = () => { throw new Error('emmet'); };
    const num = () => { const m = /^\d+/.exec(src.slice(i)); if (!m) return null; i += m[0].length; return Number(m[0]); };
    function element() {
      const n = { tag: '', attrs: [], cls: [], text: null, rep: 1, kids: [] };
      const m = /^(?:[a-z][a-z0-9$-]*(?::[a-z]+)?|!)/i.exec(src.slice(i));
      if (m) { n.tag = m[0].toLowerCase(); i += m[0].length; }
      const start = i;
      for (;;) {
        const ch = src[i];
        if (ch === '.' || ch === '#') {
          const v = /^[\w$-]+/.exec(src.slice(i + 1));
          if (!v) fail();
          if (ch === '.') n.cls.push(v[0]); else n.attrs.push(['id', v[0]]);
          i += 1 + v[0].length;
        } else if (ch === '[') {
          const end = src.indexOf(']', i);
          if (end < 0) fail();
          const re = /([\w:-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s]*)))?/g;
          const part = src.slice(i + 1, end);
          let a;
          while ((a = re.exec(part))) n.attrs.push([a[1], a[2] ?? a[3] ?? a[4] ?? '']);
          i = end + 1;
        } else if (ch === '{') {
          const end = src.indexOf('}', i);
          if (end < 0) fail();
          n.text = src.slice(i + 1, end);
          i = end + 1;
        } else break;
      }
      if (!n.tag && i === start) fail();
      if (src[i] === '*') { i += 1; n.rep = num() ?? fail(); }
      return n;
    }
    function list(close) {
      const root = { kids: [], up: null };
      let cur = root;
      for (;;) {
        let n;
        if (src[i] === '(') {
          i += 1;
          n = { group: true, kids: list(true), rep: 1 };
          if (src[i] === '*') { i += 1; n.rep = num() ?? fail(); }
        } else n = element();
        if (n.rep < 1 || n.rep > 100) fail();
        n.up = cur;
        cur.kids.push(n);
        const op = src[i];
        if (op === undefined) { if (close) fail(); return root.kids; }
        if (op === ')') { if (!close) fail(); i += 1; return root.kids; }
        if (op === '>') { i += 1; if (n.group) fail(); cur = n; } else if (op === '+') i += 1;
        else if (op === '^') { while (src[i] === '^') { i += 1; cur = cur.up || root; } } else fail();
      }
    }
    const out = list(false);
    if (i !== src.length) fail();
    return out;
  }
  const IMPLICIT = { ul: 'li', ol: 'li', table: 'tr', tbody: 'tr', thead: 'tr', tr: 'td', select: 'option', p: 'span', span: 'span', a: 'span', b: 'span', em: 'span', strong: 'span', label: 'span', button: 'span' };
  function renderEmmet(nodes, parentTag) {
    let budget = 600;
    const numb = (s, k) => s.replace(/\$+/g, (m) => String(k).padStart(m.length, '0'));
    function one(n, k, pTag) {
      budget -= 1;
      if (budget < 0) throw new Error('emmet');
      if (n.group) return { inline: false, html: list(n.kids, pTag, k).map((x) => x.html).join('\n') };
      let tag = numb(n.tag, k) || IMPLICIT[pTag] || 'div';
      const al = ALIAS[tag];
      const attrs = [];
      if (al) {
        tag = al[0];
        Object.entries(al[1] || {}).forEach(([a, v]) => attrs.push([a, v]));
      } else if (!TAG_SET.has(tag)) throw new Error('emmet');
      n.attrs.forEach(([a, v]) => {
        const old = attrs.find((x) => x[0] === a);
        if (old) old[1] = v; else attrs.push([a, v]);
      });
      if (n.cls.length) attrs.unshift(['class', n.cls.join(' ')]);
      const at = attrs.map(([a, v]) => (v === null || (v === '' && FLAGS.has(a)) ? ` ${a}` : ` ${a}="${v === '' ? STOP : numb(v, k)}"`)).join('');
      const open = `<${tag}${at}>`;
      const inline = INLINE.has(tag);
      if (VOID.has(tag)) return { inline, html: open };
      const kids = list(n.kids, tag, k);
      const text = n.text === null ? '' : numb(n.text, k);
      let inner = text || (kids.length ? '' : STOP);
      if (kids.length) {
        if (kids.every((x) => x.inline) && kids.length <= 3) inner += kids.map((x) => x.html).join('');
        else inner += `\n\t${kids.map((x) => x.html).join('\n').replace(/\n/g, '\n\t')}\n`;
      }
      return { inline, html: `${open}${inner}</${tag}>` };
    }
    function list(ns, pTag, k) {
      const out = [];
      ns.forEach((n) => { for (let r = 1; r <= n.rep; r += 1) out.push(one(n, n.rep > 1 ? r : k, pTag)); });
      return out;
    }
    return list(nodes, parentTag, 1).map((x) => x.html).join('\n');
  }
  function emmet(abbr, parentTag) {
    if (abbr === '!' || abbr === 'html:5') return DOC;
    if (EXPAND[abbr]) return emmet(EXPAND[abbr], parentTag);
    try { return renderEmmet(parseEmmet(abbr), parentTag); } catch (e) { return null; }
  }

  // Kursordan oldingi Emmet qisqartmasi (teglar va bo'sh joydan keyingi qism)
  function abbrBefore(before) {
    const line = before.slice(before.lastIndexOf('\n') + 1);
    let from = 0;
    const re = /<[^<>]*>/g;
    while (re.exec(line)) from = re.lastIndex;
    const s = line.slice(from);
    let depth = 0;
    let i = s.length;
    while (i > 0) {
      const ch = s[i - 1];
      if (ch === ']' || ch === '}') depth += 1;
      else if (ch === '[' || ch === '{') { if (!depth) break; depth -= 1; } else if (!depth && !/[\w.#>+^*$:!()-]/.test(ch)) break;
      i -= 1;
    }
    return depth ? '' : s.slice(i);
  }

  // ================= CSS qisqartmalari =================
  function cssAbbr(a) {
    if (CSS_ABBR[a]) return CSS_ABBR[a];
    let m = /^([a-z]+)((?:-?\d*\.?\d+(?:px|rem|em|vh|vw|[pre%])?)(?:-\d*\.?\d+(?:px|rem|em|vh|vw|[pre%])?)*)$/.exec(a);
    if (m && CSS_NUM[m[1]]) {
      const prop = CSS_NUM[m[1]];
      const vals = m[2].match(/(?:^-)?\d*\.?\d+(?:px|rem|em|vh|vw|[pre%])?/g).map((v) => {
        const p = /^(-?\d*\.?\d+)(.*)$/.exec(v);
        const unit = { p: '%', r: 'rem', e: 'em' }[p[2]] || p[2];
        return Number(p[1]) === 0 || UNITLESS.has(prop) ? p[1] : p[1] + (unit || 'px');
      });
      return `${prop}: ${vals.join(' ')};`;
    }
    m = /^(c|bg|bgc|bdc)#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(a);
    if (m) return `${{ c: 'color', bg: 'background', bgc: 'background-color', bdc: 'border-color' }[m[1].toLowerCase()]}: #${m[2]};`;
    return null;
  }

  // ================= Qayerda turibmiz? =================
  function segment(text, pos, mode) {
    if (mode !== 'auto' && mode !== 'html') return { mode, before: text.slice(0, pos) };
    const before = text.slice(0, pos);
    const low = before.toLowerCase();
    for (const [tag, m] of [['style', 'css'], ['script', 'js']]) {
      const re = new RegExp(`<${tag}(?:\\s[^>]*)?>`, 'g');
      let end = -1;
      while (re.exec(low)) end = re.lastIndex;
      if (end >= 0 && low.lastIndexOf(`</${tag}`) < end) return { mode: m, before: before.slice(end) };
    }
    if (mode === 'auto' && !text.includes('<') && /\{/.test(before)) return { mode: 'css', before }; // faqat CSS yozilgan
    const lt = before.lastIndexOf('<');
    if (lt >= 0 && /^<\/?[a-z]?/i.test(before.slice(lt)) && !tagClosed(before.slice(lt))) return { mode: 'tag', before: before.slice(lt) };
    return { mode: 'html', before };
  }
  function tagClosed(s) { // <a href="..."> yopilganmi (qo'shtirnoq ichidagi > hisobmas)
    let q = null;
    for (const ch of s) {
      if (q) { if (ch === q) q = null; } else if (ch === '"' || ch === "'") q = ch;
      else if (ch === '>') return true;
    }
    return false;
  }
  function openTag(before) { // hali yopilmagan eng ichki teg
    const st = [];
    const re = /<!--[\s\S]*?-->|<(\/?)([a-z][\w-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/gi;
    let m;
    while ((m = re.exec(before))) {
      if (!m[2]) continue;
      const t = m[2].toLowerCase();
      if (m[1]) { const k = st.lastIndexOf(t); if (k >= 0) st.length = k; } else if (!VOID.has(t) && !/\/$/.test(m[3])) st.push(t);
    }
    return st[st.length - 1] || '';
  }
  function cssPlace(s) { // { in: 'prop' | 'value' | 'sel', word, prop }
    const clean = s.replace(/\/\*[\s\S]*?\*\//g, '');
    if (/\/\*[^*]*$/.test(clean)) return null;
    const st = [];
    let last = 0;
    for (let i = 0; i < clean.length; i += 1) {
      const ch = clean[i];
      if (ch === '{') { st.push(clean.slice(last, i).trim()); last = i + 1; } else if (ch === '}') { st.pop(); last = i + 1; } else if (ch === ';') last = i + 1;
    }
    const part = clean.slice(last);
    const inner = st[st.length - 1];
    if (inner === undefined || /^@(media|supports|keyframes|layer|container)/.test(inner)) return { in: 'sel', word: /[^\s,>+~{}]*$/.exec(part)[0] };
    return declPlace(part);
  }
  function declPlace(part) {
    const c = part.indexOf(':');
    if (c < 0) return { in: 'prop', word: /[\w#.%-]*$/.exec(part)[0] };
    return { in: 'value', prop: part.slice(0, c).trim(), word: /[^\s,(]*$/.exec(part.slice(c + 1))[0] };
  }
  function jsPlace(s) { // satrdagi qo'shtirnoq/izoh holati
    let q = null;
    let qAt = -1;
    for (let i = 0; i < s.length; i += 1) {
      const ch = s[i];
      if (q) {
        if (ch === '\\') i += 1;
        else if (ch === q) q = null;
        else if (ch === '\n' && q !== '`') q = null;
      } else if (ch === '"' || ch === "'" || ch === '`') { q = ch; qAt = i; } else if (ch === '/' && s[i + 1] === '/') {
        const nl = s.indexOf('\n', i);
        if (nl < 0) return { comment: true };
        i = nl;
      } else if (ch === '/' && s[i + 1] === '*') {
        const e = s.indexOf('*/', i + 2);
        if (e < 0) return { comment: true };
        i = e + 1;
      }
    }
    return { quote: q, head: q ? s.slice(0, qAt) : s, inStr: q ? s.slice(qAt + 1) : '' };
  }
  function names(all) { // koddagi class va id'lar
    const cls = new Set();
    const ids = new Set();
    let m;
    const a = /\bclass\s*=\s*["']([^"']*)["']/gi;
    while ((m = a.exec(all))) words(m[1] || 'x').forEach((c) => c && m[1].trim() && cls.add(c));
    const b = /\bid\s*=\s*["']([\w-]+)["']/gi;
    while ((m = b.exec(all))) ids.add(m[1]);
    const c = /\.([a-z_][\w-]*)\s*(?=[{,:])/gi;
    while ((m = c.exec(all))) cls.add(m[1]);
    return { cls: [...cls], ids: [...ids] };
  }

  // ================= Takliflar =================
  // item: { label, insert, kind, detail, cut } — cut: kursordan oldin o'chiriladigan belgilar soni
  function rank(list, word, label = (x) => x) {
    const w = word.toLowerCase();
    const a = [];
    const b = [];
    list.forEach((x) => {
      const l = label(x).toLowerCase();
      if (l.startsWith(w)) a.push(x);
      else if (w.length > 1 && subseq(w, l)) b.push(x);
    });
    return a.concat(b);
  }
  function subseq(w, l) { // bgc -> background-color
    if (l[0] !== w[0]) return false;
    let k = 0;
    for (const ch of l) if (ch === w[k]) k += 1;
    return k === w.length;
  }
  function suggest(text, pos, mode, peers, force) {
    const seg = segment(text, pos, mode);
    const all = `${text}\n${peers}`;
    if (seg.mode === 'css') return cssItems(seg.before, all, force);
    if (seg.mode === 'js') return jsItems(seg.before, all, text, pos, force);
    if (seg.mode === 'tag') return tagItems(seg.before, text.slice(0, pos - seg.before.length), all, force);
    const abbr = abbrBefore(seg.before);
    if (!abbr) return [];
    const parent = openTag(seg.before);
    const items = [];
    if (/^[a-z][a-z0-9]*(:[a-z]*)?\+?$|^!$/i.test(abbr)) {
      const w = abbr.toLowerCase();
      const keys = [...new Set([...TAGS, ...Object.keys(ALIAS), ...Object.keys(EXPAND), 'html:5'])].filter((k) => k.startsWith(w)).sort();
      if (w === '!') keys.push('!');
      const at = keys.indexOf(w);
      if (at > 0) keys.unshift(...keys.splice(at, 1));
      keys.slice(0, 40).forEach((k) => {
        const ins = emmet(k, parent);
        if (ins !== null) items.push({ label: k, insert: ins, kind: 'tag', detail: k === '!' || k === 'html:5' ? 'tayyor sahifa' : DESC[k] || (ALIAS[k] && ALIAS[k][0] !== k ? `<${ALIAS[k][0]}>` : ''), cut: abbr.length });
      });
    } else if (/[a-z0-9)\]}]$/i.test(abbr)) {
      const ins = emmet(abbr, parent);
      if (ins !== null && !/^[.#]?\d/.test(abbr)) items.push({ label: abbr, insert: ins, kind: 'tag', detail: 'Emmet', cut: abbr.length });
    }
    return items;
  }
  function tagItems(s, beforeTag, all, force) {
    let m = /^<\/([\w-]*)$/.exec(s);
    if (m) {
      const t = openTag(beforeTag);
      return t && t.startsWith(m[1].toLowerCase()) ? [{ label: `/${t}`, insert: `${t}>`, kind: 'tag', detail: 'yopish', cut: m[1].length }] : [];
    }
    m = /^<([a-z][\w-]*|)$/i.exec(s);
    if (m) {
      if (!m[1] && !force) return [];
      return TAGS.filter((t) => t.startsWith(m[1].toLowerCase())).slice(0, 40).map((t) => ({ label: t, insert: emmet(t, '').slice(1), kind: 'tag', detail: DESC[t] || '', cut: m[1].length }));
    }
    const tag = (/^<([a-z][\w-]*)/i.exec(s) || [])[1];
    if (!tag) return [];
    m = /([\w-]+)\s*=\s*(["'])([^"']*)$/.exec(s);
    if (m && !s.slice(0, s.length - m[0].length).match(/=\s*["'][^"']*$/)) {
      const [, name, , val] = m;
      const w = /[^\s]*$/.exec(val)[0];
      if (name === 'style') return declItems(declPlace(val.slice(val.lastIndexOf(';') + 1)), force);
      if (name === 'onclick') return [];
      const n = names(all);
      const list = name === 'class' ? n.cls : name === 'for' || name === 'id' ? n.ids : name === 'href' ? n.ids.map((x) => `#${x}`) : words(ATTR_VALUES[name] || '').filter(Boolean);
      return list.filter((v) => v.startsWith(w) && v !== w).slice(0, 30).map((v) => ({ label: v, insert: v, kind: 'value', detail: name, cut: w.length }));
    }
    m = /\s([\w-]*)$/.exec(s);
    if (!m || (!m[1] && !force)) return [];
    const list = [...words(TAG_ATTRS[tag.toLowerCase()] || ''), ...ATTRS].filter((a, k, arr) => a && arr.indexOf(a) === k);
    return list.filter((a) => a.startsWith(m[1].toLowerCase())).map((a) => ({ label: a, insert: FLAGS.has(a) || a.endsWith('-') ? a : `${a}="${STOP}"`, kind: 'prop', detail: 'atribut', cut: m[1].length, again: !FLAGS.has(a) }));
  }
  function declItems(p, force) {
    if (!p) return [];
    if (p.in === 'prop') {
      const w = p.word.toLowerCase();
      if (!w && !force) return [];
      const out = [];
      const ab = cssAbbr(w);
      if (ab) out.push({ label: ab.split(STOP).join(''), insert: ab, kind: 'tag', detail: w, cut: w.length });
      const short = CSS_SHORT[w];
      const list = rank(PROPS, w);
      if (short) { const k = list.indexOf(short); if (k >= 0) list.splice(k, 1); list.unshift(short); }
      list.slice(0, 30).forEach((x) => out.push({ label: x, insert: `${x}: ${STOP};`, kind: 'prop', detail: '', cut: w.length, again: true }));
      return out;
    }
    const vals = [];
    words(CSS[p.prop] || '').filter(Boolean).forEach((v) => { if (v === '@') vals.push(...COLORS); else vals.push(v.replace(/ /g, ' ')); });
    if (!vals.length) return [];
    const w = p.word.toLowerCase();
    if (!force && !w && vals.length === 0) return [];
    return vals.filter((v) => v.toLowerCase().startsWith(w) && v !== w).slice(0, 40)
      .map((v) => ({ label: v, insert: v.replace('()', `(${STOP})`), kind: COLORS.includes(v) ? 'color' : 'value', detail: '', cut: w.length }));
  }
  function cssItems(s, all, force) {
    const p = cssPlace(s);
    if (!p) return [];
    if (p.in !== 'sel') return declItems(p, force);
    const w = p.word;
    if (!w && !force) return [];
    const n = names(all);
    const colon = w.lastIndexOf(':');
    if (colon >= 0) {
      const c = w.slice(w[colon - 1] === ':' ? colon - 1 : colon);
      return PSEUDO.filter((x) => x.startsWith(c)).map((x) => ({ label: x, insert: x.replace('()', `(${STOP})`), kind: 'value', detail: 'holat', cut: c.length }));
    }
    if (w[0] === '@') return Object.keys(AT).filter((x) => x.startsWith(w)).map((x) => ({ label: x, insert: AT[x], kind: 'tag', detail: '', cut: w.length }));
    const dot = Math.max(w.lastIndexOf('.'), w.lastIndexOf('#'));
    const part = dot >= 0 ? w.slice(dot) : w;
    const pool = part[0] === '.' ? n.cls.map((x) => `.${x}`) : part[0] === '#' ? n.ids.map((x) => `#${x}`) : [...TAGS, ...n.cls.map((x) => `.${x}`), ...n.ids.map((x) => `#${x}`)];
    return pool.filter((x) => x.startsWith(part) && (x !== part || !/[.#]/.test(part))).slice(0, 30).map((x) => ({ label: x, insert: `${x} {\n\t${STOP}\n}`, kind: /^[.#]/.test(x) ? 'word' : 'tag', detail: DESC[x] || (x[0] === '.' ? 'class' : x[0] === '#' ? 'id' : ''), cut: part.length }));
  }
  function jsItems(s, all, text, pos, force) {
    const p = jsPlace(s);
    if (p.comment) return [];
    if (p.quote) {
      const w = p.inStr;
      const fnName = (/(\w+)\($/.exec(p.head.trimEnd()) || [])[1];
      const n = names(all);
      let pool = [];
      if (fnName === 'addEventListener' || fnName === 'removeEventListener') pool = EVENTS;
      else if (fnName === 'getElementById') pool = n.ids;
      else if (/^querySelector(All)?$|^closest$/.test(fnName || '')) pool = [...n.ids.map((x) => `#${x}`), ...n.cls.map((x) => `.${x}`), ...TAGS];
      else if (fnName === 'createElement') pool = TAGS;
      else if (/^(add|remove|toggle|contains|getElementsByClassName)$/.test(fnName || '')) pool = n.cls;
      return pool.filter((x) => x.startsWith(w) && x !== w).slice(0, 30).map((x) => ({ label: x, insert: x, kind: 'value', detail: '', cut: w.length }));
    }
    const mem = /(?:([\w$]+)|[)\]"'`])\s*\??\.([\w$]*)$/.exec(s);
    if (mem) {
      if (mem[1] && /^\d+$/.test(mem[1])) return [];
      let pool = MEMBERS[mem[1]];
      if (mem[1] === 'style') pool = Object.fromEntries(PROPS.map((x) => [camel(x), `${camel(x)} = '${STOP}'`]));
      pool = pool || ANY;
      return rank(Object.keys(pool), mem[2]).slice(0, 40).map((k) => ({ label: k, insert: pool[k] || k, kind: pool[k] && /\(/.test(pool[k]) ? 'fn' : 'prop', detail: '', cut: mem[2].length, again: /\('\u0001/.test(pool[k] || '') }));
    }
    const w = /[\w$]*$/.exec(s)[0];
    if ((!w && !force) || /^\d/.test(w)) return [];
    const out = [];
    JS_KEYS.concat(JS_GLOBALS).forEach((k) => { if (k.toLowerCase().startsWith(w.toLowerCase()) && k !== w) out.push({ label: k, insert: k, kind: JS_KEYS.includes(k) ? 'key' : 'prop', detail: '', cut: w.length }); });
    rank(Object.keys(JS_SNIP), w).forEach((k) => { if (k.toLowerCase().startsWith(w.toLowerCase()) && !JS_KEYS.includes(k)) out.push({ label: k, insert: JS_SNIP[k][0], kind: 'tag', detail: JS_SNIP[k][1], cut: w.length }); });
    const own = new Set();
    const rest = `${text.slice(0, pos - w.length)} ${text.slice(pos)}`;
    (rest.match(/[A-Za-z_$][\w$]{2,}/g) || []).forEach((x) => { if (x.startsWith(w) && x !== w && !TAG_SET.has(x)) own.add(x); });
    [...own].slice(0, 12).forEach((x) => { if (!out.some((o) => o.label === x)) out.push({ label: x, insert: x, kind: 'word', detail: 'sizniki', cut: w.length }); });
    const ex = out.findIndex((o) => o.label === w);
    if (ex > 0) out.unshift(...out.splice(ex, 1));
    return out.slice(0, 40);
  }

  // ================= Ro'yxat oynasi =================
  const ICONS = {
    tag: '<path d="M10.5 2.2a3.6 3.6 0 0 0-4.6 4.6L2 10.7a1.4 1.4 0 0 0 2 2l3.9-3.9a3.6 3.6 0 0 0 4.6-4.6L10.4 6.300 8.700 4.600z"/>',
    prop: '<rect x="2.500" y="5" width="11" height="6" rx="1"/><path d="M5 8h6"/>', fn: '<path d="M8 1.800 13.500 5v6L8 14.200 2.500 11V5z M2.500 5 8 8l5.500-3 M8 8v6.200"/>',
    value: '<path d="M3 4h10M3 8h10M3 12h6"/>', key: '<path d="M2.500 5h11v6h-11z M5 8h1 M8 8h3"/>', word: '<path d="M2 11 4.500 5 7 11 M3 9h3 M9 5v6 M9 8.500a2 2 0 1 1 0 1"/>',
  };
  let box = null;
  let live = null; // { t, items, at, opts }
  let watch = null;
  function makeBox() {
    box = document.createElement('div');
    box.className = 'codehelp';
    box.id = 'codehelp-list';
    box.setAttribute('role', 'listbox');
    box.setAttribute('data-no-translate', '');
    box.hidden = true;
    box.addEventListener('pointerdown', (e) => { // maydon fokusi yo'qolmasin
      e.preventDefault();
      const row = e.target.closest('.codehelp__row');
      if (row && e.button === 0) row.dataset.down = '1';
    });
    box.addEventListener('click', (e) => {
      const row = e.target.closest('.codehelp__row');
      if (row && live) { live.at = Number(row.dataset.i); accept(); }
    });
    document.body.append(box);
    window.addEventListener('scroll', (e) => { if (live && e.target !== box && !(e.target.nodeType === 1 && box.contains(e.target))) place(); }, true);
    window.addEventListener('resize', hide);
  }
  function hide() {
    if (!live) return;
    live.t.removeAttribute('aria-activedescendant');
    live = null;
    box.hidden = true;
    clearInterval(watch);
  }
  function show(t, items, opts) {
    if (!box) makeBox();
    live = { t, items, at: 0, opts };
    box.replaceChildren(...items.map((it, i) => {
      const row = document.createElement('div');
      row.className = 'codehelp__row';
      row.id = `codehelp-${i}`;
      row.dataset.i = i;
      row.setAttribute('role', 'option');
      const ic = document.createElement('span');
      ic.className = `codehelp__icon codehelp__icon--${it.kind}`;
      if (it.kind === 'color') ic.style.background = it.label;
      else ic.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true">${ICONS[it.kind] || ICONS.word}</svg>`;
      const name = document.createElement('span');
      name.className = 'codehelp__name';
      const cutN = it.cut;
      const typed = t.value.slice(t.selectionStart - cutN, t.selectionStart);
      if (typed && it.label.toLowerCase().startsWith(typed.toLowerCase())) {
        const b = document.createElement('b');
        b.textContent = it.label.slice(0, cutN);
        name.append(b, it.label.slice(cutN));
      } else name.textContent = it.label;
      const d = document.createElement('span');
      d.className = 'codehelp__detail';
      d.textContent = it.detail || '';
      row.append(ic, name, d);
      return row;
    }));
    box.hidden = false;
    box.scrollTop = 0;
    mark();
    place();
    clearInterval(watch);
    watch = setInterval(() => { if (!live || !live.t.isConnected || document.activeElement !== live.t) hide(); }, 250);
  }
  function mark() {
    [...box.children].forEach((r, i) => {
      r.classList.toggle('is-on', i === live.at);
      r.setAttribute('aria-selected', String(i === live.at));
    });
    const on = box.children[live.at];
    live.t.setAttribute('aria-activedescendant', on.id);
    if (on.offsetTop < box.scrollTop) box.scrollTop = on.offsetTop;
    else if (on.offsetTop + on.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = on.offsetTop + on.offsetHeight - box.clientHeight;
  }
  function caretXY(t, pos) {
    const cs = getComputedStyle(t);
    const m = document.createElement('div');
    ['boxSizing', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
      'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'tabSize', 'textIndent'].forEach((k) => { m.style[k] = cs[k]; });
    Object.assign(m.style, { position: 'fixed', top: '0', left: '-9999px', visibility: 'hidden', whiteSpace: 'pre-wrap', overflowWrap: 'break-word', borderStyle: 'solid', width: `${t.clientWidth + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth)}px` });
    m.textContent = t.value.slice(0, pos);
    const s = document.createElement('span');
    s.textContent = t.value.slice(pos, pos + 1) || '.';
    m.append(s);
    document.body.append(m);
    const r = t.getBoundingClientRect();
    const out = { x: r.left + s.offsetLeft - t.scrollLeft, y: r.top + s.offsetTop - t.scrollTop, h: parseFloat(cs.lineHeight) || 20, r };
    m.remove();
    return out;
  }
  function place() {
    if (!live) return;
    const { t } = live;
    const c = caretXY(t, t.selectionStart - live.items[0].cut);
    if (c.y + c.h < c.r.top - 4 || c.y > c.r.bottom + 4) { hide(); return; }
    const w = box.offsetWidth;
    const h = box.offsetHeight;
    const below = c.y + c.h + 4;
    const top = below + h > window.innerHeight - 6 && c.y - h - 4 > 6 ? c.y - h - 4 : below;
    box.style.left = `${Math.max(6, Math.min(c.x - 26, window.innerWidth - w - 6))}px`;
    box.style.top = `${Math.max(6, Math.min(top, window.innerHeight - h - 6))}px`;
  }

  // ================= Matnga yozish =================
  let busy = false;
  function put(t, from, to, text) {
    if (from === to && !text) return;
    t.focus();
    t.setSelectionRange(from, to);
    let ok = false;
    busy = true;
    try { ok = text ? document.execCommand('insertText', false, text) : document.execCommand('delete'); } catch (e) { ok = false; } // Ctrl+Z ishlashi uchun
    if (!ok) {
      t.setRangeText(text, from, to, 'end');
      t.dispatchEvent(new Event('input', { bubbles: true }));
    }
    busy = false;
  }
  const indentOf = (t, pos) => /^[ \t]*/.exec(t.value.slice(t.value.lastIndexOf('\n', pos - 1) + 1, pos))[0];
  function snippet(t, st, from, to, src) {
    const ind = indentOf(t, from);
    const text = src.replace(/\t/g, '  ').replace(/\n/g, `\n${ind}`);
    const parts = text.split(STOP);
    const plain = parts.join('');
    put(t, from, to, plain);
    if (parts.length < 2) { st.stops = []; return; }
    const stops = [];
    let at = from;
    parts.slice(0, -1).forEach((p) => { at += p.length; stops.push(at); });
    const end = from + plain.length;
    if (stops[stops.length - 1] !== end) stops.push(end);
    // kursordan keyingi joylar oxiridan hisoblanadi — oldinda yozilsa ham siljimaydi
    st.stops = stops.slice(1).map((s) => t.value.length - s);
    const word = /^[\w.]+/.exec(t.value.slice(stops[0], end)); // tayyor qiymat bo'lsa — belgilab qo'yiladi
    const isDefault = word && /[\s(>'"]/.test(t.value[stops[0] - 1] || ' ');
    t.setSelectionRange(stops[0], isDefault ? stops[0] + word[0].length : stops[0]);
  }
  function accept() {
    const { t, items, at, opts } = live;
    const it = items[at];
    const st = opts.state;
    hide();
    const pos = t.selectionStart;
    let ins = it.insert;
    const next = t.value.slice(pos);
    if (it.kind === 'prop' && ins.endsWith(`: ${STOP};`) && /^\s*:/.test(next)) ins = it.label;
    if (ins.endsWith(';') && next[0] === ';') ins = ins.slice(0, -1);
    if (/^[\w-]+>$/.test(ins) && next[0] === '>') ins = ins.slice(0, -1);
    if (/^[\w-]+[^<]*>\u0001?<\/|^[\w-]+[^<]*>$/.test(ins) && next[0] === '>' && it.kind === 'tag') ins = it.label; // <sec|>
    snippet(t, st, pos - it.cut, pos, ins);
    if (it.again) opts.refresh(true);
  }

  const PAIRS = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '`': '`' };
  function attach(t, opts = {}) {
    if (!t || t.dataset.codehelp) return;
    t.dataset.codehelp = '1';
    t.spellcheck = false;
    t.setAttribute('autocapitalize', 'off');
    t.setAttribute('autocomplete', 'off');
    t.setAttribute('autocorrect', 'off');
    t.setAttribute('aria-autocomplete', 'list');
    t.setAttribute('aria-controls', 'codehelp-list');
    const mode = opts.mode || 'auto';
    const peers = opts.peers || (() => '');
    const state = { stops: [], freeTab: false };
    const ctx = () => segment(t.value, t.selectionStart, mode).mode;
    const refresh = (force) => {
      if (t.selectionStart !== t.selectionEnd && !force) { hide(); return; }
      const items = suggest(t.value, t.selectionEnd, mode, peers(), force);
      if (!items.length || t.selectionStart !== t.selectionEnd) { hide(); return; }
      show(t, items, { state, refresh });
    };
    t.addEventListener('input', (e) => {
      if (busy) return;
      if (e.inputType && /^(insertFromPaste|insertFromDrop|history)/.test(e.inputType)) { hide(); return; }
      refresh(false);
    });
    t.addEventListener('blur', hide);
    t.addEventListener('pointerdown', () => { hide(); state.stops = []; });

    // Juft belgilar va teglarni o'zi yopish
    t.addEventListener('beforeinput', (e) => {
      if (busy || e.isComposing) return;
      const a = t.selectionStart;
      const b = t.selectionEnd;
      const v = t.value;
      if (e.inputType === 'deleteContentBackward' && a === b && a > 0 && PAIRS[v[a - 1]] && PAIRS[v[a - 1]] === v[a] && ctx() !== 'html') {
        e.preventDefault();
        put(t, a - 1, a + 1, '');
        refresh(false);
        return;
      }
      if (e.inputType !== 'insertText' || !e.data || e.data.length !== 1) return;
      const ch = e.data;
      const m = ctx();
      if (a === b && (ch === v[a]) && /[)\]}"'`]/.test(ch) && m !== 'html') { // yopuvchisi turibdi — ustidan o'tamiz
        e.preventDefault();
        t.setSelectionRange(a + 1, a + 1);
        hide();
        return;
      }
      if (ch === '>' && m === 'tag' && a === b) {
        const seg = segment(v, a, mode).before;
        const tag = /^<([a-z][\w-]*)/i.exec(seg);
        if (tag && !VOID.has(tag[1].toLowerCase()) && !/\/$/.test(seg) && !/=\s*["'][^"']*$/.test(seg)) {
          e.preventDefault();
          const close = `</${tag[1]}>`;
          put(t, a, a, v.startsWith(close, a) ? '>' : `>${close}`);
          t.setSelectionRange(a + 1, a + 1);
          hide();
        }
        return;
      }
      if (ch === '/' && v[a - 1] === '<' && (m === 'tag' || m === 'html') && a === b) {
        const tag = openTag(v.slice(0, a - 1));
        if (tag) {
          e.preventDefault();
          const close = `</${tag}>`;
          if (v.startsWith(close, a)) { // yopuvchisi allaqachon turibdi — ustidan o'tamiz
            put(t, a - 1, a, '');
            t.setSelectionRange(a - 1 + close.length, a - 1 + close.length);
          } else put(t, a, a, `/${tag}>`);
          hide();
        }
        return;
      }
      const isQuote = /["'`]/.test(ch);
      if (PAIRS[ch] && (m === 'js' || m === 'css' || (m === 'tag' && ch === '"'))) {
        if (a !== b) {
          e.preventDefault();
          const sel = v.slice(a, b);
          put(t, a, b, ch + sel + PAIRS[ch]);
          t.setSelectionRange(a + 1, a + 1 + sel.length);
          return;
        }
        const nextOk = a >= v.length || /[\s)\]}>;,:<]/.test(v[a]);
        if (nextOk && !(isQuote && /[\w"'`]/.test(v[a - 1] || '')) && !(m === 'js' && jsPlace(segment(v, a, mode).before).quote)) {
          e.preventDefault();
          put(t, a, a, ch + PAIRS[ch]);
          t.setSelectionRange(a + 1, a + 1);
          refresh(false);
        }
      }
    });

    t.addEventListener('keydown', (e) => {
      if (e.isComposing) return;
      const open = live && live.t === t;
      const stop = () => { e.preventDefault(); e.stopPropagation(); };
      if (open) {
        const n = live.items.length;
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { stop(); live.at = (live.at + (e.key === 'ArrowDown' ? 1 : n - 1)) % n; mark(); return; }
        if ((e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.shiftKey) || (e.key === 'Tab' && !e.shiftKey)) { stop(); accept(); return; }
        if (e.key === 'Escape') { stop(); hide(); return; }
        if (/^(ArrowLeft|ArrowRight|Home|End|PageUp|PageDown)$/.test(e.key)) hide();
      }
      if ((e.ctrlKey || e.metaKey) && e.code === 'Space') { stop(); refresh(true); return; }
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && opts.onRun) { stop(); hide(); opts.onRun(); return; }
      const a = t.selectionStart;
      const b = t.selectionEnd;
      const v = t.value;
      if ((e.ctrlKey || e.metaKey) && (e.key === '/' || e.code === 'Slash')) { stop(); comment(); return; }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'Escape') { state.stops = []; state.freeTab = true; return; } // Esc, keyin Tab — maydondan chiqish
      if (e.key === 'Tab') {
        if (state.freeTab) { state.freeTab = false; return; }
        stop();
        if (a !== b && v.slice(a, b).includes('\n')) { shift(e.shiftKey); return; }
        if (e.shiftKey) { shift(true); return; }
        while (state.stops.length) {
          const to = t.value.length - state.stops.shift();
          if (to > b) { t.setSelectionRange(to, to); return; }
        }
        if (a === b) {
          const seg = segment(v, a, mode);
          let src = null;
          let cut = 0;
          if (seg.mode === 'html') { const ab = abbrBefore(seg.before); src = ab && emmet(ab, openTag(seg.before)); cut = ab.length; } else if (seg.mode === 'css') {
            const p = cssPlace(seg.before);
            if (p && p.in === 'prop') { src = cssAbbr(p.word); cut = p.word.length; }
          }
          if (src) { snippet(t, state, a - cut, a, src); return; }
        }
        put(t, a, b, '  ');
        return;
      }
      state.freeTab = false;
      if (e.key === 'Enter' && !e.shiftKey) {
        stop();
        hide();
        const ind = indentOf(t, a);
        const p = v[a - 1];
        const nx = v[b];
        if ((p === '{' && nx === '}') || (p === '[' && nx === ']') || (p === '(' && nx === ')') || (p === '>' && v.startsWith('</', b) && ctx() === 'html')) {
          put(t, a, b, `\n${ind}  \n${ind}`);
          const to = a + 1 + ind.length + 2;
          t.setSelectionRange(to, to);
        } else {
          const tag = p === '>' && ctx() === 'html' && /<([a-z][\w-]*)[^<>]*>$/i.exec(v.slice(0, a));
          const deeper = /[{[(]/.test(p || '') || (tag && !VOID.has(tag[1].toLowerCase()));
          put(t, a, b, `\n${ind}${deeper ? '  ' : ''}`);
        }
      }
    });

    function lines() {
      const a = t.selectionStart;
      const b = t.selectionEnd;
      const from = t.value.lastIndexOf('\n', a - 1) + 1;
      let to = t.value.indexOf('\n', b > a && t.value[b - 1] === '\n' ? b - 1 : b);
      if (to < 0) to = t.value.length;
      return { from, to, text: t.value.slice(from, to) };
    }
    function replaceLines(l, text) {
      const a = t.selectionStart;
      const one = a === t.selectionEnd;
      if (text === l.text) return;
      put(t, l.from, l.to, text);
      if (one) { const p = Math.max(l.from, a + text.length - l.text.length); t.setSelectionRange(p, p); } else t.setSelectionRange(l.from, l.from + text.length);
    }
    function shift(back) {
      const l = lines();
      replaceLines(l, l.text.split('\n').map((x) => (back ? x.replace(/^( {1,2}|\t)/, '') : `  ${x}`)).join('\n'));
    }
    function comment() {
      hide();
      const l = lines();
      const m = ctx();
      let out;
      if (m === 'js') {
        const on = l.text.split('\n').every((x) => !x.trim() || /^\s*\/\//.test(x));
        out = l.text.split('\n').map((x) => (on ? x.replace(/^(\s*)\/\/ ?/, '$1') : x.trim() ? x.replace(/^(\s*)/, '$1// ') : x)).join('\n');
      } else {
        const [o, c] = m === 'css' ? ['/*', '*/'] : ['<!--', '-->'];
        const body = l.text.trim();
        const pad = /^\s*/.exec(l.text)[0];
        out = body.startsWith(o) && body.endsWith(c) ? pad + body.slice(o.length, -c.length).trim() : `${pad}${o} ${body} ${c}`;
      }
      replaceLines(l, out);
    }
  }

  // ================= JavaScript ishga tushirgich =================
  // Skript alohida «sandbox» oynada ishlaydi: sayt ma'lumoti va akkauntga yeta olmaydi.
  function run(host, { html = '', css = '', js = '', modals = false } = {}) {
    const token = `c${Math.random().toString(36).slice(2)}`;
    const safe = (s, tag) => s.replace(new RegExp(`</(${tag})`, 'gi'), '<\\/$1');
    const bridge = `(()=>{const T=${JSON.stringify(token)};let n=0;const f=(x)=>{if(typeof x==='string')return x;if(x instanceof Error)return String(x);if(typeof x==='function')return String(x).slice(0,200);if(typeof Element!=='undefined'&&x instanceof Element)return x.outerHTML.slice(0,200);try{const s=JSON.stringify(x);return s===undefined?String(x):s}catch(e){return String(x)}};const p=(l,a)=>{if(++n>200)return;parent.postMessage({token:T,level:l,text:a.map(f).join(' ').slice(0,2000)},'*')};['log','info','warn','error','table'].forEach((k)=>{console[k]=(...a)=>p(k==='table'||k==='info'?'log':k,a)});addEventListener('error',(e)=>{if(e.message)p('error',[e.message])});addEventListener('unhandledrejection',(e)=>p('error',[e.reason]))})();`;
    const frame = document.createElement('iframe');
    frame.className = 'code-preview';
    frame.setAttribute('sandbox', modals ? 'allow-scripts allow-modals' : 'allow-scripts');
    frame.title = 'Natija';
    const cons = document.createElement('div');
    cons.className = 'code-console';
    cons.setAttribute('data-no-translate', '');
    const empty = document.createElement('small');
    empty.textContent = "Konsol — console.log va xatolar shu yerda chiqadi";
    cons.append(empty);
    if (host._codeRun) window.removeEventListener('message', host._codeRun);
    const onMsg = (e) => {
      if (!frame.isConnected) { window.removeEventListener('message', onMsg); return; }
      if (e.source !== frame.contentWindow || !e.data || e.data.token !== token) return;
      empty.remove();
      const row = document.createElement('div');
      row.className = `code-console__row code-console__row--${e.data.level === 'error' ? 'error' : e.data.level === 'warn' ? 'warn' : 'log'}`;
      row.textContent = String(e.data.text);
      cons.append(row);
      cons.scrollTop = cons.scrollHeight;
    };
    host._codeRun = onMsg;
    window.addEventListener('message', onMsg);
    frame.srcdoc = `<!doctype html><meta charset="utf-8"><script>${bridge}</script><style>body{font-family:system-ui,sans-serif;margin:12px}${safe(css, 'style')}</style>${html}${js ? `<script>\n${safe(js, 'script')}\n</script>` : ''}`;
    host.replaceChildren(frame, cons);
    return frame;
  }

  return { attach, run, hide, _test: { emmet, cssAbbr, suggest, abbrBefore, segment } };
})();

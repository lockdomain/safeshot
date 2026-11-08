// SafeShot detection rules. Pure functions, no DOM, so they are easy to test.
(function (root) {
  const CATS = {
    secret: 'API keys and tokens',
    email: 'Emails',
    phone: 'Phone numbers',
    ip: 'IP addresses',
    card: 'Card numbers',
  };

  // Known secret formats first, then generic high entropy strings.
  const SECRET_PATTERNS = [
    /\bsk-ant-[A-Za-z0-9_\-]{12,}/g,              // Anthropic
    /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_\-]{16,}/g, // OpenAI style
    /\b[sr]k_(?:live|test)_[A-Za-z0-9]{12,}/g,     // Stripe secret / restricted
    /\bpk_(?:live|test)_[A-Za-z0-9]{12,}/g,        // Stripe publishable (still noisy to share)
    /\bwhsec_[A-Za-z0-9]{16,}/g,                   // webhook secrets
    /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, // GitHub
    /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
    /\bglpat-[A-Za-z0-9_\-]{16,}/g,                // GitLab
    /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,              // AWS access key id
    /\bAIza[0-9A-Za-z_\-]{30,}/g,                  // Google API key
    /\bxox[abprs]-[A-Za-z0-9\-]{10,}/g,            // Slack
    /\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{6,}/g, // JWT
    /\bSG\.[A-Za-z0-9_\-]{16,}\.[A-Za-z0-9_\-]{16,}/g, // SendGrid
    /\b(?:re|rk)_[A-Za-z0-9]{20,}/g,               // Resend style
    /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s]+/g, // connection strings
  ];
  // KEY=value or key: value where the key name smells like a secret
  const ASSIGN = /\b([A-Za-z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|PWD|PRIVATE|CREDENTIAL|AUTH)[A-Za-z0-9_]*)\s*[:=]\s*["']?([^\s"']{6,})/gi;
  const EMAIL = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g;
  const PHONE = /(?:\+\d{1,3}[\s.\-]?)?(?:\(\d{2,4}\)[\s.\-]?|\d{2,4}[\s.\-])\d{2,4}[\s.\-]?\d{2,5}(?:[\s.\-]\d{2,4})?/g;
  const IPV4 = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;
  const CARD = /\b(?:\d{4}[\s\-]?){3}\d{4}\b/g;

  function entropy(s) {
    const f = {};
    for (const ch of s) f[ch] = (f[ch] || 0) + 1;
    let e = 0;
    for (const k in f) { const p = f[k] / s.length; e -= p * Math.log2(p); }
    return e;
  }
  function looksRandom(s) {
    if (s.length < 24) return false;
    if (/^[a-z]+$/i.test(s) || /^\d+$/.test(s)) return false;
    if (/^https?:/i.test(s) || s.includes('/')) return false;
    const hasDigit = /\d/.test(s), hasLetter = /[a-z]/i.test(s);
    return hasDigit && hasLetter && entropy(s) > 3.6;
  }
  function luhn(num) {
    const d = num.replace(/\D/g, '');
    if (d.length < 13) return false;
    let sum = 0, alt = false;
    for (let i = d.length - 1; i >= 0; i--) {
      let n = +d[i];
      if (alt) { n *= 2; if (n > 9) n -= 9; }
      sum += n; alt = !alt;
    }
    return sum % 10 === 0;
  }

  // Find matches in one line of text. Returns [{cat, start, end, text}]
  function scanText(text) {
    const out = [];
    const add = (cat, start, end) => {
      if (end <= start) return;
      if (out.some((m) => start < m.end && end > m.start)) return; // first rule wins
      out.push({ cat, start, end, text: text.slice(start, end) });
    };
    const run = (re, cat, filter) => {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text))) {
        if (!filter || filter(m[0])) add(cat, m.index, m.index + m[0].length);
        if (m[0].length === 0) re.lastIndex++;
      }
    };
    SECRET_PATTERNS.forEach((re) => run(re, 'secret'));
    ASSIGN.lastIndex = 0;
    let a;
    while ((a = ASSIGN.exec(text))) {
      const vStart = a.index + a[0].length - a[2].length;
      add('secret', vStart, vStart + a[2].length);
    }
    run(EMAIL, 'email');
    run(IPV4, 'ip');
    run(CARD, 'card', luhn);
    run(PHONE, 'phone', (s) => {
      const digits = s.replace(/\D/g, '');
      if (digits.length < 9 || digits.length > 15) return false;
      if (/^\s*(?:19|20)\d{2}[\-.\/]\d{1,2}[\-.\/]\d{1,2}/.test(s)) return false; // dates and timestamps
      return true;
    });
    // generic random looking tokens
    const tok = /[A-Za-z0-9_\-+/=]{24,}/g;
    run(tok, 'secret', looksRandom);
    return out;
  }

  // lines: [{ words: [{ text, bbox: {x0,y0,x1,y1} }] }]
  function detect(lines) {
    const hits = [];
    for (const line of lines) {
      const words = (line.words || []).filter((w) => w.text && w.text.trim());
      if (!words.length) continue;
      let text = '';
      const spans = words.map((w) => {
        const start = text.length;
        text += w.text;
        const span = { start, end: text.length, w };
        text += ' ';
        return span;
      });
      for (const m of scanText(text)) {
        const covered = spans.filter((s) => s.start < m.end && s.end > m.start);
        if (!covered.length) continue;
        // if the match starts mid word (KEY=value), shrink the box horizontally
        const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
        covered.forEach((s) => {
          let { x0, x1 } = s.w.bbox;
          const len = s.end - s.start;
          if (len > 0) {
            const cw = (x1 - x0) / len;
            const a = Math.max(m.start, s.start) - s.start;
            const b = Math.min(m.end, s.end) - s.start;
            x1 = x0 + cw * b; x0 = x0 + cw * a;
          }
          box.x0 = Math.min(box.x0, x0); box.x1 = Math.max(box.x1, x1);
          box.y0 = Math.min(box.y0, s.w.bbox.y0); box.y1 = Math.max(box.y1, s.w.bbox.y1);
        });
        if (m.cat === 'secret') {
          // Be generous with secrets: OCR often splits one long token into pieces
          // and misjudges character widths, so never leave a tail visible.
          const lastSpan = covered[covered.length - 1];
          box.x1 = Math.max(box.x1, lastSpan.w.bbox.x1);
          const firstSpan = covered[0];
          const cw0 = (firstSpan.w.bbox.x1 - firstSpan.w.bbox.x0) / Math.max(1, firstSpan.end - firstSpan.start);
          box.x0 = Math.max(firstSpan.w.bbox.x0, box.x0 - cw0 * 1.5);
          let idx = spans.indexOf(lastSpan);
          let prev = lastSpan.w.bbox;
          while (idx + 1 < spans.length) {
            const nx = spans[idx + 1].w;
            const h = prev.y1 - prev.y0;
            if (nx.bbox.x0 - prev.x1 > h * 0.9) break;
            if (!/^[A-Za-z0-9_\-+/=.]{2,}$/.test(nx.text)) break;
            box.x1 = Math.max(box.x1, nx.bbox.x1);
            box.y0 = Math.min(box.y0, nx.bbox.y0); box.y1 = Math.max(box.y1, nx.bbox.y1);
            prev = nx.bbox; idx++;
          }
        }
        hits.push({ cat: m.cat, text: m.text, bbox: box });
      }
    }
    return hits;
  }

  const api = { CATS, scanText, detect, entropy, luhn };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SafeShotDetect = api;
})(this);

"use strict";

/**
 * Self-contained syntax highlighter.
 *
 * Deliberately hand-rolled rather than vendoring highlight.js or Shiki: this app
 * runs on work machines, and keeping the dependency count at two NuGet packages
 * (Markdig, WebView2) with zero third-party JavaScript is worth more than the
 * extra language coverage. Covers the languages that actually show up in these
 * docs; anything else falls through to plain text.
 *
 * Unlabelled fences are NOT auto-detected. Directory trees, console output and
 * ASCII diagrams are common in agent-written docs, and guessing a language for
 * them produces confetti. No label means no highlighting.
 */

window.HL = (() => {

  // Rule regex sources must use non-capturing groups only -- the tokenizer maps
  // match groups back to rules positionally, so a stray capture shifts everything.
  const rules = {};

  const NUM = String.raw`\b(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)[uUlLfFdDmM]*\b`;

  /** A backtick cannot appear inside a template literal, so patterns build around this. */
  const BT = String.fromCharCode(96);

  rules.csharp = [
    { cls: "comment", re: String.raw`//[^\n]*|/\*[\s\S]*?\*/` },
    { cls: "string", re: String.raw`\$?@"(?:[^"]|"")*"|\$?"(?:[^"\\\n]|\\[\s\S])*"|'(?:[^'\\\n]|\\[\s\S])*'` },
    { cls: "meta", re: String.raw`^[ \t]*#(?:region|endregion|if|else|elif|endif|define|pragma|nullable)[^\n]*` },
    { cls: "keyword", re: String.raw`\b(?:abstract|as|async|await|base|break|case|catch|checked|class|const|continue|default|delegate|do|else|enum|event|explicit|extern|finally|fixed|for|foreach|get|global|goto|if|implicit|in|init|interface|internal|is|lock|namespace|new|operator|out|override|params|partial|private|protected|public|readonly|record|ref|required|return|sealed|set|sizeof|stackalloc|static|struct|switch|this|throw|try|typeof|unchecked|unsafe|using|value|virtual|volatile|when|where|while|with|yield)\b` },
    { cls: "literal", re: String.raw`\b(?:true|false|null|nameof|var|void)\b` },
    { cls: "type", re: String.raw`\b(?:bool|byte|char|decimal|double|dynamic|float|int|long|nint|nuint|object|sbyte|short|string|uint|ulong|ushort)\b|\b[A-Z][A-Za-z0-9_]*(?=\s*[<(\[]|\s+[a-zA-Z_])|\b[A-Z][A-Za-z0-9_]*\b` },
    { cls: "number", re: NUM }
  ];

  rules.xml = [
    { cls: "comment", re: String.raw`<!--[\s\S]*?-->` },
    { cls: "meta", re: String.raw`<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<!DOCTYPE[^>]*>` },
    { cls: "string", re: String.raw`"[^"]*"|'[^']*'` },
    { cls: "tag", re: String.raw`</?[A-Za-z_][\w.:-]*|/?>` },
    { cls: "attr", re: String.raw`[A-Za-z_][\w.:-]*(?=\s*=)` }
  ];

  rules.json = [
    { cls: "comment", re: String.raw`//[^\n]*|/\*[\s\S]*?\*/` },
    { cls: "attr", re: String.raw`"(?:[^"\\]|\\[\s\S])*"(?=\s*:)` },
    { cls: "string", re: String.raw`"(?:[^"\\]|\\[\s\S])*"` },
    { cls: "literal", re: String.raw`\b(?:true|false|null)\b` },
    { cls: "number", re: String.raw`-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b` }
  ];

  rules.sql = [
    { cls: "comment", re: String.raw`--[^\n]*|/\*[\s\S]*?\*/` },
    { cls: "string", re: String.raw`'(?:[^']|'')*'` },
    { cls: "keyword", re: String.raw`\b(?:ADD|ALL|ALTER|AND|ANY|AS|ASC|BEGIN|BETWEEN|BY|CASE|CAST|COMMIT|CONSTRAINT|CREATE|CROSS|DECLARE|DEFAULT|DELETE|DESC|DISTINCT|DROP|ELSE|END|EXEC|EXECUTE|EXISTS|FOREIGN|FROM|FULL|GROUP|HAVING|IF|IN|INDEX|INNER|INSERT|INTO|IS|JOIN|KEY|LEFT|LIKE|MERGE|NOT|NULL|ON|OR|ORDER|OUTER|PRIMARY|PROCEDURE|RIGHT|ROLLBACK|SELECT|SET|TABLE|THEN|TOP|TRANSACTION|TRUNCATE|UNION|UNIQUE|UPDATE|VALUES|VIEW|WHEN|WHERE|WITH)\b` },
    { cls: "type", re: String.raw`\b(?:BIGINT|BIT|CHAR|DATE|DATETIME|DATETIME2|DECIMAL|FLOAT|INT|MONEY|NCHAR|NVARCHAR|REAL|SMALLINT|TEXT|TIME|TINYINT|UNIQUEIDENTIFIER|VARBINARY|VARCHAR|XML)\b` },
    { cls: "variable", re: String.raw`@[\w@]+` },
    { cls: "number", re: String.raw`\b\d+(?:\.\d+)?\b` }
  ];

  rules.powershell = [
    { cls: "comment", re: String.raw`<#[\s\S]*?#>|#[^\n]*` },
    { cls: "string", re: String.raw`@"[\s\S]*?"@|@'[\s\S]*?'@|"(?:[^"` + "`" + String.raw`]|` + "`" + String.raw`[\s\S])*"|'(?:[^']|'')*'` },
    { cls: "keyword", re: String.raw`\b(?:begin|break|catch|continue|data|do|dynamicparam|else|elseif|end|exit|filter|finally|for|foreach|function|if|in|param|process|return|switch|throw|trap|try|until|while)\b` },
    { cls: "variable", re: String.raw`\$(?:[A-Za-z_][\w:]*|\{[^}]*\})` },
    { cls: "type", re: String.raw`\[[A-Za-z_][\w.\[\]]*\]` },
    { cls: "builtin", re: String.raw`\b[A-Z][a-z]+-[A-Z][A-Za-z]+\b` },
    { cls: "attr", re: String.raw`(?:^|\s)-[A-Za-z][\w-]*\b` },
    { cls: "number", re: NUM }
  ];

  rules.bash = [
    { cls: "comment", re: String.raw`#[^\n]*` },
    { cls: "string", re: String.raw`"(?:[^"\\]|\\[\s\S])*"|'[^']*'` },
    { cls: "variable", re: String.raw`\$(?:[A-Za-z_]\w*|\{[^}]*\}|[@*#?$!0-9-])` },
    { cls: "keyword", re: String.raw`\b(?:case|do|done|elif|else|esac|export|fi|for|function|if|in|local|return|select|set|then|until|while)\b` },
    { cls: "builtin", re: String.raw`\b(?:awk|cat|cd|chmod|cp|curl|cut|dotnet|echo|find|git|grep|head|ls|mkdir|mv|npm|rm|sed|sort|tail|touch|uniq|wc|wget|xargs)\b` },
    { cls: "attr", re: String.raw`(?:^|\s)--?[A-Za-z][\w-]*\b` },
    { cls: "number", re: String.raw`\b\d+\b` }
  ];

  rules.javascript = [
    { cls: "comment", re: String.raw`//[^\n]*|/\*[\s\S]*?\*/` },
    { cls: "string", re: "`(?:[^`\\\\]|\\\\[\\s\\S])*`" + String.raw`|"(?:[^"\\\n]|\\[\s\S])*"|'(?:[^'\\\n]|\\[\s\S])*'` },
    { cls: "keyword", re: String.raw`\b(?:as|async|await|break|case|catch|class|const|continue|debugger|default|delete|do|else|export|extends|finally|for|from|function|get|if|import|in|instanceof|interface|let|new|of|return|set|static|super|switch|this|throw|try|type|typeof|var|void|while|yield)\b` },
    { cls: "literal", re: String.raw`\b(?:true|false|null|undefined|NaN|Infinity)\b` },
    { cls: "type", re: String.raw`\b(?:any|boolean|number|string|unknown|never|Array|Promise|Map|Set|Record)\b|\b[A-Z][A-Za-z0-9_]*\b` },
    { cls: "number", re: NUM }
  ];

  rules.yaml = [
    { cls: "comment", re: String.raw`#[^\n]*` },
    { cls: "meta", re: String.raw`^---[^\n]*|^\.\.\.[^\n]*` },
    { cls: "attr", re: String.raw`^[ \t]*-?[ \t]*[A-Za-z_][\w.-]*(?=[ \t]*:)` },
    { cls: "string", re: String.raw`"(?:[^"\\]|\\[\s\S])*"|'(?:[^']|'')*'` },
    { cls: "literal", re: String.raw`\b(?:true|false|null|yes|no|on|off)\b` },
    { cls: "number", re: String.raw`\b\d+(?:\.\d+)?\b` }
  ];

  rules.ini = [
    { cls: "comment", re: String.raw`[#;][^\n]*` },
    { cls: "meta", re: String.raw`^[ \t]*\[[^\]\n]*\]` },
    { cls: "attr", re: String.raw`^[ \t]*[A-Za-z_][\w.-]*(?=[ \t]*=)` },
    { cls: "string", re: String.raw`"[^"\n]*"|'[^'\n]*'` }
  ];

  // Markdown, for the source editor. Order matters: fenced blocks and comments are
  // matched before anything inside them can be, and emphasis before list markers so a
  // leading "*" is not claimed by the wrong rule.
  rules.markdown = [
    // A fence contains backticks, so its pattern cannot be a template literal, and a
    // quoted string would eat the escapes. Concatenating around BT keeps both intact.
    { cls: "mdfence", re: "^" + BT + BT + BT + String.raw`[^\n]*\n[\s\S]*?^` + BT + BT + BT + String.raw`[^\n]*$`
                          + "|^~~~" + String.raw`[^\n]*\n[\s\S]*?^~~~[^\n]*$` },
    { cls: "comment", re: String.raw`<!--[\s\S]*?-->` },
    { cls: "mdheading", re: String.raw`^[ \t]{0,3}#{1,6}[ \t][^\n]*` },
    { cls: "mdrule", re: String.raw`^[ \t]{0,3}(?:-[ \t]*){3,}$|^[ \t]{0,3}(?:\*[ \t]*){3,}$|^[ \t]{0,3}(?:_[ \t]*){3,}$` },
    { cls: "mdquote", re: String.raw`^[ \t]{0,3}>[^\n]*` },
    { cls: "mdtable", re: String.raw`^[ \t]{0,3}\|[^\n]*\|[ \t]*$` },
    { cls: "mdcode", re: BT + BT + String.raw`[^` + BT + String.raw`\n]+` + BT + BT
                        + "|" + BT + String.raw`[^` + BT + String.raw`\n]+` + BT },
    { cls: "mdlink", re: String.raw`!?\[[^\]\n]*\]\([^)\n]*\)` },
    { cls: "mdrefLink", re: String.raw`!?\[[^\]\n]*\]\[[^\]\n]*\]` },
    { cls: "mdtask", re: String.raw`^[ \t]*(?:[-\*+]|\d+[.)])[ \t]+\[[ xX]\]` },
    { cls: "mdmarker", re: String.raw`^[ \t]*(?:[-\*+]|\d+[.)])[ \t]` },
    { cls: "mdbold", re: String.raw`\*\*(?:[^*\n]|\*(?!\*))+\*\*|__(?:[^_\n]|_(?!_))+__` },
    { cls: "mditalic", re: String.raw`\*(?!\*)[^*\n]+\*` },
    { cls: "mdautolink", re: String.raw`<https?://[^>\s]+>|https?://[^\s<>)\]]+` },
    { cls: "meta", re: String.raw`^---[ \t]*$` }
  ];

  rules.diff = [
    { cls: "meta", re: String.raw`^(?:@@[^\n]*|diff [^\n]*|index [^\n]*)` },
    { cls: "addition", re: String.raw`^\+[^\n]*` },
    { cls: "deletion", re: String.raw`^-[^\n]*` }
  ];

  const aliases = {
    cs: "csharp", "c#": "csharp", dotnet: "csharp",
    html: "xml", csproj: "xml", props: "xml", targets: "xml", config: "xml", xaml: "xml", svg: "xml",
    jsonc: "json",
    tsql: "sql", mssql: "sql", psql: "sql",
    ps: "powershell", ps1: "powershell", pwsh: "powershell",
    sh: "bash", shell: "bash", zsh: "bash", console: "bash", terminal: "bash",
    js: "javascript", jsx: "javascript", ts: "javascript", tsx: "javascript", typescript: "javascript", mjs: "javascript",
    yml: "yaml",
    toml: "ini", conf: "ini", properties: "ini", env: "ini",
    patch: "diff",
    // Deliberately absent from `rules`: a mermaid fence is replaced by a rendered
    // diagram, so highlighting its source would only ever be seen if that failed.
    mmd: "mermaid",
    md: "markdown", mkd: "markdown", markdown: "markdown"
  };

  const compiled = new Map();

  function compile(language) {
    if (compiled.has(language)) return compiled.get(language);
    const set = rules[language];
    if (!set) { compiled.set(language, null); return null; }
    const source = set.map(rule => "(" + rule.re + ")").join("|");
    const entry = { classes: set.map(r => r.cls), re: new RegExp(source, "gm") };
    compiled.set(language, entry);
    return entry;
  }

  function escapeHtml(text) {
    return text.replace(/[&<>]/g, c => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
  }

  function highlight(code, language) {
    const entry = compile(language);
    if (!entry) return escapeHtml(code);

    let out = "";
    let last = 0;
    let match;
    entry.re.lastIndex = 0;

    while ((match = entry.re.exec(code)) !== null) {
      if (match[0].length === 0) { entry.re.lastIndex++; continue; }

      let index = 1;
      while (index <= entry.classes.length && match[index] === undefined) index++;
      if (index > entry.classes.length) continue;

      out += escapeHtml(code.slice(last, match.index));
      out += '<span class="hl-' + entry.classes[index - 1] + '">' + escapeHtml(match[0]) + "</span>";
      last = match.index + match[0].length;
    }

    return out + escapeHtml(code.slice(last));
  }

  /** Reads the language off a Markdig-emitted `language-xxx` class. */
  function languageOf(codeElement) {
    for (const name of codeElement.classList) {
      if (!name.startsWith("language-")) continue;
      const raw = name.slice("language-".length).toLowerCase();
      return aliases[raw] || raw;
    }
    return null;
  }

  function highlightAll(root) {
    for (const code of root.querySelectorAll("pre > code")) {
      const language = languageOf(code);
      const pre = code.parentElement;

      if (!language || !rules[language]) {
        pre.dataset.lang = language || "";
        continue;
      }

      code.innerHTML = highlight(code.textContent || "", language);
      pre.dataset.lang = language;
    }
  }

  return { highlight, highlightAll, supported: Object.keys(rules) };
})();

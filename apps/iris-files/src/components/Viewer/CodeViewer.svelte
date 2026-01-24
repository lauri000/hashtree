<script lang="ts">
  import Prism from 'prismjs';
  // Import popular languages
  import 'prismjs/components/prism-markup';
  import 'prismjs/components/prism-css';
  import 'prismjs/components/prism-clike';
  import 'prismjs/components/prism-javascript';
  import 'prismjs/components/prism-typescript';
  import 'prismjs/components/prism-jsx';
  import 'prismjs/components/prism-tsx';
  import 'prismjs/components/prism-json';
  import 'prismjs/components/prism-markdown';
  import 'prismjs/components/prism-python';
  import 'prismjs/components/prism-rust';
  import 'prismjs/components/prism-go';
  import 'prismjs/components/prism-c';
  import 'prismjs/components/prism-cpp';
  import 'prismjs/components/prism-java';
  import 'prismjs/components/prism-bash';
  import 'prismjs/components/prism-sql';
  import 'prismjs/components/prism-yaml';
  import 'prismjs/components/prism-toml';
  import 'prismjs/components/prism-ini';
  import 'prismjs/components/prism-diff';
  import 'prismjs/components/prism-ruby';
  import 'prismjs/components/prism-markup-templating';
  import 'prismjs/components/prism-php';
  import 'prismjs/components/prism-swift';
  import 'prismjs/components/prism-kotlin';
  import 'prismjs/components/prism-scala';
  import 'prismjs/components/prism-docker';
  import 'prismjs/components/prism-nginx';

  interface Props {
    content: string;
    filename: string;
  }

  let { content, filename }: Props = $props();

  // Map file extensions to Prism language names
  const extToLang: Record<string, string> = {
    js: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    ts: 'typescript',
    mts: 'typescript',
    cts: 'typescript',
    jsx: 'jsx',
    tsx: 'tsx',
    json: 'json',
    md: 'markdown',
    py: 'python',
    rs: 'rust',
    go: 'go',
    c: 'c',
    h: 'c',
    cpp: 'cpp',
    cc: 'cpp',
    cxx: 'cpp',
    hpp: 'cpp',
    hxx: 'cpp',
    java: 'java',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    sql: 'sql',
    yaml: 'yaml',
    yml: 'yaml',
    toml: 'toml',
    ini: 'ini',
    cfg: 'ini',
    conf: 'ini',
    diff: 'diff',
    patch: 'diff',
    rb: 'ruby',
    php: 'php',
    swift: 'swift',
    kt: 'kotlin',
    kts: 'kotlin',
    scala: 'scala',
    html: 'markup',
    htm: 'markup',
    xml: 'markup',
    svg: 'markup',
    css: 'css',
    scss: 'css',
    sass: 'css',
    dockerfile: 'docker',
    svelte: 'markup',
    vue: 'markup',
  };

  function getLanguage(filename: string): string {
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    const base = filename.toLowerCase();

    // Handle special filenames
    if (base === 'dockerfile' || base.startsWith('dockerfile.')) return 'docker';
    if (base === 'nginx.conf' || base.endsWith('.nginx')) return 'nginx';
    if (base === 'makefile' || base === 'gnumakefile') return 'clike';

    return extToLang[ext] || 'clike'; // fallback to clike for basic highlighting
  }

  let language = $derived(getLanguage(filename));

  let highlightedHtml = $derived.by(() => {
    const grammar = Prism.languages[language];
    if (!grammar) {
      // Fallback: escape HTML and return plain
      return content
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    }
    return Prism.highlight(content, grammar, language);
  });
</script>

<pre class="code-viewer"><code class="language-{language}">{@html highlightedHtml}</code></pre>

<style>
  .code-viewer {
    margin: 0;
    padding: 0;
    font-size: 0.875rem;
    line-height: 1.5;
    font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--text-1, #f1f1f1);
    background: transparent;
  }

  .code-viewer code {
    font-family: inherit;
  }

  /* Dark theme - matches app colors */
  :global(.code-viewer .token.comment),
  :global(.code-viewer .token.prolog),
  :global(.code-viewer .token.doctype),
  :global(.code-viewer .token.cdata) {
    color: #6a737d;
  }

  :global(.code-viewer .token.punctuation) {
    color: #aab1bb;
  }

  :global(.code-viewer .token.property),
  :global(.code-viewer .token.tag),
  :global(.code-viewer .token.boolean),
  :global(.code-viewer .token.number),
  :global(.code-viewer .token.constant),
  :global(.code-viewer .token.symbol),
  :global(.code-viewer .token.deleted) {
    color: #f97583;
  }

  :global(.code-viewer .token.selector),
  :global(.code-viewer .token.attr-name),
  :global(.code-viewer .token.string),
  :global(.code-viewer .token.char),
  :global(.code-viewer .token.builtin),
  :global(.code-viewer .token.inserted) {
    color: #9ecbff;
  }

  :global(.code-viewer .token.operator),
  :global(.code-viewer .token.entity),
  :global(.code-viewer .token.url),
  :global(.code-viewer .language-css .token.string),
  :global(.code-viewer .style .token.string) {
    color: #79b8ff;
  }

  :global(.code-viewer .token.atrule),
  :global(.code-viewer .token.attr-value),
  :global(.code-viewer .token.keyword) {
    color: #b392f0;
  }

  :global(.code-viewer .token.function),
  :global(.code-viewer .token.class-name) {
    color: #ffab70;
  }

  :global(.code-viewer .token.regex),
  :global(.code-viewer .token.important),
  :global(.code-viewer .token.variable) {
    color: #ffab70;
  }
</style>

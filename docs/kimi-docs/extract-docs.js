/**
 * Kimi Code 文档 HTML→Markdown 转换器
 * 从 VitePress 预渲染的 .js 文件中提取内容并转换为标准 Markdown
 * 
 * 用法: node extract-docs.js
 * 输出: ../kimi-docs-md/
 */

const fs = require('fs');
const path = require('path');

const ASSETS_DIR = path.join(__dirname, 'assets');
const OUTPUT_DIR = path.join(__dirname, '..', 'kimi-docs-md');

// 目录映射: relativePath 前缀 → 输出子目录
const DIR_MAP = {
  'index': '',
  'kimi-code/': '01-overview/',
  'kimi-code-cli/guides/': '02-cli-guides/',
  'kimi-code-cli/configuration/': '03-cli-configuration/',
  'kimi-code-cli/customization/': '04-cli-customization/',
  'kimi-code-cli/reference/': '05-cli-reference/',
  'kimi-code-cli/release-notes/': '06-cli-release-notes/',
  'kimi-code-for-vscode/': '07-vscode/',
  'third-party-tools/': '08-third-party/',
};

// 文件名映射
const FILENAME_MAP = {
  'index': '产品概览',
  'models': '模型配置',
  'membership': '会员权益',
  'whats-new': '最新动态',
  'community-guidelines': '社区倡议',
  'faq': '常见问题',
  'error-reference': '错误参考',
  'contact-and-feedback': '联系与反馈',
  'getting-started': '开始使用',
  'migration': '从kimi-cli迁移',
  'use-cases': '常见使用案例',
  'interaction': '交互与输入',
  'sessions': '会话与上下文',
  'goals': '使用目标模式',
  'ides': '在IDE中使用',
  'config-files': '配置文件',
  'providers': '平台与模型',
  'overrides': '配置覆盖',
  'env-vars': '环境变量',
  'data-locations': '数据路径',
  'mcp': 'Model-Context-Protocol',
  'skills': 'Agent-Skills',
  'plugins': 'Plugins',
  'agents': 'Agent与子Agent',
  'hooks': 'Hooks',
  'themes': '自定义主题',
  'kimi-command': 'kimi命令',
  'kimi-acp': 'kimi-acp子命令',
  'tools': '内置工具',
  'slash-commands': '斜杠命令',
  'keyboard': '键盘快捷键',
  'changelog': '变更记录',
  'core-operations': '核心操作',
  'configuration': '配置',
  'customization': '定制化',
  'claude-code': 'Claude-Code',
  'opencode': 'OpenCode',
  'codex': 'Codex',
};

function getOutputInfo(relativePath) {
  let subDir = '';
  for (const [prefix, dir] of Object.entries(DIR_MAP)) {
    if (relativePath === prefix || relativePath.startsWith(prefix)) {
      subDir = dir;
      break;
    }
  }
  if (!subDir) subDir = 'other/';
  
  const parts = relativePath.replace(/\.md$/, '').split('/');
  const slug = parts[parts.length - 1];
  const chineseName = FILENAME_MAP[slug] || slug;
  
  return {
    dir: path.join(OUTPUT_DIR, subDir),
    filename: `${chineseName}.md`,
    slug,
  };
}

function extractContent(jsContent) {
  // Step 1: Extract JSON metadata
  const metaMatch = jsContent.match(/JSON\.parse\(`(\{[^`]*\})`\)/);
  let metadata = {};
  if (metaMatch) {
    try {
      metadata = JSON.parse(metaMatch[1]);
    } catch(e) {
      console.warn('  [WARN] Failed to parse metadata');
    }
  }
  
  // Step 2: Extract HTML content - two patterns exist:
  // Pattern A: n(`...`,N) — used in some pages
  // Pattern B: r(`...`,N) — used in other pages
  let htmlContent = '';

  // Try pattern A: n(`...`,N)
  let nStart = jsContent.indexOf('n(`');
  if (nStart >= 0) {
    let end = jsContent.indexOf('`,', nStart + 3);
    if (end > nStart) {
      htmlContent = jsContent.substring(nStart + 3, end);
      console.log('  [Pattern A: n()]');
    }
  }

  // Try pattern B: r(`...`,N) - look for the FIRST r(` with substantial content
  if (!htmlContent) {
    nStart = jsContent.indexOf('r(`');
    if (nStart >= 0) {
      // Find the matching `,N) which should be right after the closing backtick
      let end = jsContent.indexOf('`,', nStart + 3);
      if (end > nStart) {
        htmlContent = jsContent.substring(nStart + 3, end);
        // Verify this is HTML content (starts with '<')
        if (htmlContent.trim().startsWith('<')) {
          console.log('  [Pattern B: r()]');
        } else {
          htmlContent = '';
        }
      }
    }
  }

  // Try pattern C: n('...',N) or r('...',N) - single-quoted string (e.g. agents.md)
  if (!htmlContent) {
    for (const prefix of ["n('", "r('"]) {
      nStart = jsContent.indexOf(prefix);
      if (nStart >= 0) {
        let end = jsContent.indexOf("',", nStart + 3);
        if (end > nStart) {
          let raw = jsContent.substring(nStart + 3, end);
          if (raw.trim().startsWith('<')) {
            // Unescape single-quoted string escapes
            htmlContent = raw.replace(/\\'/g, "'").replace(/\\\\/g, '\\');
            console.log('  [Pattern C: ' + prefix[0] + "('')]");
            break;
          }
        }
      }
    }
  }
  
  // Unescape template literal escapes
  htmlContent = htmlContent
    .replace(/\\`/g, '`')
    .replace(/\\\$/g, '$')
    .replace(/\\\\/g, '\\');
  
  return { metadata, html: htmlContent };
}

function stripShikiSpans(html) {
  return html
    .replace(/<span class="line">/g, '')
    .replace(/<\/span>/g, '')
    .replace(/<span[^>]*style="[^"]*"[^>]*>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .trim();
}

function stripInlineHtml(html) {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function htmlToMarkdown(html) {
  let md = html;

  var NL = String.fromCharCode(10);
  
  // ===== 0. Pre-processing: strip Vue scoped data attributes =====
  md = md.replace(/\s+data-v-[a-f0-9]+(?:s*=s*"[^"]*")?/g, '');
  
  // ===== 1. Code blocks (must process before inline code) =====
  // Shiki code blocks with language div wrapper
  md = md.replace(/<div class="language-(\w+)(?:[^"]*)">\s*<button[^>]*><\/button>\s*<span class="lang">[^<]*<\/span>\s*<pre class="shiki[^"]*"[^>]*><code>([\s\S]*?)<\/code><\/pre>\s*<\/div>/g, (match, lang, code) => {
    let text = stripShikiSpans(code);
    return '\n\n```' + lang + '\n' + text + '\n```\n\n';
  });
  
  // Fallback: <pre><code> without shiki wrapper
  md = md.replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/g, (match, code) => {
    let text = stripShikiSpans(code);
    return '\n\n```\n' + text + '\n```\n\n';
  });
  
  // ===== 2. Custom blocks =====
  md = md.replace(/<div class="tip custom-block">\s*<p class="custom-block-title">([^<]*)<\/p>\s*([\s\S]*?)<\/div>/g, (match, title, content) => {
    const icon = (title.includes('提示') || title.includes('TIP')) ? '💡' : '📌';
    return '\n\n> **' + icon + ' ' + title + '**\n> \n' + content.split('\n').map(function(l) { return l.trim() ? '> ' + l : '>'; }).join('\n') + '\n\n';
  });
  
  md = md.replace(/<div class="warning custom-block">\s*<p class="custom-block-title">([^<]*)<\/p>\s*([\s\S]*?)<\/div>/g, (match, title, content) => {
    return '\n\n> **⚠️ ' + title + '**\n> \n' + content.split('\n').map(function(l) { return l.trim() ? '> ' + l : '>'; }).join('\n') + '\n\n';
  });
  
  md = md.replace(/<div class="danger custom-block">\s*<p class="custom-block-title">([^<]*)<\/p>\s*([\s\S]*?)<\/div>/g, (match, title, content) => {
    return '\n\n> **🚫 ' + title + '**\n> \n' + content.split('\n').map(function(l) { return l.trim() ? '> ' + l : '>'; }).join('\n') + '\n\n';
  });
  
  // Generic custom blocks
  md = md.replace(/<div class="([^"]*) custom-block">\s*(?:<p class="custom-block-title">([^<]*)<\/p>)?\s*([\s\S]*?)<\/div>/g, (match, type, title, content) => {
    if (title) {
      return '\n\n> **' + title + '**\n> \n' + content.split('\n').map(function(l) { return l.trim() ? '> ' + l : '>'; }).join('\n') + '\n\n';
    }
    return '\n\n> ' + content.split('\n').map(function(l) { return l.trim() ? '> ' + l : '>'; }).join('\n') + '\n\n';
  });
  
  // ===== 3. Details/summary =====
  md = md.replace(/<details[^>]*>\s*<summary[^>]*>([\s\S]*?)<\/summary>\s*([\s\S]*?)<\/details>/g, (match, summary, content) => {
    return '\n\n<details>\n<summary>' + summary.trim() + '</summary>\n\n' + content.trim() + '\n\n</details>\n\n';
  });
  
  // ===== 4. Blockquotes =====
  md = md.replace(/<blockquote>\s*<p>([\s\S]*?)<\/p>\s*<\/blockquote>/g, (match, content) => {
    return '\n\n> ' + content.trim().replace(/<br\s*\/?>/g, '\n> ') + '\n\n';
  });
  
  // ===== 5. Headings =====
  md = md.replace(/<h1[^>]*>(.*?)<\/h1>/g, function(m, inner) {
    // Remove header-anchor links from heading content
    inner = inner.replace(/<a class="header-anchor"[^>]*>[^<]*<\/a>/g, '');
    return '\n\n# ' + inner.trim() + '\n\n';
  });
  md = md.replace(/<h2[^>]*>(.*?)<\/h2>/g, function(m, inner) {
    inner = inner.replace(/<a class="header-anchor"[^>]*>[^<]*<\/a>/g, '');
    return '\n\n## ' + inner.trim() + '\n\n';
  });
  md = md.replace(/<h3[^>]*>(.*?)<\/h3>/g, function(m, inner) {
    inner = inner.replace(/<a class="header-anchor"[^>]*>[^<]*<\/a>/g, '');
    return '\n\n### ' + inner.trim() + '\n\n';
  });
  md = md.replace(/<h4[^>]*>(.*?)<\/h4>/g, function(m, inner) {
    inner = inner.replace(/<a class="header-anchor"[^>]*>[^<]*<\/a>/g, '');
    return '\n\n#### ' + inner.trim() + '\n\n';
  });
  
  // ===== 6. Tables - keep as HTML =====
  md = md.replace(/<table[^>]*>/g, '\n\n<table>');
  md = md.replace(/<\/table>/g, '</table>\n\n');
  
  // ===== 7. Lists =====
  md = md.replace(/<ul>\s*/g, '\n');
  md = md.replace(/<\/ul>/g, '\n');
  md = md.replace(/<ol>\s*/g, '\n');
  md = md.replace(/<\/ol>/g, '\n');
  md = md.replace(/<li>/g, '- ');
  md = md.replace(/<\/li>/g, '\n');
  
  // ===== 8. Paragraphs =====
  md = md.replace(/<p>/g, '\n\n');
  md = md.replace(/<\/p>/g, '\n\n');
  
  // ===== 9. Inline elements =====
  // Links - must process before other inline elements
  md = md.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g, (match, href, text) => {
    text = stripInlineHtml(text);
    if (href.startsWith('/code/docs/')) {
      href = href.replace(/\.html$/, '.md').replace('/code/docs/', '');
    }
    return '[' + text + '](' + href + ')';
  });
  
  // Bold and emphasis
  md = md.replace(/<strong>([\s\S]*?)<\/strong>/g, '**$1**');
  md = md.replace(/<em>([\s\S]*?)<\/em>/g, '*$1*');
  
  // Inline code
  md = md.replace(/<code>([\s\S]*?)<\/code>/g, '`$1`');
  
  // ===== 10. Break and HR =====
  md = md.replace(/<br\s*\/?>/g, '\n');
  md = md.replace(/<hr\s*\/?>/g, '\n\n---\n\n');
  
  // ===== 11. Remove remaining tags =====
  md = md.replace(/<button[^>]*>[\s\S]*?<\/button>/g, '');
  md = md.replace(/<span[^>]*class="lang"[^>]*>[^<]*<\/span>/g, '');
  md = md.replace(/<span[^>]*>([\s\S]*?)<\/span>/g, '$1');
  md = md.replace(/<div[^>]*>/g, '');
  md = md.replace(/<\/div>/g, '');
  md = md.replace(/<img[^>]*alt="([^"]*)"[^>]*\/?>/g, (match, alt) => '![' + alt + ']');
  md = md.replace(/<a class="header-anchor"[^>]*>[^<]*<\/a>/g, '');
  
  // ===== 12. Clean up =====
  // Decode HTML entities
  md = md.replace(/&quot;/g, '"');
  md = md.replace(/&amp;/g, '&');
  md = md.replace(/&lt;/g, '<');
  md = md.replace(/&gt;/g, '>');
  md = md.replace(/&#39;/g, "'");
  md = md.replace(/&apos;/g, "'");
  
  // Collapse excessive blank lines: reduce 3+ newlines to 2 (standard paragraph spacing)
  md = md.replace(new RegExp(NL + '{3,}', 'g'), NL + NL);
  
  // Remove trailing whitespace from lines
  md = md.replace(/[ \t]+$/gm, '');
  
  return md.trim();
}

async function processAllFiles() {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
  
  const allFiles = fs.readdirSync(ASSETS_DIR);
  const jsFiles = allFiles.filter(f => {
    return f.endsWith('.js') && !f.endsWith('.lean.js') && f !== 'app.De0FTGlA.js';
  });
  
  console.log('Found ' + jsFiles.length + ' content files to process\n');
  
  let successCount = 0;
  let failCount = 0;
  const indexEntries = [];
  
  for (const jsFile of jsFiles) {
    const filePath = path.join(ASSETS_DIR, jsFile);
    console.log('Processing: ' + jsFile);
    
    try {
      const jsContent = fs.readFileSync(filePath, 'utf-8');
      const { metadata, html } = extractContent(jsContent);
      
      if (!html) {
        console.log('  [SKIP] No HTML content found');
        failCount++;
        continue;
      }
      
      const markdown = htmlToMarkdown(html);
      const { dir, filename, slug } = getOutputInfo(metadata.relativePath || jsFile.replace(/\.md\..*\.js$/, '.md'));
      
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      
      const title = metadata.title || slug;
      // Content already has its own h1 heading, just add source note
      const fullMd = '> 来源: https://www.kimi.com/code/docs/' + (metadata.relativePath || '').replace(/\.md$/, '.html').replace(/^zh\//, '') + '\n\n' + markdown + '\n';
      
      const outputPath = path.join(dir, filename);
      fs.writeFileSync(outputPath, fullMd, 'utf-8');
      
      console.log('  -> ' + path.relative(OUTPUT_DIR, outputPath) + ' (' + (fullMd.length / 1024).toFixed(1) + ' KB)');
      
      indexEntries.push({
        title,
        path: path.relative(OUTPUT_DIR, outputPath).replace(/\\/g, '/'),
        relativePath: metadata.relativePath || '',
        size: fullMd.length,
      });
      
      successCount++;
    } catch (err) {
      console.error('  [ERROR] ' + err.message);
      failCount++;
    }
  }
  
  console.log('\n' + '='.repeat(60));
  console.log('Done! ' + successCount + ' converted, ' + failCount + ' failed');
  
  return indexEntries;
}

function generateSearchIndex(indexEntries) {
  const index = {
    version: '1.0',
    generated: new Date().toISOString(),
    source: 'https://www.kimi.com/code/docs/',
    totalPages: indexEntries.length,
    pages: indexEntries.map(e => ({
      title: e.title,
      path: e.path,
    })),
  };
  
  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'search-index.json'),
    JSON.stringify(index, null, 2),
    'utf-8'
  );
  
  return index;
}

function generateSearchHtml(indexEntries) {
  const pagesJson = JSON.stringify(indexEntries.map(e => ({
    title: e.title,
    path: e.path,
    snippet: e.title,
  })));
  
  const html = '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width,initial-scale=1">\n  <title>Kimi Code 离线文档搜索</title>\n  <style>\n    * { box-sizing: border-box; margin: 0; padding: 0; }\n    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; background: #f5f5f5; color: #333; }\n    .container { max-width: 900px; margin: 0 auto; padding: 20px; }\n    h1 { font-size: 24px; margin-bottom: 8px; color: #1a1a1a; }\n    .header { margin-bottom: 24px; border-bottom: 1px solid #e0e0e0; padding-bottom: 16px; }\n    .header p { color: #666; font-size: 14px; }\n    #searchInput { width: 100%; padding: 14px 20px; font-size: 16px; border: 2px solid #ddd; border-radius: 10px; outline: none; transition: border-color .2s; background: #fff; }\n    #searchInput:focus { border-color: #6C63FF; }\n    #results { margin-top: 16px; }\n    .result-item { background: #fff; border-radius: 8px; padding: 14px 20px; margin-bottom: 8px; border: 1px solid #eee; transition: box-shadow .2s; }\n    .result-item:hover { box-shadow: 0 2px 8px rgba(0,0,0,.08); }\n    .result-item a { color: #6C63FF; text-decoration: none; font-size: 16px; font-weight: 500; }\n    .result-item a:hover { text-decoration: underline; }\n    .result-item .path { font-size: 12px; color: #999; margin-top: 4px; }\n    .no-results { text-align: center; padding: 40px; color: #999; }\n    .stats { font-size: 13px; color: #888; margin-top: 8px; }\n  </style>\n</head>\n<body>\n<div class="container">\n  <div class="header">\n    <h1>🔍 Kimi Code 离线文档搜索</h1>\n    <p>全文搜索 ' + indexEntries.length + ' 篇官方文档（中文）</p>\n  </div>\n  <input type="text" id="searchInput" placeholder="输入关键词搜索文档..." autofocus>\n  <div class="stats" id="stats">共 ' + indexEntries.length + ' 篇文档</div>\n  <div id="results"></div>\n</div>\n\n<script>\nvar PAGES = ' + pagesJson + ';\n\nfunction renderResults(pages) {\n  var el = document.getElementById("results");\n  var stats = document.getElementById("stats");\n  if (pages.length === 0) {\n    el.textContent = "";\n    var div = document.createElement("div");\n    div.className = "no-results";\n    div.textContent = "😕 未找到匹配的文档，试试其他关键词";\n    el.appendChild(div);\n    stats.textContent = "无匹配结果";\n    return;\n  }\n  stats.textContent = "找到 " + pages.length + " 篇文档";\n  el.textContent = "";\n  pages.forEach(function(p) {\n    var item = document.createElement("div");\n    item.className = "result-item";\n    var a = document.createElement("a");\n    a.href = p.path;\n    a.target = "_blank";\n    a.textContent = p.title;\n    var div = document.createElement("div");\n    div.className = "path";\n    div.textContent = p.path;\n    item.appendChild(a);\n    item.appendChild(div);\n    el.appendChild(item);\n  });\n}\n\ndocument.getElementById("searchInput").addEventListener("input", function(e) {\n  var q = e.target.value.trim().toLowerCase();\n  if (!q) { renderResults(PAGES); return; }\n  var keywords = q.split(/\\s+/).filter(Boolean);\n  var results = PAGES.filter(function(p) {\n    var text = (p.title + " " + p.path + " " + p.snippet).toLowerCase();\n    return keywords.every(function(kw) { return text.indexOf(kw) !== -1; });\n  });\n  renderResults(results);\n});\n\nrenderResults(PAGES);\n</script>\n</body>\n</html>';
  
  fs.writeFileSync(path.join(OUTPUT_DIR, 'search.html'), html, 'utf-8');
}

async function main() {
  console.log('Kimi Code 文档 HTML → Markdown 转换器\n');
  
  const indexEntries = await processAllFiles();
  
  if (indexEntries.length > 0) {
    generateSearchIndex(indexEntries);
    generateSearchHtml(indexEntries);
    console.log('\nSearch page: ' + path.join(OUTPUT_DIR, 'search.html'));
    console.log('Search index: ' + path.join(OUTPUT_DIR, 'search-index.json'));
  }
}

main().catch(console.error);

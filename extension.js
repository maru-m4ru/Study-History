(function (Scratch) {
  'use strict';

  if (!Scratch.extensions.unsandboxed) {
    throw new Error('この拡張機能は「サンドボックスなし」で読み込んでください。');
  }

  const BlockType = Scratch.BlockType;
  const ArgumentType = Scratch.ArgumentType;
  const WORKER_BASE = 'https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev';
  const DEFAULT_WIDTH = 480;
  const DEFAULT_HEIGHT = 360;

  let viewer = null;
  let frame = null;
  let closeButton = null;
  let currentUrl = '';
  let requestedWidth = DEFAULT_WIDTH;
  let requestedHeight = DEFAULT_HEIGHT;
  let animationFrame = 0;

  function getCanvas() {
    const vm = Scratch.vm;
    const canvas = vm && vm.runtime && vm.runtime.renderer && vm.runtime.renderer.canvas;
    return canvas || document.querySelector('canvas');
  }

  function createViewer() {
    if (viewer) return;

    viewer = document.createElement('div');
    viewer.setAttribute('aria-label', 'TurboWarp Web Viewer');
    Object.assign(viewer.style, {
      position: 'fixed',
      left: '0',
      top: '0',
      width: `${DEFAULT_WIDTH}px`,
      height: `${DEFAULT_HEIGHT}px`,
      zIndex: '2147483000',
      overflow: 'hidden',
      background: '#ffffff',
      border: '1px solid #555',
      boxSizing: 'border-box',
      boxShadow: '0 4px 18px rgba(0, 0, 0, 0.28)',
      display: 'none',
    });

    frame = document.createElement('iframe');
    frame.title = 'Web page displayed in TurboWarp';
    frame.referrerPolicy = 'no-referrer';
    frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads');
    Object.assign(frame.style, {
      position: 'absolute',
      inset: '0',
      width: '100%',
      height: '100%',
      border: '0',
      background: '#ffffff',
    });

    closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.textContent = '閉じる ×';
    closeButton.title = 'Web表示を閉じる';
    Object.assign(closeButton.style, {
      position: 'absolute',
      top: '4px',
      right: '4px',
      zIndex: '2',
      border: '1px solid #555',
      borderRadius: '4px',
      padding: '4px 8px',
      color: '#ffffff',
      background: 'rgba(25, 25, 25, 0.88)',
      font: '12px sans-serif',
      cursor: 'pointer',
    });
    closeButton.addEventListener('click', closeViewer);

    viewer.append(frame, closeButton);
    document.body.appendChild(viewer);
    window.addEventListener('resize', updateViewerPosition);
    window.addEventListener('scroll', updateViewerPosition, true);

    if (typeof ResizeObserver === 'function') {
      const canvas = getCanvas();
      if (canvas) {
        const observer = new ResizeObserver(updateViewerPosition);
        observer.observe(canvas);
        viewer.__resizeObserver = observer;
      }
    }
  }

  function updateViewerPosition() {
    if (!viewer || viewer.style.display === 'none') return;

    const canvas = getCanvas();
    if (!canvas) {
      viewer.style.display = 'none';
      return;
    }

    const rect = canvas.getBoundingClientRect();
    const width = Math.max(160, Math.min(requestedWidth, rect.width));
    const height = Math.max(120, Math.min(requestedHeight, rect.height));

    viewer.style.left = `${rect.left + (rect.width - width) / 2}px`;
    viewer.style.top = `${rect.top + (rect.height - height) / 2}px`;
    viewer.style.width = `${width}px`;
    viewer.style.height = `${height}px`;
  }

  function trackViewerPosition() {
    if (!viewer || viewer.style.display === 'none') {
      animationFrame = 0;
      return;
    }

    updateViewerPosition();
    animationFrame = window.requestAnimationFrame(trackViewerPosition);
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function makeProxyUrl(value) {
    if (WORKER_BASE.includes('YOUR-WORKER') || WORKER_BASE.includes('YOUR-SUBDOMAIN')) {
      throw new Error('extension.js の WORKER_BASE をデプロイ済み Worker の URL に変更してください。');
    }

    const workerUrl = new URL(WORKER_BASE);
    if (workerUrl.protocol !== 'https:') {
      throw new Error('WORKER_BASE には https:// で始まる Worker URL を指定してください。');
    }

    const target = new URL(value);

    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      throw new Error('URLには http:// または https:// を指定してください。');
    }

    if (target.username || target.password || target.port) {
      throw new Error('ユーザー情報や標準以外のポートを含むURLには対応していません。');
    }

    const base = WORKER_BASE.replace(/\/+$/, '');
    return `${base}/__proxy__/${target.protocol.slice(0, -1)}/${target.host}${target.pathname}${target.search}${target.hash}`;
  }

  function openWebsite(args) {
    const value = String(args.URL || '').trim();

    try {
      const target = new URL(value);
      const proxyUrl = makeProxyUrl(target.href);
      createViewer();
      currentUrl = target.href;
      viewer.style.display = 'block';
      frame.removeAttribute('srcdoc');
      frame.src = proxyUrl;
      updateViewerPosition();

      if (!animationFrame) {
        animationFrame = window.requestAnimationFrame(trackViewerPosition);
      }
    } catch (error) {
      currentUrl = `エラー: ${error.message}`;
      createViewer();
      viewer.style.display = 'block';
      frame.removeAttribute('src');
      frame.srcdoc = `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font:16px sans-serif;padding:20px;color:#222"><h2>Web表示の設定エラー</h2><p>${escapeHtml(error.message)}</p></body></html>`;
      updateViewerPosition();

      if (!animationFrame) {
        animationFrame = window.requestAnimationFrame(trackViewerPosition);
      }
    }
  }

  function closeViewer() {
    if (viewer) viewer.style.display = 'none';
    if (frame) {
      frame.removeAttribute('srcdoc');
      frame.src = 'about:blank';
    }
    currentUrl = '';

    if (animationFrame) {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = 0;
    }
  }

  function setViewerSize(args) {
    const width = Number(args.WIDTH);
    const height = Number(args.HEIGHT);

    requestedWidth = Number.isFinite(width) ? Math.max(160, Math.min(1600, Math.round(width))) : DEFAULT_WIDTH;
    requestedHeight = Number.isFinite(height) ? Math.max(120, Math.min(1200, Math.round(height))) : DEFAULT_HEIGHT;
    updateViewerPosition();
  }

  class TurboWarpWebViewer {
    getInfo() {
      return {
        id: 'turbowarpwebviewer',
        name: 'Webサイト表示',
        color1: '#1769aa',
        color2: '#0d47a1',
        blocks: [
          {
            opcode: 'openWebsite',
            blockType: BlockType.COMMAND,
            text: 'Webサイト [URL] を表示する',
            arguments: {
              URL: {
                type: ArgumentType.STRING,
                defaultValue: 'https://example.com/',
              },
            },
          },
          {
            opcode: 'setViewerSize',
            blockType: BlockType.COMMAND,
            text: '表示領域を 幅 [WIDTH] 高さ [HEIGHT] にする',
            arguments: {
              WIDTH: {
                type: ArgumentType.NUMBER,
                defaultValue: DEFAULT_WIDTH,
              },
              HEIGHT: {
                type: ArgumentType.NUMBER,
                defaultValue: DEFAULT_HEIGHT,
              },
            },
          },
          {
            opcode: 'closeViewer',
            blockType: BlockType.COMMAND,
            text: 'Webサイト表示を閉じる',
          },
          {
            opcode: 'getCurrentUrl',
            blockType: BlockType.REPORTER,
            text: '表示中のWebサイトURL',
          },
          {
            opcode: 'getViewerStatus',
            blockType: BlockType.REPORTER,
            text: 'Webサイト表示の状態',
          },
        ],
      };
    }

    openWebsite(args) {
      openWebsite(args);
    }

    setViewerSize(args) {
      setViewerSize(args);
    }

    closeViewer() {
      closeViewer();
    }

    getCurrentUrl() {
      return currentUrl;
    }

    getViewerStatus() {
      return viewer && viewer.style.display !== 'none' ? '表示中' : '非表示';
    }
  }

  Scratch.extensions.register(new TurboWarpWebViewer());
})(Scratch);

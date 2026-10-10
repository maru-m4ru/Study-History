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

  let proxyToken = '';
  let viewer = null;
  let frame = null;
  let closeButton = null;
  let currentUrl = '';
  let currentStatus = '非表示';
  let requestedWidth = DEFAULT_WIDTH;
  let requestedHeight = DEFAULT_HEIGHT;
  let animationFrame = 0;
  let tokenDialog = null;

  function getCanvas() {
    const vm = Scratch.vm;
    const canvas = vm && vm.runtime && vm.runtime.renderer && vm.runtime.renderer.canvas;
    return canvas || document.querySelector('canvas');
  }

  function handleViewerMessage(event) {
    if (!frame || event.source !== frame.contentWindow) return;

    const data = event.data;

    if (
      !data ||
      data.source !== 'turbowarp-web-viewer' ||
      typeof data.url !== 'string'
    ) {
      return;
    }

    try {
      const target = new URL(data.url);

      if (target.protocol !== 'http:' && target.protocol !== 'https:') {
        return;
      }

      currentUrl = target.href;
      currentStatus = '表示中';
    } catch {
    }
  }

  function sendViewerCommand(action) {
    if (!frame || !currentUrl || !viewer || viewer.style.display === 'none') {
      return;
    }

    frame.contentWindow.postMessage({
      source: 'turbowarp-web-viewer-control',
      action,
    }, '*');
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

    frame.addEventListener('load', () => {
      if (
        viewer &&
        viewer.style.display !== 'none' &&
        currentUrl &&
        !currentUrl.startsWith('エラー:')
      ) {
        currentStatus = '表示中';
      }
    });

    frame.referrerPolicy = 'no-referrer';

    frame.setAttribute(
      'sandbox',
      'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads'
    );

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

    window.addEventListener('message', handleViewerMessage);
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

  function removeTokenDialog() {
    if (!tokenDialog) return;

    tokenDialog.remove();
    tokenDialog = null;
  }

  function showTokenDialog() {
    if (tokenDialog) {
      const existingInput = tokenDialog.querySelector('input[type="password"]');

      if (existingInput) existingInput.focus();

      return;
    }

    const overlay = document.createElement('div');
    overlay.setAttribute('role', 'presentation');

    Object.assign(overlay.style, {
      position: 'fixed',
      inset: '0',
      zIndex: '2147483647',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '20px',
      background: 'rgba(0, 0, 0, 0.55)',
      fontFamily: 'system-ui, sans-serif',
      boxSizing: 'border-box',
    });

    const panel = document.createElement('form');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', 'tw-web-viewer-token-title');

    Object.assign(panel.style, {
      width: 'min(440px, 100%)',
      padding: '24px',
      borderRadius: '12px',
      background: '#ffffff',
      color: '#1f2937',
      boxShadow: '0 18px 60px rgba(0, 0, 0, 0.3)',
      boxSizing: 'border-box',
    });

    const title = document.createElement('h2');
    title.id = 'tw-web-viewer-token-title';
    title.textContent = 'Cloudflare プロキシトークン';

    Object.assign(title.style, {
      margin: '0 0 10px',
      fontSize: '20px',
      lineHeight: '1.35',
    });

    const description = document.createElement('p');
    description.textContent =
      'Worker に設定した PROXY_TOKEN を入力してください。入力内容は画面上で伏せて表示され、このページを再読み込みするまでメモリ内に保持されます。';

    Object.assign(description.style, {
      margin: '0 0 16px',
      fontSize: '14px',
      lineHeight: '1.6',
      color: '#4b5563',
    });

    const label = document.createElement('label');
    label.textContent = 'トークン';

    Object.assign(label.style, {
      display: 'block',
      marginBottom: '6px',
      fontSize: '14px',
      fontWeight: '600',
    });

    const input = document.createElement('input');
    input.type = 'password';
    input.name = 'proxy-token';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.value = proxyToken;
    input.placeholder = 'ランダムなトークンを入力';

    Object.assign(input.style, {
      display: 'block',
      width: '100%',
      minHeight: '42px',
      padding: '10px 12px',
      border: '1px solid #9ca3af',
      borderRadius: '6px',
      boxSizing: 'border-box',
      font: '14px ui-monospace, monospace',
      color: '#111827',
      background: '#ffffff',
      outlineOffset: '2px',
    });

    label.appendChild(input);

    const error = document.createElement('p');
    error.setAttribute('aria-live', 'polite');

    Object.assign(error.style, {
      minHeight: '20px',
      margin: '8px 0 0',
      fontSize: '13px',
      color: '#b91c1c',
    });

    const buttons = document.createElement('div');

    Object.assign(buttons.style, {
      display: 'flex',
      justifyContent: 'flex-end',
      gap: '8px',
      marginTop: '18px',
    });

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'キャンセル';

    Object.assign(cancel.style, {
      minHeight: '38px',
      padding: '8px 12px',
      border: '1px solid #9ca3af',
      borderRadius: '6px',
      color: '#111827',
      background: '#ffffff',
      font: '14px system-ui, sans-serif',
      cursor: 'pointer',
    });

    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.textContent = '設定する';

    Object.assign(submit.style, {
      minHeight: '38px',
      padding: '8px 14px',
      border: '1px solid #0d47a1',
      borderRadius: '6px',
      color: '#ffffff',
      background: '#1769aa',
      font: '600 14px system-ui, sans-serif',
      cursor: 'pointer',
    });

    cancel.addEventListener('click', removeTokenDialog);

    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) {
        removeTokenDialog();
      }
    });

    panel.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        removeTokenDialog();
      }
    });

    panel.addEventListener('submit', (event) => {
      event.preventDefault();

      const value = input.value.trim();

      if (value.length < 24) {
        error.textContent = 'トークンは24文字以上にしてください。';
        input.focus();
        return;
      }

      proxyToken = value;
      currentStatus = currentUrl ? '表示中' : '非表示';

      removeTokenDialog();
    });

    buttons.append(cancel, submit);
    panel.append(title, description, label, error, buttons);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    tokenDialog = overlay;
    input.focus();
  }

  function clearProxyToken() {
    proxyToken = '';
    closeViewer();
    currentStatus = 'トークン未設定';
  }

  function makeProxyUrl(value) {
    if (
      WORKER_BASE.includes('YOUR-WORKER') ||
      WORKER_BASE.includes('YOUR-SUBDOMAIN')
    ) {
      throw new Error(
        'extension.js の WORKER_BASE をデプロイ済み Worker の URL に変更してください。'
      );
    }

    if (proxyToken.length < 24) {
      throw new Error(
        '先に「プロキシトークンを設定する」ブロックでトークンを入力してください。'
      );
    }

    const workerUrl = new URL(WORKER_BASE);

    if (workerUrl.protocol !== 'https:') {
      throw new Error(
        'WORKER_BASE には https:// で始まる Worker URL を指定してください。'
      );
    }

    const target = new URL(value);

    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      throw new Error('URLには http:// または https:// を指定してください。');
    }

    if (target.username || target.password || target.port) {
      throw new Error(
        'ユーザー情報や標準以外のポートを含むURLには対応していません。'
      );
    }

    const base = WORKER_BASE.replace(/\/+$/, '');

    return `${base}/__proxy__/${encodeURIComponent(proxyToken)}/${target.protocol.slice(0, -1)}/${target.host}${target.pathname}${target.search}${target.hash}`;
  }

  function openWebsite(args) {
    const value = String(args.URL || '').trim();

    try {
      const target = new URL(value);
      const proxyUrl = makeProxyUrl(target.href);

      createViewer();

      currentUrl = target.href;
      currentStatus = '読み込み中';
      viewer.style.display = 'block';

      frame.removeAttribute('srcdoc');
      frame.src = proxyUrl;

      updateViewerPosition();

      if (!animationFrame) {
        animationFrame = window.requestAnimationFrame(trackViewerPosition);
      }
    } catch (error) {
      currentUrl = `エラー: ${error.message}`;
      currentStatus = 'エラー';

      createViewer();

      viewer.style.display = 'block';
      frame.removeAttribute('src');

      frame.srcdoc =
        `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font:16px sans-serif;padding:20px;color:#222"><h2>Web表示の設定エラー</h2><p>${escapeHtml(error.message)}</p></body></html>`;

      updateViewerPosition();

      if (!animationFrame) {
        animationFrame = window.requestAnimationFrame(trackViewerPosition);
      }
    }
  }

  function closeViewer() {
    if (viewer) {
      viewer.style.display = 'none';
    }

    if (frame) {
      frame.removeAttribute('srcdoc');
      frame.src = 'about:blank';
    }

    currentUrl = '';
    currentStatus = '非表示';

    if (animationFrame) {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = 0;
    }
  }

  function reloadWebsite() {
    if (!frame || !currentUrl || !viewer || viewer.style.display === 'none') {
      return;
    }

    currentStatus = '読み込み中';
    sendViewerCommand('reload');
  }

  function goBack() {
    if (!frame || !currentUrl || !viewer || viewer.style.display === 'none') {
      return;
    }

    currentStatus = '読み込み中';
    sendViewerCommand('back');
  }

  function goForward() {
    if (!frame || !currentUrl || !viewer || viewer.style.display === 'none') {
      return;
    }

    currentStatus = '読み込み中';
    sendViewerCommand('forward');
  }

  function setViewerSize(args) {
    const width = Number(args.WIDTH);
    const height = Number(args.HEIGHT);

    requestedWidth = Number.isFinite(width)
      ? Math.max(160, Math.min(1600, Math.round(width)))
      : DEFAULT_WIDTH;

    requestedHeight = Number.isFinite(height)
      ? Math.max(120, Math.min(1200, Math.round(height)))
      : DEFAULT_HEIGHT;

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
            opcode: 'showTokenDialog',
            blockType: BlockType.COMMAND,
            text: 'プロキシトークンを設定する',
          },
          {
            opcode: 'clearProxyToken',
            blockType: BlockType.COMMAND,
            text: 'プロキシトークンを消去する',
          },
          {
            opcode: 'isTokenSet',
            blockType: BlockType.BOOLEAN,
            text: 'プロキシトークンが設定済み',
          },
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
            opcode: 'reloadWebsite',
            blockType: BlockType.COMMAND,
            text: 'Webサイトを再読み込みする',
          },
          {
            opcode: 'goBack',
            blockType: BlockType.COMMAND,
            text: 'Webサイトで前のページに戻る',
          },
          {
            opcode: 'goForward',
            blockType: BlockType.COMMAND,
            text: 'Webサイトで次のページに進む',
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

    showTokenDialog() {
      showTokenDialog();
    }

    clearProxyToken() {
      clearProxyToken();
    }

    isTokenSet() {
      return proxyToken.length >= 24;
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

    reloadWebsite() {
      reloadWebsite();
    }

    goBack() {
      goBack();
    }

    goForward() {
      goForward();
    }

    getCurrentUrl() {
      return currentUrl;
    }

    getViewerStatus() {
      return currentStatus;
    }
  }

  Scratch.extensions.register(new TurboWarpWebViewer());
})(Scratch);

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

    const title = document.createElement('h

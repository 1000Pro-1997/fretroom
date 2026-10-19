import { getDocument, GlobalWorkerOptions, OPS } from 'pdfjs-dist/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { readPdfTab } from './pdf-tab.js';

GlobalWorkerOptions.workerSrc = workerUrl;

// Tablature exported as vector graphics (Guitar Pro, MuseScore…) is read exactly, without recognition.
export async function readVectorTab(bytes) {
  const loadingTask = getDocument({ data: bytes instanceof Uint8Array ? bytes.slice() : new Uint8Array(bytes).slice() });
  try {
    return await readPdfTab(await loadingTask.promise, OPS);
  } finally {
    await loadingTask.destroy();
  }
}

export function createPdfPreview(container, scroll) {
  let loadingTask;
  let observer;
  let imageUrl;
  let version = 0;

  function clear() {
    version++;
    observer?.disconnect();
    observer = undefined;
    if (loadingTask) void loadingTask.destroy();
    loadingTask = undefined;
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    imageUrl = undefined;
    container.replaceChildren();
  }

  async function show(name, bytes) {
    clear();
    const current = version;
    if (!/\.pdf$/i.test(name)) {
      imageUrl = URL.createObjectURL(new Blob([bytes]));
      const image = document.createElement('img');
      image.className = 'preview-image';
      image.alt = name;
      image.src = imageUrl;
      container.append(image);
      return;
    }
    // PDF.js transfers its input to a worker; retain the original for conversion.
    loadingTask = getDocument({ data: bytes instanceof Uint8Array ? bytes.slice() : new Uint8Array(bytes).slice() });
    const pdf = await loadingTask.promise;
    if (current !== version) return;
    observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        const holder = entry.target;
        const pageNumber = Number(holder.dataset.page);
        void pdf.getPage(pageNumber).then(async (page) => {
          if (current !== version) return;
          const width = page.getViewport({ scale: 1 }).width;
          const scale = Math.min(1.8, (container.clientWidth - 44) / width);
          const viewport = page.getViewport({ scale });
          holder.style.minHeight = `${viewport.height}px`;
          const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(viewport.width * pixelRatio);
          canvas.height = Math.round(viewport.height * pixelRatio);
          canvas.style.width = `${viewport.width}px`;
          canvas.style.height = `${viewport.height}px`;
          const context = canvas.getContext('2d', { alpha: false });
          await page.render({ canvasContext: context, canvas, viewport,
            transform: [pixelRatio, 0, 0, pixelRatio, 0, 0] }).promise;
          if (current === version) holder.replaceChildren(canvas);
        }).catch((error) => {
          if (current === version) holder.textContent = `PDF ${pageNumber}쪽을 표시할 수 없습니다: ${error.message}`;
        });
      }
    }, { root: scroll, rootMargin: '600px 0px' });
    const firstPage = await pdf.getPage(1);
    if (current !== version) return;
    const size = firstPage.getViewport({ scale: 1 });
    const estimatedHeight = size.height * Math.min(1.8, (container.clientWidth - 44) / size.width);
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const holder = document.createElement('div');
      holder.className = 'preview-page';
      holder.dataset.page = String(i);
      holder.style.minHeight = `${estimatedHeight}px`;
      holder.textContent = `${i} / ${pdf.numPages}쪽 불러오는 중…`;
      pages.push(holder);
    }
    container.append(...pages);
    for (const page of pages) observer.observe(page);
  }

  return { show, clear };
}
